---
title: "Migrate an MCP Server from SSE to Streamable HTTP (2026 Checklist)"
description: "The legacy HTTP+SSE transport used two endpoints and a sticky connection. Streamable HTTP uses one. Here is the step-by-step migration for the TypeScript and Python SDKs, the client configs you have to repoint, and the proxy buffering gotcha that makes the new endpoint look broken."
pubDate: 2026-07-25
updatedDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "mcp"
  - "ai-agents"
  - "claude-code"
  - "typescript"
  - "python"
---

If your MCP server still answers on `GET /sse` and takes messages on `POST /messages?sessionId=...`, you are running the `2024-11-05` HTTP+SSE transport, which the Model Context Protocol deprecated in the `2025-03-26` revision and replaced with Streamable HTTP. **For a single-process server the migration is a half-day job: your tool, resource, and prompt handlers do not change at all.** What changes is the endpoint shape (two endpoints collapse into one), where the session ID lives (query string becomes the `Mcp-Session-Id` header), and every published client config that points at a `/sse` URL. The long pole is never the code. It is chasing down the clients you do not control before you delete the old endpoints.

Everything here is pinned to the MCP specification revision [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), the MCP TypeScript SDK `@modelcontextprotocol/sdk` **1.29.0** (the v1.x production line), the MCP Python SDK v1.x, and Claude Code 2.x as the client. The v2 SDKs targeting the `2026-07-28` revision are in beta; v1.x is what you should be migrating onto today.

## "SSE" is a generation, not a transport tier

The single biggest source of confusion is that Streamable HTTP also uses Server-Sent Events. It does. The difference is that SSE went from being the whole transport to being an optional response mode.

- **HTTP+SSE (`2024-11-05`, deprecated)**: the client GETs a long-lived SSE stream, and the very first event on that stream is an `endpoint` event telling the client where to POST. Two endpoints, one mandatory persistent connection, no defined way to recover a dropped stream.
- **Streamable HTTP (`2025-11-25`, current)**: one MCP endpoint handling POST and GET. Every client message is its own POST. The server answers each request either with a plain `application/json` body or by upgrading that same response to `text/event-stream`. The GET stream is optional and exists only for unsolicited server-to-client messages.

If you want the decision framework rather than the migration, [the transport comparison covering stdio vs HTTP vs SSE](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) lays out which one to pick in the first place. This post assumes you have already picked, and the answer was "the one that is not deprecated".

## Why this is worth doing now

- **The old transport cannot scale horizontally.** An HTTP+SSE session is pinned to whichever replica holds the open GET stream, so every deployment needs sticky sessions. Streamable HTTP can run fully stateless behind a plain round-robin load balancer.
- **Dropped connections stop losing messages.** Streamable HTTP defines resumability: the server tags SSE events with IDs, and a reconnecting client sends `Last-Event-ID` to replay what it missed. The legacy transport defined nothing here, so a network blip meant a lost response.
- **Serverless becomes viable.** A server can answer a request with a single JSON body and close, so there is no socket to hold open for the life of a session.
- **Vendors are already pulling the plug.** Keboola [removed SSE from its MCP server on April 1, 2026](https://changelog.keboola.com/sse-transport-deprecation-migration-to-streamable-http/) and repointed everyone to `/mcp`. If you host a public MCP server, expect your clients to have the same expectation of you.
- **It is the on-ramp to the next revision.** The [`2026-07-28` release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) removes protocol-level sessions and the `Mcp-Session-Id` header entirely and adds `Mcp-Method` / `Mcp-Name` routing headers. A stateless Streamable HTTP server is most of the way there already. A stateful SSE server is two migrations away.

## What breaks

| Area | Old (HTTP+SSE `2024-11-05`) | New (Streamable HTTP `2025-11-25`) | Severity |
| --- | --- | --- | --- |
| Endpoints | `GET /sse` plus `POST /messages` | one MCP endpoint, POST + GET + DELETE | high |
| Session identity | `?sessionId=` query parameter | `Mcp-Session-Id` response and request header | high |
| Client config | `"type": "sse"`, URL ends in `/sse` | `"type": "http"`, URL ends in `/mcp` | high |
| Request headers | none required | POST must send `Accept: application/json, text/event-stream` | medium |
| Version negotiation | implicit | `MCP-Protocol-Version` header on every post-init request | medium |
| Connection lifetime | one mandatory long-lived GET | GET optional, server may answer 405 | medium |
| Origin checking | not specified | server **MUST** validate `Origin` and return 403 when invalid | high |
| Resumability | undefined | `Last-Event-ID` replay, needs an event store | low |
| Reverse proxy | must not buffer `/sse` | must not buffer the MCP endpoint either | medium |

Note the security row. The `2025-11-25` spec makes `Origin` validation a MUST, not a SHOULD, because a local MCP server on `127.0.0.1` is otherwise reachable from any web page through DNS rebinding. If you skip that step you have migrated the transport and introduced a hole.

## Pre-flight checklist

Before touching the transport wiring:

- **Bump the SDK.** TypeScript: `npm i @modelcontextprotocol/sdk@1.29.0`. Streamable HTTP landed in 1.10.0, so anything on 1.9.x or below has to move first. Python: install the v1.x line of `mcp`.
- **Inventory every client.** Grep your own repos and your docs for the `/sse` URL. Anything you published in a README, a Cursor `mcp.json`, or an onboarding doc is a config you have to repoint. If you distribute a team config, [the pattern for pushing one MCP config to both cloud agents and the IDE](/2026/07/distribute-team-mcp-config-across-cursor-cloud-agents-and-ide/) is the place to make the change once.
- **Decide stateful or stateless now.** If your tools keep per-session state in memory, you need session IDs and sticky routing. If they do not (most servers), go stateless and delete a whole class of infrastructure problem.
- **Check the reverse proxy.** Whatever `proxy_buffering off` or equivalent you set for `/sse` has to cover the new endpoint too.
- **Snapshot the deployment.** You are going to run both transports side by side for a while, so make sure you can roll the new endpoint out without touching the old one.

## Migration steps

1. Add the Streamable HTTP endpoint alongside the existing SSE endpoints, without removing anything.
2. Pick stateful or stateless session handling and configure the transport accordingly.
3. Add `Origin` validation and, for local servers, bind to `127.0.0.1`.
4. Repoint the client configs you control from `/sse` to the MCP endpoint.
5. Log every request that still hits the legacy endpoints, and wait until the log goes quiet.
6. Delete the SSE endpoints and the legacy transport import.

### Step 1: mount the new endpoint beside the old one

The spec's own backwards-compatibility guidance is to keep hosting both endpoints during the transition, and both SDKs support running the two transports in the same process. In TypeScript, the transports share a session map, and each handler checks the instance type before reusing an entry:

```typescript
// @modelcontextprotocol/sdk 1.29.0, spec 2025-11-25, dual transport
import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(express.json());

const transports: Record<
  string,
  StreamableHTTPServerTransport | SSEServerTransport
> = {};

// NEW: one MCP endpoint, POST + GET + DELETE.
app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  const existing = sessionId ? transports[sessionId] : undefined;
  if (existing instanceof StreamableHTTPServerTransport) {
    transport = existing;
  } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { transports[sid] = transport; },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) delete transports[sid];
    };
    await getServer().connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// LEGACY: keep these until the old clients are gone.
app.get("/sse", async (_req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => { delete transports[transport.sessionId]; });
  await getServer().connect(transport);
});

app.post("/messages", async (req, res) => {
  const transport = transports[req.query.sessionId as string];
  if (transport instanceof SSEServerTransport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).send("No SSE transport found for sessionId");
  }
});

app.listen(3000, "127.0.0.1");
```

`getServer()` returns a freshly constructed `McpServer` with your tools registered. Construct one per session rather than sharing a single instance across transports, which is what the SDK's own `sseAndStreamableHttpCompatibleServer.ts` example does.

On the Python side there is no wiring to write. The official SDK's FastMCP takes the transport as a string:

```python
# MCP Python SDK v1.x, spec 2025-11-25
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("inventory")

@mcp.tool()
def lookup(sku: str) -> str:
    """Look up a SKU."""
    return f"{sku}: 42 in stock"

if __name__ == "__main__":
    # was: mcp.run(transport="sse")
    mcp.run(transport="streamable-http")
```

To serve both at once in Python, mount `mcp.streamable_http_app()` and `mcp.sse_app()` on the same Starlette app under different paths instead of calling `mcp.run`.

**Verify**: `curl -i -X POST http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'` returns 200 with an `Mcp-Session-Id` response header, and `curl -i http://127.0.0.1:3000/sse` still opens a stream.

### Step 2: choose stateful or stateless

The `sessionIdGenerator` option decides this. Pass a generator and the server issues an `Mcp-Session-Id`, tracks state in memory, and requires sticky routing. Pass `undefined` and every request is self-contained:

```typescript
// @modelcontextprotocol/sdk 1.29.0 -- stateless: no session, no sticky routing
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true, // answer with application/json instead of an SSE stream
});
```

Python's equivalent is `FastMCP("inventory", stateless_http=True)`. In C#, `builder.Services.AddMcpServer().WithHttpTransport()` plus `app.MapMcp()` gives you the Streamable HTTP endpoint, and the transport defaults to stateful sessions, so opt into stateless mode explicitly if you are deploying more than one replica. The [C# MCP server walkthrough on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) covers the surrounding host setup.

Stateless also means you can skip the event store. Resumability only matters when a stream can be interrupted mid-response, and `enableJsonResponse: true` means there is no stream.

**Verify**: run two replicas behind a round-robin proxy with no session affinity and confirm a full `initialize` plus `tools/list` plus `tools/call` sequence completes.

### Step 3: validate Origin and bind locally

This is a MUST in the spec and the SDKs do not do it for you when you hand-roll the Express wiring:

```typescript
// Reject cross-origin browser requests before they reach the transport.
const ALLOWED = new Set(["http://localhost:3000", "https://mcp.example.com"]);

app.use("/mcp", (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED.has(origin)) {
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Forbidden: invalid Origin" },
      id: null,
    });
    return;
  }
  next();
});
```

Note the guard only fires when the header is present, because non-browser clients such as Claude Code do not send `Origin` at all. Combine this with `app.listen(3000, "127.0.0.1")` for anything running on a developer machine.

**Verify**: `curl -i -X POST http://127.0.0.1:3000/mcp -H 'Origin: https://evil.example' ...` returns 403, and the same request without the header still returns 200.

### Step 4: repoint the clients

Claude Code takes the transport as a flag. Remove the old entry and add the new one:

```bash
claude mcp remove inventory
claude mcp add --transport http inventory https://mcp.example.com/mcp
```

In `.mcp.json`, `~/.claude.json`, or a Cursor `mcp.json`, the change is the `type` field and the path:

```json
{
  "mcpServers": {
    "inventory": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${INVENTORY_TOKEN}" }
    }
  }
}
```

Claude Code accepts `"streamable-http"` as an alias for `"http"` so configs copied straight from a server's docs work unmodified. What it does not accept is a `url` with no `type`: it reads that entry as a stdio server and skips it. Claude Desktop is fussier still, and its config file only validates stdio entries, which is the whole story behind [why an HTTP MCP server URL refuses to connect there](/2026/05/fix-http-mcp-server-url-wont-connect-in-claude-desktop/). Remote servers go in through the Connectors UI.

**Verify**: `claude mcp list` shows the server as connected, and `/mcp` inside a session lists your tools.

### Step 5: watch the legacy endpoints

Add a one-line log to both legacy handlers recording the timestamp, User-Agent, and source IP. Ship it, then leave it alone for a full billing cycle or at least two weeks. Weekly cron jobs and CI pipelines are the classic stragglers: they are real clients that nobody remembers configuring.

**Verify**: the legacy access log has no entries for the agreed quiet period.

### Step 6: delete the SSE endpoints

Remove the `app.get("/sse")` and `app.post("/messages")` handlers, drop the `SSEServerTransport` import, and narrow the transports map to `Record<string, StreamableHTTPServerTransport>`. In Python, stop mounting `sse_app()`.

**Verify**: `curl -i https://mcp.example.com/sse` returns 404, and the full client smoke test below still passes.

## Post-migration smoke test

Run all five against the deployed server, not localhost:

- `initialize` over POST returns 200 with a `protocolVersion` of `2025-11-25` in the result.
- `tools/list` with the negotiated `MCP-Protocol-Version` header returns your full tool set.
- A `tools/call` that streams progress notifications delivers them before the final response.
- `GET` on the MCP endpoint returns either an SSE stream or a clean 405. Both are spec-legal; a 500 is not.
- A real client (`claude mcp list`, or Cursor's MCP panel) shows green.

## Rollback

This migration is fully reversible right up until Step 6, which is the entire reason Step 1 adds the new endpoint instead of replacing the old one. Until you delete the legacy handlers, rolling back is a client-config change: point the URL back at `/sse` and set `"type": "sse"`. After Step 6 the rollback is a redeploy of the previous build. Keep that build tagged.

## Gotchas that cost real hours

**The Python transport string is not the same everywhere.** The official MCP Python SDK uses `mcp.run(transport="streamable-http")`. The standalone FastMCP project on `gofastmcp.com` uses `transport="http"`. Feed the wrong string to the wrong library and you get an unhelpful value error. Check which package you actually imported before you trust a snippet from a blog post, including this one.

**Reverse proxy buffering makes the endpoint look hung.** If nginx buffers the response, an SSE upgrade on the MCP endpoint sits in the buffer until it fills. The symptom is identical to a dead server: the client connects, sends `initialize`, and waits forever. Set `proxy_buffering off` and a generous `proxy_read_timeout` on the new path, not just the retired `/sse` one.

**The trailing slash matters.** Some frameworks mount the endpoint at `/mcp/` and 307-redirect `/mcp`, and not every client follows a redirect on a POST with a body. Pick one form and publish exactly that URL.

**A missing `MCP-Protocol-Version` header means the server assumes `2025-03-26`.** That is the spec's stated fallback. If you built version-conditional behavior and it silently picks the wrong branch, this is why.

**Startup ordering still bites.** An HTTP MCP server can be dialed before it is listening, which is a different failure from anything stdio can produce. That class of problem is covered in [why a local MCP server throws ECONNREFUSED when the client starts first](/2026/05/fix-econnrefused-when-a-local-mcp-server-starts-before-the-client-is-ready/).

**Do not migrate stdio servers.** If a single client launches your server as a subprocess, none of this applies. Streamable HTTP is for servers that outlive any one client. The [TypeScript walkthrough for an MCP server that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) and the [Python SDK walkthrough](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) both stay on stdio for exactly that reason.

The pattern worth internalizing: HTTP+SSE made the connection the unit of session, and Streamable HTTP makes the request the unit. Every awkward thing about the old transport, the sticky routing, the lost messages, the impossibility of serverless, follows from that one design choice. The `2026-07-28` revision finishes the job by removing sessions from the protocol altogether, so a stateless server you build today needs almost nothing done to it next year.

## Related

- [MCP stdio vs HTTP vs SSE transport: which to choose](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) - the decision this migration assumes you already made.
- [Fix: an HTTP MCP server URL will not connect in Claude Desktop](/2026/05/fix-http-mcp-server-url-wont-connect-in-claude-desktop/) - the client-side half of Step 4, when the config silently drops.
- [How to build a custom MCP server in Python with the official SDK](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) - the Python server this migration is repointing.
- [How to build a custom MCP server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) - `MapMcp` and the ASP.NET Core hosting side of Step 2.
- [How to distribute a team MCP config across Cursor cloud agents and the IDE](/2026/07/distribute-team-mcp-config-across-cursor-cloud-agents-and-ide/) - repointing every client once instead of chasing them individually.

## Sources

- MCP specification `2025-11-25`, [Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), including the Backwards Compatibility section
- MCP specification `2024-11-05`, [HTTP with SSE](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports)
- Model Context Protocol blog, [the 2026-07-28 specification release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- MCP TypeScript SDK, [`sseAndStreamableHttpCompatibleServer.ts` example](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/sseAndStreamableHttpCompatibleServer.ts)
- [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) and [FastMCP: running your server](https://gofastmcp.com/deployment/running-server)
- Claude Code docs, [connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
- Keboola changelog, [SSE transport deprecation and migration to Streamable HTTP](https://changelog.keboola.com/sse-transport-deprecation-migration-to-streamable-http/)
