---
title: "Retry and Backoff for Long Agent Loops Under Overloaded and Rate-Limit Errors"
description: "The Anthropic SDK retries a failed call twice in about 1.2 seconds, which is fine for a chat request and wrong for a 200-turn agent run. Classify every failure into retry-after, capacity, transient or terminal, retry the model turn (never the tool call), share one pause gate across workers, catch the mid-stream overloaded_error that arrives as a 200, and checkpoint so a dead run resumes. Tested against anthropic 2.3.0 for Python."
pubDate: 2026-11-01
template: how-to
tags:
  - "ai-agents"
  - "llm"
  - "anthropic-sdk"
  - "rate-limits"
  - "resilience"
  - "patterns"
---

**Short answer:** for a long agent loop, turn off the SDK's built-in retries (`max_retries=0`) and own one retry layer around each model turn. Sort every failure into four buckets: **retry-after** (a 429 that tells you how long to wait), **capacity** (529 `overloaded_error`, including the one that arrives mid-stream), **transient** (500, 504, dropped connections) and **terminal** (400, 401, 413, and the spend-cap 429 that never recovers). Back off with full jitter against a wall-clock budget instead of a retry count, push any `retry-after` into a gate every worker respects, switch to a fallback model after a few capacity failures, and checkpoint the conversation after every tool result so the run resumes instead of restarting. Everything below is tested against `anthropic` 2.3.0 for Python (the TypeScript SDK 1.3.0 has the same defaults) with `claude-opus-5-5` as the primary and `claude-sonnet-5-5` as the fallback.

## Why the SDK default is tuned for a request, not a run

The official SDKs already retry. In `anthropic` 2.3.0 the defaults live in `_constants.py`: `DEFAULT_MAX_RETRIES = 2`, `INITIAL_RETRY_DELAY = 0.5`, `MAX_RETRY_DELAY = 8.0`. The retry predicate in `_base_client.py` retries 408, 409, 429, every status of 500 and above, and connection errors, honours an `x-should-retry` header when the server sends one, and prefers `retry-after-ms`, then `retry-after`, over its own backoff. Without a server hint it sleeps `0.5 * 2^n` seconds, capped at 8, multiplied by a jitter factor between 0.75 and 1.

I pointed the SDK at a local mock that answers every request with `529 overloaded_error` and timed it:

```python
# anthropic 2.3.0, Python 3.12, mock server on 127.0.0.1 always returning 529
import time, anthropic

client = anthropic.Anthropic(api_key="sk-test", base_url="http://127.0.0.1:8765")
t = time.time()
try:
    client.messages.create(model="claude-sonnet-5-5", max_tokens=64,
                           messages=[{"role": "user", "content": "hi"}])
except anthropic.OverloadedError as e:
    print(type(e).__name__, e.status_code, round(time.time() - t, 2))
# OverloadedError 529 1.23   (3 requests: initial + 2 retries, ~0.4s and ~0.8s apart)
```

Three requests, 1.23 seconds, then the exception lands in your code. For a single chat completion that is the right trade: the user is waiting, so fail fast. For an agent loop that makes 200 model calls over 40 minutes, it means one bad minute of API capacity kills the whole run, and everything the agent did up to that point is gone unless you saved it. That is exactly the failure mode in [the headless Claude Code run that dies after three 529s](/2026/10/fix-claude-code-repeated-529-overloaded-errors-in-a-headless-run/), just in your own code instead of Anthropic's CLI.

The obvious fix, "wrap it in a loop and retry more", creates three new problems. Retries multiply (your 5 attempts times the SDK's 3 is 15 requests per turn). Parallel workers each back off on their own and stampede the API together when the window reopens. And a naive outer retry re-runs the whole step, including tool calls that already wrote files or sent requests. The pattern below addresses all three.

## Classify every failure before deciding what to do

The [errors page](https://platform.claude.com/docs/en/api/errors) lists the status codes. What matters for a loop is not the code but what waiting will achieve:

| Bucket | What arrives | Does waiting help? | What to do |
|---|---|---|---|
| retry-after | 429 `rate_limit_error` with a `retry-after` header | Yes, after exactly that long | Wait at least `retry-after`, pause every worker sharing the key |
| capacity | 529 `overloaded_error`, 503, or an SSE `error` event with `overloaded_error` after a 200 | Usually, on a scale of seconds to minutes | Exponential backoff with jitter, fall back to another model after N failures |
| transient | 500 `api_error`, 504 `timeout_error`, 408, 409, connection reset, client timeout | Usually, quickly | Short exponential backoff |
| terminal | 400, 401, 402, 403, 404, 413, 422, and a 429 whose `error.details.error_code` is `enforced_spend_limit_reached` | No | Raise immediately, checkpoint, alert a human |

Two entries in that table catch people out.

**The spend-cap 429 looks like a rate limit and is not one.** When an organisation hits its usage tier's monthly spend cap, the API returns `429 rate_limit_error` with no `retry-after` header and `"error_code": "enforced_spend_limit_reached"` in `error.details`. It will keep failing until the cap resets or someone raises it. A retry loop keyed on status code alone will sit on it for its full budget.

**The mid-stream overload arrives as a 200.** The [streaming docs](https://platform.claude.com/docs/en/build-with-claude/streaming) say the API can send an `error` event inside an event stream that already returned HTTP 200, typically `overloaded_error` during high load. The SDK raises it while you iterate, which is after its retry loop has finished, so it is never retried. And because the exception is built from the response object, its status is the response's status. I verified this against the same mock, which streams a partial text delta and then the error event:

```python
# anthropic 2.3.0, mock server: 200 + message_start + text delta + event: error
try:
    with client.messages.stream(model="claude-sonnet-5-5", max_tokens=64,
                                messages=[{"role": "user", "content": "hi"}]) as s:
        for text in s.text_stream:
            print("TEXT", repr(text))
except Exception as e:
    print(type(e).__name__, e.status_code, e.body)
# TEXT 'Half an answ'
# APIStatusError 200 {'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'Overloaded'}}
# server log: 1 request, no retry
```

So `except anthropic.OverloadedError` does not catch it. You have to look at `err.body["error"]["type"]`. Here is the classifier that handles both:

```python
# agent_retry.py -- anthropic 2.3.0, Python 3.12
import random, threading, time
import anthropic

RETRY_AFTER, CAPACITY, TRANSIENT, TERMINAL = "retry_after", "capacity", "transient", "terminal"

def classify(err: Exception) -> tuple[str, float | None]:
    """Map an SDK exception to a retry bucket plus an optional server-given wait."""
    if isinstance(err, anthropic.APIConnectionError):  # includes APITimeoutError
        return TRANSIENT, None
    if not isinstance(err, anthropic.APIStatusError):
        return TERMINAL, None
    body = err.body if isinstance(err.body, dict) else {}
    error = body.get("error", {}) if isinstance(body.get("error"), dict) else {}
    etype = error.get("type")
    # Mid-stream SSE error: the HTTP status is 200, the real cause is in the body.
    if err.status_code == 200:
        if etype == "overloaded_error":
            return CAPACITY, None
        return (TRANSIENT, None) if etype in ("api_error", "timeout_error") else (TERMINAL, None)
    if err.status_code == 429:
        if (error.get("details") or {}).get("error_code") == "enforced_spend_limit_reached":
            return TERMINAL, None  # monthly spend cap: no retry-after, never recovers
        ra = err.response.headers.get("retry-after")
        return RETRY_AFTER, float(ra) if ra else None
    if err.status_code in (529, 503):
        return CAPACITY, None
    if err.status_code in (408, 409, 500, 504) or err.status_code > 500:
        return TRANSIENT, None
    return TERMINAL, None  # 400, 401, 402, 403, 404, 413, 422
```

Anything that is not an SDK exception, such as a bug in your own code or a `KeyError` while parsing tool input, is terminal. Retrying a programming error just repeats it more slowly.

## Retry the model turn, never the tool call or the whole run

An agent loop alternates two kinds of step: a model call (pure, safe to repeat) and tool execution (side effects: a file was written, a ticket was opened, a deploy was triggered). The retry layer belongs around the model call only.

That works because the conversation itself is the state. A Messages API call takes the full `messages` list and returns one assistant message. If it fails, nothing was appended, so calling again with the same list is a clean retry. There is no half-applied state to clean up as long as you discard partial output.

Partial output is the trap with streaming. When the overload hits after `Half an answ`, you have a half-built assistant message, possibly with a half-built `tool_use` block. The streaming docs note that tool use and thinking blocks cannot be partially recovered, so do not try to stitch them. Throw the partial message away and re-issue the same request. For a plain text answer you can ask the model to continue, but in an agent loop nearly every turn ends in a tool call, so "discard and repeat" is the only rule that is always safe.

Here is the turn-level wrapper. It uses a wall-clock budget instead of a retry count, because "keep trying for 15 minutes" is what you actually mean for an unattended job, and a count gives wildly different durations depending on where in the backoff curve the failures land:

```python
# agent_retry.py (continued) -- anthropic 2.3.0, Python 3.12
class Gate:
    """One per process (or per API key): every worker waits until `not_before`."""
    def __init__(self):
        self._lock = threading.Lock()
        self.not_before = 0.0
    def push(self, seconds: float):
        with self._lock:
            self.not_before = max(self.not_before, time.monotonic() + seconds)
    def wait(self):
        delay = self.not_before - time.monotonic()
        if delay > 0:
            time.sleep(delay)

class RetryBudgetExhausted(Exception):
    pass

def call_model(client, gate, *, model, fallback_model=None, budget_s=900.0,
               base_s=2.0, cap_s=60.0, fallback_after=3, **params):
    """One model turn with a wall-clock retry budget. Returns the final Message."""
    deadline = time.monotonic() + budget_s
    attempt, capacity_failures, current = 0, 0, model
    while True:
        gate.wait()
        try:
            with client.messages.stream(model=current, **params) as stream:
                return stream.get_final_message()
        except Exception as err:
            bucket, server_wait = classify(err)
            if bucket == TERMINAL:
                raise
            attempt += 1
            if bucket == CAPACITY:
                capacity_failures += 1
                if fallback_model and capacity_failures >= fallback_after and current != fallback_model:
                    current = fallback_model  # stop waiting on a saturated model
            # Full jitter: uniform(0, min(cap, base * 2^attempt))
            wait = random.uniform(0, min(cap_s, base_s * 2 ** attempt))
            if server_wait is not None:
                wait = max(wait, server_wait)
                gate.push(server_wait)  # a 429 is org-wide, so pause everyone
            if time.monotonic() + wait > deadline:
                raise RetryBudgetExhausted(f"gave up after {attempt} attempts on {current}") from err
            time.sleep(wait)
```

Create the client with `max_retries=0` so the SDK does not retry underneath you:

```python
client = anthropic.Anthropic(max_retries=0)  # anthropic 2.3.0: this layer owns all retries
gate = Gate()
```

I ran this against a mock that plays back a scripted sequence of failures (with `base_s=0.2`, `cap_s=1` so the test finishes quickly). The server log shows what it did:

```text
sequence 529, mid-stream overload, 529, ok:
  HIT 1 529 claude-opus-5-5
  HIT 2 mid claude-opus-5-5        <- 200 + SSE error, classified as capacity
  HIT 3 529 claude-opus-5-5
  HIT 4 ok  claude-sonnet-5-5      <- fallback after 3 capacity failures
sequence 429 (retry-after: 2), ok:   waited 2.0s, then succeeded on the primary
sequence 429 spend cap:              raised RateLimitError after 1 request
sequence 500, 400:                   retried the 500, raised BadRequestError on the 400
sequence 529 forever, budget 3s:     10 requests, then RetryBudgetExhausted
```

### Why full jitter and not plain exponential

If ten workers all hit a 529 at the same moment and each sleeps exactly 2, 4, 8 seconds, they all come back at the same moment, too. AWS's [analysis of backoff strategies](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) showed that "full jitter", a uniform random wait between zero and the exponential ceiling, spreads the retries out and finishes the total work with fewer calls than either no jitter or the SDK-style "equal-ish" jitter (multiplying by 0.75 to 1 keeps every worker within 25% of each other). For one process making one call at a time it barely matters. For a fleet of subagents it is the difference between a retry storm and a gentle ramp.

The `cap_s=60` ceiling keeps one unlucky sequence from sleeping for ten minutes. The budget is what decides when to give up.

### Why a shared gate for 429s

Rate limits are per organisation and per model class, enforced with a token bucket, according to the [rate limits page](https://platform.claude.com/docs/en/api/rate-limits). When one worker gets `retry-after: 20`, every other worker on the same key will get a 429 too if it fires in the next 20 seconds, and each of those rejected requests is wasted work. The `Gate` turns one worker's 429 into a pause for all of them. Share one `Gate` per API key across threads; for multiple processes, put `not_before` in Redis or a file lock.

A 529 does not go through the gate. Overload is about the model's capacity across all customers, not your quota, so there is no shared "you may resume at" time to respect. Jitter handles it.

## Switch to a fallback model, knowing what it costs

After `fallback_after` capacity failures, `call_model` switches the rest of that turn to `fallback_model`. This is the same idea as Claude Code's `--fallback-model` flag: when Opus is saturated, Sonnet often is not, and a slightly less capable answer now beats a perfect answer in eight minutes.

Two costs to accept consciously:

1. **The prompt cache is per model.** Your cached system prompt and tool definitions for `claude-opus-5-5` do not help `claude-sonnet-5-5`. The first fallback call pays the cache write again. On a 40k-token prefix that is noticeable, so fall back per turn, not on the first hiccup. [Caching a multi-turn conversation](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/) goes into how the prefix is built.
2. **Behaviour changes mid-run.** A different model can pick a different plan. The wrapper above falls back for the current turn only and starts the next turn on the primary again. If you would rather keep the run consistent, make the switch sticky and log it.

Never fall back on a 429. A rate limit on Opus is usually a sign you are sending too much, and moving the same volume to Sonnet just moves the problem to another bucket, assuming the limits are separate for your tier.

## Checkpoint after every tool result so the run can resume

Even a 15-minute budget runs out sometimes. When it does, the run should stop with a resumable state, not a stack trace. The conversation is that state, so write it after each step:

```python
# agent_loop.py -- anthropic 2.3.0, Python 3.12
import json, pathlib, sys
from agent_retry import Gate, call_model, RetryBudgetExhausted
import anthropic

CHECKPOINT = pathlib.Path("run-checkpoint.json")

def save(messages):
    tmp = CHECKPOINT.with_suffix(".tmp")
    tmp.write_text(json.dumps(messages))
    tmp.replace(CHECKPOINT)  # atomic: never a half-written checkpoint

def run(task, tools, execute_tool, max_turns=200):
    client, gate = anthropic.Anthropic(max_retries=0), Gate()
    messages = json.loads(CHECKPOINT.read_text()) if CHECKPOINT.exists() else [
        {"role": "user", "content": task}]
    for _ in range(max_turns):
        try:
            msg = call_model(client, gate, model="claude-opus-5-5",
                             fallback_model="claude-sonnet-5-5",
                             max_tokens=8192, tools=tools, messages=messages)
        except (RetryBudgetExhausted, anthropic.APIStatusError) as err:
            save(messages)
            sys.exit(f"stopped, resumable from {CHECKPOINT}: {err}")
        messages.append({"role": "assistant",
                         "content": [b.model_dump(exclude_none=True) for b in msg.content]})
        if msg.stop_reason != "tool_use":
            CHECKPOINT.unlink(missing_ok=True)
            return msg
        results = []
        for block in msg.content:
            if block.type == "tool_use":
                # block.id is stable across a resume: use it as the idempotency key
                output = execute_tool(block.name, block.input, idempotency_key=block.id)
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": output})
        messages.append({"role": "user", "content": results})
        save(messages)
```

The checkpoint is written after the tool results are appended, so a resumed run never sees an assistant `tool_use` without its `tool_result` (which the API rejects as a 400). The one window where a crash can bite is between executing a tool and saving: the tool ran, but the checkpoint still ends at the previous turn, so the resumed run asks the model again and it may call the same tool a second time. Passing `block.id` as an idempotency key only helps if the model reissues the identical call, which is not guaranteed, so for tools with real side effects the safer design is to make the tool itself idempotent: "create file with this content" rather than "append this line", "set ticket status to closed" rather than "toggle". The [preview, confirm, apply pattern for file-write tools](/2026/08/safe-file-write-tools-for-an-agent-preview-confirm-apply/) gets you most of the way there.

Run it from cron or CI with a wrapper that reruns the script when it exits with the "resumable" message, with a cap on how many resumes per day. That is the same shape as `claude --resume` in the Claude Code version of this problem.

## Gotchas that make the retry layer worse than none

**Long waits throw away your prompt cache.** The default cache TTL is 5 minutes and refreshes on each hit. If a backoff sleeps past that, the next request writes the whole cache again at 1.25x input price. With a 15-minute budget and a 60-second cap you rarely cross it in one sleep, but a `retry-after` of several minutes will. If your loop routinely waits that long, use the 1-hour cache TTL on the prefix.

**The SDK honours any `retry-after`, however large.** In `anthropic` 2.3.0, `_calculate_retry_timeout` returns the server's value capped only at about 49 days (a platform `sleep` limit). Older SDK versions ignored values above 60 seconds and fell back to their own backoff. If you keep the SDK's retries on, a large `retry-after` can block a thread far longer than you expect. With `max_retries=0` your budget check makes that decision.

**Ramping up workers can trigger 429s with plenty of quota left.** The rate limits page warns about acceleration limits: a sharp jump in an organisation's usage can be rejected even under the published limits. Starting 30 subagents in the same second is exactly that jump. Stagger worker start-up over a minute or two, and read why [deep subagent fan-out burns tokens](/2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens/) before you scale out in the first place.

**Most 429s in a long loop are input tokens, not requests.** Retrying correctly does not fix sending 150k uncached tokens per turn. Cached reads do not count toward ITPM on current models, so caching the prefix and pruning history reduce how often you need the retry layer at all. The [rate_limit_error fix for long agent loops](/2026/05/fix-rate-limit-error-on-claude-sonnet-4-6-in-a-long-agent-loop/) covers reading the `anthropic-ratelimit-input-tokens-remaining` header to slow down before the 429.

**Long non-streaming calls time out on the client.** The SDK refuses non-streaming requests it expects to exceed 10 minutes, and some networks drop idle connections earlier. That is why `call_model` always streams and uses `get_final_message()`. A dropped connection then surfaces as `APIConnectionError` and goes into the transient bucket.

**Do not retry 413 or 400 by "trimming and trying again" inside the retry layer.** A request that is too large or malformed needs a decision about what to drop, which is agent logic, not transport logic. Raise it, let the loop compact the history, and call again.

**Log the `request-id`.** Every response carries a `request-id` header, and error bodies include `request_id`. Log it on every retry so that when a run dies after 14 minutes of 500s you can hand Anthropic support the actual requests.

If you are building on .NET instead of Python, the same buckets map onto a resilience pipeline; the [Polly vs resilience handlers comparison](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) shows where the jitter and the `Retry-After` handling plug in, though you still need the mid-stream check yourself.

## Related

- [Fix: repeated 529 overloaded errors end a headless Claude Code run](/2026/10/fix-claude-code-repeated-529-overloaded-errors-in-a-headless-run/), the CLI-side version of this problem with its retry environment variables.
- [Fix: rate_limit_error in a long agent loop](/2026/05/fix-rate-limit-error-on-claude-sonnet-4-6-in-a-long-agent-loop/), for when the 429s are self-inflicted ITPM.
- [How to cache multi-turn Claude conversations across API calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/), which decides how much a retry costs.
- [Safe file-write tools for an agent: preview, confirm, apply](/2026/08/safe-file-write-tools-for-an-agent-preview-confirm-apply/), for making tool side effects safe to repeat.
- [Nested subagent depth: when it helps and when it burns tokens](/2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens/).

## Sources

- Anthropic, [Errors](https://platform.claude.com/docs/en/api/errors): status codes, error types, the SSE error caveat and `request-id`.
- Anthropic, [Rate limits](https://platform.claude.com/docs/en/api/rate-limits): token bucket, `retry-after`, `anthropic-ratelimit-*` headers, cache-aware ITPM, acceleration limits, spend caps.
- Anthropic, [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming): `event: error` with `overloaded_error` and partial-response recovery.
- [anthropic-sdk-python](https://github.com/anthropics/anthropic-sdk-python), version 2.3.0: `_constants.py` and `_base_client.py` (`_should_retry`, `_calculate_retry_timeout`), `_streaming.py` (SSE error raising).
- [anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript), version 1.3.0: same defaults (`maxRetries` 2, 0.5s initial, 8s max).
- AWS Architecture Blog, [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/).
