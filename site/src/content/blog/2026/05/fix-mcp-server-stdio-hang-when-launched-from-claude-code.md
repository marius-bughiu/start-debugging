---
title: "Fix: MCP Server stdio Hang When Launched From Claude Code"
description: "Why your Model Context Protocol server gets stuck in 'connecting' from Claude Code 2.x and never registers any tools. Covers stdout pollution, the npx install prompt, MCP_TIMEOUT, buffered output, and WSL pitfalls, with verifiable repros."
pubDate: 2026-05-15
tags:
  - "mcp"
  - "claude-code"
  - "ai-agents"
  - "anthropic-sdk"
---

If `claude mcp list` shows your server stuck on `Connecting...` for ten seconds and then nothing happens, or `/mcp` inside Claude Code shows it as connected but with zero tools registered, the stdio transport is wedged. Claude Code 2.1.x (and earlier) does not surface a useful error in this state because, until very recently, the client had no timeout on the MCP initialization handshake at all -- a misbehaving server could leave the host waiting indefinitely, as documented in [anthropics/claude-code#35287](https://github.com/anthropics/claude-code/issues/35287).

This post walks through the five causes responsible for almost every stdio hang report and shows how to verify each one with the MCP Inspector or `claude --debug`. Tested against Claude Code 2.1.128, the MCP TypeScript SDK 1.29.0, the Python SDK 1.13.0, and the MCP spec dated [2026-03-26](https://modelcontextprotocol.io/specification/2026-03-26).

## TL;DR

The stdio transport uses `stdout` exclusively for newline-delimited JSON-RPC. Anything else your process writes to stdout -- a startup banner, a logger that defaulted to stdout, a stray `console.log`, a debugger prompt, an npx install line -- silently corrupts the framing and the client gives up. The five fixes, in order of how often they hit production:

1. Redirect every log line, banner, and dependency stdout write to **stderr**.
2. Add `-y` to any `npx` invocation so the first-run install prompt does not block.
3. Bump `MCP_TIMEOUT` if the server needs more than 30 seconds to come up.
4. Use absolute paths in `command` and pass required environment variables via `env`, not your shell.
5. Disable line buffering for Python servers running under a pipe (`-u` or `PYTHONUNBUFFERED=1`).

## Why the hang is silent

The MCP stdio transport is defined in the [transports section of the spec](https://modelcontextprotocol.io/specification/2026-03-26/basic/transports): the client launches the server as a subprocess, writes JSON-RPC 2.0 messages to its stdin, and parses newline-delimited JSON-RPC messages from its stdout. stderr is reserved for free-form logging that the host can capture without parsing.

That separation is strict. The official debugging guide spells it out:

> Local MCP servers should not log messages to stdout (standard out), as this will interfere with protocol operation.

If your server writes a single non-JSON line to stdout before the `initialize` response, the client's JSON-RPC reader either errors on the unparseable line and drops the connection, or treats the broken frame as a partial message and waits for the rest -- forever. Either way, no tools register, and the only signal you get inside Claude Code is `0 tools` after the connection appears to succeed. That is the entire bug class.

## Scenario: a TypeScript server that hangs on first launch

Start with a server that "works on my machine" via `tsx server.ts` but hangs the moment Claude Code launches it. The `.mcp.json` entry looks innocuous:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"],
      "env": {}
    }
  }
}
```

Run `claude --debug` from the project directory. The debug log will print every JSON-RPC frame it sends and every chunk it receives from the child process. If you see lines like:

```
[MCP my-server] stderr: Welcome to my-mcp-server v0.4.1
[MCP my-server] received non-JSON frame: "Welcome to my-mcp-server v0.4.1"
```

the second line is the problem -- the welcome banner is going to **stdout**, not stderr, and the client dropped the connection. The fix is one-line in TypeScript:

```typescript
// MCP TypeScript SDK 1.29.0
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

console.error("Welcome to my-mcp-server v0.4.1");

const server = new Server(
  { name: "my-mcp-server", version: "0.4.1" },
  { capabilities: { tools: {} } }
);

await server.connect(new StdioServerTransport());
```

Two rules to enforce in code review:

- Replace **every** `console.log`, `console.info`, and `console.debug` in server-side code with `console.error`. The Node SDK's own examples use `console.error` for logging in stdio servers for exactly this reason.
- Audit dependencies. Any library that calls `process.stdout.write` directly -- some progress-bar libraries, some auto-instrumenting OpenTelemetry exporters, anything that hooks `console` -- will silently break the transport. The safest defensive pattern is to reassign `process.stdout.write` to `process.stderr.write` at the top of your entry point, before any imports.

## The npx install prompt that nobody sees

Stdio servers configured via `npx` hang on first launch if the package is not already in the npx cache. `npx` prompts `"Need to install the following packages: ... Ok to proceed? (y)"`. That prompt is written to stdout, blocks waiting for input on stdin, and the MCP client never sees a JSON-RPC frame.

The fix is in the official Claude Code MCP setup guide: pass `-y` to npx so the prompt auto-accepts:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/me/data"
      ]
    }
  }
}
```

The same pattern applies to `pnpm dlx` (use `--package-import`), `uvx` (already non-interactive), and `pipx run` (use `--spec`). On Windows specifically, the prompt also fires the first time SmartScreen sees the npx-installed binary -- if you run Claude Code under a non-interactive service account, that prompt will never resolve.

## MCP_TIMEOUT and the 30-second default

If your server reads a few hundred megabytes from disk on boot, downloads a model, or warms a cache before responding to `initialize`, the client will time out before the handshake finishes. As [anthropics/claude-code#16837](https://github.com/anthropics/claude-code/issues/16837) records, Claude Code reads `MCP_TIMEOUT` from the environment with a default of 30 seconds:

```javascript
// equivalent of what the CLI does internally
const timeout = parseInt(process.env.MCP_TIMEOUT || "", 10) || 30000;
```

Set it globally in `~/.claude/settings.json`:

```json
{
  "env": {
    "MCP_TIMEOUT": "120000",
    "MCP_TOOL_TIMEOUT": "300000"
  }
}
```

`MCP_TIMEOUT` covers the initialization handshake; `MCP_TOOL_TIMEOUT` covers individual tool calls and defaults to a much longer value. Two known limitations to plan around:

- Some Claude Code builds clamp the effective initialization timeout at 60 seconds even when `MCP_TIMEOUT` is set higher -- if a 120000 value still times out at exactly one minute, that is the bug, not your server.
- `claude-code-action` (the GitHub Actions runner) does not propagate `MCP_TIMEOUT` to the spawned CLI subprocess. Tracked as [anthropics/claude-code-action#1152](https://github.com/anthropics/claude-code-action/issues/1152). The workaround is to set the env var on the workflow step, not on the runner.

If you cannot avoid a long warm-up, defer it. Respond to `initialize` immediately and lazy-load resources on the first tool call. The protocol allows that; the timeout policy does not allow you to keep the handshake open.

## Working directory, absolute paths, and missing env vars

The MCP debugging docs are explicit about this:

> The working directory for servers launched via the client's config may be undefined (like `/` on macOS) since the client could be started from anywhere. Always use absolute paths in your configuration and `.env` files to ensure reliable operation.

Three concrete consequences for a hanging server:

1. **Relative path to the server script**. `"command": "./bin/server.js"` from `.mcp.json` resolves against the host's working directory, not the project root. On Claude Desktop that is typically `/` on macOS. The launch fails silently because Claude Code does not currently distinguish "process exited with code 127" from "process is still warming up" in the connecting state.
2. **`.env` files**. A server that calls `dotenv.config()` with no path loads `./.env` from the current working directory -- which, again, is not your project root. Missing API keys then surface as the server hanging at the first network call inside `initialize`. Pass the absolute path: `dotenv.config({ path: path.join(__dirname, ".env") })`.
3. **Environment variables not inherited**. stdio MCP servers inherit only a platform-dependent subset of the parent environment. If your server expects `DATABASE_URL` to be present, declare it explicitly in the config:

```json
{
  "mcpServers": {
    "db-tools": {
      "command": "/usr/local/bin/node",
      "args": ["/abs/path/to/server.js"],
      "env": {
        "DATABASE_URL": "postgres://localhost/dev",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

The same shape is documented in the [MCP debugging guide](https://modelcontextprotocol.io/docs/tools/debugging#environment-variables). For larger surfaces, point `command` at a launcher script that sources the right env file and `exec`s the real server -- but the launcher itself must not print anything to stdout.

## Python servers and buffered stdout

Python's stdout is line-buffered when attached to a TTY and block-buffered when attached to a pipe. Claude Code attaches a pipe. The result: your server writes the `initialize` response with `print(json.dumps(msg))`, the bytes sit in a 4 KB buffer, the client never sees the response, the handshake never completes.

The official MCP Python SDK handles flushing correctly because it writes JSON-RPC frames through its own transport. The hang shows up when people roll their own stdio loop, or when a dependency captures `sys.stdout` and replaces the buffering policy. Two reliable fixes:

```bash
# launcher: force unbuffered Python
python -u server.py
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "py-server": {
      "command": "/abs/path/to/python",
      "args": ["-u", "/abs/path/to/server.py"],
      "env": {
        "PYTHONUNBUFFERED": "1"
      }
    }
  }
}
```

If you implement the protocol by hand, `sys.stdout.write(frame + "\n"); sys.stdout.flush()` after every message is mandatory. The same warning applies to Go (set `os.Stdout` to `bufio.NewWriter` only if you remember to `Flush()`) and to any language that defaults to block buffering on pipes.

## WSL, npm-Windows, and path mismatches

A specific failure mode that produces a confusing "0 tools registered" result on Windows: the MCP server is installed via `npm install -g` inside WSL, but Claude Code is running natively on Windows. The Windows-side `npx` finds a different package (or no package), the launched process exits, and Claude Code reports a clean connection that registered nothing. See [anthropics/claude-code#29443](https://github.com/anthropics/claude-code/issues/29443) for the canonical report.

Two ways out:

- Run Claude Code inside WSL too (`claude` from the same shell where `npx my-mcp-server` works on the command line).
- Or install the server natively on Windows and point `command` at the Windows binary. Do not cross the WSL boundary in the middle of a stdio transport -- the path translation is fragile and the working directory rules in the previous section get worse.

## Verify with the MCP Inspector before you blame the client

When in doubt, take Claude Code out of the loop and use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) -- the official testing UI for both stdio and Streamable HTTP transports:

```bash
# MCP Inspector 0.18.x
npx @modelcontextprotocol/inspector npx -y my-mcp-server
```

Inspector launches your server with the exact same stdio transport Claude Code uses, shows every frame in a message log, and surfaces non-JSON output as unparseable data with the raw bytes. If Inspector connects and lists tools, the bug is in your client configuration (paths, env, npx). If Inspector hangs, the bug is in your server -- and you can iterate on the fix without restarting Claude Code each time.

For a deeper investigation, combine Inspector with `claude --debug` in a second terminal. The two together give you the client side and the server side of the same handshake.

## Gotchas that look like stdio hangs but are not

A few failure modes look like the stdio hang but have different root causes. Worth ruling out before you start auditing logging code:

- **Capability mismatch returns JSON-RPC error `-32602`**. The server declared a capability the client did not negotiate (most commonly sampling or elicitation), and the client rejects the request. The connection looks alive but every tool call fails. The lifecycle and capability sections of the spec cover the [initialize exchange](https://modelcontextprotocol.io/specification/2026-03-26/basic/lifecycle) that has to succeed before any tool registers.
- **Protocol version mismatch**. An older Claude Code build (pre-2.0) speaks MCP `2025-03-26`; an SDK pinned to `2026-03-26` will refuse the handshake instead of negotiating down on some paths. Pin the SDK version that matches your client.
- **Server crash on import**. If your server throws synchronously during module load, the process exits before it ever speaks JSON-RPC. This is not a hang -- it is a crash that the client surfaces as a hang because of the missing timeout discussed earlier. `claude --debug` will show the exit code; without `--debug` you see only the spinner.

## Related

- [Build a custom MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) for the matching server-side blueprint that does logging the right way.
- [Custom MCP server in Python](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) for the buffered-stdout discussion in practice.
- [Custom MCP server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) for the `ILogger` to stderr pattern in the official .NET SDK.
- [Schedule a recurring Claude Code task](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) for the GitHub Actions environment where `MCP_TIMEOUT` propagation matters.
- [Cowork Terminal MCP host](/2026/04/cowork-terminal-mcp-host-terminal-access-for-claude-cowork/) for an example of a non-stdio MCP transport when stdio is the wrong choice for your workload.

## Sources

- [MCP debugging guide -- official docs](https://modelcontextprotocol.io/docs/tools/debugging)
- [MCP stdio transport specification, 2026-03-26](https://modelcontextprotocol.io/specification/2026-03-26/basic/transports)
- [Claude Code troubleshooting page](https://code.claude.com/docs/en/troubleshooting)
- [Claude Code MCP setup docs](https://code.claude.com/docs/en/mcp)
- [anthropics/claude-code#35287 -- stdio servers hang on init failure](https://github.com/anthropics/claude-code/issues/35287)
- [anthropics/claude-code#16837 -- MCP_TIMEOUT 60-second clamp](https://github.com/anthropics/claude-code/issues/16837)
- [anthropics/claude-code-action#1152 -- MCP_TIMEOUT not propagated](https://github.com/anthropics/claude-code-action/issues/1152)
- [anthropics/claude-code#29443 -- Windows/WSL tool registration](https://github.com/anthropics/claude-code/issues/29443)
