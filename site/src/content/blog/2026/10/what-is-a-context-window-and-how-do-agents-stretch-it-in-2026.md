---
title: "What Is a Context Window and How Do Agents Stretch It in 2026"
description: "A context window is everything the model can see in one request: system prompt, tool definitions, history, tool results, thinking and the reply. Here is what counts, what happens at the limit on claude-opus-5-5 and friends, and the six techniques agents use to work past it: deferred tools, context editing, compaction, memory, subagents and output filtering."
pubDate: 2026-10-06
tags:
  - "llm"
  - "ai-agents"
  - "claude-code"
  - "context-window"
  - "compaction"
  - "anthropic-sdk"
---

**Short answer:** a context window is the total number of tokens a model can read and write in a single request: the system prompt, every tool definition, the full message history (including tool results, images and earlier thinking blocks), plus the reply it generates. In October 2026, `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-fable-5-1` have a 1M-token window and up to 128k output tokens per request, while `claude-haiku-4-5-20251001` and Sonnet 4.5 still have 200k. Agents do not "stretch" the window by making it bigger. They stretch the *work* that fits in it, using six techniques: load less up front (deferred tools, skills), clear stale tool results (context editing), summarize old turns (compaction), offload facts to files (memory), isolate noisy work (subagents), and filter tool output before the model sees it.

The rest of this post explains what actually counts, what happens at the limit, and which technique to reach for first. The API snippets use the Anthropic Python SDK against the beta headers documented as of October 2026 (`context-management-2025-06-27`, `compact-2026-01-12`, `compact-2026-09-04`). The Claude Code commands refer to Claude Code 2.1.2xx.

## What actually lands in the window

The easiest mistake is thinking of the window as "the conversation". It is the whole request. From the [context windows docs](https://platform.claude.com/docs/en/build-with-claude/context-windows), everything below counts:

- The `system` prompt.
- Every tool definition in `tools`, whether or not the model calls it.
- Every message in `messages`, including `tool_result` blocks, images, PDFs and documents.
- On newer models, previous `thinking` blocks. Opus 4.5 and later, Sonnet 4.6 and later, and the Fable and Mythos models keep earlier thinking blocks by default, so they count as input on every later turn. Older Opus/Sonnet models and every Haiku model strip them automatically.
- The output generated for this turn, including its thinking.

Prompt caching does not change any of this. `cache_read_input_tokens` and `cache_creation_input_tokens` count toward the window exactly like `input_tokens`. Caching changes the price of those tokens, not whether they occupy space. A 90% cache hit rate does nothing for a request that is about to overflow.

An agent loop makes the arithmetic brutal. Every tool call is a new request that resends everything before it. A coding agent that reads ten 3,000-token files and runs the test suite twice has added roughly 40k tokens of tool results to every subsequent request, even if it only needed two of those files.

## Window sizes and what happens at the edge

| Model family | Context window | Max output per request |
| --- | --- | --- |
| Opus 5.5, Opus 5, Opus 4.8/4.7/4.6 | 1M | 128k |
| Sonnet 5.5, Sonnet 5, Sonnet 4.6 | 1M | 128k |
| Fable 5.1, Fable 5, Mythos 5.1, Mythos 5 | 1M | 128k |
| Sonnet 4.5, Haiku 4.5 and older | 200k | model-dependent |

For every 1M-window model, 1M is the default: no beta header, and long-context requests are billed at standard pricing. There are two distinct failure modes at the edge:

1. **Input alone exceeds the window.** Every model returns `400 invalid_request_error` with "prompt is too long". Nothing runs.
2. **Input fits, but input plus generation does not.** On Claude 4.5 and newer, the API accepts the request and stops generation with `stop_reason: "model_context_window_exceeded"`. Older models reject it up front unless you send the `model-context-window-exceeded-2025-08-26` beta header.

The second case matters for agents because it fails *late*. Your loop has to treat `model_context_window_exceeded` as a signal to compact or clear, not as a normal end of turn.

## Why a bigger window is not the fix

Two reasons, and both show up in real agent runs.

The first is quality. Anthropic's own docs name the effect: as token count grows, accuracy and recall degrade, which they call *context rot*. A 1M window means the request will not fail, not that the model will weigh the 40th file read as carefully as the first. Curating what is in context matters as much as how much fits.

The second is cost. Because the loop resends everything, a session's spend scales with the area under the context curve, not with the final size. A Claude Code session that has been open all day turns a one-line question into a request that carries the entire day's history. The [Claude Code cost docs](https://code.claude.com/docs/en/costs) list long context as the first reason usage climbs in a long session.

So the goal is not to fill 1M tokens. It is to keep the active context small and relevant for as long as the task runs.

## Measure before you optimize

You cannot manage what you do not measure. On the API, the [token counting endpoint](https://platform.claude.com/docs/en/build-with-claude/token-counting) tells you how big a request will be before you send it:

```python
# anthropic Python SDK, claude-opus-5-5, October 2026
import anthropic

client = anthropic.Anthropic()

count = client.messages.count_tokens(
    model="claude-opus-5-5",
    system=SYSTEM_PROMPT,
    tools=TOOLS,
    messages=history,
)
print(count.input_tokens)  # system + tools + history, before any output
```

After each response, add `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` and `output_tokens` from `usage` to know how big the *next* request will be, because the next request resends this reply too.

In Claude Code, `/context` breaks the current window down by system prompt, tools, MCP servers, memory files, skills and messages. Run it once at the start of a fresh session in your repo. The number before you type anything is your fixed overhead, and it is often larger than people expect. I wrote up a full method for that in [measuring an agent's fixed token overhead before the first user token](/2026/09/measure-an-agents-fixed-token-overhead-before-the-first-user-token/).

## Technique 1: do not load what you might not need

The cheapest token is the one never sent. Tool definitions are the usual culprit: Anthropic's [tool search docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) cite a typical five-server MCP setup (GitHub, Slack, Sentry, Grafana, Splunk) consuming about 55k tokens of definitions before any work starts, and say tool search typically cuts that by over 85%.

On the API you keep sending every definition, but mark most of them `defer_loading: true` and add a search tool. Only the search tool and non-deferred tools enter the window until the model looks something up:

```python
# anthropic Python SDK, claude-opus-5-5, tool_search_tool_bm25_20251119
response = client.messages.create(
    model="claude-opus-5-5",
    max_tokens=4096,
    messages=[{"role": "user", "content": "Which Sentry issues spiked after the last deploy?"}],
    tools=[
        {"type": "tool_search_tool_bm25_20251119", "name": "tool_search_tool_bm25"},
        read_file_tool,  # hot path, stays loaded
        *[{**t, "defer_loading": True} for t in mcp_tools],  # loaded on demand
    ],
)
```

Keep your three to five most-used tools non-deferred, and never defer the search tool itself (the API returns 400 if every tool is deferred). Deferred tools are excluded from the cached prefix, so discovering one mid-conversation does not break prompt caching.

Claude Code does this for MCP tools by default: only tool names and server instructions load until a tool is used. The same "load on demand" idea applies to instructions. A CLAUDE.md loads in full on every session, while a skill loads only its short description until invoked, so moving a 150-line PR-review procedure out of CLAUDE.md into a skill removes it from every unrelated session. The Claude Code docs recommend keeping CLAUDE.md under 200 lines. If you want to go further on the MCP side, see [how to reduce the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/).

## Technique 2: clear tool results that already did their job

Most of an agent's context is tool output it has already acted on. The file it read three edits ago, the test run before the fix, the search results it already summarized. [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) removes those server-side, by rule, without you rewriting history:

```python
# anthropic Python SDK, beta header context-management-2025-06-27
response = client.beta.messages.create(
    model="claude-opus-5-5",
    max_tokens=8192,
    betas=["context-management-2025-06-27"],
    tools=TOOLS,
    messages=history,
    context_management={
        "edits": [
            {
                "type": "clear_tool_uses_20250919",
                "trigger": {"type": "input_tokens", "value": 120000},  # default 100k
                "keep": {"type": "tool_uses", "value": 5},              # default 3
                "clear_at_least": {"type": "input_tokens", "value": 20000},
                "exclude_tools": ["memory"],
            }
        ]
    },
)

for edit in response.context_management.applied_edits:
    print(edit.type, edit.cleared_input_tokens)
```

Your client keeps the full history; the API edits what the model sees. Cleared results are replaced with a placeholder, so the model knows something was there and can call the tool again if it needs the data back.

Two settings deserve attention. `clear_at_least` exists because clearing invalidates the prompt cache from the cleared point onward: if each clearing only frees 2k tokens, you pay a cache rewrite for almost nothing. Setting a floor makes each invalidation worth it. And `exclude_tools` protects results you never want gone, such as memory reads or a fetched spec. A sibling strategy, `clear_thinking_20251015`, trims old thinking blocks on models that keep them; when you combine both, `clear_thinking_20251015` must be first in the `edits` array.

## Technique 3: summarize old turns with compaction

Clearing works on tool results. When the *conversation itself* is what has grown, you summarize it. This is compaction, and in 2026 it runs on the server in two flavours, both in beta on Claude 4.6 and later models.

**Threshold compaction** (`compact-2026-01-12`) is one parameter on your ordinary request. When input tokens cross the trigger, the API summarizes everything before that point, returns a `compaction` block, and drops the summarized messages on later requests:

```python
# anthropic Python SDK, beta header compact-2026-01-12
response = client.beta.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=8192,
    betas=["compact-2026-01-12"],
    messages=history,
    context_management={
        "edits": [{
            "type": "compact_20260112",
            "trigger": {"type": "input_tokens", "value": 200000},  # default 150k, minimum 50k
        }]
    },
)
history.append({"role": "assistant", "content": response.content})
```

**On-demand compaction** (`compact-2026-09-04`) is the newer option and the one the docs now recommend first. You decide when, send the conversation with `compaction={"type": "summarize"}`, get back a single signed `compaction` block with `stop_reason: "compaction"`, and replace your history with it:

```python
# anthropic Python SDK, beta header compact-2026-09-04
summary = client.beta.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=4096,
    system=SYSTEM_PROMPT,   # send the same system and tools as the conversation
    tools=TOOLS,
    betas=["compact-2026-09-04"],
    messages=history,
    compaction={
        "type": "summarize",
        "instructions": "Keep every file path, failing test name and open TODO. Do not call tools.",
    },
)
if summary.stop_reason == "compaction":
    history = [{"role": "assistant", "content": summary.content}]
```

Check `stop_reason` before you touch the block. If the summarizer hit `max_tokens`, tried to call a tool, or refused, the response is still a 200 with empty content, and blindly replacing your history would wipe the conversation.

Claude Code wraps all of this in auto-compaction. When the conversation nears the auto-compact window, it summarizes older history for you. `/compact Focus on the failing tests and the files we changed` steers that summary, a `# Compact instructions` section in CLAUDE.md sets a default, and `/autocompact 500k` (or the `autoCompactWindow` setting, or `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in CI) moves the threshold anywhere from 100k to 1M tokens. When you want a fresh start rather than continuity, `/clear` is free, while `/compact` is itself a large request that reads everything it summarizes.

## Technique 4: offload durable facts to memory

Compaction is lossy by design. Anything the next phase of the task must remember exactly, like a decision, a file list, or a reproduced error, belongs outside the window. The [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) (`memory_20250818`) gives the model a file directory it can create, read and edit, which your application implements. Paired with context editing, Claude receives a warning before clearing kicks in and can write what matters to memory first:

```python
# anthropic Python SDK, memory_20250818 + context-management-2025-06-27
response = client.beta.messages.create(
    model="claude-opus-5-5",
    max_tokens=8192,
    betas=["context-management-2025-06-27"],
    tools=[{"type": "memory_20250818", "name": "memory"}, *TOOLS],
    messages=history,
    context_management={"edits": [{"type": "clear_tool_uses_20250919"}]},
)
```

Coding agents already do a low-tech version of this: a `PLAN.md`, a `progress.txt`, or a git commit per step. The principle is identical. State that survives on disk can be re-read into a fresh window in a few hundred tokens instead of being carried for the whole session.

## Technique 5: isolate noisy work in subagents

A subagent runs with its own context window. It can read 30 files, run the test suite, grep logs, and return a 400-token summary to the parent. The parent's window only grows by the summary. This is the single most effective trick for long Claude Code sessions, because verbose operations (test output, documentation fetches, log analysis) are exactly what fills a window with low-value tokens.

The trade-off is total spend. Every subagent sends its own requests, and the parent pays for re-explaining the task in the spawn prompt. Delegation pays off when the subagent's raw work is large and its useful output is small. It does not pay off for a two-file lookup. The trade-off is worked through in [nested subagent depth: when it helps and when it burns tokens](/2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens/).

## Technique 6: filter tool output before the model sees it

Every technique above deals with tokens after they have entered the window. The best fix is upstream: do not return 10,000 lines of log when the model needs the 12 that say `ERROR`. In your own tools, return summaries, paginate, and cap result size. In Claude Code, a `PreToolUse` hook can rewrite commands before they run. The cost docs show one that pipes `npm test`, `pytest` and `go test` through a failure filter:

```bash
#!/bin/bash
# ~/.claude/hooks/filter-test-output.sh, Claude Code 2.1.x PreToolUse hook on Bash
input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command')

if [[ "$cmd" =~ ^(npm test|pytest|go test) ]]; then
  filtered_cmd="$cmd 2>&1 | grep -A 5 -E '(FAIL|ERROR|error:)' | head -100"
  echo "$input" | jq --arg filtered "$filtered_cmd" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: (.tool_input + {command: $filtered})}}'
else
  echo "{}"
fi
```

A single oversized read can also trap an agent in a loop where it compacts, rereads the same giant file, and compacts again. If you have seen that, [the autocompact thrashing fix](/2026/07/fix-claude-code-autocompact-thrashing-on-large-file-or-tool-output/) walks through reading in slices and writing big output to disk.

## Gotchas that bite in production

- **Compaction and context editing do not mix on one request.** You cannot send `compaction` and `context_management` together, and threshold compaction cannot run on a request that already carries an on-demand block. Pick one compaction style per conversation.
- **The block must go first.** With on-demand compaction, the `compaction` block must be the first content in `messages`, and the messages it summarized must be gone. Leaving them in front returns `compaction_block_misplaced`. Leaving them *after* the block raises no error and silently resends them.
- **Send the block exactly as returned.** Editing its `content` or dropping its `signature` fails with `compaction_signature_invalid` or `compaction_content_mismatch`. In Python, a plain `model_dump()` adds `citations: null` and the API rejects it; use the beta client or `model_dump(exclude_none=True)`.
- **Summaries cannot carry binaries.** Images, documents, `container_upload` blocks and fetched URLs inside the summarized range are gone after compaction. Re-upload anything a later step needs.
- **Count iterations, not top-level usage.** A compaction call reports zero top-level `input_tokens` and `output_tokens`; the real cost is in `usage.iterations`. Dashboards that read only the top-level fields undercount compaction spend.
- **Kept thinking is not free.** On Opus 5.5, Sonnet 5.5 and Fable 5.1, earlier thinking blocks stay in context by default and count as input on every turn. On thinking-heavy agents, `clear_thinking_20251015` can free more space than tool clearing.
- **Context awareness depends on the model.** Sonnet 5, Sonnet 4.6, Sonnet 4.5 and Haiku 4.5 receive injected `<system_warning>Token usage: ...</system_warning>` updates after each tool call. Opus 4.7 and later, Sonnet 5.5 and Fable 5.1 do not; give them an explicit budget with task budgets if your agent needs to pace itself.

## Picking the right technique

If your agent fails or degrades on long tasks, work through this in order:

1. Run `/context` or `count_tokens` on an empty session. If fixed overhead is above 20-30k tokens, start with technique 1.
2. If most of the growth is tool results, add context editing with a sensible `clear_at_least`.
3. If the conversation itself is long, add on-demand compaction with explicit `instructions` about what to preserve.
4. If the task spans hours or sessions, add a memory tool or plan file so compaction can be lossy without losing decisions.
5. If a few operations dominate the growth, move them to subagents or filter their output at the source.

None of these makes the window larger. All of them make the same window last longer, and they compound: an agent that loads 8k tokens of tools instead of 55k, clears stale reads, and delegates its test runs can work for hours inside a window that a naive loop would exhaust before lunch.

### Read next

- [Migrate an agent from chunking-and-RAG to a 1M-token context window](/2026/08/migrate-from-rag-chunking-to-a-1m-token-context-window/) for when a bigger window really does replace a retrieval pipeline.
- [How to cache multi-turn Claude conversations across API calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/), the cost side of resending history every turn.
- [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/), for keeping always-loaded instructions short.
- [Measure an agent's fixed token overhead before the first user token](/2026/09/measure-an-agents-fixed-token-overhead-before-the-first-user-token/).

### Sources

- [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows), Claude API docs.
- [Compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction), [Compaction on demand](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand) and [Compaction at a token threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold).
- [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) and the [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool).
- [Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).
- [Manage costs effectively](https://code.claude.com/docs/en/costs) and [model configuration](https://code.claude.com/docs/en/model-config), Claude Code docs.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), Anthropic Engineering.
