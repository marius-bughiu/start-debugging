---
title: "Fix: Claude Code Drops MCP Tools After Auto-Compaction"
description: "If MCP tools disappear around Claude Code compaction, distinguish a failed connection from deferred tools, authentication, permissions and discovery before reconnecting."
updatedDate: 2026-11-02
pubDate: 2026-06-30
template: error-page
tags:
  - "errors"
  - "mcp"
  - "claude-code"
  - "ai-agents"
---

If MCP tools disappear around auto-compaction, open `/mcp` and check the affected server before clearing the conversation. A failed connection, deferred tool descriptions, authentication problems and a client bug can look similar. The timing alone does not establish that compaction disconnected the server.

> **Correction — November 2, 2026:** Removed an invalid reproduction, an unpublished MCP version, and unsupported claims about registry internals and OAuth loss. Updated the recovery steps to reflect documented reconnection behavior. No compaction-related Claude Code defect was reproduced for this revision.

## Establish what disappeared

Record the Claude Code version and the time of the failure. In the **same interactive session**, use `/mcp` to inspect the server and its tools. Distinguish these observations:

| Observation | What to investigate |
| --- | --- |
| Server failed or disconnected | Launch errors, server exit, network interruption or exhausted retries. |
| Server needs authentication | Reauthenticate through the supported client flow. |
| Server connected, expected tool absent from its advertised list | Server registration, configuration, permissions or discovery behavior. |
| Tool exists but its full schema is not in the current prompt | Tool search/deferred loading; absence from the prompt alone is not disconnection. |
| Tool call returns a permission error | Permission policy, not necessarily transport availability. |

Claude Code's [MCP tool search documentation](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search) explains on-demand tool loading. Asking the model to recite its tools is less reliable than inspecting the server state and attempting discovery of the particular tool.

For a new debug session:

```bash
claude --version
claude mcp get my-server
claude --debug
```

A separate `claude mcp list` can check configuration and connectivity, but it does not expose the internal registry of an already-running conversation.

## Reconnect according to the transport

The current [Claude Code MCP reference](https://code.claude.com/docs/en/mcp#automatic-reconnection) documents automatic retries for remote servers. It separately describes exited stdio servers: in an interactive session, select the server in `/mcp` and choose Reconnect. That is different from supervising an independent HTTP service.

On Claude Code **2.1.284 or later**, an interactive terminal session also supports:

```text
/mcp reconnect all
```

Earlier versions do not support `all` here; use the server's menu. If the server requires authentication, complete that flow rather than repeatedly retrying an expired credential.

After reconnecting, check that the expected tool is advertised and run a harmless read operation. Do not automatically replay an interrupted write: a lost response does not establish whether the operation already took effect.

## If the connection is healthy but the tool is still missing

Check whether the server's tool list changed and whether tool-search or permission settings hide the operation. The current documentation describes refreshing discovery on supported `list_changed` notifications; those details depend on the runtime and server capabilities.

For a persistent client-specific failure, save a short task checkpoint, capture redacted logs, and restart Claude Code. `claude --resume` can restore a conversation while establishing a new client process. This is a diagnostic and recovery attempt, not a guarantee that the underlying problem is fixed.

`/clear` clears conversation context. It should not be presented as a universal command to repair MCP transport state. Use it when a fresh conversation is useful, after preserving information you need.

## Test the hypothesis before blaming compaction

A useful reproduction compares the same tool before and after **manual** `/compact` while recording server logs and whether the process or connection remains alive. Repeat without compaction as a control. Include the exact Claude Code version, transport, SDK/server version and permission settings.

A demo server that exits after a timer only demonstrates process termination. It does not establish a compaction bug. Likewise, a report involving Cowork authentication does not establish the same behavior in a local Claude Code stdio server.

The previous example used an incomplete `setRequestHandler` call and registered no functioning tool. It was not a runnable reproduction and has been removed. For a working baseline, use the [tested echo server](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/#test-a-server-that-really-exposes-a-tool).

## Separate context management from connection health

Reducing oversized outputs and using focused subagents can make a long task easier to manage. It does not prove that an MCP transport will stop disconnecting. Investigate a server's actual idle policy, proxy timeouts, crashes and credentials when the logs point there.

Auto-compaction thrashing is another issue: context repeatedly refills after summarization. Follow the [Claude Code troubleshooting guidance](https://code.claude.com/docs/en/troubleshooting) for that symptom rather than treating it as a network error.

If tools never appeared at startup, use [stdio initialization troubleshooting](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/). If the log reports `-32000`, follow [transport-closure triage](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/). Those observations provide a stronger starting point than the fact that compaction happened nearby.
