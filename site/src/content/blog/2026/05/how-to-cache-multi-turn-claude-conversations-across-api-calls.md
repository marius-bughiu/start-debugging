---
title: "How to Cache Multi-Turn Claude Conversations Across API Calls"
description: "Place rolling cache_control breakpoints across messages, respect the 20-block lookback, and refresh the 5-minute TTL automatically so a 50-turn agent loop pays the prefix once, not fifty times. Verified against anthropic 0.42 (Python) and @anthropic-ai/sdk 0.30 (Node) in May 2026."
pubDate: 2026-05-12
tags:
  - "llm"
  - "ai-agents"
  - "claude-code"
  - "prompt-caching"
  - "anthropic-sdk"
---

A single `cache_control` breakpoint on a long system prompt is the easy 80 percent of prompt caching. The harder 20 percent is the part that actually decides whether your agent loop is affordable: caching the **conversation history** itself, so that turn 12 doesn't re-bill the eleven turns that came before it. That requires rolling breakpoints, respect for the 20-block lookback window, and a clear story about when the 5-minute TTL refreshes. Get it wrong and `cache_creation_input_tokens` quietly climbs every turn while `cache_read_input_tokens` stays flat -- a silent regression that only shows up in the bill.

This post is the multi-turn follow-up to [adding prompt caching to an Anthropic SDK app and measuring the hit rate](https://startdebugging.net/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/). Code is verified against `anthropic` 0.42 (Python) and `@anthropic-ai/sdk` 0.30 (Node), targeting the current API (Claude Opus 4.7, Sonnet 4.6, Haiku 4.5) on 2026-05-12.

## What "multi-turn" actually charges you for

A multi-turn loop sends one request per turn, and each request is a complete replay of the conversation so far. Without caching, the API re-encodes the entire prefix every time. With a single breakpoint on the system prompt, you cache the system prefix but still pay full input price for every prior `user` and `assistant` block. That is the trap: a coding agent's system prompt is usually 4k to 10k tokens, but by turn 20 the message history can be 60k tokens and growing.

The correct mental model: a `cache_control` breakpoint marks a position in the request. Everything **at or before** that position becomes a single cache entry, keyed by the byte-exact content. On the next request, if the same prefix appears, the API serves it as `cache_read_input_tokens` at 10 percent of the base input price instead of re-encoding it. The official [prompt caching docs](https://docs.claude.com/en/docs/build-with-claude/prompt-caching) spell out the contract, but they leave the per-turn placement strategy as an exercise.

The breakpoint you placed on turn 1 keeps paying off only if turn 2 puts another breakpoint **further down**, covering the new content. If you don't, turn 2 re-uses the turn-1 cache for the system prefix, but the new assistant reply and user message at the end of turn 2 are billed at full price, and they will be billed at full price again on turn 3, and again on turn 4. The breakpoint has to roll.

## The 4-breakpoint limit and the 20-block lookback

The API permits up to **4 explicit `cache_control` breakpoints per request**. That is not a soft hint, it is a hard schema limit. The naive "add one breakpoint per turn" approach hits the wall on turn 5.

The second constraint is subtler: a breakpoint's cache lookup only checks **20 content blocks backward** from its position. If a prior write landed more than 20 blocks earlier in the request, the lookup misses it, even though the bytes are identical. In an agent loop that emits a `tool_use` block, a `tool_result` block, and a short assistant reply per turn, you cross the 20-block boundary in about 6 to 7 turns. After that, a single rolling breakpoint at the tail of the conversation can no longer find the cache entry written at the head, so the system prompt gets rewritten -- billed at the 1.25x cache-write premium -- on every turn.

The combined picture: you have at most 4 breakpoints, and each breakpoint can only look 20 blocks back. The strategy that survives a long loop uses **breakpoints in pairs**: one stable anchor near the top of the request (system prompt plus tools), and one moving cursor near the tail. As the tail breakpoint walks forward, you periodically re-anchor a middle breakpoint so the 20-block window never gaps.

## The minimum pattern: two breakpoints, one stable, one rolling

For the majority of agent loops, two breakpoints is enough. Place one on the last block of the system + tools prefix (this is the part that never changes between turns), and place another on the last `user` or `tool_result` block of the most recent turn. Every turn, the second breakpoint moves forward.

```python
# Python 3.11, anthropic 0.42
import anthropic

client = anthropic.Anthropic()

SYSTEM = open("prompts/agent_system.md").read()  # ~8k tokens

def build_request(messages: list[dict]) -> dict:
    # Anchor: cache the system prompt prefix (changes only when you edit prompts/).
    system = [
        {
            "type": "text",
            "text": SYSTEM,
            "cache_control": {"type": "ephemeral"},
        }
    ]

    # Rolling: cache the conversation up to and including the last message.
    rolled = [dict(m) for m in messages]
    last = rolled[-1]
    if isinstance(last["content"], str):
        last["content"] = [{"type": "text", "text": last["content"]}]
    last["content"][-1]["cache_control"] = {"type": "ephemeral"}

    return {
        "model": "claude-sonnet-4-6",
        "max_tokens": 1024,
        "system": system,
        "messages": rolled,
    }

def ask(history: list[dict], user_text: str) -> tuple[str, dict]:
    history.append({"role": "user", "content": user_text})
    resp = client.messages.create(**build_request(history))
    history.append({"role": "assistant", "content": resp.content[0].text})
    return resp.content[0].text, resp.usage.model_dump()
```

After the first call, `usage` shows `cache_creation_input_tokens` covering the system prompt plus the first user message. On the second call, that same prefix comes back as `cache_read_input_tokens`, and `cache_creation_input_tokens` covers only the assistant reply from turn 1 plus the new user message from turn 2. That is the rolling pattern working correctly: each turn pays a small write for the new tail, then reads everything before it from cache.

The Node equivalent is structurally identical -- the SDK exposes `cache_control` at the block level on both `system` array entries and `content` array entries:

```typescript
// @anthropic-ai/sdk 0.30, Node 22
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const SYSTEM = await Bun.file("prompts/agent_system.md").text(); // ~8k tokens

function buildRequest(messages: Anthropic.MessageParam[]) {
  const rolled = messages.map((m) => ({ ...m, content: structuredClone(m.content) }));
  const last = rolled[rolled.length - 1];
  const content = Array.isArray(last.content)
    ? last.content
    : [{ type: "text" as const, text: last.content }];
  // Stamp the rolling breakpoint on the final block.
  content[content.length - 1] = {
    ...content[content.length - 1],
    cache_control: { type: "ephemeral" },
  };
  last.content = content;

  return {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [{ type: "text" as const, text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: rolled,
  };
}
```

This is the configuration that takes a 50-turn coding session from "expensive" to "barely noticeable on the bill" without any model behaviour change. The model sees the exact same input it would have seen without caching; the only difference is how Anthropic accounts for the tokens.

## Why two breakpoints stop being enough around turn 7

The 20-block lookback is what eventually breaks the two-breakpoint setup. Count the content blocks in a realistic agent turn: an assistant message often emits one `text` block and one or more `tool_use` blocks, and the following user turn emits one `tool_result` block per tool call. Three blocks per turn is a conservative average; tool-heavy turns can easily emit five or six.

By turn 7, the tail of the conversation is roughly 20 blocks past the system prompt anchor. The breakpoint on turn 7's last message looks back 20 blocks and finds the cache entry from turn 6. Good. By turn 8, the same lookup looks back 20 blocks and finds turn 7. Still good. But the anchor at the top -- the system + tools prefix -- is now 24 blocks back from the rolling breakpoint. The rolling breakpoint can no longer locate it. The system prefix gets rewritten as a fresh cache entry, billed at the 1.25x write premium.

This is the regression that hides from you: cache reads still happen for the **recent** history, so `cache_read_input_tokens` looks healthy, but `cache_creation_input_tokens` quietly inflates by ~8k tokens every turn. Multiply that by the 1.25x write surcharge and a 50-turn session and you have wasted the bulk of the savings you thought caching gave you.

The fix is a third breakpoint, placed mid-history, as a stepping stone:

```python
def build_request_with_midpoint(messages: list[dict]) -> dict:
    system = [
        {"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}
    ]

    rolled = [dict(m) for m in messages]
    n = len(rolled)

    # Midpoint anchor: lock a breakpoint roughly halfway, so the rolling tail
    # never has to look more than ~10 blocks back to find a write.
    if n >= 6:
        mid = n // 2
        _stamp_cache_control(rolled[mid])

    # Rolling tail.
    _stamp_cache_control(rolled[-1])

    return {
        "model": "claude-sonnet-4-6",
        "max_tokens": 1024,
        "system": system,
        "messages": rolled,
    }

def _stamp_cache_control(message: dict) -> None:
    content = message["content"]
    if isinstance(content, str):
        message["content"] = [{"type": "text", "text": content}]
        content = message["content"]
    content[-1]["cache_control"] = {"type": "ephemeral"}
```

Three of four breakpoints used, with the fourth held in reserve. The midpoint should advance in jumps, not on every turn -- if it advances every turn, you spend breakpoints rewriting cache entries you'd rather just read. A reasonable cadence is to advance the midpoint every 5 to 8 turns, which keeps the lookback window comfortably under 20 blocks at both the head and the tail.

## TTL refresh: the 5-minute clock is your friend

Each cached prefix has a Time-To-Live: **5 minutes by default**, **1 hour optional**. The crucial property is that the TTL **resets every time you read the cache**. As long as your agent makes a request within 5 minutes of the last one, the cached prefix stays alive indefinitely. A coding agent that fires a tool call every 20 to 60 seconds will keep the cache hot for free.

The 1-hour TTL costs more to write (2x base input, versus 1.25x for the 5-minute version) and is only worth it when:

- The gap between turns reliably exceeds 5 minutes (a chat UI where users come back after lunch).
- Your latency budget can't absorb the occasional re-encoding from a missed 5-minute window.
- You're using long-tail context (large RAG corpora) that you want to keep warm across sessions.

```python
# Two-tier TTL: long-tail system prompt on 1h, rolling tail on 5m.
system = [
    {
        "type": "text",
        "text": SYSTEM,
        "cache_control": {"type": "ephemeral", "ttl": "1h"},
    }
]
```

Mixing TTLs has a rule worth memorising: **longer-TTL breakpoints must appear before shorter-TTL breakpoints in the request**. The 1-hour anchor goes on the system prompt; the 5-minute rollers go on the message history. The reverse layout silently degrades to all-5m pricing.

## What invalidates a cached prefix in a multi-turn loop

The cache key is byte-exact. The hierarchy goes `tools` -> `system` -> `messages`, and a change at any level invalidates that level and everything below it. In a multi-turn agent loop, three categories of bug routinely shred the cache without obvious symptoms:

1. **Tool definitions reordered or mutated**. If you sort tools dictionary-wise in one place and list-wise somewhere else, two otherwise-identical turns produce different `tools` JSON, and the entire cache invalidates. Freeze the tool order in a constant.
2. **System prompt with a timestamp**. Embedding "Current time: 2026-05-12T14:33:01Z" in the system block guarantees every request is a cache miss. Move per-request context to a `user` message at the end of the history, behind the breakpoints.
3. **Tool results with non-deterministic ordering**. Parallel tool calls return in nondeterministic order. If you append `tool_result` blocks in arrival order rather than `tool_use_id` order, two replays of the same turn can differ. Sort on a stable key before appending. The same goes for streaming tool calls -- accumulate into a deterministic structure before serialising back into the request.

A cheap diagnostic: log `usage.cache_read_input_tokens` after every call. If it drops from "most of the prefix" to "zero" between two consecutive turns, something upstream of your earliest breakpoint changed. Bisect by hashing the serialised request before each call.

If you are wrapping the SDK from .NET, the same accounting fields show up on the Anthropic provider in [Microsoft.Extensions.AI's tool-calling chat client](https://startdebugging.net/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/) -- the `Usage` property carries `cache_read_input_tokens` and `cache_creation_input_tokens` straight through.

## Measuring the savings without trusting the bill

The fast feedback loop is to compute the hit rate from `usage` rather than waiting for the monthly invoice. After each call:

```python
def hit_rate(u: dict) -> float:
    read = u.get("cache_read_input_tokens", 0) or 0
    write = u.get("cache_creation_input_tokens", 0) or 0
    fresh = u.get("input_tokens", 0) or 0
    total = read + write + fresh
    return read / total if total else 0.0
```

A well-tuned rolling cache on a 30-turn coding session typically sits at 90 to 97 percent hit rate from turn 3 onward. Anything under 70 percent on a steady-state agent loop is a bug -- usually one of the three invalidation patterns above.

For cost math: a cache **read** is 0.1x base input, a 5-minute cache **write** is 1.25x, a 1-hour cache write is 2x, and fresh input is 1x. On Claude Sonnet 4.6 at $3 / MTok input, a 60k-token cached prefix that would have cost $0.18 per turn at full price costs $0.018 per turn on a cache read, plus the one-time $0.0024 write surcharge on the new tail. That is the bill that lets a long-running coding agent stay cheap.

## Related reading

- [How to add prompt caching to an Anthropic SDK app and measure the hit rate](https://startdebugging.net/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/) -- the single-breakpoint baseline this post extends.
- [How to call the Claude API from a .NET 11 minimal API with streaming](https://startdebugging.net/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/) -- where to plug the `cache_control` blocks if you are wiring this from C#.
- [How to write a CLAUDE.md that actually changes model behaviour](https://startdebugging.net/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) -- the prompt that gets cached should also be a prompt worth caching.
- [How to run Claude Code in a GitHub Action for autonomous PR review](https://startdebugging.net/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/) -- a real multi-turn loop where this pattern actually moves the bill.
- [How to schedule a recurring Claude Code task that triages GitHub issues](https://startdebugging.net/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) -- short-lived loops that benefit most from the 5-minute TTL refresh.

## Source links

- Anthropic, [Prompt caching reference](https://docs.claude.com/en/docs/build-with-claude/prompt-caching).
- Anthropic, [`anthropic` Python SDK on PyPI](https://pypi.org/project/anthropic/).
- Anthropic, [`@anthropic-ai/sdk` on npm](https://www.npmjs.com/package/@anthropic-ai/sdk).
- Anthropic, [Pricing](https://www.anthropic.com/pricing).
- Anthropic, [Claude cookbooks: prompt caching notebook](https://github.com/anthropics/anthropic-cookbook/blob/main/misc/prompt_caching.ipynb).
