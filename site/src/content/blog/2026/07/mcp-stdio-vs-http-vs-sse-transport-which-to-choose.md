---
title: "MCP stdio vs HTTP vs SSE Transport: Which Should You Choose in 2026?"
description: "Use stdio for a local server one client launches, use Streamable HTTP for anything remote or multi-client, and do not build new HTTP+SSE servers -- that transport was deprecated in the 2025-03-26 MCP spec. Here is the decision, the wire-level differences, and the code for each."
pubDate: 2026-07-02
template: vs
tags:
  - "comparison"
  - "mcp"
  - "ai-agents"
  - "claude-code"
  - "anthropic-sdk"
---

If you are wiring up a Model Context Protocol server and staring at three transport names -- stdio, HTTP, and SSE -- here is the call: **use stdio when a single client launches your server as a local subprocess, use Streamable HTTP for anything remote or multi-client, and do not write a new HTTP+SSE server at all.** "HTTP" and "SSE" are not two peers next to stdio. They are two generations of the same network transport: Streamable HTTP is the current one, and the old HTTP+SSE transport was deprecated in the `2025-03-26` spec and superseded again in `2025-11-25`. The only reason to touch HTTP+SSE in 2026 is backward compatibility with a client that predates March 2025.

Everything below is pinned to the MCP specification revision [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) (the current stable spec), with notes on the [`2026-07-28` release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) that goes stateless. Code is tested against the MCP TypeScript SDK 1.29.x and the Python SDK / FastMCP with `mcp.run(transport=...)`, driven from Claude Code 2.x and Claude Desktop 0.13.x.

## Three names, two transports

The spec defines exactly two standard transports today: stdio and Streamable HTTP. "SSE" is the nickname for the older `2024-11-05` HTTP-with-SSE transport that Streamable HTTP replaced. Keeping that straight is most of the battle:

- **stdio** -- the client launches your server as a child process and talks newline-delimited JSON-RPC over `stdin`/`stdout`. Local, single client, no network.
- **Streamable HTTP** -- your server runs independently on a URL and exposes one MCP endpoint that handles both POST and GET. It can optionally upgrade a response to an SSE stream for server-to-client messages. This is "the HTTP transport" in 2026.
- **HTTP+SSE (legacy)** -- the `2024-11-05` design that used two separate endpoints: a GET endpoint that opened a long-lived SSE stream, and a POST endpoint the client discovered from an `endpoint` event. Deprecated. New builds should not use it.

When a changelog, a config file, or a Reddit thread says "SSE transport," it almost always means the legacy two-endpoint design. When it says "Streamable HTTP," it means the current one, which happens to *use* SSE internally as an optional streaming mode. Same three letters, very different things.

## The feature matrix

| Feature | stdio | Streamable HTTP (`2025-11-25`) | HTTP+SSE (legacy `2024-11-05`) |
| --- | --- | --- | --- |
| Status in 2026 | Standard | Standard | Deprecated |
| Where the server runs | Local subprocess | Independent process / remote host | Independent process / remote host |
| Client count | One (the launcher) | Many concurrent | Many concurrent |
| Endpoints | none (pipes) | One MCP endpoint (POST + GET) | Two (GET for SSE, separate POST) |
| Server-to-client streaming | over `stdout` | SSE, optional per request | SSE, always-on GET stream |
| Auth | inherits the parent process env | OAuth / bearer / API key over HTTP | OAuth / bearer / API key over HTTP |
| Session header | n/a | `Mcp-Session-Id` (optional) | n/a |
| Resumability | n/a | `Last-Event-ID` replay | none defined |
| Best for | dev tools, CLIs, local files | hosted / shared / cloud servers | keeping old clients alive |

The one axis that actually decides it: **does one client own the server process, or do many clients hit one server over a network?** Everything else follows.

## When to pick stdio

Reach for stdio when the server and the client live on the same machine and the client is the one that starts the server.

- **A local dev tool your editor spawns.** Claude Code, Cursor, and Claude Desktop all launch stdio servers by putting a `command` in their config and reading `stdout`. This is the default for `npx your-mcp-server` style entries. If you are writing [an MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/), stdio is the transport you want.
- **Anything touching the local filesystem, git, or local processes.** The server runs with the user's own permissions and environment, so there is no auth to design. Secrets come in through `env` in the client config.
- **Zero-infrastructure distribution.** You ship a package; the client runs it. No port, no TLS, no reverse proxy, no CORS.

Minimal stdio server, TypeScript SDK 1.29.x:

```typescript
// MCP TypeScript SDK 1.29.x, spec 2025-11-25, transport: stdio
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "clock", version: "1.0.0" });

server.registerTool(
  "now",
  { description: "Current server time", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: new Date().toISOString() }] })
);

// The client launches this process and speaks JSON-RPC over stdin/stdout.
await server.connect(new StdioServerTransport());
```

The one hard rule of stdio: **never write anything to `stdout` that is not a JSON-RPC message.** A stray `console.log` corrupts the message stream and the client will hang or disconnect. Log to `stderr` instead. That single mistake is behind most of the pain in [why an MCP server hangs when launched from Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/).

## When to pick Streamable HTTP

Reach for Streamable HTTP the moment the server outlives any one client, or when clients connect over a network.

- **A hosted server multiple people or agents share.** One deployment, many concurrent clients, each POSTing to the same MCP endpoint. Claude Desktop registers these as Custom Connectors; Claude Code takes them with `--transport http`.
- **A server behind auth.** OAuth flows, bearer tokens, and API keys all ride standard HTTP headers. There is no clean way to do that over stdio.
- **Cloud or serverless deployment.** The `2025-11-25` transport lets the server answer a request with a plain JSON body and close, so it maps onto request/response infrastructure without holding a socket open. The `2026-07-28` release candidate leans into this by dropping protocol-level sessions entirely.

Minimal Streamable HTTP server, TypeScript SDK 1.29.x on Express:

```typescript
// MCP TypeScript SDK 1.29.x, spec 2025-11-25, transport: Streamable HTTP
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json());

const server = new McpServer({ name: "clock", version: "1.0.0" });
server.registerTool(
  "now",
  { description: "Current server time", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: new Date().toISOString() }] })
);

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(), // pass undefined for a stateless server
});
await server.connect(transport);

// One MCP endpoint handles POST (client -> server) and GET (SSE stream).
app.all("/mcp", (req, res) => transport.handleRequest(req, res, req.body));
app.listen(3000, "127.0.0.1"); // bind to localhost for local servers
```

The Python side is even shorter. FastMCP defaults to stdio, so you opt into HTTP with one argument:

```python
# MCP Python SDK / FastMCP, spec 2025-11-25
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("clock")

@mcp.tool()
def now() -> str:
    """Current server time."""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()

if __name__ == "__main__":
    # transport="stdio" is the default; switch to HTTP for a hosted server.
    mcp.run(transport="streamable-http")
```

If you are starting from the Python side, the walkthrough in [building a custom MCP server in Python with the official SDK](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) fills in tools, resources, and prompts around this skeleton.

### How the streaming actually works

The name confuses people, so here is the wire behavior. Every client message is a fresh HTTP POST to the one MCP endpoint. For a request, the server picks per response: return `Content-Type: application/json` with a single object, or return `Content-Type: text/event-stream` and stream JSON-RPC messages as SSE events before the final response. The client must accept both, which is why every POST carries `Accept: application/json, text/event-stream`.

The client can also issue a GET to the same endpoint to open a standalone SSE stream, letting the server push requests and notifications that are not tied to any one client call. Sessions are optional: if the server returns an `Mcp-Session-Id` header on the initialize response, the client echoes it on every later request. Broken streams resume via `Last-Event-ID`, so a dropped connection replays missed events instead of losing them. That resumability is the concrete thing Streamable HTTP has that the legacy transport never defined.

## When to pick HTTP+SSE (almost never)

Only one scenario justifies the legacy transport: you must serve a client that was built against the `2024-11-05` spec and cannot be upgraded. The spec's backward-compatibility guidance is to host the old two-endpoint design *alongside* a new MCP endpoint, so modern clients get Streamable HTTP and ancient ones fall back:

```text
GET  /sse      -> long-lived SSE stream, first event names the POST endpoint
POST /messages -> client sends JSON-RPC here (endpoint learned from the stream)
```

A `2025-11-25` client detects which it is talking to by POSTing an `InitializeRequest` first; on a 400/404/405 it falls back to GETting the SSE stream and waiting for the `endpoint` event. If you control both ends, skip all of this and ship Streamable HTTP. The legacy design's split endpoints, always-on GET stream, and lack of resumability are exactly the problems Streamable HTTP was created to fix.

## The gotcha that picks for you

Two things override preference entirely.

**Your client's config schema.** Claude Desktop's `claude_desktop_config.json` validates stdio entries only. Paste a `url` field in and it silently drops the whole `mcpServers` block. Remote servers go in through the Connectors UI or a `mcp-remote` stdio bridge instead. That single mismatch is the whole story behind [why an HTTP MCP server URL will not connect in Claude Desktop](/2026/05/fix-http-mcp-server-url-wont-connect-in-claude-desktop/). Check what your target client accepts before you pick a transport.

**Startup ordering, if you go HTTP locally.** A stdio server cannot race its client -- the client launches it. An HTTP server can: if the client dials before the server is listening, you get `ECONNREFUSED` and a dead connection, which is a recurring failure mode covered in [fixing ECONNREFUSED when a local MCP server starts before the client is ready](/2026/05/fix-econnrefused-when-a-local-mcp-server-starts-before-the-client-is-ready/). stdio sidesteps the whole class of problem, which is one more reason it is the default for local tools.

## What the 2026-07-28 spec changes

The `2026-07-28` release candidate does not add a fourth transport. It sharpens Streamable HTTP: protocol-level sessions and the `Mcp-Session-Id` header are removed, so any request can route to any server instance with no sticky sessions and no shared session store. It also adds `Mcp-Method` and `Mcp-Name` routing headers so gateways can route without parsing the body, plus `ttlMs` / `cacheScope` caching metadata on list and read results. None of that changes the stdio-vs-HTTP decision. It makes the HTTP choice scale better horizontally, which only strengthens the recommendation: local and single-client, stdio; everything networked, Streamable HTTP.

## The call, restated

Do not think of it as three options. Think of it as one question -- local subprocess or networked server -- and one dead end. If a single client launches the server on the same machine, use **stdio**: no ports, no auth, no CORS, and the client cannot outrace it. If the server is remote, shared, or behind auth, use **Streamable HTTP**: one MCP endpoint, optional SSE streaming, optional sessions, real resumability, and a clean path to the stateless `2026-07-28` model. Reach for **HTTP+SSE** only to keep a pre-March-2025 client alive, and even then run it beside a Streamable HTTP endpoint so you can retire it the day that client updates.

If you have not built a server yet, the language-specific guides for [C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/), [TypeScript](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/), and [Python](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) all start with stdio and note exactly where to flip the transport when you outgrow it.

## Sources

- MCP specification `2025-11-25`, [Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- MCP specification `2024-11-05`, [HTTP with SSE (deprecated)](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports)
- Model Context Protocol blog, [The 2026-07-28 MCP Specification Release Candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) and [FastMCP: Running Your Server](https://gofastmcp.com/deployment/running-server)
