---
title: "Fix: MCP error -32000: Connection closed in Claude Code"
description: "MCP error -32000 means your MCP server process exited before the handshake finished. Fix the missing binary, the Windows cmd /c wrap, the event-loop exit, and the startup race."
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "mcp"
  - "claude-code"
  - "ai-agents"
---

`MCP error -32000: Connection closed` means the server process Claude Code spawned exited before the JSON-RPC handshake finished. It is not a timeout and not a refused socket: the child died. The fix in 90% of cases is one of three things: the `command` binary does not exist (use an absolute path), you are on Windows and `npx`/`uvx` was not wrapped in `cmd /c`, or the server crashed on boot (run the command by hand and read the stack trace).

The rest of this post is the full triage. Everything here is tested against Claude Code 2.1.x, the MCP TypeScript SDK 1.x, the MCP Python SDK 1.x, and the MCP specification dated [2026-03-26](https://modelcontextprotocol.io/specification/2026-03-26). The same error and the same fixes apply to Claude Desktop, Cursor, Cline, and anything else built on the official SDK, because the error is raised inside the SDK, not inside Claude Code.

## The error in context

You see it in `/mcp`, in `claude mcp list`, or in the debug log. The fully expanded form is a `McpError` with code `-32000`:

```
McpError: MCP error -32000: Connection closed
    at Client._onclose (.../@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:130:23)
    at _transport.onclose (.../@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:76:18)
    at ChildProcess.<anonymous> (.../@modelcontextprotocol/sdk/dist/esm/client/stdio.js:95:77)
```

In the Claude Code debug log it looks like this, with a connection time that is far below the 30 second timeout:

```
[DEBUG] MCP server "mysql": Starting connection with timeout of 30000ms
[DEBUG] MCP server "mysql": Connection failed after 6544ms: MCP error -32000: Connection closed
```

Some clients render the same code with a different message string, including `Client Closed` and `Transport closed`. They are all the same condition: code `-32000`.

## What -32000 actually is

JSON-RPC 2.0 reserves the range `-32000` to `-32099` for "implementation-defined server errors." The MCP SDKs use the top of that range for their own transport-level codes. In the TypeScript SDK the `ErrorCode` enum maps `-32000` to `ConnectionClosed` and `-32001` to `RequestTimeout`. That distinction is the single most useful fact for triage:

- **-32001 (`RequestTimeout`)** means the server is alive but did not answer in time. That is the hang, and it is a different bug covered in [the stdio hang post](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/).
- **-32000 (`ConnectionClosed`)** means the transport's `onclose` fired. For a stdio server, that fires when the child process exits. The stack trace above is literal proof: the call originates in `ChildProcess.<anonymous>` inside `client/stdio.js`, the handler the SDK attaches to the child process `exit`/`close` event.

So `-32000` is never "the server is slow." It is "the process Claude Code launched is gone." The whole job is finding out why it left.

There is a sharp edge worth knowing if you embed the SDK client yourself rather than going through Claude Code. As reported in [modelcontextprotocol/typescript-sdk#1049](https://github.com/modelcontextprotocol/typescript-sdk/issues/1049), when the spawned server exits unexpectedly the `-32000` rejection from `Client._onclose` is unhandled, which triggers `triggerUncaughtException` and terminates the entire host Node process with exit code 1. If your own tool dies whenever an MCP server crashes, wrap the connect in a `try/catch` and attach an `onclose` handler rather than letting the rejection escape.

## The fastest reproduction: run the command yourself

Before touching any config, take Claude Code out of the loop. Open `claude mcp list`, copy the exact `command` and `args` for the failing server, and run them in a terminal:

```bash
# Claude Code 2.1.x: print the registered command, then run it verbatim
claude mcp list
node /abs/path/to/server.js
```

One of two things happens, and each points straight at the cause:

- The process **prints a stack trace and exits**. That is your bug. A missing module, a Node version mismatch, a thrown error during import, a missing environment variable read at module load. Fix the crash and the connection follows.
- The process **starts and then returns to the shell prompt immediately** without an error. That is the quieter cause covered below: nothing is keeping the event loop alive, so the process exits cleanly the moment startup finishes.
- The process **stays running and waits for input**. Good. The server is fine, and the problem is in how Claude Code launches it (path, Windows shim, working directory, or the race). Press Ctrl+C and keep reading.

## Cause 1: the binary does not exist where Claude Code looks

This is the most common `-32000` and the most boring. The `command` field resolves against the host's `PATH` and working directory, neither of which is guaranteed to be your shell's. A server launched as `node` works in your terminal because `node` is on your interactive PATH, but Claude Code launched from a GUI, a service account, or a different shell may not have it. The child fails to exec, the OS returns exit code 127, the transport closes, you get `-32000`.

The fix is absolute paths for both the interpreter and the script:

```json
// .mcp.json, Claude Code 2.1.x. Absolute paths remove all PATH ambiguity.
{
  "mcpServers": {
    "db-tools": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/me/servers/db-tools/dist/server.js"],
      "env": {
        "DATABASE_URL": "postgres://localhost/dev"
      }
    }
  }
}
```

Find the absolute path with `which node` (macOS/Linux) or `where node` (Windows) and paste the result. The same applies to `python`, `uv`, `deno`, and any other launcher. While you are there, declare every environment variable the server needs in `env`, because stdio servers inherit only a platform-dependent subset of the parent environment, and a missing key read at boot is a crash, which is a `-32000`.

## Cause 2: Windows, where npx and uvx are not executables

This is the dominant Windows cause and it surprises people because the identical config works on macOS. On Windows, `npx`, `npm`, `uvx`, and `pnpm` are not real executables. They are `.cmd` batch shims. The Node `child_process.spawn` call the SDK uses cannot exec a `.cmd` file directly without a shell, so the spawn fails, the child never starts, and the transport closes immediately with `-32000`.

The fix is to run the shim through the command interpreter explicitly:

```json
// .mcp.json on Windows, Claude Code 2.1.x.
// cmd /c gives Windows a shell that can resolve the npx batch shim.
{
  "mcpServers": {
    "filesystem": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:\\Users\\me\\data"
      ]
    }
  }
}
```

Recent Claude Code builds wrap known shims automatically, but custom configs, hand-written `.mcp.json` files copied from a macOS tutorial, and older builds still hit this. If you are on Windows and the macOS instructions you followed used a bare `npx`, this is almost certainly your bug. The `-y` flag is still required so the first-run install prompt does not block on stdin, the same pollution issue described in [the stdio hang post](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/). If your servers broke specifically after a Claude Desktop update on Windows, the config path also moved, which is a separate failure covered in [the Windows config-path post](/2026/06/fix-mcp-servers-stop-working-after-claude-desktop-update-on-windows/).

## Cause 3: a custom Node server that exits because nothing holds the event loop

If you wrote your own server and `node server.js` returns to the prompt with no error, the event loop drained. Node exits when it has no pending work, and a server that finished its synchronous startup but never registered an active handle has nothing pending. The official `StdioServerTransport` keeps the process alive by reading stdin, so servers built on the SDK do not hit this. Hand-rolled stdio loops and servers that construct the transport conditionally do.

The minimal correct server keeps stdin open by connecting the transport, and that is enough:

```typescript
// MCP TypeScript SDK 1.x, Node 20+
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  { name: "my-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// connect() attaches a reader to process.stdin, which keeps the loop alive.
await server.connect(new StdioServerTransport());
```

If you are not using the SDK transport, or you have a wrapper that does setup work and then would otherwise fall through, pin stdin open yourself:

```javascript
// Node: prevent the process from exiting after startup completes
process.stdin.resume();
```

The Python equivalent is to run the server inside the SDK's `stdio_server()` context manager and `anyio.run` the coroutine, which blocks on stdin for you. If you roll your own read loop, it must block, not return.

## Cause 4: stdout pollution that closes the stream

The stdio transport uses stdout exclusively for newline-delimited JSON-RPC. A banner, a stray `console.log`, or a dependency that writes to stdout corrupts the frame. The usual symptom is the silent hang ("0 tools registered"), but when the corrupted frame causes the client's reader to throw and tear down the transport, you get `-32000` instead. If running the server by hand prints anything that is not JSON before the `initialize` response, route it to stderr:

```typescript
// MCP TypeScript SDK 1.x: logging goes to stderr, never stdout
console.error("starting my-server v1.0.0");
```

The full stdout-pollution checklist, including dependencies that hook `process.stdout.write` and Python's block-buffering trap, lives in [the stdio hang post](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/). Treat that post as canonical for this cause.

## Cause 5: the startup race that closes the handshake early

A smaller but real class of `-32000` is a genuine race inside the client. As tracked in [anthropics/claude-code#20713](https://github.com/anthropics/claude-code/issues/20713), some users on Claude Code 2.1.19 with Node v25 saw the connection fail with `-32000` after several seconds even though the server worked perfectly when driven by hand:

```bash
# the server answers a manual handshake correctly
echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | node index.js
# returns a valid initialize response with tools
```

The reporter ruled out the server by reproducing the failure across four different MySQL MCP packages and a from-scratch server with no stdout output. When the server is provably healthy in isolation and only fails under Claude Code, you are likely on the client-side race rather than a server bug. Two things help: pin Node to an even-numbered LTS (20 or 22) rather than an odd-numbered current release, and update Claude Code, since the timing window has been narrowed in releases after 2.1.19. If it persists, capture a `claude --debug` log and attach it to the tracking issue rather than rewriting your server, which will not fix a client race.

## The diagnostic order that gets you there fastest

Walk these in order and you will land on the cause in under two minutes:

1. **Read the code.** `-32000` is process-died, `-32001` is timeout. If it is `-32001`, stop here and read the [stdio hang post](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/) instead. A refused HTTP socket (`ECONNREFUSED`) is a third thing entirely, covered in [the ECONNREFUSED post](/2026/05/fix-econnrefused-when-a-local-mcp-server-starts-before-the-client-is-ready/).
2. **Run the command by hand** from `claude mcp list`. Crash with a stack trace means Cause 1 or a boot error. Clean exit to the prompt means Cause 3. Stays running means a launch problem.
3. **On Windows, check for a bare `npx`/`uvx`.** Wrap it in `cmd /c` (Cause 2).
4. **Make every path absolute** and declare env vars in the config (Cause 1).
5. **Run `claude doctor`.** It surfaces most misconfigurations, including PATH and config-file problems, in one pass.
6. **Drop to the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)** if the server still misbehaves. It launches your server with the same stdio transport and shows the exit code and every frame, so you can iterate without restarting Claude Code.

If the Inspector connects and lists tools but Claude Code does not, the bug is in the Claude Code config or the launch environment, not your server. If the Inspector also reports `-32000`, the bug is in the server, and step 2 already told you which line it died on.

## Gotchas that look like -32000 but are not

- **The connection drops minutes later, not at launch.** That is a server crash mid-session or an idle-disconnect, not a launch failure. Look at what the server was doing when it closed, not at the launch config.
- **WSL path mismatches.** A server installed inside WSL but launched by a native-Windows Claude Code can exit instantly because the Windows side finds a different binary or none. That specific cross-boundary failure is covered in [the WSL disconnect post](/2026/05/fix-claude-code-reports-mcp-server-disconnected-inside-wsl/).
- **Too many tools, not a closed connection.** If the server connects fine but Claude refuses to load it, you may be hitting the tool-count ceiling, which is a different problem with a different fix in [the reduce-MCP-tools post](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/).

The throughline for `-32000` is simple: the process you launched is not running anymore. Find out whether it never started (Cause 1, 2), started and quit (Cause 3), or started and was killed by its own output or a client race (Cause 4, 5). Run the command by hand first, and the SDK's own stack trace will point at the line that closed the transport.

## Sources

- [modelcontextprotocol/typescript-sdk#1049 -- stdio client crashes with -32000 when the spawned server exits](https://github.com/modelcontextprotocol/typescript-sdk/issues/1049)
- [anthropics/claude-code#20713 -- connection fails with -32000 (race condition)](https://github.com/anthropics/claude-code/issues/20713)
- [MCP specification 2026-03-26: transports](https://modelcontextprotocol.io/specification/2026-03-26/basic/transports)
- [MCP debugging guide -- official docs](https://modelcontextprotocol.io/docs/tools/debugging)
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
- [MCP Inspector -- official testing UI](https://modelcontextprotocol.io/docs/tools/inspector)
- [JSON-RPC 2.0 specification: error object and the server-error range](https://www.jsonrpc.org/specification#error_object)
