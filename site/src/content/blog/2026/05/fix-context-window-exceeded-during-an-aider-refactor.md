---
title: "Fix: Context Window Exceeded During an Aider Refactor"
description: "Aider 0.86 hit the token limit mid-refactor. The fix is /clear, /drop, --map-tokens, and switching to architect mode with Claude Sonnet 4.6's 1M window. Step-by-step repro, error breakdown, and config."
pubDate: 2026-05-17
template: error-page
tags:
  - "errors"
  - "ai-agents"
  - "llm"
  - "aider"
  - "claude-code"
---

You ran `aider` over a five-thousand-file repo, asked for a "rename `IUserService` everywhere and add a tenant id", and somewhere in turn three the session died with `Model X has hit a token limit! Input tokens: 198432 of 200000`. The fix is rarely a bigger model. It is almost always: `/clear`, drop everything that is not the file you are editing, cap `--map-tokens` to 1024, and let aider's repo map find what it needs. If you are on Claude Sonnet 4.6, switch to architect mode so the bulky 1M context only happens once per turn, not on every search/replace round-trip. This post is the long-form version of that paragraph, with the exact error strings, the four real causes, and a config that survives a multi-day refactor.

Tested against aider `0.86.0`, the Anthropic API with `claude-sonnet-4-6` and `claude-opus-4-7`, OpenAI `gpt-5`, and the [aider token limits guide](https://aider.chat/docs/troubleshooting/token-limits.html).

## TL;DR

1. Run `/tokens` immediately. The line you care about is `Total tokens used` versus the model's `Max input tokens`. If you are above 60% before the LLM has even responded, you have a context problem, not a model problem.
2. `/clear` to wipe chat history. `/drop` every file that is not actively being edited. Keep two or three files in chat at most.
3. Cap the repo map with `--map-tokens 1024`. The default is already 1k but it grows to ~8k when no files are added, which is the worst case for a fresh refactor session.
4. Use `--architect` so the planning model sees the full context once, and a cheaper editor model does each search/replace block.
5. If the model itself is the bottleneck, switch to `claude-sonnet-4-6` (1M-token window) with prompt caching enabled. Do not switch to a model with a smaller window expecting it to "just work".

## The error in context

Aider does not enforce a token budget. It dispatches the request, the provider rejects it, and aider prints the provider's response inside its own banner. The exact string depends on which step blew up.

The input-side variant, the one most refactors hit:

```
Model claude-sonnet-4-6 has hit a token limit!
Input tokens: 1041203 of 1000000
Output tokens: 0 of 8192

To reduce input tokens:
 - Use /drop to remove unneeded files from the chat
 - Use /clear to clear the chat history
 - Break your code into smaller files
```

The output-side variant, which looks similar but means something different:

```
Model gpt-5 has hit a token limit!
Input tokens: 12453 of 400000
Output tokens: 16384 of 16384 -- exceeded output limit!
```

And the raw provider error you might see in `--verbose` mode:

```
litellm.BadRequestError: AnthropicException - prompt is too long: 1041203 tokens > 1000000 maximum
```

The two failure modes look identical at the aider banner level. The fixes are completely different. Always read the `Input tokens` line first.

## Why this happens

There are four root causes. They appear in this order of frequency for refactor sessions:

**1. The chat history grew faster than the repo map shrank.** Aider streams every assistant turn back into the next request as conversation history. A multi-turn refactor with diffs of a few hundred lines each will pile on 10-30k tokens per turn. By the time you are on turn five, the history alone is what fills the window. `/clear` removes it.

**2. Too many files are in the chat.** Every file added with `/add` is sent in full on every request, every turn. A chat with even ten medium files is starting at ~40k input tokens before you have said a word. Aider's own [repository map docs](https://aider.chat/docs/repomap.html) make this explicit: do not pre-add files, let the repo map surface relevant ones.

**3. The repo map ballooned.** `--map-tokens` defaults to 1024, but aider deliberately grows the map to roughly 8x its target when no files are in the chat, on the theory that the map is the only navigation aid the model has. On a huge monorepo this expanded map alone can push past 25k tokens, the point at which most models start ignoring system-prompt instructions even when the request technically fits.

**4. You picked a model with a small window.** GPT-4 Turbo at 128k, Claude Haiku at 200k, and most local models at 32k or below cannot survive a real refactor. The fix is not to keep stripping context. The fix is to use a model whose window matches the work. Claude Sonnet 4.6 has a 1M-token context window. Claude Opus 4.7 has 200k by default with a 1M tier on request, per the [Claude API context windows reference](https://docs.claude.com/en/docs/build-with-claude/context-windows).

## Minimal repro: a chat that dies on turn three

Start aider against a real repo:

```bash
# aider 0.86.0, Anthropic SDK via litellm 1.5x
aider --model anthropic/claude-sonnet-4-6 \
      --map-tokens 8192 \
      --no-show-model-warnings
```

Add a handful of files (most of the bug reports look like this):

```
/add src/Domain/**/*.cs
/add src/Infrastructure/Persistence/**/*.cs
/add src/Application/**/*.cs
```

Then issue a vague, repo-wide refactor:

```
> Rename IUserService to IAccountService everywhere, and add a tenantId
  parameter to every public method on it. Update the implementations and
  every call site.
```

For a 1000-file solution, the first request already shoves ~120-160k tokens at the model, the model responds with three or four search/replace blocks per file, you accept them, and aider re-sends the modified files plus the assistant turn on the next request. By turn three you are typically at 700-900k input tokens. Turn four trips the input limit and the session dies.

The repro is dull because the failure mode is dull. The whole point of this post is that you are not supposed to fight the model on a 1000-file refactor by pre-loading the whole solution. Aider is designed for the opposite shape: empty chat, generous repo map, files added on demand.

## Fix, in detail

Apply these in order. The first three fixes solve 90% of input-token blowups without touching the model or the budget.

### 1. /clear after every successful diff

The chat-history fix is one keystroke. After every turn that actually lands a diff you are happy with, run:

```
/clear
```

`/clear` removes the conversation history but keeps the files you have added. This is the single most underused command in aider. The fact that the previous turn's diff is already committed to the working tree means the model can re-derive its context from the files themselves, it does not need its own past assistant messages to do that.

There is also `/reset`, which drops files AND clears history. Use it between unrelated refactors. Do not use it mid-task.

### 2. /drop everything that is not being edited right now

This one is harder because it requires discipline. The aider mental model is:

> Only add the files that aider will need to edit. The repo map will surface other relevant code automatically.

In practice, the safest pattern for a multi-file refactor is to work one logical unit at a time:

```
/drop *
/add src/Domain/Users/IUserService.cs src/Domain/Users/UserService.cs
> Rename IUserService to IAccountService. Just this file pair, no call sites yet.
```

Then commit, `/clear`, and move on to call sites in another folder. You sacrifice a bit of "do it all in one prompt" magic in exchange for sessions that actually finish.

### 3. Cap --map-tokens and trust it

Setting `--map-tokens 1024` is not a workaround. It is the documented default, and the repo map is good at picking the most-referenced symbols within that budget. The reason to set it explicitly is to override aider's automatic expansion when no files are in the chat:

```bash
aider --model anthropic/claude-sonnet-4-6 \
      --map-tokens 1024 \
      --map-refresh files
```

`--map-refresh files` only rebuilds the map when files in the chat change, instead of the default `auto` which is more aggressive. On a large repo this alone cuts a noticeable amount of redundant token usage.

You can verify the map size at any time:

```
/tokens
```

The output breaks down by component (repo map, files in chat, chat history, system prompt) so you can see which one is the culprit.

### 4. Switch to architect mode for the multi-turn work

Architect mode is the single biggest improvement for long refactors. It uses two models per turn: a stronger "architect" model that sees the full context and proposes changes in prose, and a cheaper "editor" model that converts those proposals into search/replace blocks.

```bash
aider --architect \
      --model anthropic/claude-opus-4-7 \
      --editor-model anthropic/claude-sonnet-4-6
```

The relevant property for context-window blowups: the editor model only sees the architect's proposal plus the file being edited, not the full chat history or the full file set. That means each editor call is a small, bounded prompt, even when the architect call is large. You also get the side benefit that aider's [edit-error guidance](https://aider.chat/docs/troubleshooting/edit-errors.html) explicitly recommends architect mode as the most reliable path for tricky diffs.

### 5. Use a model whose window fits the work

Once the first four fixes are in place, the window is the last variable. Pick by the shape of the task:

- **Claude Sonnet 4.6** (1M tokens, `claude-sonnet-4-6`): default choice for large repos. Has prompt caching with a 4096-token minimum, which is well below what a serious refactor session pushes per turn.
- **Claude Opus 4.7** (200k default, 1M on tier 4+, `claude-opus-4-7`): use as the architect model. The 1M tier is gated; check your account.
- **GPT-5** (400k tokens): a good fallback if the Anthropic latency is a problem. Smaller window, but the model itself is fast and the architect mode mitigates the size gap.

Avoid setting a tiny `--model` for cost reasons mid-refactor. The token spent re-explaining what was already in the chat history costs more than the model price delta.

### 6. Set --max-chat-history-tokens explicitly

By default aider auto-summarizes history above the model's `max_chat_history_tokens` heuristic. On a 1M-window model that heuristic kicks in late, which is why a Sonnet 4.6 session can still blow up before summarization fires. Pin it lower:

```bash
aider --model anthropic/claude-sonnet-4-6 \
      --max-chat-history-tokens 16384
```

Now history gets summarized aggressively long before it threatens the request budget, regardless of model window. The env-var form is `AIDER_MAX_CHAT_HISTORY_TOKENS`, which is the right place to set it for CI runs.

## A config that survives a real refactor

Drop this into `.aider.conf.yml` at the repo root. It encodes every fix above:

```yaml
# aider 0.86.0
model: anthropic/claude-opus-4-7
editor-model: anthropic/claude-sonnet-4-6
architect: true

map-tokens: 1024
map-refresh: files

max-chat-history-tokens: 16384

auto-commits: true
dirty-commits: true

cache-prompts: true
```

`cache-prompts: true` enables [Anthropic prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching) for the static parts of the request (system prompt, repo map, file contents on read). With Sonnet 4.6's cache write cost at 1.25x and cache read at 0.1x of the base input rate, a long session can drop input cost by 70-80% even before the context window stops being a worry.

## Gotchas and variants

**The error is on output, not input.** If `Output tokens: 8192 of 8192 -- exceeded output limit!` is the line you see, the model produced more text than its output budget allows. None of the input-side fixes help. Ask for smaller, incremental changes, or split the prompt: "Just rename the interface, do not touch call sites yet." The aider docs are blunt about this: there is no universal switch for output limits, it has to come from the prompt.

**You are using a local model.** If you are on `ollama/qwen2.5-coder:32b` or similar, the context window is often 8k or 32k. Aider has no way to know that unless the model is in its `model_settings.yml`. Override it:

```bash
aider --model ollama/qwen2.5-coder:32b \
      --map-tokens 512
```

And expect to do refactors one file at a time. Local models do not survive 50-file edits regardless of how you tune them.

**You are using `--no-auto-commits` to "save tokens".** That does not reduce tokens, it just means aider never resets the working tree between turns. The token cost is identical and you lose the ability to roll back a bad turn. Leave auto-commits on.

**You are hitting rate limits, not the context window.** A response of `rate_limit_error` or `429 Too Many Requests` is a different problem. See the related post on fixing rate-limit errors in long Claude agent loops, linked below.

**You added the repo with `aider --subtree-only` and still hit the limit.** Subtree mode shrinks the repo map but not files-in-chat or history. The first three fixes still apply.

**Architect mode is slower per turn.** Two model calls per edit instead of one. The tradeoff is reliability on long refactors. For a five-file change you do not need architect mode. For a fifty-file change you almost always do.

## Related reading

- The repo-map design and why the 1k default is usually right: [Repository map in aider](https://aider.chat/docs/repomap.html).
- How to compose a coding agent across tools, including driving aider from a planning session in another agent: [pipe Cursor's context to an Aider session for multi-agent refactors](/2026/05/how-to-pipe-cursors-context-to-an-aider-session-for-multi-agent-refactors/).
- The other half of "agent crashed mid-refactor": [fix `rate_limit_error` and friends in Anthropic tool use](/2026/05/fix-tool-call-arguments-did-not-match-schema-in-anthropic-tool-use/).
- A neighbouring failure mode in a different tool: [Claude Code's "context window exceeded" and how to keep its context small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/).
- The other lever for long sessions: [add prompt caching to an Anthropic SDK app and measure the hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/).

## Sources

- aider docs, [Token limits](https://aider.chat/docs/troubleshooting/token-limits.html).
- aider docs, [Repository map](https://aider.chat/docs/repomap.html).
- aider docs, [In-chat commands](https://aider.chat/docs/usage/commands.html).
- aider docs, [Options reference](https://aider.chat/docs/config/options.html).
- aider docs, [File editing problems](https://aider.chat/docs/troubleshooting/edit-errors.html).
- Anthropic, [Context windows](https://docs.claude.com/en/docs/build-with-claude/context-windows).
- Anthropic, [Prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching).
- [aider v0.86.0 release notes](https://github.com/Aider-AI/aider/releases/tag/v0.86.0).
