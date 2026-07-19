---
title: "Fix: Claude Code misreads an MCP server's stderr startup message as an error"
description: "Claude Code logs every MCP server stderr line at [ERROR] and marks working servers as failed. If your tools still run, it is cosmetic. Here is how to confirm it and quiet the noise."
pubDate: 2026-07-19
template: error-page
tags:
  - "errors"
  - "mcp"
  - "claude-code"
  - "ai-agents"
---

If Claude Code prints `X MCP servers failed` at startup but your tools still work, this is almost certainly a false positive. Claude Code logs every line an MCP server writes to `stderr` at `[ERROR]` level, including normal startup banners and warnings, and then counts that server as failed. Run `/mcp`: if the server shows its tools and a tool call succeeds, nothing is actually broken. The rest of this post shows how to confirm that and, if the noise bothers you, how to silence it without breaking the stdio protocol.

This is tracked as [anthropics/claude-code#17653](https://github.com/anthropics/claude-code/issues/17653), reproduced on Claude Code 2.1.5 and still present in current 2.1.x builds. It affects any stdio MCP server that logs to `stderr` on boot, regardless of language or SDK, because the misclassification happens in the host, not in your server.

## The error in context

You start Claude Code, or run `claude mcp list`, and see a red failure count. In the debug log (`claude --debug`, or `~/.claude/logs/`) the offending lines look like this:

```
2026-01-12T09:19:33.356Z [ERROR] MCP server "plugin:context7:context7" Server stderr: WARNING: Using default CLIENT_IP_ENCRYPTION_KEY.
2026-01-12T09:19:33.431Z [ERROR] MCP server "plugin:context7:context7" Server stderr: Context7 Documentation MCP Server v2.1.0 running on stdio
```

Read the payload after `Server stderr:`. The first line is a `WARNING` about an optional key. The second is a startup banner announcing the server is up and listening on stdio. Neither is an error. Claude Code has wrapped both in an `[ERROR]` envelope and, because it saw output on `stderr` during initialization, decided the server "failed." Meanwhile the server is running fine and its tools are registered.

That is the entire bug: the `[ERROR]` prefix and the "failed" tally come from Claude Code, not from your server reporting a problem.

## Why this happens

The stdio transport splits the two output streams by purpose. `stdout` carries newline-delimited JSON-RPC and nothing else. `stderr` is the free-form log channel. The MCP specification is explicit about how a client should treat `stderr`. From the stdio transport section of the [2025-11-25 spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports):

> The server **MAY** write UTF-8 strings to its standard error (`stderr`) for any logging purposes including informational, debug, and error messages.

And, one bullet down, the rule Claude Code is breaking:

> The client **MAY** capture, forward, or ignore the server's `stderr` output and **SHOULD NOT** assume `stderr` output indicates error conditions.

Well-behaved servers follow the spec exactly. Sending a startup banner or a config warning to `stderr` is the *correct* place to put it, precisely because `stdout` is reserved for protocol frames. If a server logged that banner to `stdout` instead, it would corrupt the JSON-RPC stream and the connection would genuinely hang, which is a different failure covered in [MCP Server stdio Hang When Launched From Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/). So the servers doing the "right" thing are the ones that trip this cosmetic alarm.

Claude Code captures the `stderr` stream (useful, and allowed) but tags every line `[ERROR]` and treats any early output as a startup failure signal. The maintainers closed #17653 as not planned, with the note that it is cosmetic: the servers work despite the message. That leaves the burden on you to tell a false positive apart from a real one.

## Telling a false positive from a real failure

Before you touch any config, confirm which case you are in. A real failure and this cosmetic one produce a similar-looking banner, so verify by behavior, not by the red text.

Open the MCP panel inside Claude Code:

```
/mcp
```

For a false positive you will see the server listed with its tool count greater than zero. Pick a tool and actually call it. If it returns a result, the server is healthy and the "failed" count is noise.

For a comparison against the failure modes that are *not* cosmetic:

- The tool count is zero and the server hangs on `Connecting...`: that is stdout pollution or a startup race, not this bug. See the [stdio hang triage](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/).
- The log shows `MCP error -32000: Connection closed`: the process actually died before the handshake finished. See [Fix: MCP error -32000: Connection closed in Claude Code](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/).
- Every server in your config drops at once: suspect a config parse error, covered in [all MCP servers fail to load after one malformed-JSON syntax error](/2026/07/fix-all-mcp-servers-fail-to-load-after-malformed-json-in-config/).

The distinguishing question is simple: do the tools appear and run? If yes, you are in the cosmetic case and the fixes below are optional cleanup. If no, you have a real connection problem and should follow one of the posts above instead.

## Minimal repro

Here is a five-line stdio server that is 100% healthy and still triggers the `[ERROR]` line. It uses the MCP TypeScript SDK and writes one banner to `stderr` on boot, exactly as the spec permits.

```typescript
// server.ts -- MCP TypeScript SDK 1.29.0, MCP spec 2025-11-25
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "repro", version: "1.0.0" });
server.tool("ping", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));

// Correct per spec: log to stderr, never stdout.
console.error("repro MCP server v1.0.0 running on stdio");

await server.connect(new StdioServerTransport());
```

Register it in `.mcp.json`:

```json
{
  "mcpServers": {
    "repro": {
      "command": "node",
      "args": ["--experimental-strip-types", "server.ts"]
    }
  }
}
```

Start Claude Code and you get `1 MCP server failed`, with a debug line reading `Server stderr: repro MCP server v1.0.0 running on stdio`. Call the `ping` tool and it returns `pong`. The server was never broken. That single `console.error` is the whole cause.

## Fix, in order of recommendation

### 1. Recognize it and move on

If the tools work, the correct action is often no action. The "failed" tally is cosmetic and the servers are functioning. This is the fix that costs nothing and does not risk breaking the protocol. Note the server name from the log, confirm its tools in `/mcp`, and stop treating the red count as a blocker. The other options below only make sense if the noise is actively hiding real errors from you or cluttering a shared setup.

### 2. Quiet the server if you own it

For a server you control, gate the startup banner behind a debug flag so the default path emits nothing on `stderr` until something actually goes wrong.

```typescript
// server.ts -- MCP TypeScript SDK 1.29.0
// Only announce when explicitly debugging; silent by default.
if (process.env.MCP_DEBUG === "1") {
  console.error("repro MCP server v1.0.0 running on stdio");
}
```

Do not "fix" this by moving the banner to `stdout`. That is the one change guaranteed to break you: `stdout` is the JSON-RPC channel, and a stray non-JSON line there corrupts the framing and produces a genuine hang. Keep all logging on `stderr` and simply emit less of it. If your server logs through a library, point that logger at `stderr` (its correct destination) and raise its default level to `warn` or `error` so informational lines never fire during a normal boot.

### 3. Wrap a third-party server and redirect its stderr

For an `npx`/`uvx` server you do not own, such as the Context7 example, you cannot edit its logging. Wrap the launch command so the child's `stderr` goes to a file, leaving `stdout` (the protocol) untouched.

On macOS or Linux, use a small shell wrapper:

```sh
#!/bin/sh
# mcp-context7.sh -- redirect stderr to a log file, keep stdout clean
exec npx -y @upstash/context7-mcp 2>> "$HOME/.mcp-logs/context7.log"
```

On Windows, a `.cmd` wrapper does the same:

```bat
@echo off
REM mcp-context7.cmd -- stderr to a file, stdout stays as the JSON-RPC stream
npx -y @upstash/context7-mcp 2>> "%TEMP%\context7-mcp.log"
```

Then point the config at the wrapper:

```json
{
  "mcpServers": {
    "context7": {
      "command": "/absolute/path/to/mcp-context7.sh"
    }
  }
}
```

The `2>>` redirect only touches file descriptor 2, so JSON-RPC on `stdout` (descriptor 1) is unaffected and tool calls work exactly as before. The tradeoff is that you now have to `tail` that log file to see genuine server errors, since Claude Code no longer sees them. Keep the file, do not send it to `/dev/null`, or you will discard the diagnostics you actually want the day the server does break.

### 4. Lower the server's own log level via env

Many published servers expose an environment variable to reduce logging without a wrapper. Check the server's README for something like `LOG_LEVEL`, `MCP_LOG_LEVEL`, or `QUIET`, and set it through the config `env` block:

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "env": { "LOG_LEVEL": "error" }
    }
  }
}
```

This is cleaner than a wrapper because genuine errors still reach Claude Code, they just stop being drowned out by boot chatter. It only works if the server honors such a variable, so it is not universal, but it is the least invasive option when it applies.

## Gotchas and variants

**Do not chase this by editing `stdout`.** The single most common self-inflicted wound is deciding the banner is the problem and redirecting it to `stdout` to "hide" the error. That corrupts the protocol frame and turns a cosmetic warning into a real hang. Everything logging-related stays on `stderr`.

**A warning during a tool call is not the same thing.** This post is about `stderr` at *startup* being counted as a failed server. If a specific tool call emits a warning mid-session, that line is also tagged `[ERROR]` in the log but does not affect the failure count. Same misclassification, different blast radius, and again cosmetic if the call returns a result.

**Long sessions used to leak memory here.** A related but separate issue was Claude Code buffering MCP `stderr` unbounded, up to tens of megabytes per server over a long session. That has been fixed in recent 2.1.x releases; if you were seeing this bug alongside growing memory use, the memory half is resolved even though the `[ERROR]` labeling is not. For the memory-pressure side, see [Fix: Claude Code high memory usage and context overflow](/2026/07/fix-claude-code-high-memory-usage-and-context-overflow/).

**Plugin-namespaced servers show the same thing.** The reported example was `plugin:context7:context7`, a server delivered through a plugin. The namespacing in the name does not change the behavior; any stdio server behind a plugin logs to `stderr` the same way a top-level one does.

**Other hosts are stricter, or looser.** Because the spec says clients `SHOULD NOT` treat `stderr` as errors, this is a Claude Code presentation choice, not a protocol requirement. Cursor and Claude Desktop capture `stderr` too but do not headline it as a failure count, so the same server can look "failed" in Claude Code and "connected" elsewhere with no change on the server side.

## Related

- [Fix: MCP Server stdio Hang When Launched From Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/) covers the opposite problem: logging to `stdout` instead of `stderr` and genuinely wedging the transport.
- [Fix: MCP error -32000: Connection closed in Claude Code](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/) is the triage for a server process that actually died on launch.
- [Fix: Claude Code Drops MCP Tools After Auto-Compaction](/2026/06/fix-claude-code-drops-mcp-tools-after-auto-compaction/) explains a different "my tools vanished" report that is not a stderr issue.
- [How to Build a Custom MCP Server in TypeScript That Wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) shows where to route logs so you never fight the stdout/stderr split in the first place.
- [MCP stdio vs HTTP vs SSE Transport: Which Should You Choose in 2026?](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) is worth reading if the stdio log handling pushes you toward an HTTP server instead.

## Sources

- [anthropics/claude-code#17653 - MCP servers incorrectly shown as 'failed' when stderr contains non-error output](https://github.com/anthropics/claude-code/issues/17653)
- [Model Context Protocol specification, stdio transport, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Model Context Protocol - Debugging guide](https://modelcontextprotocol.io/docs/tools/debugging)
