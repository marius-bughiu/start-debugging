---
title: "Fix: MCP error -32000: Connection closed in Claude Code"
description: "MCP error -32000: Connection closed reports a closed transport in the TypeScript SDK. Diagnose startup failures, later disconnects, paths, stdout and HTTP separately."
updatedDate: 2026-11-02
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "mcp"
  - "claude-code"
  - "ai-agents"
---

`MCP error -32000: Connection closed` means the SDK observed a closed connection while work was pending. For a stdio server, an exited child process is one possible cause. The message does **not** prove the child died, that failure happened during startup, or that every client uses the same numeric error mapping.

> **Correction — November 2, 2026:** Corrected the earlier “process died” definition, removed unsupported failure percentages and testing claims, and replaced an invalid hand-written handshake. The behavior described here was checked against MCP TypeScript SDK 1.29.0.

## What the code establishes

[JSON-RPC reserves -32000 through -32099](https://www.jsonrpc.org/specification#error_object) for implementation-defined server errors. In [TypeScript SDK 1.29.0](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/types.ts), `ConnectionClosed` is `-32000` and `RequestTimeout` is `-32001`.

The SDK's [`Protocol._onclose`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/shared/protocol.ts) rejects outstanding requests when its transport closes. It does not test whether an operating-system process has died. A local test closed an in-memory transport during a pending request and produced `-32000` while the Node process stayed alive. This is why the transport, timing and preceding error matter more than the number alone.

A timeout likewise does not prove the server is alive. It establishes that a request did not complete before its deadline.

## Start with the server entry and timing

```bash
claude --version
claude mcp get my-server
claude --debug
```

In the active session, `/mcp` shows the server state and available recovery actions. Note whether failure occurs before initialization, during discovery, on a tool call, or after an idle period. A separate `claude mcp list` invocation checks configuration and connectivity from that invocation; it is not a direct inspection of another process's live tool registry.

| Observation | Next check |
| --- | --- |
| Executable not found or permission error | Resolve the exact interpreter, arguments and file permissions. |
| Child exits with a stack trace | Fix the reported import, configuration or runtime error. |
| Child stays running but sends no response | Check framing, buffering and initialization rather than assuming the server is healthy. |
| HTTP connection closes later | Inspect server/proxy logs, session state, authentication and network changes. |
| Explicit tool error response | Investigate that tool's failure; a tool error need not close the transport. |

## Check a stdio launch outside the client

Run the registered command with the same working directory and environment. Use `command -v node` on a POSIX shell or `Get-Command node` in PowerShell to locate the intended runtime. An absolute-path entry is useful while diagnosing differences:

```json
{
  "mcpServers": {
    "demo": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/echo-server.mjs"]
    }
  }
}
```

A quiet server waiting for stdin is normal, but it still needs a protocol client to test it. The [complete echo-server example](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/#test-a-server-that-really-exposes-a-tool) registers a tool and can be exercised with Inspector. Merely keeping stdin open with `process.stdin.resume()` does not implement MCP.

On native Windows, follow the [documented `cmd /c` wrapper](https://code.claude.com/docs/en/mcp) for an `npx` shim. Do not assume every launcher is a batch file: `uvx`, for example, can be a native executable. When crossing Windows/WSL, explicitly select the intended environment as described in [the WSL disconnect guide](/2026/05/fix-claude-code-reports-mcp-server-disconnected-inside-wsl/).

## Preserve stdout and use a complete protocol exchange

Under the [published 2025-11-25 stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio), stdout contains newline-delimited MCP messages; logs belong on stderr. An invalid line can produce parsing errors, but the client's handling determines whether it also closes the transport.

Do not use an `echo '{"method":"initialize",...}'` command as a compatibility test. The ellipsis is invalid JSON, required initialization fields are missing, and a short pipe closes stdin immediately. An SDK client keeps the connection open, negotiates a supported version, sends the initialized notification, and can then list and call tools.

The reproducible examples in this series use SDK 1.29.0 and its published `2025-11-25` lifecycle. The [current 2026-07-28 protocol](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning) has a different discovery/versioning flow. Diagnose the actual client/server pair rather than substituting an unsupported version date.

## Treat HTTP and reconnection separately

A TCP `ECONNREFUSED` error occurs before an HTTP or MCP exchange succeeds; see [HTTP readiness and address checks](/2026/05/fix-econnrefused-when-a-local-mcp-server-starts-before-the-client-is-ready/). An HTTP status such as 401, 403 or 404 supplies different evidence from a transport closure. Check authentication, endpoint and session handling rather than replaying every request.

Current [Claude Code reconnection behavior](https://code.claude.com/docs/en/mcp#automatic-reconnection) varies by transport and execution mode. In an interactive session, an exited stdio server can be restarted from `/mcp`; remote servers have automatic retry behavior. A reconnect does not establish that an interrupted tool operation failed before making changes. Verify the result before repeating a tool that writes data.

If an issue persists after a version update, preserve a minimal reproduction, runtime/SDK versions and redacted logs. A historical issue report can suggest a hypothesis, but matching an error string is not evidence that its root cause applies to your server.
