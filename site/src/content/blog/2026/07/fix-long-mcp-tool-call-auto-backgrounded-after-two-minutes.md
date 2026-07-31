---
title: "Fix: A Long MCP Tool Call Gets Auto-Backgrounded After Two Minutes Mid-Task"
description: "Claude Code 2.1.212+ moves any main-conversation MCP tool call still running at two minutes into a background task. Set CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0 to stop it, raise the threshold to move the line, or send progress notifications from the server."
pubDate: 2026-07-31
tags:
  - "claude-code"
  - "mcp"
  - "ai-agents"
  - "errors"
---

Your MCP tool starts a build, a migration, or a long database query, and about two minutes in Claude stops waiting for it and starts doing something else. The call did not fail and the server was never disconnected: on Claude Code 2.1.212 or later, an MCP tool call in the main conversation that is still running after two minutes moves to a background task, Claude gets the task ID immediately, and the real result lands later as a task notification. If you want the old blocking behaviour back, set `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`. If you just want a longer leash, set it to the number of milliseconds you actually need. This is written against Claude Code 2.1.219 on `claude-sonnet-5`, with the MCP spec revision `2026-07-28`.

## What actually happens at the two-minute mark

Nothing is aborted. Claude Code takes the in-flight `tools/call` request, hands the model a task handle for it, and lets the model keep working on the rest of the turn. The underlying JSON-RPC request is still open against your server, the server is still computing, and when it finally answers, the result is delivered back into the session as a task notification rather than as the return value of the tool call the model made two minutes earlier.

Three properties of that background task matter when you are debugging:

- It shows up in `/tasks`, which lists the current session's background work. You can stop it from there.
- It does not survive exiting the session. Quit Claude Code and the pending call is gone, even if your server would have answered thirty seconds later.
- The per-call limits keep running while it is backgrounded. Backgrounding changes what blocks the session, not how long the call is allowed to live.

That last point is the one people get wrong. Auto-backgrounding is not a timeout extension. It is a scheduling change layered on top of the timeouts that were already there.

## Why it reads like a failure

The symptom that brings people here is usually not "my call was backgrounded". It is one of four downstream effects.

**The model answers before the result exists.** Claude receives a task ID, not your data. If the surrounding prompt does not make it obvious that the value is pending, the model will happily continue and reason about a build it has not seen the output of. When the notification arrives it corrects itself, which reads like the model changing its mind for no reason.

**Ordering looks scrambled in transcripts.** The tool call and its real result are now separated by however much work happened in between. If you are parsing `stream-json` output or reading a session log, the `tool_result` you expected next is somewhere else entirely.

**Nothing happens at all in a one-shot run.** In non-interactive mode, auto-backgrounding is off by default, because a `claude -p` run can finish and exit before the notification arrives. That is the sane default, but it means a workflow you debugged interactively can behave differently in CI, in both directions.

**Subagent calls never move.** Claude Code backgrounds only main-conversation calls. The same MCP tool that gets backgrounded when you call it directly will block for its full duration inside a subagent. If you delegate the slow work, as in [Claude Code skills vs subagents vs MCP servers](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/), you get blocking semantics back without configuring anything.

## Four timers, and only one of them is two minutes

Most of the confusion in this area comes from treating "MCP timeout" as a single number. On Claude Code 2.1.219 there are four separate clocks on a tool call, and they do different things:

| Clock | Default | Set with | What happens when it fires |
| --- | --- | --- | --- |
| Auto-background threshold | 2 minutes | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` | Call moves to a background task, keeps running |
| Idle window | 5 min HTTP/SSE/WS, 30 min stdio | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` | Call is aborted with an error |
| Wall clock per call | per-server `timeout`, else `MCP_TOOL_TIMEOUT` | `.mcp.json` `timeout`, `MCP_TOOL_TIMEOUT` | Call is aborted |
| First-byte timer (HTTP/SSE/connectors only) | 60 seconds | raised by `timeout` or `MCP_TOOL_TIMEOUT` >= 60000 | Request fails before your handler ever answers |

The idle window is the one that usually kills a genuinely long call. It requires Claude Code 2.1.187 or later, and since 2.1.203 it applies to every server type except IDE servers and SDK in-process servers. A tool call that sends no response and no progress notification for the whole window aborts with an error instead of waiting for the wall clock. Before 2.1.203, stdio servers were exempt, which is why a server that used to run for an hour under stdio may now die at the thirty-minute mark after an upgrade.

The wall clock is the loosest of the four. The per-server `timeout` field is a hard wall-clock limit per call, and progress notifications do not extend it. Values below `1000` are ignored and fall through to `MCP_TOOL_TIMEOUT`, or, per the Claude Code MCP reference, to a default of about 28 hours when that variable is unset. In other words, if you never set `MCP_TOOL_TIMEOUT`, the wall clock is effectively not your limit and the idle window is.

The first-byte timer is the sharp edge nobody expects. For HTTP, SSE, and claude.ai connector servers there is a second timer covering each request through to the server's first response byte, and it is 60 seconds unless you raise it. Setting the per-server `timeout` or `MCP_TOOL_TIMEOUT` to 60000 or higher raises it to that value; a lower value does not shorten it, and the unset 28-hour default never feeds it. So an HTTP MCP server that computes for 90 seconds and then writes a single JSON response fails at 60 seconds no matter how generous your other settings look. Stdio and WebSocket servers have no first-byte timer, which is one more reason the transport choice matters. If you have not made that call yet, see [MCP stdio vs HTTP vs SSE transport](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/).

## Turning auto-backgrounding off, or moving the line

The threshold is a plain millisecond value in an environment variable.

```bash
# Claude Code 2.1.212 or later.

# Never auto-background an MCP tool call. Restores pre-2.1.212 blocking.
export CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0

# Or block for ten minutes before moving the call to a task.
export CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=600000

claude
```

Setting `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` also turns it off, but it takes every other background-task feature with it, so reach for it only if that is what you want. The narrower variable is almost always the right one.

To make it stick for a repo rather than a shell, put it in the project settings so everyone on the team gets the same behaviour:

```json
// .claude/settings.json, Claude Code 2.1.212 or later
{
  "env": {
    "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS": "0"
  }
}
```

Turning it off does not make the call unlimited. It makes the call block until one of the other three clocks fires. If your tool genuinely runs for twenty minutes, you need to raise those too, and you should do it per server rather than globally:

```json
// .mcp.json, Claude Code 2.1.203 or later
{
  "mcpServers": {
    "build-farm": {
      "command": "node",
      "args": ["./servers/build-farm/dist/index.js"],
      "timeout": 1800000
    }
  }
}
```

That `timeout` of 1800000 does two jobs. It sets a 30-minute hard wall clock for this server only, overriding `MCP_TOOL_TIMEOUT`, and since 2.1.203 a per-server `timeout` of at least 1000 also acts as a floor on the idle timeout, so Claude Code will not abort this server's calls for idleness sooner than 30 minutes. That floor is the cleanest way to give one slow server room without loosening the idle check for every other server you have connected.

## The better fix: make the server talk while it works

Turning off the threshold treats the symptom. A long-running tool that says nothing for ten minutes is also invisible to the user, indistinguishable from a hung server, and the first thing to die when the idle window shrinks in a future release. The protocol already has the answer: progress notifications.

The client includes a `progressToken` in `_meta` on the request, and the server sends `notifications/progress` referencing that token. Claude Code treats any progress notification as activity, which resets the idle window. It does not extend the wall clock, and it does not stop auto-backgrounding, but it is what keeps a genuinely long call alive.

```typescript
// @modelcontextprotocol/sdk v2.x, MCP spec revision 2026-07-28
server.registerTool(
  "run_migration",
  {
    title: "Run migration",
    description: "Applies pending migrations to the target database.",
    inputSchema: { target: z.string() },
  },
  async ({ target }, extra) => {
    const steps = await pendingMigrations(target);

    for (const [i, step] of steps.entries()) {
      await applyMigration(step);

      // progress MUST increase on every notification, even if total is unknown.
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: extra._meta?.progressToken,
          progress: i + 1,
          total: steps.length,
          message: `Applied ${step.name}`,
        },
      });
    }

    return { content: [{ type: "text", text: `Applied ${steps.length} migrations.` }] };
  },
);
```

Two rules from the spec are easy to get wrong and both cause silent breakage. `progress` must strictly increase across notifications for a given token, even when `total` is unknown, and notifications must reference only a token that came in on an active request. If `extra._meta?.progressToken` is undefined, the client did not ask for progress and you should skip the notification rather than invent a token. Both sides are also expected to rate-limit, so do not emit one notification per row of a million-row import.

## Headless runs, CI, and scheduled agents

In non-interactive mode auto-backgrounding is off unless you opt in. Set `CLAUDE_AUTO_BACKGROUND_TASKS=1` to enable it there on 2.1.212 or later:

```bash
# Claude Code 2.1.212 or later, non-interactive run.
CLAUDE_AUTO_BACKGROUND_TASKS=1 \
  claude -p "Kick off the nightly index rebuild and report when it finishes" \
  --output-format stream-json
```

Think hard before you do. A `claude -p` invocation ends when the turn ends. If the model finishes reasoning before your fifteen-minute rebuild answers, the process exits and the notification is delivered to nobody. For CI the safer shape is to leave auto-backgrounding off, raise the per-server `timeout` for the slow server, and let the call block, which is exactly the shape used in [a background coding agent that auto-commits and opens a draft PR](/2026/07/run-a-background-coding-agent-that-auto-commits-and-opens-a-draft-pr/). If you are parsing the JSON stream from a headless run that does have backgrounding on, the same demultiplexing problem described in [streaming nested subagent output from a headless run](/2026/07/stream-nested-subagent-output-from-a-headless-claude-code-run/) applies here: correlate on the task ID, not on message order.

## Variants that look like this but are not

**Your server never connected in the first place.** If tools never appear and the server sits in "connecting", you have a startup problem, not a tool-call problem. `MCP_TIMEOUT` governs server initialization and defaults to 30 seconds on 2.1.175 or later; it has nothing to do with how long a tool call may run. The usual causes are covered in [MCP server stdio hang when launched from Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/).

**The call is blocked on you, not on the server.** A call waiting on an open elicitation dialog is not backgrounded while the dialog is open. Claude Code defers the move until the dialog closes, on the reasoning that the server is blocked on your input rather than being slow. If a call seems stuck past two minutes and never moves, check for a prompt you have not answered.

**The result came back and got truncated.** That is the output limit, not a timer. Claude Code warns above 10,000 tokens of MCP output and caps it by default; raise it with `MAX_MCP_OUTPUT_TOKENS` or have the tool declare `anthropic/maxResultSizeChars`. Dumping a huge payload into the window has its own downstream cost, described in [Claude Code autocompact thrashing on large tool output](/2026/07/fix-claude-code-autocompact-thrashing-on-large-file-or-tool-output/).

**A per-server `timeout` you set below 1000 did nothing.** Values under 1000 are ignored and fall through to `MCP_TOOL_TIMEOUT`. On versions before 2.1.162 they were floored to one second instead, so the same config behaves differently across an upgrade.

## Where this is heading: MCP Tasks

Claude Code's auto-backgrounding is a client-side workaround for a protocol gap: `tools/call` is synchronous, so something has to hold the request open. The protocol is closing that gap with the Tasks extension, introduced as SEP-1686 in the `2025-11-25` revision and now specified in the `modelcontextprotocol/ext-tasks` repository.

Under Tasks, the server decides a request will be long-running and returns a `CreateTaskResult` with `resultType: "task"`, carrying a `taskId`, an initial status, a `ttlMs`, and a suggested `pollIntervalMs`. The client polls `tasks/get` until the status reaches a terminal value (`completed`, `failed`, or `cancelled`), can send `tasks/cancel` at any time, and can answer mid-flight elicitations through `tasks/update` when the status is `input_required`. Because the task ID is durable, a client that disconnects and reconnects can resume polling, which is precisely the thing Claude Code's in-session background task cannot do today.

Tasks is an extension, negotiated per request through `io.modelcontextprotocol/tasks` in the client capabilities and advertised by the server in `server/discover`, and it is still experimental with uneven client support. It is not something to build a production server around this month. But if you are designing an MCP server whose tools routinely run for minutes, it is the shape to design toward, and in the meantime progress notifications plus a per-server `timeout` cover the same ground.

## Related

- [MCP stdio vs HTTP vs SSE transport: which should you choose](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/)
- [Fix: MCP server stdio hang when launched from Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/)
- [Claude Code skills vs subagents vs MCP servers: when to build each](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/)
- [Fix: Claude Code autocompact thrashing on a large file or tool output](/2026/07/fix-claude-code-autocompact-thrashing-on-large-file-or-tool-output/)
- [How to run a background coding agent that auto-commits and opens a draft PR](/2026/07/run-a-background-coding-agent-that-auto-commits-and-opens-a-draft-pr/)

## Sources

- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp), specifically the MCP tool timeouts and automatic backgrounding of long tool calls sections.
- [Claude Code environment variables reference](https://code.claude.com/docs/en/env-vars) for `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, `MCP_TOOL_TIMEOUT`, `MCP_TIMEOUT`, and `CLAUDE_AUTO_BACKGROUND_TASKS`.
- [MCP specification 2026-07-28: progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/progress) for the `progressToken` and `notifications/progress` contract.
- [MCP specification: tasks](https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/tasks) and the [ext-tasks repository](https://github.com/modelcontextprotocol/ext-tasks) for the Tasks extension.
- [anthropics/claude-code issue #31427](https://github.com/anthropics/claude-code/issues/31427) and [issue #23611](https://github.com/anthropics/claude-code/issues/23611), the feature requests this behaviour came out of.
