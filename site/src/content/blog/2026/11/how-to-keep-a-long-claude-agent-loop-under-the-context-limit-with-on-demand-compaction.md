---
title: "How to Keep a Long Claude Agent Loop Under the Context Limit with On-Demand Compaction"
description: "Use the Claude API's on-demand compaction parameter (beta compact-2026-09-04) to summarize a tool-calling agent loop before it outgrows the 1M window: when to trigger it, where to cut so tool calls and thinking stay valid, how to write the summarization instructions, and the stop reasons, errors and billing fields that trip people up."
pubDate: 2026-11-08
template: "how-to"
tags:
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "compaction"
  - "context-window"
---

**Short answer:** on `claude-opus-5-5` (and every other model in the `compact-2026-09-04` beta), send the conversation you already have with `compaction={"type": "summarize"}` once your own token estimate crosses a limit you choose, check that `stop_reason == "compaction"`, and replace the messages you sent with the returned message. In a tool-calling loop, compact exactly the `messages` of the last request you made and keep its reply plus the tool results that followed word for word after the block. That cut never leaves a tool call without its result, and it keeps preserved thinking valid. The code below targets the Python `anthropic` 2.6.0 SDK.

## Why an agent loop needs its own compaction step

An agent loop resends its whole history on every turn. A coding agent that reads ten 50k-token files has a 500k-token request by step eleven, and every later step pays for it again. Even with the 1M-token window that `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` share, a long task runs out of room eventually, and well before that, recall degrades as the prompt grows (the docs call it *context rot*).

There are two server-side ways to summarize old turns. Threshold compaction (`compact_20260112` inside `context_management`) fires automatically when input crosses a trigger; [where to store agent chat history](/2026/09/where-to-store-agent-chat-history-cost-privacy-portability/) covers how it changes what you can persist. On-demand compaction, the subject here, is the opposite design: nothing happens until your code sends a request with the `compaction` parameter, and that request returns a summary in place of a reply. You decide when, you decide which messages, and you decide what the summary must keep. For an agent loop, which already has a natural "between steps" point, that control is the reason to prefer it. The broader menu of techniques (tool-result clearing, deferred tools, memory files) is in [what a context window is and how agents stretch it](/2026/10/what-is-a-context-window-and-how-do-agents-stretch-it-in-2026/); this post is only about getting on-demand compaction right inside a loop.

## The minimal request and what comes back

The request is an ordinary Messages call with one extra field and the beta header:

```python
# Python 3.14, anthropic 2.6.0, beta compact-2026-09-04
import anthropic

client = anthropic.Anthropic()

summary = client.beta.messages.create(
    model="claude-opus-5-5",
    max_tokens=8192,              # caps the whole call, thinking included
    system=SYSTEM,                # same system prompt as the conversation
    tools=TOOLS,                  # same tools as the conversation
    betas=["compact-2026-09-04"],
    messages=history,
    compaction={"type": "summarize"},
)
assert summary.stop_reason == "compaction"
```

The response holds exactly one content block:

```json
{
  "content": [
    {"type": "compaction", "content": "Summary of the conversation: ...", "signature": "EuYBCkQY..."}
  ],
  "stop_reason": "compaction",
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "iterations": [{"type": "compaction", "input_tokens": 144, "output_tokens": 276}]
  }
}
```

Three rules govern what you do with it:

1. The block goes **first** in `messages` on every later request, either as its own `assistant` message or as the first content block of the first message.
2. The messages it summarized must be **gone**. Leaving any in front of the block returns `400 compaction_block_misplaced`. Leaving them *after* the block returns nothing at all: the API silently sends them to the model again, and you pay for them twice.
3. Every later request carries the **beta header** and exactly **one** block, sent back unchanged with its `signature`.

To compact again later, send the history that starts with the old block plus everything after it; the new block summarizes the old summary and the newer turns, and from then on you send only the newest block.

## Where to cut in a tool-calling loop

The docs' basic loop compacts after an assistant reply and then appends the next user question. An agent loop does not look like that. Its natural compaction point is right after you append tool results and right before the next model call, which is also when the context is largest. If you compact the whole history at that point, the swap leaves you with a single `assistant` message (the block) and nothing to answer, so you would be prefilling the assistant turn. Compacting before the tool results are appended is worse: the last assistant turn ends in a `tool_use` with no result, and the API rejects the compaction request.

The cut that avoids both problems comes straight from the [keep-recent-turns](https://platform.claude.com/docs/en/build-with-claude/compaction-keep-recent-turns) and [preserved thinking](https://platform.claude.com/docs/en/build-with-claude/compaction-thinking-blocks) pages: **compact exactly the `messages` of a request you already sent, and keep everything the history has gained since.** In an agent loop that means:

- `older = history[:last_sent]`: the messages the last model request carried. They always end on a `user` message (the original task or a batch of tool results), so no tool call is left open.
- `kept = history[last_sent:]`: the model's reply (with its `tool_use` blocks and any thinking) plus your `tool_result` message.
- New history: `[block_message, *kept]`, which ends on a `user` message, ready for the next call.

This cut also satisfies the conditions for thinking in the kept turns to stay valid: the kept turns directly follow the summarized messages, the first kept message (the assistant reply) has a different role from the last summarized one (a user message), and `system` and `tools` are unchanged as long as you send the same ones on the compaction request.

## A complete loop

```python
# Python 3.14, anthropic 2.6.0, beta compact-2026-09-04, model claude-opus-5-5
import json
import pathlib

import anthropic
from anthropic.types.beta import BetaMessage, BetaMessageParam

MODEL = "claude-opus-5-5"
BETAS = ["compact-2026-09-04"]
COMPACT_AT_TOKENS = 600_000  # well under the 1M window; leaves room for one more big turn
SYSTEM = "You are a coding agent working in ./repo. Use read_file to inspect code."
TOOLS = [
    {
        "name": "read_file",
        "description": "Read a UTF-8 text file from the repository.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    }
]
COMPACT_INSTRUCTIONS = (
    "Summarize this coding-agent session so the agent can continue it. "
    "Preserve verbatim: the user's original goal, every file path read or changed, "
    "decisions made and why, exact error messages and failing test names still open, "
    "and the next step the agent planned. Drop file contents that can be re-read. "
    "Do not call tools; respond with the summary text only."
)

client = anthropic.Anthropic()


def request_tokens(msg: BetaMessage) -> int:
    """Size of the request that produced msg, plus msg itself."""
    u = msg.usage
    return (
        u.input_tokens
        + (u.cache_read_input_tokens or 0)
        + (u.cache_creation_input_tokens or 0)
        + u.output_tokens
    )


def run_tool(name: str, args: dict) -> str:
    if name == "read_file":
        return pathlib.Path("repo", args["path"]).read_text(encoding="utf-8")
    return f"unknown tool {name}"


def compact(older: list[BetaMessageParam]) -> BetaMessage | None:
    """Ask for a summary of `older`. Returns the compaction message or None."""
    max_tokens = 8192
    instructions = COMPACT_INSTRUCTIONS
    for _ in range(2):  # one retry for fixable stop reasons
        summary = client.beta.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            system=SYSTEM,  # same system and tools as the conversation
            tools=TOOLS,
            betas=BETAS,
            messages=older,
            compaction={"type": "summarize", "instructions": instructions},
        )
        if summary.stop_reason == "compaction":
            return summary
        if summary.stop_reason == "max_tokens":
            max_tokens *= 2
        elif summary.stop_reason == "tool_use":
            instructions += " Never call a tool. Output plain text only."
        else:  # refusal, end_turn, model_context_window_exceeded
            break
    return None


def run(task: str, max_steps: int = 200) -> str:
    history: list[BetaMessageParam] = [{"role": "user", "content": task}]
    last_sent = 0          # how many messages the last model request carried
    last_size = 0          # tokens that request used, reply included

    for _ in range(max_steps):
        if last_size > COMPACT_AT_TOKENS:
            # Cut at the end of the last request: summarize exactly what it sent,
            # keep its reply and the tool results that followed, word for word.
            older, kept = history[:last_sent], history[last_sent:]
            summary = compact(older)
            if summary is not None:
                history = [summary.to_param(), *kept]
                print(f"compacted {len(older)} messages, kept {len(kept)}")

        last_sent = len(history)
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=16_000,  # above ~21,333 the SDK demands streaming
            system=SYSTEM,
            tools=TOOLS,
            betas=BETAS,  # every request that may carry the block needs the header
            messages=history,
        )
        history.append(response.to_param())
        last_size = request_tokens(response)

        if response.stop_reason != "tool_use":
            return "".join(b.text for b in response.content if b.type == "text")

        results = [
            {
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": run_tool(block.name, block.input),
            }
            for block in response.content
            if block.type == "tool_use"
        ]
        history.append({"role": "user", "content": results})
        # The tool results ride on the next request too.
        last_size += sum(len(json.dumps(r)) for r in results) // 4

    raise RuntimeError("step budget exhausted")
```

A few decisions in there are worth spelling out.

**The size estimate counts cache fields.** With prompt caching on, `usage.input_tokens` counts only the tokens after the last cache breakpoint. A loop that compares `input_tokens` alone against its limit will under-read a cached 700k-token history as a few thousand tokens and never compact. Add `cache_read_input_tokens` and `cache_creation_input_tokens`, plus the reply's `output_tokens`, because the reply rides on the next request. Tool results are not in any `usage` yet, so the loop adds a rough characters-divided-by-four estimate. If you need precision, send the next request's messages to the [token counting endpoint](https://platform.claude.com/docs/en/build-with-claude/token-counting) instead; it ignores the `compaction` parameter but counts everything else.

**The threshold leaves headroom.** The compaction request itself must fit in the context window, and so must the kept tail. If one tool call can return 200k tokens, a 900k threshold is too late: the request that crosses it may already be over 1M, and then there is nothing left to compact with. Pick the limit as "window minus the largest single turn you expect, minus a margin".

**A failed compaction is not fatal.** Every failure mode comes back as a 200 with empty `content` and a different `stop_reason`, so the `stop_reason` check comes before any attempt to read the block. The loop keeps its full history and tries again after the next step.

## What to put in `instructions`

Without `instructions`, the API uses its own summarization prompt. A non-blank string, up to 16,384 characters, replaces that prompt entirely, so it has to say everything: what to keep and that tools are off-limits. The summarizer still reads the tool definitions you send (and you should send the same ones, so preserved thinking stays valid), and nothing stops it from emitting a `tool_use` if your prompt does not forbid it. That ends the call with `stop_reason: "tool_use"` and no summary.

For a coding agent, the useful rule of thumb is: keep everything the agent cannot recompute, drop everything it can. File contents can be re-read; the fact that `src/cart/total.py` was already ruled out cannot. Exact error strings and failing test names matter because a paraphrased error sends the agent searching for the wrong thing. Anything binary is lost regardless: images, documents, `container_upload` blocks and fetched URLs inside the summarized range are gone once the block replaces them, so the agent has to fetch or upload them again if a later step needs them.

Also mind what was hiding in the summarized range. A mid-conversation `role: "system"` message gets summarized like anything else, and its instructions (and any per-message effort level it set) stop applying. If an instruction must survive, restate it in a new system message after the next user turn.

## Checking the bookkeeping offline

The swap logic is where loops break silently, so the program above was checked without spending tokens. An offline harness replaced the SDK's HTTP transport (`anthropic` 2.6.0 on Python 3.14, which now ships on `httpx2`) with a fake Messages endpoint that enforces the documented rules: beta header present, at most one compaction block, block at `messages[0].content[0]`, no unknown fields on the block, and no unanswered `tool_use` at the end of a compaction request. Each fake turn requested one ~50k-token file. With the threshold lowered to 150,000 tokens, a 13-turn run compacted three times, each time summarizing 7 messages and keeping 2, and every request after a swap went out with 3 messages and about 49.6k tokens instead of growing toward 150k. No request was rejected. This checks the loop's message handling against the documented contract; it is not a test of summary quality, which only a real model run can tell you.

The harness also surfaced two SDK details. First, in 2.6.0 a non-streaming `create` call with `max_tokens` above roughly 21,333 raises `ValueError: Streaming is required for operations that may take longer than 10 minutes` before any request is sent, which is why the loop uses 16,000; use `client.beta.messages.stream(...)` if you need more. Second, `response.to_param()` is the safe way to keep the block in your history. A plain `block.model_dump()` on a `BetaCompactionBlock` yields `encrypted_content: None` and `tool_changes: None`, fields the API did not return and will reject; if you serialize history to JSON yourself, use `model_dump(exclude_none=True)`.

## Gotchas that cost a request

- **Do not combine features that conflict.** `compaction` and `context_management` cannot appear on the same request, and threshold compaction cannot run on a request that carries a signed block. Pick one compaction style per conversation.
- **Strip parameters the summarizer rejects.** `stop_sequences`, a structured-output `output_config.format`, a `tool_choice` of type `any` or `tool`, and `output_config.task_budget.remaining` all return 400 on a compaction request.
- **Missing header, two different errors.** On the compaction request the 400 says the parameter requires `anthropic-beta: compact-2026-09-04`. On a later request that carries the block, it is a validation error saying `compaction` is not an expected content block type, with no hint that the header is the problem.
- **Retry 529 `compaction_unavailable`.** It is transient, both when producing a block and when reading one you sent back. The SDK's default retries handle it; long loops benefit from the backoff discipline in [retry and backoff for long agent loops](/2026/11/retry-and-backoff-for-long-agent-loops-under-overloaded-and-rate-limit-errors/).
- **Streaming delivers the block whole.** You get one `content_block_start` with the complete block and a `content_block_stop`, with no deltas. Code that only accumulates text deltas will see an empty summary.
- **Count `usage.iterations`, not the top level.** A compaction call reports zero top-level `input_tokens` and `output_tokens`. The billed numbers are in the `compaction` entry of `usage.iterations`. Dashboards that read only the top-level fields will show compaction as free.

## What it costs and when it pays off

The summarization call is billed like any other request on the same model. On `claude-opus-5-5` at $4 per million input tokens and $20 per million output tokens, compacting an uncached 600k-token history with a 3k-token summary costs about $2.40 + $0.06. Sending the block back later adds no compaction cost.

Whether that pays off depends on caching. Uncached, every turn at 600k costs $2.40 in input alone, so a single compaction that shrinks the next ten turns to 60k saves roughly $20. With caching, a 600k-token cache hit on Opus 5.5 costs $0.12 (cache reads are 0.05x the base input price), so the cost argument weakens and the real benefits are staying under the window and keeping the model focused. Note that a compaction also invalidates the cache prefix you had built, so the first turn after a swap writes a new, much smaller cache entry. Add `cache_control` to the block to put a breakpoint right after the summary.

If you would rather not manage the cut yourself, the SDK tool runner can do it: create it with the `compact-2026-09-04` beta and call `runner.compact_before_next_turn()` (optionally with a config holding `instructions`). In 2.6.0 the runner waits until the current turn and its tool calls finish, forks the history into a compaction request without the incompatible parameters, yields the response with `stop_reason == "compaction"`, and continues on the swapped history. It refuses to compact while `context_management` holds a compaction edit. Claude Code users get the same idea packaged as auto-compaction, including a [per-subagent compaction threshold](/2026/10/how-to-give-each-claude-code-subagent-its-own-compaction-threshold-with-autocompactwindow/).

## Related

- [What is a context window and how do agents stretch it in 2026](/2026/10/what-is-a-context-window-and-how-do-agents-stretch-it-in-2026/), for compaction next to context editing, deferred tools and memory.
- [Where to store agent chat history: cost, privacy, portability](/2026/09/where-to-store-agent-chat-history-cost-privacy-portability/), on why a compacted session needs the original transcript stored separately.
- [Migrate from RAG chunking to a 1M-token context window](/2026/08/migrate-from-rag-chunking-to-a-1m-token-context-window/), which adds threshold compaction as a guard for long-context agents.
- [Migrating a coding agent to the 5.5 model family](/2026/10/migrate-a-coding-agent-from-claude-sonnet-4-6-and-opus-4-7-to-the-5-5-model-family/), for the thinking-block rules that make the cut point matter.

## Sources

- [Compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction), Claude Platform Docs.
- [Compaction on demand](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand), for the request shape, swap rules, stop reasons, error table and usage accounting.
- [Compaction that keeps recent turns](https://platform.claude.com/docs/en/build-with-claude/compaction-keep-recent-turns) and [Compaction and preserved thinking](https://platform.claude.com/docs/en/build-with-claude/compaction-thinking-blocks), for choosing the cut.
- [Compaction in the background](https://platform.claude.com/docs/en/build-with-claude/compaction-background), if the loop should keep running while the summary is written.
- [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows) and [Pricing](https://platform.claude.com/docs/en/about-claude/pricing), for window sizes and the Opus 5.5 rates.
- [`anthropic` 2.6.0 on PyPI](https://pypi.org/project/anthropic/2.6.0/), released 2026-11-05, the SDK version the code and the runner behaviour were checked against.
