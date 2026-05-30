---
title: "Fix: \"Claude reached its tool-use limit for this turn\""
description: "This banner is a pause, not a failure. It maps to the API's pause_turn stop reason (default 10 server-tool iterations). Click Continue, or in code re-send the assistant response. Full fix here."
pubDate: 2026-05-30
template: error-page
tags:
  - "errors"
  - "claude-code"
  - "ai-agents"
  - "llm"
  - "anthropic-sdk"
---

Your agent was halfway through a multi-step task, then it stopped and showed "Claude reached its tool-use limit for this turn" with a Continue button. Click Continue: nothing is lost, the context is intact, and the model picks up exactly where it left off. This is a pause, not an error and not a quota. Under the hood it is the API's `pause_turn` stop reason, which fires when the server-side sampling loop hits its iteration cap (default 10 iterations) while running server tools like web search. If you are driving Claude from code, do not retry from scratch: append the paused assistant response to your `messages` array and send another request.

This is verified against Claude Code 2.x and the Anthropic Messages API on 2026-05-30, with `claude-opus-4-8`, `claude-opus-4-7`, and `claude-sonnet-4-6`, plus the `anthropic` Python SDK and `@anthropic-ai/sdk`. The behavior is documented in the [Anthropic stop reasons reference](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons).

## The message in context

Inside Claude Code, Claude Desktop, or any app built on the agent loop, you see a banner like this mid-task:

```text
Claude reached its tool-use limit for this turn.
[ Continue ]
```

On the raw Messages API the same condition surfaces as a field on an otherwise successful (HTTP 200) response:

```json
{
  "id": "msg_a930390d3a",
  "type": "message",
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Let me keep digging through the results..." },
    {
      "type": "server_tool_use",
      "id": "srvtoolu_01WYG3ziw53XMcoyKL4XcZmE",
      "name": "web_search",
      "input": { "query": "..." }
    }
  ],
  "stop_reason": "pause_turn"
}
```

The tell is `"stop_reason": "pause_turn"` and, often, a `server_tool_use` block with no matching `server_tool_result` after it. The model wanted to keep going but the per-turn loop ran out of iterations.

## Why this happens

A "turn" is one request/response round trip. When Claude calls tools, the runtime keeps looping (call a tool, feed the result back, let Claude decide the next move) until Claude produces a response with no tool calls. To stop a single turn from running forever, that loop has a hard iteration ceiling.

For Anthropic-executed server tools (`web_search`, `web_fetch`, `code_execution`, `tool_search`), the ceiling lives on Anthropic's side and the documented default is 10 iterations per request. Hit it, and the API ends the turn early with `stop_reason: "pause_turn"` instead of `end_turn`. The work so far is real and returned to you; the turn just is not finished.

Desktop and CLI clients add their own per-turn cap on top of this so a single prompt cannot fan out into an unbounded chain of file reads, bash calls, and MCP requests. That client cap is what most people are actually hitting when they see the banner after a long stretch of autonomous work. A [reported regression in early 2026](https://github.com/anthropics/claude-code/issues/33969) dropped one user's effective ceiling from 60 to 80 tool calls per turn down to roughly 20, which is why a workflow that used to run unattended for 45 minutes suddenly started asking for Continue clicks. The fix from your side is the same either way: let the turn resume.

Three things this is NOT, because they get conflated in search:

- It is not a usage or subscription limit. Those lock the session and talk about resetting in N hours.
- It is not an HTTP 429 `rate_limit_error`. That is a real error class with a `retry-after` header, covered in [fixing rate_limit_error in a long agent loop](/2026/05/fix-rate-limit-error-on-claude-sonnet-4-6-in-a-long-agent-loop/).
- It is not the "too many tools defined" problem, where 50-plus MCP tool definitions bloat the prefix. That is about [reducing the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/), a different lever entirely.

## A minimal repro

Give Claude a server tool and a task that needs more than ten search iterations to satisfy, and you can reproduce `pause_turn` deterministically:

```python
# Anthropic Python SDK, claude-opus-4-8, web_search_20260209, 2026-05-30
import anthropic

client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=4096,
    tools=[{"type": "web_search_20260209", "name": "web_search"}],
    messages=[{
        "role": "user",
        "content": (
            "Find the exact release date of every Claude model from "
            "Claude 1 through Opus 4.8, each with a primary source."
        ),
    }],
)

print(response.stop_reason)  # -> "pause_turn"
```

A broad research prompt blows through the 10-iteration server-tool budget before Claude is ready to answer, so the turn pauses.

## The fix, in detail

### 1. In Claude Code or Desktop, click Continue

That is the whole fix for interactive use. Continue re-sends the paused conversation, the iteration counter resets for the new turn, and Claude resumes. Your context window, todo list, and partial work are preserved. There is nothing to undo and nothing to re-prompt.

### 2. In code, re-send the assistant response as-is

When you own the agent loop, handle `pause_turn` the same way the client does: append Claude's paused response to the conversation and call the API again. Do not strip the partial `server_tool_use` block, and do not start over.

```python
# Anthropic Python SDK, claude-opus-4-8, 2026-05-30
def run_until_done(client, user_query, tools, max_continuations=5):
    messages = [{"role": "user", "content": user_query}]

    for _ in range(max_continuations):
        response = client.messages.create(
            model="claude-opus-4-8",
            max_tokens=4096,
            messages=messages,
            tools=tools,
        )

        if response.stop_reason != "pause_turn":
            return response  # end_turn, tool_use, max_tokens, etc.

        # Paused: hand the response back verbatim so Claude continues.
        messages.append({"role": "assistant", "content": response.content})

    return response  # hit the continuation budget; surface it to the caller
```

The TypeScript shape is identical:

```typescript
// @anthropic-ai/sdk, claude-opus-4-8, 2026-05-30
async function runUntilDone(client, userQuery, tools, maxContinuations = 5) {
  const messages = [{ role: "user", content: userQuery }];

  for (let i = 0; i < maxContinuations; i++) {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      messages,
      tools,
    });

    if (response.stop_reason !== "pause_turn") return response;

    messages.push({ role: "assistant", content: response.content });
  }
}
```

Cap the number of continuations. An unbounded `while` loop on `pause_turn` can run up real server-tool costs (web search is billed per search), so a small ceiling with a logged exit is safer than blind resumption.

### 3. In headless and SDK runs, know your turn budget

If you launch Claude Code non-interactively with `-p`, there is no Continue button to click, so a paused turn can look like the agent quietly stopping. The Claude Code SDK exposes `--max-turns` (and `--max-budget-usd`) precisely so unattended runs fail loudly at a known ceiling rather than hanging. Set them deliberately: `--max-turns` counts tool-use turns, so a task that legitimately needs many tool calls needs a budget to match.

```bash
# Claude Code 2.x headless mode, 2026-05-30
claude -p "Triage the open issues and label each one" \
  --max-turns 40 \
  --max-budget-usd 2.00
```

When you schedule agents to run on their own, this matters even more. If you are wiring up cron'd routines, pair a generous turn budget with the patterns in [scheduling a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) so a paused turn never strands a run.

### 4. Scope the prompt so the turn finishes inside the cap

The durable fix is to stop asking for work that needs 30 tool calls in one turn. Split a sprawling task into sequential, narrower prompts: "audit the auth module" then "audit the data layer" beats "audit the whole repo." Each smaller prompt triggers fewer tool calls per turn and is far less likely to pause. This also keeps each turn's context lean, which compounds with [caching multi-turn Claude conversations](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/) to cut cost.

For server tools specifically, you can bound how many times Claude searches with `max_uses`. Note this lowers the ceiling, it does not raise it: set it to stop runaway searching, not to prevent a pause.

```python
# web_search_20250305 with an explicit cap, claude-opus-4-8, 2026-05-30
tools = [{
    "type": "web_search_20250305",
    "name": "web_search",
    "max_uses": 5,  # exceeding this returns a max_uses_exceeded error, not a pause
}]
```

## Gotchas and lookalikes

**pause_turn is not max_tokens.** If `stop_reason` is `max_tokens` and the last content block is an incomplete `tool_use`, the response was truncated by your output budget, not paused by the iteration cap. The fix there is to retry with a higher `max_tokens`, not to continue the conversation.

**An empty `end_turn` is a different bug.** If you get a 2-to-3-token response with `stop_reason: "end_turn"` and no content, you probably added a text block right after a `tool_result`, which teaches Claude to expect user input after every tool call. Send tool results with no trailing text. The [stop reasons reference](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) documents this case in detail.

**Server tools only for the API-level pause.** On the raw Messages API, `pause_turn` is specific to Anthropic-executed server tools. Your own client tools return `stop_reason: "tool_use"`, which you handle by executing the tool and posting a `tool_result`. The Claude Code banner can appear for either, because the client wraps both kinds of tools in one per-turn loop.

**Continue does not re-run finished work.** A common worry is that clicking Continue or re-sending the response will repeat tool calls that already ran. It will not. The completed `server_tool_use` and `server_tool_result` blocks are part of the history you send back, so Claude treats that work as done and moves forward.

## Related reading

- [Fixing rate_limit_error on Claude Sonnet 4.6 in a long agent loop](/2026/05/fix-rate-limit-error-on-claude-sonnet-4-6-in-a-long-agent-loop/) for the 429 that actually is an error.
- [Reducing the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/) for the other thing people call "the tool-use limit."
- [Caching multi-turn Claude conversations across API calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/) to keep each resumed turn cheap.
- [Scheduling a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) for setting turn budgets on unattended runs.
- [Adding prompt caching to an Anthropic SDK app and measuring the hit rate](/2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate/) so long, multi-continuation turns stay affordable.

## Sources

- [Handling stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) - the `pause_turn` definition, the 10-iteration default, and the continuation loop.
- [Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) - the `max_uses` parameter and `max_uses_exceeded` error code.
- [Tool use with Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) - client tools (`tool_use`) versus server tools (`pause_turn`).
- [claude-code issue #33969](https://github.com/anthropics/claude-code/issues/33969) - the per-turn tool-call cap regression report.
