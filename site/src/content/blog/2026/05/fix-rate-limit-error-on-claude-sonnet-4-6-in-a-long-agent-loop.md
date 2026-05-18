---
title: "Fix: rate_limit_error on Claude Sonnet 4.6 in a Long Agent Loop"
description: "A 429 rate_limit_error on claude-sonnet-4-6 in a long agent loop is almost always ITPM, not RPM. Read retry-after, cache the system prompt, and gate on anthropic-ratelimit-input-tokens-remaining. Step-by-step fix with code."
pubDate: 2026-05-18
template: error-page
tags:
  - "errors"
  - "ai-agents"
  - "llm"
  - "claude-code"
  - "anthropic-sdk"
  - "prompt-caching"
---

Your agent loop has been running for forty minutes against `claude-sonnet-4-6`, somewhere on turn fifteen it dies with HTTP 429 and `"type": "rate_limit_error"`. The fix is rarely "wait longer" and almost never "ask for a tier upgrade". On Sonnet 4.x the binding limit in a long loop is ITPM (input tokens per minute), not RPM, because every turn re-sends the system prompt, the tool definitions, and the conversation history. Read the `retry-after` header, sleep exactly that many seconds, then cache the bulk of your input with a `cache_control` breakpoint so `cache_read_input_tokens` stops counting against your ITPM. That single change typically reclaims a 5x to 10x throughput multiplier on Sonnet 4.x.

Tested against the Anthropic Messages API on 2026-05-18 with `claude-sonnet-4-6` and `claude-opus-4-7`, `anthropic` Python SDK `0.42.x`, `@anthropic-ai/sdk` `0.30.x`, and the [Anthropic rate limits documentation](https://platform.claude.com/docs/en/api/rate-limits) and [errors reference](https://platform.claude.com/docs/en/api/errors).

## TL;DR

1. The error type is `rate_limit_error`. If you see `overloaded_error`, that's HTTP 529, a different class, and the fix is jittered retry, not caching.
2. Read `retry-after` from the response headers. Sleep for exactly that many seconds. Do not invent your own backoff.
3. Inspect `anthropic-ratelimit-input-tokens-remaining` and `anthropic-ratelimit-output-tokens-remaining` on every success too, not just on 429. Gate the next request so you never push the bucket below the next turn's estimated cost.
4. Add `cache_control: { type: "ephemeral" }` to the system prompt and to the tool block. On non-Haiku-3.5 models, `cache_read_input_tokens` does not count toward ITPM. A 20-turn loop with an 18k-token system prompt drops from 360k ITPM to roughly 18k ITPM.
5. If you're on Tier 1 (50 RPM, 30,000 ITPM, 8,000 OTPM for Sonnet 4.x), the limit is genuinely small and you will hit it. Cache first, then escalate the tier.

## The error in context

A canonical 429 from a long agent loop, captured verbatim from the Anthropic Python SDK:

```text
anthropic.RateLimitError: Error code: 429 - {
  "type": "error",
  "error": {
    "type": "rate_limit_error",
    "message": "Number of input tokens has exceeded the per-minute rate limit. Please reduce the rate at which you send tokens, or contact us to discuss your use case."
  },
  "request_id": "req_011CSHoEeqs5C35K2UUqR7Fy"
}
```

The response headers are where the answer lives:

```text
retry-after: 23
anthropic-ratelimit-requests-limit: 1000
anthropic-ratelimit-requests-remaining: 994
anthropic-ratelimit-requests-reset: 2026-05-18T11:42:16Z
anthropic-ratelimit-input-tokens-limit: 450000
anthropic-ratelimit-input-tokens-remaining: 0
anthropic-ratelimit-input-tokens-reset: 2026-05-18T11:42:18Z
anthropic-ratelimit-output-tokens-limit: 90000
anthropic-ratelimit-output-tokens-remaining: 14000
anthropic-ratelimit-output-tokens-reset: 2026-05-18T11:42:17Z
```

In this Tier 2 example the RPM bucket is barely touched (994/1000 left) and OTPM is fine (14k/90k left). What pushed the request over the edge is the input token bucket: `anthropic-ratelimit-input-tokens-remaining: 0`. That is the signature of a long loop without prompt caching.

The `error.message` text varies based on which of the three buckets (RPM, ITPM, OTPM) was breached. The `error.type` is always `rate_limit_error`. The HTTP status is always 429. Do not key your retry logic on the message string.

## Why this happens

A long agent loop sends the same prefix on every turn. On turn 20 of a tool-using session the request body typically looks like:

* System prompt (12k tokens of guidance and policy).
* Tool definitions (6k tokens of JSON schemas for, say, 30 tools).
* Conversation history (1k to 4k tokens of prior user, assistant, and tool turns).
* The current user turn or the next tool result (a few hundred tokens).

That is roughly 22k tokens going in, every turn. On Tier 2 Sonnet 4.x (450,000 ITPM) you can run 20 such turns per minute without trouble. On Tier 1 (30,000 ITPM) you exhaust the bucket on the second turn.

Two more factors compound the problem on Sonnet 4.x specifically:

1. The Sonnet 4.x rate limit is shared across `claude-sonnet-4-6`, `claude-sonnet-4-5`, and `claude-sonnet-4`. If a second process in your org is hitting Sonnet 4.5, it counts against the same bucket. The official docs spell this out: "Sonnet 4.x rate limit is a total limit that applies to combined traffic across Sonnet 4.6, Sonnet 4.5, and Sonnet 4."
2. The API uses a [token bucket](https://en.wikipedia.org/wiki/Token_bucket), not a fixed 60-second window. Capacity refills continuously, so a 60-RPM limit is enforced closer to "1 RPS with a small burst". A loop that fires three turns in 800ms can 429 even if the per-minute average is fine. The docs call this out: "you might hit rate limits over shorter time intervals".

There is also a third, less common cause: acceleration limits. If your org's usage jumps sharply versus its baseline, the API can 429 you on traffic patterns alone, not absolute numbers. The remedy is to ramp gradually.

## Minimal repro

A 25-turn loop on Tier 1, no caching, that reliably 429s within the first minute:

```python
# Python, anthropic 0.42.x, model claude-sonnet-4-6, Tier 1
import os, anthropic

client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
SYSTEM = "You are a senior code reviewer.\n" + ("Style rule. " * 1500)  # ~12k tokens

history = [{"role": "user", "content": "Review the next 25 snippets one at a time."}]

for i in range(25):
    resp = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=512,
        system=SYSTEM,
        messages=history,
    )
    history.append({"role": "assistant", "content": resp.content})
    history.append({"role": "user", "content": f"Snippet {i}: def f(): pass"})
```

Each turn ships the 12k-token system plus a growing history. By turn three you are over the Tier 1 30k ITPM ceiling and the next call throws `anthropic.RateLimitError`.

## Fix, in detail

In recommended order, with rationale for each.

### 1. Honour `retry-after` instead of inventing backoff

The first mistake most agent harnesses make is a fixed `time.sleep(60)` on 429. The API tells you exactly how long to wait. Read it.

```python
# Python, anthropic 0.42.x
import time, anthropic

def with_retry(call):
    while True:
        try:
            return call()
        except anthropic.RateLimitError as e:
            wait = int(e.response.headers.get("retry-after", "5"))
            time.sleep(wait)
        except anthropic.APIStatusError as e:
            if e.status_code == 529:  # overloaded_error, not a rate limit
                time.sleep(2 + (0.5 * (time.time() % 1)))  # short jitter
                continue
            raise
```

Note that 529 `overloaded_error` is a temporary global condition, not a per-org rate limit. It deserves a different policy: short, jittered retry, with a low max attempt count. Mixing the two is why a lot of agent loops grind for hours when the API recovers in seconds.

### 2. Cache the system prompt and tool definitions

This is the change that actually fixes long loops on Sonnet 4.x. The Anthropic docs are explicit: on all current models except Claude Haiku 3.5, `cache_read_input_tokens` does not count toward your ITPM limit. With an 80% cache hit rate, a 2,000,000 ITPM Tier 4 effectively lets through 10,000,000 input tokens per minute.

```python
# Python, anthropic 0.42.x, claude-sonnet-4-6
resp = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=512,
    system=[
        {
            "type": "text",
            "text": SYSTEM,
            "cache_control": {"type": "ephemeral"},
        }
    ],
    tools=[
        {
            "name": "read_file",
            "description": "...",
            "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}},
            "cache_control": {"type": "ephemeral"},
        }
    ],
    messages=history,
)
print(resp.usage)
# Usage(input_tokens=120, cache_creation_input_tokens=18043,
#       cache_read_input_tokens=0, output_tokens=180)
```

The first call writes to the cache. `cache_creation_input_tokens` (18,043 in the snippet) still counts toward ITPM on that one request. Every subsequent call within the cache TTL hits `cache_read_input_tokens` instead, which does not count. From turn two onward, your `input_tokens` field reflects only what changed: the delta on `messages` since the last breakpoint.

Watch out for the `input_tokens` field. The docs are explicit: "the `input_tokens` field only represents tokens that appear after your last cache breakpoint, not all input tokens in your request." A 200,000-token cached doc with a 50-token question shows `input_tokens: 50`. Do not mistake that for the bill.

For the full caching workflow, including how to verify your hit rate is actually climbing, see the [prompt caching guide](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/) and the writeup on [caching multi-turn Claude conversations across API calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/).

### 3. Gate on the rate limit headers on every successful response

Do not wait for a 429 to slow down. Every successful response carries the same `anthropic-ratelimit-*` headers. Use them as a pre-flight check before the next call.

```typescript
// TypeScript, @anthropic-ai/sdk 0.30.x, claude-sonnet-4-6
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
let ratelimit = { input: Infinity, output: Infinity, resetAt: 0 };

async function safeCreate(params: Anthropic.MessageCreateParams) {
  if (ratelimit.input < 5_000 || ratelimit.output < 2_000) {
    const ms = Math.max(0, ratelimit.resetAt - Date.now());
    await new Promise((r) => setTimeout(r, ms));
  }
  const { data, response } = await client.messages.create(params).withResponse();
  ratelimit = {
    input: Number(response.headers.get("anthropic-ratelimit-input-tokens-remaining")) || Infinity,
    output: Number(response.headers.get("anthropic-ratelimit-output-tokens-remaining")) || Infinity,
    resetAt: Date.parse(response.headers.get("anthropic-ratelimit-input-tokens-reset") ?? ""),
  };
  return data;
}
```

The `remaining` headers are rounded to the nearest thousand, so leave a margin. The `reset` headers are RFC 3339 timestamps for when the bucket is fully replenished, which is later than when you can next squeeze a request in (the token bucket refills continuously). Treat `resetAt` as a worst case, not a deadline.

### 4. Prune conversation history

Caching does not help with the part of `messages` that grows every turn. Two approaches that do help:

* Cap history at the last N turns. A code-review agent rarely needs anything older than three exchanges. Drop the rest. If a tool result was huge (a full file dump), replace it with a short pointer like `"[tool_result file=src/a.cs, see turn 7]"` once it's no longer the active subject.
* Insert a second cache breakpoint near the tail of the stable prefix of history, not just at the end of the system prompt. A breakpoint after the user's "Here is the repo" message keeps the long context cached while later turns mutate.

```python
# Python, anthropic 0.42.x
messages = [
    {"role": "user", "content": [
        {"type": "text", "text": LARGE_REPO_DUMP,
         "cache_control": {"type": "ephemeral"}},
    ]},
    {"role": "assistant", "content": "Got it. Ask me anything."},
    {"role": "user", "content": "Now review the latest PR diff:\n" + diff},
]
```

You're allowed up to four cache breakpoints. Use them where the request stops being stable.

### 5. Split work across model classes

The Sonnet 4.x bucket and the Opus 4.x bucket are independent. On Tier 2, that's 450k ITPM of Sonnet plus 2,000,000 ITPM of Opus, running concurrently. A reviewer-plus-fixer pattern, where Opus 4.7 plans and Sonnet 4.6 edits, draws from both buckets and roughly doubles your effective ceiling without changing your tier.

Haiku 4.5 is also a separate bucket and has higher ITPM than Sonnet at every tier. Routing classification, summarisation, and small tool calls to Haiku 4.5 is the cheapest way to lift Sonnet pressure off the critical path.

### 6. Last resort: request a tier increase

If after the steps above you're still pegging `anthropic-ratelimit-input-tokens-remaining: 0` and your cache hit rate on the Usage page is above 80%, you are genuinely undersized. Tier moves are automatic up to Tier 4 ($400 lifetime deposit on the standard tier). For limits beyond Tier 4, contact sales from the Limits page. Tier upgrades fix RPM and OTPM ceilings cleanly, but ITPM is best fixed with caching first, because cached reads are also billed at 10% of the base input price.

## Gotchas and variants

**`overloaded_error` (HTTP 529) is not a rate limit.** It is the API itself being temporarily saturated across the fleet. The fix is jittered retry, not caching. Confusing the two will have you "fixing" a transient outage by restructuring your prompt.

**Acceleration limits look like normal 429s.** If your org just doubled its traffic, you can hit acceleration limits even when your published tier limits look fine. The remedy is to ramp gradually rather than spiking. There is no separate error type for this; it appears as a plain `rate_limit_error`.

**`anthropic-ratelimit-tokens-*` versus the split headers.** The combined `tokens-*` headers report the most restrictive limit in effect, including workspace overrides. If you have per-workspace caps configured, those win over the org headers. The split `input-tokens-*` and `output-tokens-*` headers are what you want for ITPM and OTPM specifically.

**Claude Code's `429` looks the same but is not always API-side.** If `claude-code` itself prints a rate-limit banner, check whether it's the API rate limit (the upstream 429 above) or a local routine rate limit. The first has a `retry-after`, the second usually doesn't.

**Fast mode has its own bucket.** If you're using Opus 4.6 or 4.7 with `speed: "fast"`, the rate limits are separate from the standard Opus pool, and the response includes `anthropic-fast-*` headers. A 429 from fast mode is not a 429 from your normal Opus traffic.

**Claude Haiku 3.5 is the one exception.** On Haiku 3.5, `cache_read_input_tokens` does count against ITPM. The "cache it and forget about it" advice does not apply there. Anthropic marks it with a dagger in the rate limit tables specifically for this reason.

**Streaming and 429s.** A 429 on a streaming Messages call is returned before the SSE stream opens, so the standard `RateLimitError` path catches it. Errors emitted mid-stream are different: they appear inside the event stream after the 200 response. Your retry layer needs to handle both.

## Related

* [How to add prompt caching to an Anthropic SDK app and measure the hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/) for the full caching configuration and verification flow.
* [How to cache multi-turn Claude conversations across API calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/) for breakpoint placement in long sessions.
* [Fix: Context window exceeded during an Aider refactor](/2026/05/fix-context-window-exceeded-during-an-aider-refactor/) for the lookalike error one search-bucket over.
* [How to call the Claude API from a .NET 11 minimal API with streaming](/2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming/) for the streaming pattern referenced above.
* [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) for the kind of long loop that needs all of the above wired in from day one.

## Sources

* [Anthropic Rate limits](https://platform.claude.com/docs/en/api/rate-limits), specifically the cache-aware ITPM section, the per-tier tables, and the response header reference.
* [Anthropic Errors](https://platform.claude.com/docs/en/api/errors), for the canonical `rate_limit_error` versus `overloaded_error` distinction and the JSON shape.
* [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) for the `cache_control` placement and breakpoint count.
* [Rate Limits API](https://platform.claude.com/docs/en/manage-claude/rate-limits-api) if you want to read your org's current limits programmatically rather than from a header.
