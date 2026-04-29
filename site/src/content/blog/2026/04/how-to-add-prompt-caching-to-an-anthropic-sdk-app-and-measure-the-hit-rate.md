---
title: "How to Add Prompt Caching to an Anthropic SDK App and Measure the Hit Rate"
description: "Add prompt caching to a Python or TypeScript Anthropic SDK app, place cache_control breakpoints correctly, and read cache_read_input_tokens and cache_creation_input_tokens to compute a real hit rate. With pricing math for Claude Sonnet 4.6 and Opus 4.7."
pubDate: 2026-04-29
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "prompt-caching"
  - "claude-code"
---

If your Anthropic SDK app sends the same long system prompt or tool catalogue on every turn, you are paying full input price for tokens the model already saw thirty seconds ago. Prompt caching cuts those repeated tokens to **10 percent of the base input price** in exchange for a small one-time write surcharge. On a multi-turn agent loop with a 10k-token system prompt, that is a 5x to 10x cost reduction on input, with roughly 85ms shaved off latency for the cached prefix. The catch: you have to place the cache_control breakpoints in the right spots and verify the hit rate with the SDK's usage object, because a misplaced breakpoint silently degrades to a full-price call.

This guide walks through adding caching to a Python or TypeScript Anthropic SDK app on the current API (Claude Opus 4.7, Sonnet 4.6, Haiku 4.5), then measuring the actual cache hit rate with a small wrapper. Code is verified against `anthropic` 0.42 (Python) and `@anthropic-ai/sdk` 0.30 (Node), both released in early 2026.

## Why caching is non-optional for agent loops

A coding agent that iterates over a repository typically sends:

1. A 5k to 30k token system prompt (the agent's instructions, tool descriptions, file conventions).
2. A growing message history (the user's request plus prior tool calls and tool results).
3. A new user turn or tool result that triggers the next response.

Without caching, every turn re-encodes the full prefix. On Claude Sonnet 4.6 at $3/MTok input, an 8k token prefix costs $0.024 per turn. A 50-turn session is $1.20 in re-billed prefix alone, on top of the actual work. With caching the same prefix costs $0.0024 per cached turn after the first write. Same answer, ten percent of the bill.

The mechanism is described in the official [prompt caching docs](https://docs.claude.com/en/docs/build-with-claude/prompt-caching). You mark a content block with `cache_control: {"type": "ephemeral"}` and the API treats everything **before and including** that block as a cache key. On the next request, if the prefix matches byte-for-byte, the model reads from cache instead of re-encoding.

What "byte-for-byte" really means is the source of every "why isn't it caching" thread on the Anthropic forums. We will get to that.

## Versions, model IDs, and the minimum-tokens trap

Caching only kicks in when the cached prefix exceeds a per-model minimum:

- **Claude Opus 4.7 (`claude-opus-4-7`)**: 4,096 tokens minimum.
- **Claude Sonnet 4.6 (`claude-sonnet-4-6`)**: 2,048 tokens minimum.
- **Claude Haiku 4.5 (`claude-haiku-4-5`)**: 4,096 tokens minimum.
- **Older Sonnet 4.5, Opus 4.1, Sonnet 3.7**: 1,024 tokens minimum.

If your prefix is smaller than the threshold, the request still succeeds, but `cache_creation_input_tokens` comes back as 0 and you are silently paying full input price. This is the single most common reason developers report "caching does nothing." Always check the threshold for your target model first.

The `anthropic` Python SDK gained native `cache_control` support in 0.40 and tightened the typing for the usage breakdown in 0.42. The Node SDK has had it since `@anthropic-ai/sdk` 0.27. No beta header is required for either the 5-minute or the 1-hour TTL anymore: just set `ttl` inside `cache_control`.

## A minimal Python example with cache_control

The pattern below caches a long system prompt. It is the simplest and most common use case.

```python
# Python 3.11, anthropic 0.42
import anthropic

client = anthropic.Anthropic()

LONG_SYSTEM_PROMPT = open("prompts/system.md").read()  # ~8k tokens

def ask(user_message: str) -> anthropic.types.Message:
    return client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": LONG_SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_message}],
    )

first = ask("List the public methods on OrderService.")
second = ask("Now list the private ones.")

print(first.usage)
print(second.usage)
```

The `system` parameter must be an **array of content blocks** when you attach `cache_control`. Passing a plain string (the convenience form) does not allow caching: the SDK has no place to put the cache flag. This trips up everyone the first time.

The first call writes the prefix to cache. The second call reads it. The usage objects make this visible:

```
# first.usage
{ "cache_creation_input_tokens": 8137, "cache_read_input_tokens": 0,  "input_tokens": 18,  "output_tokens": 124 }
# second.usage
{ "cache_creation_input_tokens": 0,    "cache_read_input_tokens": 8137, "input_tokens": 22, "output_tokens": 156 }
```

The fields you care about:

- `cache_creation_input_tokens`: tokens written to the cache on this request, billed at 1.25x base for the 5-minute TTL or 2.0x for the 1-hour TTL.
- `cache_read_input_tokens`: tokens read from the cache, billed at 0.10x base.
- `input_tokens`: tokens **after the last cache breakpoint** that were not eligible for caching. This is the message-tail you keep changing.

## The same example in TypeScript

The Node SDK has the same shape. Note that the `system` array entries use plain object literals, not class wrappers.

```typescript
// Node 22, @anthropic-ai/sdk 0.30
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

const client = new Anthropic();
const SYSTEM = readFileSync("prompts/system.md", "utf8");

async function ask(userMessage: string) {
  return client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
  });
}

const first = await ask("List the public methods on OrderService.");
const second = await ask("Now list the private ones.");
console.log(first.usage);
console.log(second.usage);
```

Same usage breakdown, same pricing. No header gymnastics.

## Where to place cache breakpoints in an agent loop

A coding agent does not just have a long system prompt. It has a long **and growing** message history plus a static tool catalogue. The optimum is usually three or four breakpoints arranged from most-stable to most-volatile.

You get up to **4 explicit cache breakpoints** per request. The API caches everything before and including each marked block, so each breakpoint creates a layered prefix.

```python
# Python 3.11, anthropic 0.42
client.messages.create(
    model="claude-opus-4-7",
    max_tokens=2048,
    tools=[
        # ... tool schemas ...
        {
            "name": "search_repo",
            "description": "...",
            "input_schema": {"type": "object", "properties": {...}},
            "cache_control": {"type": "ephemeral"},  # breakpoint 1: tools
        },
    ],
    system=[
        {
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},  # breakpoint 2: system
        }
    ],
    messages=[
        # All prior turns...
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": stable_repo_summary,
                    "cache_control": {"type": "ephemeral"},  # breakpoint 3: repo state
                }
            ],
        },
        # ... older messages ...
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": current_user_turn,
                    "cache_control": {"type": "ephemeral"},  # breakpoint 4: most recent stable point
                }
            ],
        },
    ],
)
```

The rule is "stable on the outside, volatile on the inside." If your tool catalogue changes when a feature flag flips, that change invalidates every other layer behind it. If your system prompt embeds today's date, every cache write expires at midnight UTC. Pull anything dynamic out of the cached blocks.

## Measuring the hit rate

The vendor dashboard is good for a monthly invoice. It is not good for tuning an agent in real time. Wrap the SDK and aggregate the usage fields yourself.

```python
# Python 3.11, anthropic 0.42
from dataclasses import dataclass, field
import anthropic

@dataclass
class CacheStats:
    requests: int = 0
    base_input: int = 0          # uncached
    cache_writes_5m: int = 0
    cache_writes_1h: int = 0
    cache_reads: int = 0
    output: int = 0

    def record(self, usage):
        self.requests += 1
        self.base_input += usage.input_tokens
        self.cache_reads += usage.cache_read_input_tokens or 0
        creation = getattr(usage, "cache_creation", None)
        if creation:
            self.cache_writes_5m += creation.ephemeral_5m_input_tokens or 0
            self.cache_writes_1h += creation.ephemeral_1h_input_tokens or 0
        else:
            self.cache_writes_5m += usage.cache_creation_input_tokens or 0
        self.output += usage.output_tokens

    @property
    def hit_rate(self) -> float:
        cacheable = self.cache_reads + self.cache_writes_5m + self.cache_writes_1h
        return self.cache_reads / cacheable if cacheable else 0.0

    def cost_usd(self, base_input_per_mtok: float, output_per_mtok: float) -> float:
        # Sonnet 4.6: base_input=3.00, output=15.00
        # Opus 4.7:   base_input=15.00, output=75.00
        write_5m = self.cache_writes_5m * base_input_per_mtok * 1.25
        write_1h = self.cache_writes_1h * base_input_per_mtok * 2.0
        reads    = self.cache_reads     * base_input_per_mtok * 0.10
        base     = self.base_input      * base_input_per_mtok
        out      = self.output          * output_per_mtok
        return (write_5m + write_1h + reads + base + out) / 1_000_000

stats = CacheStats()

def cached_call(client, **kwargs):
    response = client.messages.create(**kwargs)
    stats.record(response.usage)
    return response
```

Run the agent end-to-end, then print the hit rate.

```python
print(f"requests:    {stats.requests}")
print(f"hit rate:    {stats.hit_rate:.1%}")
print(f"cache reads: {stats.cache_reads:,}")
print(f"5m writes:   {stats.cache_writes_5m:,}")
print(f"1h writes:   {stats.cache_writes_1h:,}")
print(f"uncached in: {stats.base_input:,}")
print(f"USD:         ${stats.cost_usd(3.00, 15.00):.4f}")  # Sonnet 4.6 prices
```

A healthy 50-turn coding agent on Sonnet 4.6 with an 8k system prompt typically lands at:

- 95-98% hit rate on the system prompt block.
- 70-90% hit rate on the messages block depending on how aggressively you re-prompt.
- 1.5x to 4x lower total spend than the same agent without caching.

If you see hit rate stuck at 0%, three things are almost always to blame: prefix below the minimum-tokens threshold, a non-deterministic value (timestamp, random ID, dict ordering) embedded in the cached text, or messages re-shuffled between turns.

## The 1-hour TTL: when it pays for itself

The default TTL is 5 minutes. For a chat-style agent that is fine: each turn refreshes the cache, and the small write surcharge is amortized over many reads.

The 1-hour TTL costs **2x base input** to write but lasts twelve times longer. The math: if you expect at least one read every five minutes for an hour, the 5-minute cache works. If your traffic is bursty (someone runs the agent every 20 minutes), the 5-minute cache expires between turns and you keep paying the write cost over and over. The 1-hour TTL pays for itself the moment two cache reads occur during an hour-long idle period.

```python
# Python 3.11, anthropic 0.42 -- mixing TTLs
system=[
    {
        "type": "text",
        "text": STABLE_INSTRUCTIONS,             # the bedrock part
        "cache_control": {"type": "ephemeral", "ttl": "1h"},
    },
    {
        "type": "text",
        "text": SESSION_SCOPED_CONTEXT,          # changes per user session
        "cache_control": {"type": "ephemeral", "ttl": "5m"},
    },
],
```

When mixing TTLs, longer-TTL entries must appear **before** shorter-TTL entries. If you reverse them the API rejects the request.

No beta header is required. The old `anthropic-beta: prompt-caching-2024-07-31` and the later `extended-cache-ttl-2025-04-11` headers are retired, although the SDK still accepts them as no-ops for backwards compatibility.

## Five gotchas that wreck the hit rate

**1. Embedding non-deterministic content.** A `datetime.now()` in your system prompt invalidates the cache every second. Common offenders: timestamps, request IDs, random sample data injected for diversity, JSON serialization that does not pin key order. If the bytes change, the cache misses.

**2. Re-ordering tools or messages.** The API hashes the bytes in order. Sorting your tool array differently between calls produces a different hash. Stick to a deterministic order, ideally the order from your config file.

**3. Forgetting to switch system from string to array.** `system="..."` (a plain string) accepts no `cache_control`. You must use `system=[{"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}]`. The SDK does not warn you when you pass a string with caching expectations.

**4. Crossing the 20-block lookback window.** A breakpoint can only see 20 content blocks before it. In a long tool-use loop with many tool_result blocks, your breakpoint near the head of the conversation eventually falls out of range. Add a second breakpoint closer to the current turn before that happens.

**5. Hitting the same cache from different organizations or workspaces.** Caches are isolated per organization, and as of February 2026 also per workspace on the Anthropic API and Azure. If you run dev on one workspace and prod on another, they do not share cached prefixes.

For a deeper look at what wraps the Anthropic SDK on the .NET side, see [Microsoft Agent Framework 1.0 for AI agents in C#](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) and [GitHub Copilot's BYOK support for the Anthropic provider in VS Code](/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/).

## What "automatic caching" does and why it is not enough

The recent SDK releases added a top-level `cache_control` parameter on `messages.create`. Setting it tells the API to apply caching automatically based on heuristics. It works, but it picks one breakpoint, and you cannot control where. For a single long system prompt that is fine. For an agent loop with tool catalogues, summaries, and message history you want explicit breakpoints. Automatic mode is best treated as a smoke test: turn it on once to confirm caching works in your setup, then move to explicit `cache_control` blocks.

If you are also building MCP servers that expose tools to the same agent, the layout principles are the same. See [How to build a custom MCP server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/), [How to build an MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/), and [How to build a custom MCP server in Python with the official SDK](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) for the server side. The breakpoint placement guide here applies to the client that calls them.

## A spreadsheet view of when caching pays off

For a back-of-envelope check, take the prefix size in tokens (`P`), the number of reads expected per write (`R`), and the cache TTL multiplier (`m`, where `m=1.25` for 5m and `m=2.0` for 1h). The break-even read count for a single cached prefix versus the un-cached baseline is:

```
R_breakeven = (m - 1) / (1 - 0.1)
            = (m - 1) / 0.9
```

That is **0.28 reads** for the 5-minute TTL and **1.11 reads** for the 1-hour TTL. In other words, the 5-minute cache pays off after a single read in any realistic scenario, and the 1-hour cache pays off after the second read. There is essentially no agent-loop scenario where caching is the wrong choice; the only question is which TTL to pick.

For more on agent-loop patterns that benefit from caching, see [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) and [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/).

## Reference links

- [Prompt caching documentation](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
- [Anthropic Python SDK on PyPI](https://pypi.org/project/anthropic/)
- [Anthropic TypeScript SDK on npm](https://www.npmjs.com/package/@anthropic-ai/sdk)
- [Anthropic API pricing](https://docs.claude.com/en/docs/about-claude/pricing)
