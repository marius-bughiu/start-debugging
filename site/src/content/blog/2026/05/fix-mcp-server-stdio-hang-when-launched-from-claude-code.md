---
title: "Fix: MCP Server stdio Hang When Launched From Claude Code"
description: "Diagnose MCP stdio startup failures: separate protocol stdout from logs, use a complete SDK server, check launch paths and buffering, and configure startup timeouts."
updatedDate: 2026-11-02
pubDate: 2026-05-15
tags:
  - "mcp"
  - "claude-code"
  - "ai-agents"
  - "anthropic-sdk"
---

A server that stays on `Connecting` or connects without the expected tools needs two separate checks: did its transport initialize, and did tool discovery return the tools you implemented? Neither symptom alone proves stdout corruption or a client bug.

> **Correction — November 2, 2026:** Replaced the unpublished `2026-03-26` specification reference and unsupported release-wide claims. Removed advice to redirect all stdout to stderr, which would also redirect valid protocol responses. The SDK example below was exercised locally; this is not a claim of end-to-end testing in every Claude Code version.

## Know which protocol you are debugging

The runnable example uses **MCP TypeScript SDK 1.29.0**, whose source lists `2025-11-25` as its latest supported protocol revision. In that [published lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), the client sends `initialize`, accepts a supported negotiated version, then sends `notifications/initialized` before normal operations such as `tools/list`.

The [current specification](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning) is `2026-07-28`, which uses per-request version declarations and `server/discover`. Current Claude Code can use either its v1 or v2 MCP runtime. Do not paste a different date into a hand-written handshake and assume compatibility; inspect the SDK and negotiated protocol involved.

## Keep protocol messages on stdout

The [2025-11-25 stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio) carries one JSON-RPC message per line on stdout. Log text belongs on stderr:

```javascript
console.error('Starting the MCP server');
```

Configure application loggers, progress output and dependencies accordingly. Do **not** replace `process.stdout.write` globally or launch the whole server with `1>&2`: the SDK needs stdout for its responses. Non-protocol stdout is a protocol violation, but the observable consequence depends on the client's parser; it is not guaranteed to produce a silent infinite hang.

## Test a server that really exposes a tool

In a temporary project, install the pinned SDK and its schema dependency:

```bash
npm init -y
npm install @modelcontextprotocol/sdk@1.29.0 zod@4
```

Save this as `echo-server.mjs`:

```javascript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-demo', version: '1.0.0' });
server.registerTool('echo', {
  description: 'Return the supplied text.',
  inputSchema: { text: z.string() }
}, async ({ text }) => ({ content: [{ type: 'text', text }] }));
console.error('Starting echo-demo');
await server.connect(new StdioServerTransport());
```

The `registerTool` call matters. Advertising a tools capability without implementing discovery and calls does not create a usable tool. The local check for this article initialized the server, listed `echo`, called it with `{"text":"hello"}`, and received `hello`. The startup message was captured separately on stderr.

To inspect your own server interactively, use the official [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx -y @modelcontextprotocol/inspector@2.13.0 node /absolute/path/echo-server.mjs
```

Compare launch arguments, working directory, environment and negotiated version with Claude Code. Success in Inspector narrows the investigation; it does not prove every client-specific interaction is correct.

## Remove launcher uncertainty

Inspect the configured server and start a debug session:

```bash
claude mcp get my-server
claude --debug
```

Use absolute interpreter and script paths when diagnosing PATH or working-directory differences. Supply required variables explicitly or through a trusted launcher, without committing secrets to a shared `.mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/echo-server.mjs"],
      "env": { "MY_API_TOKEN": "${MY_API_TOKEN}" }
    }
  }
}
```

Variable expansion and configuration scopes are client features, not MCP wire-protocol requirements. Check the [Claude Code MCP configuration documentation](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson) for their behavior in your version.

If using a trusted package through `npx`, `-y` avoids its install confirmation. Other package runners have different flags; `pipx --spec` and package-import options are not equivalent “disable prompts” switches. Native Windows `npx` may require the documented `cmd /c` wrapper. A Windows launcher cannot directly use an interpreter installed only inside WSL; see [the WSL setup guide](/2026/05/fix-claude-code-reports-mcp-server-disconnected-inside-wsl/).

## Distinguish startup timeout from tool timeout

Claude Code documents `MCP_TIMEOUT` in milliseconds for startup. For a server whose measured initialization is legitimately slow:

```bash
MCP_TIMEOUT=120000 claude
```

Set it on the Claude Code process, not just in the server's `env` block. Tool execution has separate timeout settings. Do not assume one historical default or reported timeout bug applies to every 2.x release. A timeout only establishes that a deadline elapsed; the server may be busy, blocked, unreachable or already unhealthy.

Keep avoidable downloads and expensive initialization out of startup where practical, while returning accurate capabilities and tool errors if a resource is not ready. Increasing the deadline will not fix malformed JSON-RPC or a process that exits immediately.

## Check Python flushing without breaking the protocol

For a hand-written Python loop, flush each protocol response:

```python
import json
import sys

print('Starting server', file=sys.stderr)
response = {"jsonrpc": "2.0", "id": 1, "result": {}}
print(json.dumps(response), flush=True)
```

This is a **framing demonstration**, not a complete MCP server or initialization response. The stdout line parsed as JSON and the diagnostic was separate in the local test. Prefer the SDK's transport for a real server. Python's [`-u` option](https://docs.python.org/3/using/cmdline.html#cmdoption-u) or `PYTHONUNBUFFERED=1` can help when a custom launcher otherwise buffers pipe output:

```bash
python3 -u server.py
```

Do not replace a working SDK stream writer with an unrelated `print` loop to fix buffering.

## Decide what failed

A process that exits before replying needs crash or launch investigation. A successful initialization followed by an empty `tools/list` needs tool-registration investigation. A JSON-RPC error response needs its method, code and message inspected; there is no universal capability-mismatch error code. Record those observations before attributing the issue to the client.

For closure errors, continue with [what MCP error -32000 establishes](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/). If tools worked earlier in the same conversation, use [the compaction and reconnect checklist](/2026/06/fix-claude-code-drops-mcp-tools-after-auto-compaction/).
