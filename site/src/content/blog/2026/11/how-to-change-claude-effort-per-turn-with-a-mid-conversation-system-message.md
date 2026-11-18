---
title: "How to Change Claude's Effort Per Turn With a Mid-Conversation System Message"
description: "Stop rewriting output_config.effort between requests. Append {\"role\": \"system\", \"content\": [], \"output_config\": {\"effort\": \"low\"}} with the mid-conversation-output-config-2026-07-01 beta and claude-opus-5-5, claude-sonnet-5-5 or claude-haiku-5-5 switches effort from the next user turn while the prompt cache and preserved thinking stay valid. Placement, persistence, errors and an agent-loop helper."
pubDate: 2026-11-18
template: "how-to"
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "prompt-caching"
  - "effort"
---

**Short answer:** keep the request's top-level `output_config.effort` exactly as it was on turn one, and append an effort-only system message to `messages`: `{"role": "system", "content": [], "output_config": {"effort": "low"}}`. Send the `mid-conversation-output-config-2026-07-01` beta header. Claude's reply to the next `user` turn with new input runs at the new level, and the level sticks until another system message changes it. Because nothing before the new message changes, the cached prefix still hits, which is the whole point: changing the top-level value between requests can invalidate the cache. It works on `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5` and the Fable/Mythos 5.1 and 5.2 models, not on Claude Fable 5, Claude Sonnet 5 or Opus 4.8. The Python below targets the `anthropic` SDK 2.10.0 (whose `BetaSystemMessageParam` type carries the `output_config` field); it was written against the documentation and the SDK's type definitions and was not executed for this post.

## Why one effort level for the whole conversation is the wrong default

Effort is the only reasoning dial left on the 5.x models. The [effort docs](https://platform.claude.com/docs/en/build-with-claude/effort) describe it as "a behavioral signal, not a strict token budget", with five levels: `low`, `medium`, `high`, `xhigh` and `max`. Most models default to `high`; Claude Opus 5.5 and Claude Haiku 5.5 default to `medium`. If you migrated an agent off `budget_tokens`, the [5.5 migration checklist](/2026/10/migrate-a-coding-agent-from-claude-sonnet-4-6-and-opus-4-7-to-the-5-5-model-family/) already told you to set the value explicitly on every route.

The problem is that a conversation is not one kind of work. A coding agent might spend its first turn planning a schema migration (worth `high` or `xhigh`), then twenty turns answering "now rename that column" or "summarize what you did" (fine at `low`). A support assistant might need `max` for the one turn where the user pastes a stack trace and `low` for every "thanks, and how do I log out?" afterwards.

Paying `high` effort for the cheap turns wastes output tokens and latency. The obvious fix, flipping `output_config.effort` on the next request, has a cost of its own. The effort docs say a change to the top-level value "can invalidate cached prefixes from earlier turns", and the [per-message effort page](https://platform.claude.com/docs/en/build-with-claude/effort-per-message) is blunter: "A top-level change can invalidate all or part of the cache." For an agent carrying 200k tokens of history, one cache miss can cost more than the effort savings of the next ten turns. On Claude Fable 5.1 the same page adds that a top-level change "steers the model less reliably" than the per-message route.

## The request shape

A mid-conversation system message is an entry in `messages` with `role: "system"`. The [mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages) feature was introduced for changed instructions and tool changes (the [tool-change variant](/2026/11/add-a-tool-mid-conversation-without-breaking-the-claude-prompt-cache/) uses `tool_addition` and `tool_removal` blocks). Effort is not a content block. It is an `output_config` object on the message itself, next to `role` and `content`:

```json
{"role": "system", "content": [], "output_config": {"effort": "low"}}
```

The SDK's type definition makes the scope explicit. In `anthropic` 2.10.0, `BetaSystemMessageOutputConfigParam` has exactly one field, `effort`, typed as `Literal["low", "medium", "high", "xhigh", "max"]`, and its docstring reads: "Fields here apply per-turn; `format` remains top-level only." So structured output format stays on the request; only effort moves into the conversation. Two other details from the same type: a message with neither content nor `output_config` fields is rejected, and an empty `{}` is accepted on a message that carries content.

Here is the minimal two-turn request, adapted from the documentation's example:

```python
# anthropic==2.10.0, beta mid-conversation-output-config-2026-07-01
import anthropic

client = anthropic.Anthropic()

response = client.beta.messages.create(
    model="claude-opus-5-5",
    max_tokens=4096,
    output_config={"effort": "high"},  # request-level value: never change it later
    messages=[
        {"role": "user", "content": "Plan a migration from SQLite to PostgreSQL in three short steps."},
        {
            "role": "assistant",
            "content": "1. Export the SQLite data. 2. Create the PostgreSQL schema. 3. Import the data and verify row counts.",
        },
        # Effort-only system message: the reply to the next user turn runs at low.
        {"role": "system", "content": [], "output_config": {"effort": "low"}},
        {"role": "user", "content": "Summarize the plan in one sentence."},
    ],
    betas=["mid-conversation-output-config-2026-07-01"],
)

for block in response.content:
    if block.type == "text":
        print(block.text)
```

The TypeScript shape is identical with `@anthropic-ai/sdk`:

```typescript
// @anthropic-ai/sdk 1.10.0, beta mid-conversation-output-config-2026-07-01
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const response = await client.beta.messages.create({
  model: "claude-sonnet-5-5",
  max_tokens: 8192,
  output_config: { effort: "high" },
  messages: [
    { role: "user", content: "Why does this test deadlock? <paste>" },
    { role: "assistant", content: "The lock is taken twice on the same thread because..." },
    { role: "system", content: [], output_config: { effort: "low" } },
    { role: "user", content: "Write the commit message for that fix." },
  ],
  betas: ["mid-conversation-output-config-2026-07-01"],
});
```

On Amazon Bedrock `InvokeModel` the header goes into the `anthropic_beta` array in the request body instead of an HTTP header. Claude Managed Agents do not support per-message effort at all; the docs point to a session model override there.

## When the new level takes effect, and how long it lasts

Two rules from the per-message page decide everything:

1. **Position decides the first turn at the new level.** If the effort message sits directly after a `user` turn with new input, Claude's reply to that turn already uses the new level. In any other position, the new level starts at the next `user` turn with new input.
2. **The level persists.** "The new level stays in effect until a later message changes it." It is not a one-turn override.

The phrase "new input" matters in an agent loop. A `user` message that contains only `tool_result` blocks does not count. If you append an effort change after a tool result, the model finishes the current tool loop at the old level and switches when the human (or your orchestrator) sends the next real prompt. That is usually what you want: a task that started at `high` should not lose reasoning depth halfway through its tool calls.

The effort-only message can also be the first entry in `messages`, which is a way to start a conversation at a level different from the top-level value. That is unusual, but it means one request-level config can serve several routes that open at different levels.

Persistence has a consequence for how you think about the top-level field. Once a conversation contains an effort message, the top-level `output_config.effort` only describes the turns before the first change. The docs do not spell out a precedence table, but their example (top-level `high`, system `low`, next reply at `low`) and the persistence rule together mean the latest effort message in the array wins for every later turn.

## An agent-loop helper that only ever appends

The rule that keeps the cache valid is append-only. From the docs: "Put the message after everything you've already sent, and keep it in place on later requests. Don't insert it before turns you've already sent, and don't move or remove it later." A helper that enforces this is short:

```python
# anthropic==2.10.0, claude-sonnet-5-5 with adaptive thinking
import anthropic

client = anthropic.Anthropic()
BETAS = ["mid-conversation-output-config-2026-07-01"]
BASE_EFFORT = "high"  # sent on every request, forever


class Conversation:
    def __init__(self, system_prompt: str):
        self.system = system_prompt
        self.messages: list[dict] = []
        self.current_effort = BASE_EFFORT

    def set_effort(self, level: str) -> None:
        if level == self.current_effort:
            return  # a no-op change would still add a message; skip it
        # Append only: never insert, move or delete an effort message once sent.
        self.messages.append({"role": "system", "content": [], "output_config": {"effort": level}})
        self.current_effort = level

    def ask(self, text: str) -> str:
        self.messages.append({"role": "user", "content": text})
        resp = client.beta.messages.create(
            model="claude-sonnet-5-5",
            max_tokens=16000,
            system=self.system,
            output_config={"effort": BASE_EFFORT},
            messages=self.messages,
            betas=BETAS,
        )
        # Keep thinking blocks untouched: preserved thinking depends on it.
        self.messages.append({"role": "assistant", "content": resp.content})
        u = resp.usage
        print(f"effort={self.current_effort} cache_read={u.cache_read_input_tokens} "
              f"cache_write={u.cache_creation_input_tokens} out={u.output_tokens}")
        return "".join(b.text for b in resp.content if b.type == "text")


conv = Conversation("You are a senior reviewer for a Python monorepo.")
conv.ask("Review this diff for concurrency bugs: <diff>")       # high
conv.set_effort("low")
conv.ask("Turn your findings into a three-line PR comment.")      # low
conv.set_effort("xhigh")
conv.ask("The CI log shows a new deadlock. Here is the trace: <trace>")  # xhigh
```

The `print` line is the part worth keeping in production. If you already [measure your cache hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/), an effort change done this way should look like any other turn: `cache_read_input_tokens` close to the previous request's prompt size and a small `cache_creation_input_tokens`. If the read collapses to zero right after a level change, something before the tail changed, and the [`diagnostics` request object](/2026/11/how-to-find-out-why-a-claude-prompt-cache-missed-with-diagnostics/) will tell you which part.

Note that the helper never touches `BASE_EFFORT`. That constant is part of the cached request config; treat it like the `tools` array.

## Picking the level per turn

The API gives you the mechanism; the policy is yours. A few routing rules that follow from what effort actually controls:

- **Route on the kind of turn, not on its length.** A one-line "the test still fails" can be the hardest turn in the session. Classify by intent: planning, debugging and review get `high` or above; formatting, summarizing, renaming and confirmations get `low`.
- **Raise before the hard turn, lower after it.** Because an effort message placed right after a `user` turn applies to that turn's reply, you can classify the incoming prompt first, then append the user message and the effort change in that order before calling the API.
- **Do not drop below the model's floor for tool-heavy work.** At `low`, the model makes fewer tool calls and stops sooner. That is fine for a summary, risky for "fix the build".
- **Use `xhigh` and `max` sparingly, and raise `max_tokens` with them.** The effort docs recommend a large `max_tokens` at `high` and above because it is a hard cap on thinking plus text. `xhigh` is not available on every model that has `max` (Sonnet 4.6 and Opus 4.6 lack it, but they also lack per-message effort).

If the cheap turns are cheap enough to go to a smaller model entirely, effort is the wrong tool and a subagent is the right one; the [Haiku 5.5 vs Sonnet 5.5 vs Opus 5.5 comparison](/2026/10/claude-haiku-5-5-vs-sonnet-5-5-vs-opus-5-5-for-coding-agent-subagents/) covers that split. Per-message effort is for when the conversation context itself is what makes the cheap turn correct.

## Gotchas and the errors they produce

**Missing beta header.** Without `mid-conversation-output-config-2026-07-01`, the API rejects the field with a 400: `messages.N.output_config: Extra inputs are not permitted`, where `N` is the index of the system message. If you are building `betas` from config, a dropped header shows up exactly like this.

**Unsupported model.** With the header present but a model that cannot vary effort per turn (Claude Fable 5, for example), the 400 reads `output_config.effort requires a model that supports per-turn effort; this model does not`. On Bedrock those models, and also Claude Opus 5, return `Extra inputs are not permitted` instead, so do not branch on the message text alone.

**Thinking modes that pin effort.** Claude Sonnet 5.5 with `thinking: {"type": "between_tools"}` and Claude Haiku 5.5 with `thinking: {"type": "disabled"}` reject a per-message change to a different level with a 400. The docs' advice is to use adaptive thinking on any route where you want to vary effort per turn. Opus 5.5 rejects disabled thinking at every effort level anyway.

**`adaptive` is not an effort level.** It is a thinking mode. Passing `"effort": "adaptive"` is invalid at both the top level and the message level.

**Preserved thinking breaks if you edit history.** On models with preserved thinking, moving, removing or inserting an effort message "invalidates the thinking blocks in the `assistant` turns after the message". Depending on your `prefix_mismatch_behavior` setting, that is either silent stripping or a 400 on the next request. This is the same failure mode as editing `tools` mid-session: append, never rewrite.

**Turn-scoped messages cannot carry effort.** The `clear_at: "next_user_message"` option (beta `mid-conversation-system-clear-at-2026-08-21`) makes a system message's text visible for one turn only. It does not combine with effort: the API returns `output_config is not permitted on a turn-scoped system message (clear_at: 'next_user_message')`. Effort is persistent by design, so a "just this turn" bump is two messages: one raising the level before the turn and one lowering it after.

**Mixing effort with text instructions.** A system message can carry both `content` (a string or `text` blocks) and `output_config`. When it does, it follows the stricter placement rules for content-carrying system messages: it cannot be the first entry in `messages`, and it cannot sit between a `tool_use` and its `tool_result`. An effort-only message (empty `content`) is the most permissive form; keep effort changes in their own message unless you are also changing instructions at the same point.

**Compaction.** If you compact history, the effort messages inside the summarized span disappear with it. After the compaction block, re-append the current level as a fresh effort message, or the conversation silently falls back to the top-level value. The [on-demand compaction walkthrough](/2026/11/how-to-keep-a-long-claude-agent-loop-under-the-context-limit-with-on-demand-compaction/) shows where to cut so the rest of the loop stays valid; the same "re-apply current state after the cut" rule covers tool changes too.

**Sonnet 5.5 and Haiku 5.5 after tool results.** The mid-conversation docs note that on these two models a content-carrying system message placed right after a tool result may be ignored, and suggest putting the user's text as a `text` block after the last `tool_result` instead. That caveat is about text instructions; for effort, the "new input" rule already means a change after a tool result waits for the next real user turn.

## Checking that the level actually changed

There is no response field that echoes the effort level, so verify indirectly. Run the same short prompt twice in a fixed conversation, once after a `low` message and once after a `max` message, and compare `usage.output_tokens`: thinking tokens are billed as output, and the gap between the two runs should be large on any prompt that invites reasoning. Combine that with the cache check above (`cache_read_input_tokens` steady across the change) and you have proof of both halves: the level moved, and the cache did not.

The feature is still a beta, so pin the header string in one place and re-read the [per-message effort page](https://platform.claude.com/docs/en/build-with-claude/effort-per-message) before relying on the model list in production.

### Read next

- [Migrate a coding agent from Claude Sonnet 4.6 and Opus 4.7 to the 5.5 model family](/2026/10/migrate-a-coding-agent-from-claude-sonnet-4-6-and-opus-4-7-to-the-5-5-model-family/)
- [How to add or change a tool mid-conversation without invalidating the Claude prompt cache](/2026/11/add-a-tool-mid-conversation-without-breaking-the-claude-prompt-cache/)
- [How to find out why a Claude API prompt cache missed with `diagnostics`](/2026/11/how-to-find-out-why-a-claude-prompt-cache-missed-with-diagnostics/)
- [Claude Haiku 5.5 vs Sonnet 5.5 vs Opus 5.5 for coding agent subagents](/2026/10/claude-haiku-5-5-vs-sonnet-5-5-vs-opus-5-5-for-coding-agent-subagents/)

### Sources

- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) (levels, defaults, `max_tokens` guidance)
- [Per-message effort](https://platform.claude.com/docs/en/build-with-claude/effort-per-message) (request shape, placement, persistence, errors, supported models)
- [Mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages) (content placement rules, `clear_at`, tool changes)
- [Preserved thinking: prefix checks](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking/prefix-checks#mismatch-behavior)
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [`anthropic` 2.10.0 on PyPI](https://pypi.org/project/anthropic/2.10.0/) (`BetaSystemMessageParam`, `BetaSystemMessageOutputConfigParam`)
