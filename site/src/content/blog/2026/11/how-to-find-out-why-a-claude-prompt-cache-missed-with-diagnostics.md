---
title: "How to Find Out Why a Claude API Prompt Cache Missed With the diagnostics Request Object"
description: "Send diagnostics.previous_message_id on every Messages API call and Claude tells you which part of the prompt broke the cache: model_changed, system_changed, tools_changed or messages_changed, plus an estimate of the tokens you paid to rewrite. Request and response shapes, the pending and not-found states, streaming, a logging helper for anthropic 2.7.0, and the limits."
pubDate: 2026-11-10
template: "how-to"
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "prompt-caching"
  - "observability"
---

**Short answer:** add `"diagnostics": {"previous_message_id": null}` to the first Messages API request of a conversation, then `"diagnostics": {"previous_message_id": "<id of the previous response>"}` on every request after it. When the cached prefix could not be reused, the response carries `diagnostics.cache_miss_reason` with a `type` of `model_changed`, `system_changed`, `tools_changed` or `messages_changed` and a `cache_missed_input_tokens` estimate. It works on every current Claude model (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and back to `claude-sonnet-4-5-20250929`), on the Claude API only, and in the Python SDK it is a plain `client.messages.create(..., diagnostics=...)` argument as of `anthropic` 2.7.0. The old `cache-diagnosis-2026-04-07` beta header is no longer required.

## Why usage fields alone cannot tell you what broke

The usual way to spot a cache problem is the `usage` block. A healthy second turn has a large `cache_read_input_tokens` and a small `cache_creation_input_tokens`. A broken one flips that: `cache_read_input_tokens: 0` and the whole prefix shows up again as `cache_creation_input_tokens`, billed at 1.25x the base input price for the 5-minute TTL (2x for the 1-hour TTL) instead of the 0.1x read price.

That tells you *that* the cache missed. It does not tell you *why*. The cache key is the exact byte sequence of `tools`, then `system`, then `messages`, up to the breakpoint, and on top of that the model. Anything that changes a byte anywhere in that prefix produces a miss, and the usual suspects are boring and hard to see in a diff:

- a timestamp or request ID interpolated into the system prompt,
- a tool list built from a dict or set whose order is not stable,
- JSON schemas serialized without sorted keys,
- a model router or fallback that sent one turn to a different model,
- history that gets "cleaned up" (trimmed, re-rendered, thinking blocks dropped) instead of appended to.

Before diagnostics existed, the only way to find which one was to log both full request bodies and diff them by hand. The [measuring the hit rate guide](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/) covers that approach; diagnostics makes the server do the comparison for you.

## What the diagnostics object does on the server

When a request includes a `diagnostics` object, the API stores a fingerprint of that request's prompt: per the [cache diagnostics docs](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics), "only cryptographic hashes and token-count estimates, keyed by the response `id` and scoped to your organization and workspace." On the next request, you hand back the previous response `id` as `previous_message_id`. The server compares the two fingerprints in order (model, system, tools, messages) and reports the earliest point where they diverge.

Two consequences fall out of that design:

1. **Opt in on every turn, including the first.** Requests without the object store nothing, so the next turn has nothing to compare against. Turn 1 sends `previous_message_id: null` purely to get its fingerprint stored.
2. **Only the first divergence is reported.** If your system prompt changed *and* your tool order changed, you will see `system_changed`. Fix it, and the next run may surface the tools problem that was hiding behind it.

Diagnostics is best-effort. The docs are explicit that it "never blocks or fails your request", and there is no separate price for it: you pay the normal request plus whatever the cache did.

## The minimal two-turn example

This is the documented pattern, using automatic caching (top-level `cache_control`) so there is no manual breakpoint to get wrong. The system prompt deliberately includes a timestamp so turn 2 misses:

```python
# anthropic==2.7.0 (Python >= 3.10), Claude API, model claude-opus-5-5
import datetime
import anthropic

client = anthropic.Anthropic()

LONG_POLICY = open("policy.md").read()  # well over the 512-token minimum for Opus 5.5

def system_prompt() -> str:
    # The bug: a per-request value at the top of the cached prefix.
    return f"Current time: {datetime.datetime.now().isoformat()}\n\n{LONG_POLICY}"

history = [{"role": "user", "content": "Summarize section 1."}]
r1 = client.messages.create(
    model="claude-opus-5-5",
    max_tokens=1024,
    cache_control={"type": "ephemeral"},
    system=system_prompt(),
    messages=history,
    diagnostics={"previous_message_id": None},  # opt in, nothing to compare yet
)

history += [
    {"role": "assistant", "content": r1.content},  # echo back verbatim
    {"role": "user", "content": "Now summarize section 2."},
]
r2 = client.messages.create(
    model="claude-opus-5-5",
    max_tokens=1024,
    cache_control={"type": "ephemeral"},
    system=system_prompt(),
    messages=history,
    diagnostics={"previous_message_id": r1.id},
)

print(r2.usage)
print(r2.diagnostics)
```

The response for turn 2 looks like the documented example:

```json
{
  "id": "msg_01Xyz...",
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "..." }],
  "usage": {
    "input_tokens": 42,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 41850,
    "output_tokens": 210
  },
  "diagnostics": {
    "cache_miss_reason": {
      "type": "system_changed",
      "cache_missed_input_tokens": 41850
    }
  }
}
```

The same request with curl, if you want to see the raw shape:

```bash
# Claude API, anthropic-version 2026-10-21
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2026-10-21" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-opus-5-5",
    "max_tokens": 1024,
    "cache_control": {"type": "ephemeral"},
    "system": "...",
    "messages": [ ... ],
    "diagnostics": {"previous_message_id": "msg_01Abc..."}
  }'
```

Older SDK releases only exposed the parameter on the beta namespace (`client.beta.messages.create`) together with the `cache-diagnosis-2026-04-07` header. In `anthropic` 2.7.0 it lives on the regular `client.messages.create` and the types are `anthropic.types.Diagnostics` and `DiagnosticsParam`. Sending the old header still works, so you do not have to rip it out in one go.

## Reading the three response states

`diagnostics` on the response is not simply "present" or "absent". It has three states, and confusing them is the most common way to draw the wrong conclusion:

| Response value | Meaning |
| --- | --- |
| `null` | No `diagnostics` in the request, or `previous_message_id` was `null`, or the comparison ran and found no divergence. |
| `{"cache_miss_reason": null}` | The comparison was still running when the response was serialized. Inconclusive; look at the next turn. |
| `{"cache_miss_reason": {...}}` | A reason is attached. |

The pending state "can occur when the response starts very quickly", per the docs. Do not count it as a hit. Cross-check with `usage.cache_read_input_tokens`: diagnostics tells you whether the *request* changed, `usage` tells you whether the *cache* hit. They answer different questions, and you want both in your logs.

## The six reason types and what to fix

`cache_miss_reason.type` is a discriminated union. Four types mean "your request changed" and carry `cache_missed_input_tokens`; two mean "no comparison was possible".

**`model_changed`.** The `model` field differs from the previous request. The cache is per-model, so a router, an A/B test or a fallback to a cheaper model on overload throws the whole prefix away. If you added fallback logic after reading about [retry and backoff for long agent loops](/2026/11/retry-and-backoff-for-long-agent-loops-under-overloaded-and-rate-limit-errors/), this is where it shows up. Hold the model constant within a conversation, or accept that a switch costs one full rewrite.

**`system_changed`.** The `system` content differs. In practice: a timestamp, a request or trace ID, the user's name, a "today is" line, a feature-flag dump. Keep `system` byte-stable and move per-request data into the first user message after the cached prefix.

**`tools_changed`.** Tools were added, removed or reordered, or an `input_schema` serialized differently. Build the list in a fixed order and serialize schemas deterministically (`json.dumps(schema, sort_keys=True)` if you generate them). If you actually need to change tools mid-conversation, use [`tool_addition` and `tool_removal` system blocks](/2026/11/add-a-tool-mid-conversation-without-breaking-the-claude-prompt-cache/) instead of editing the `tools` array.

**`messages_changed`.** Model, system and tools all match, but an earlier entry in `messages` was edited, reordered or removed rather than appended to. Typical causes are re-rendering assistant turns from your own storage format instead of echoing `content` back verbatim, dropping thinking blocks, truncating old tool results, or a "sliding window" that trims the oldest turns. History has to be append-only for caching to work, which is the whole premise of [caching multi-turn conversations](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/). If you need to shrink history, do it deliberately (for example with [on-demand compaction](/2026/11/how-to-keep-a-long-claude-agent-loop-under-the-context-limit-with-on-demand-compaction/)) and expect exactly one miss when you do.

**`previous_message_not_found`.** No stored fingerprint for that ID. The docs stress this "is not evidence that your request changed." Usual causes: the previous request did not include `diagnostics`, it ran in a different workspace (compare the `anthropic-workspace-id` response header on both responses), or too much time passed. Fingerprints "expire after a short period", and the docs do not give a number.

**`unavailable`.** No comparison could be produced. This includes the case where model, system and tools match but another prompt-affecting parameter differs: `tool_choice`, `thinking`, `context_management`, `output_config`, `output_format`, or the set of active `anthropic-beta` headers. It is also returned when the divergence lies beyond the comparison horizon of a very long conversation. If you see `unavailable` alongside a zero `cache_read_input_tokens`, diff those parameters first. Toggling extended thinking or flipping `tool_choice` between turns is an easy one to miss.

## What cache_missed_input_tokens is (and is not)

`cache_missed_input_tokens` is "an estimate of how many input tokens fell after the divergence point." It is derived from byte lengths before tokenization, so the docs call it "a magnitude indicator rather than a billing number": it can differ from, and occasionally exceed, `usage.input_tokens`.

Use it to rank problems, not to reconcile invoices. A `system_changed` with 41,850 missed tokens on `claude-opus-5-5` means roughly 41,850 tokens written at $5 per million (5-minute write) instead of read at $0.20 per million, using the [published Opus 5.5 rates](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). That is about $0.21 versus under a cent, per turn. A `messages_changed` with 300 missed tokens at the tail of the conversation is noise. Sum the field per `type` across a day of traffic and the biggest bucket is your next fix.

## A logging helper for agent loops

In an agent loop you want this on every call, emitted as structured logs, without sprinkling `if` statements around. A small wrapper that threads the previous ID and classifies the result is enough:

```python
# anthropic==2.7.0, Python >= 3.10
import logging
import anthropic
from anthropic.types import Message

log = logging.getLogger("claude.cache")

class DiagnosedConversation:
    """Threads diagnostics.previous_message_id through a conversation and logs misses."""

    def __init__(self, client: anthropic.Anthropic):
        self.client = client
        self.previous_id: str | None = None

    def create(self, **kwargs) -> Message:
        msg = self.client.messages.create(
            **kwargs, diagnostics={"previous_message_id": self.previous_id}
        )
        self._log(msg)
        self.previous_id = msg.id
        return msg

    def _log(self, msg: Message) -> None:
        u = msg.usage
        fields = {
            "message_id": msg.id,
            "cache_read": u.cache_read_input_tokens,
            "cache_write": u.cache_creation_input_tokens,
        }
        if self.previous_id is None or msg.diagnostics is None:
            log.info("cache ok", extra=fields)  # first turn, or no divergence
            return
        reason = msg.diagnostics.cache_miss_reason
        if reason is None:
            log.info("cache diagnosis pending", extra=fields)  # inconclusive
            return
        fields["reason"] = reason.type
        fields["missed_tokens"] = getattr(reason, "cache_missed_input_tokens", None)
        if reason.type in ("previous_message_not_found", "unavailable"):
            log.info("cache diagnosis unavailable", extra=fields)
        else:
            log.warning("cache miss", extra=fields)  # model/system/tools/messages_changed
```

`cache_missed_input_tokens` only exists on the four `*_changed` types, hence the `getattr`. With a logger that ships `extra` as attributes (structlog, an OpenTelemetry log handler, Langfuse), `reason` becomes a dimension you can group by.

We checked this helper and the two-turn example offline against `anthropic` 2.7.0 on Python 3.12: an `httpx2.MockTransport` captured the outgoing bodies (turn 1 sent `{"previous_message_id": None}`, turn 2 sent the first response's ID) and replayed the documented response shape, which the SDK parsed into a `CacheMissSystemChanged` with `cache_missed_input_tokens == 41850`. A second mocked run fed the helper a no-divergence `null`, a `tools_changed`, a pending `{"cache_miss_reason": null}` and an `unavailable`, and it logged each on the branch shown above while threading `msg_1`, `msg_2`, `msg_3` through as `previous_message_id`. That verifies request serialization and response parsing in the SDK. It was not a call to the live API, so the server-side behaviour described here comes from Anthropic's documentation.

## Streaming, async and other SDKs

With `stream=True` or `client.messages.stream(...)`, `diagnostics` arrives on the `message_start` event, not at the end. The SDK accumulators (`get_final_message()` in Python, `finalMessage()` in TypeScript, the Go `Accumulate` and Java `BetaMessageAccumulator`) carry it onto the final message, so the helper above works unchanged if you read the final message. `AsyncAnthropic` takes the same argument.

The [cache diagnostics page](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics) has equivalent examples for TypeScript, C#, Go, Java, PHP and Ruby; the field is always `diagnostics.previous_message_id` in the request and `diagnostics.cache_miss_reason` in the response. If your framework does not expose the parameter yet (the Vercel AI SDK, for example), the [Classmethod write-up](https://dev.classmethod.jp/en/articles/claude-cache-diagnostics/) injects it through a custom `fetch`. The same trick works for any client that lets you rewrite the request body.

## Limits worth knowing before you rely on it

- **Claude API only.** Not available on Claude models through Amazon Bedrock or Google Cloud, and not for Managed Agents. If you route the same agent through Bedrock in production, you can still use diagnostics in a dev environment that hits the Claude API directly.
- **Same organization and workspace.** A conversation that hops between API keys in different workspaces returns `previous_message_not_found`.
- **Short retention.** Fingerprints expire after an unspecified "short period". A user who comes back to a chat after lunch will produce `previous_message_not_found`, which is fine: the 5-minute cache would have expired anyway.
- **It does not explain under-minimum prompts.** A prompt below the minimum cacheable length (512 tokens on Opus 5.5, Sonnet 5.5 and Haiku 5.5; 1,024 on Sonnet 4.6; 4,096 on Opus 4.6 and Haiku 4.5) is processed without caching and no error is returned. Diagnostics compares requests; it will not tell you the cache never had anything to hit. Check `cache_creation_input_tokens` on turn 1: if it is 0, you are below the threshold or have no breakpoint.
- **It does not explain TTL expiry.** Identical requests seven minutes apart miss because the 5-minute entry expired, not because anything changed, and the comparison finds no divergence. If you see misses with `diagnostics: null`, look at the gap between calls and consider `"ttl": "1h"`.
- **Compliance.** The cache diagnostics page lists the feature as ZDR-eligible (hashes and token estimates are "retained briefly") and not HIPAA-eligible. If you run under a BAA, keep it off in that environment.

## A debugging loop that converges

The practical workflow is short. Turn diagnostics on in your agent harness for every call, ship the `reason` and `missed_tokens` fields to whatever you already use for logs, and let a day of real traffic run. Group by `reason`, fix the largest bucket, redeploy, repeat. Because only the earliest divergence is reported, the order you see problems in mirrors the prompt order (model, system, tools, messages), and each fix can uncover the next one. When the only remaining reasons are `messages_changed` on deliberate compaction turns and `previous_message_not_found` after idle gaps, the cache is doing all it can.

Sources:

- [Cache diagnostics, Claude Platform docs](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics)
- [Prompt caching, Claude Platform docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (minimum lengths, TTLs, pricing multipliers)
- [anthropic on PyPI](https://pypi.org/project/anthropic/) (2.7.0 exposes `diagnostics` on `messages.create`)
- [Classmethod: detecting the causes of Claude prompt cache failures](https://dev.classmethod.jp/en/articles/claude-cache-diagnostics/)
