---
title: "GitHub's MCP Server Went Stateless and Deleted Its Redis Session Store"
description: "On 2026-07-23 GitHub shipped the MCP 2026-07-28 revision ahead of the spec date. The notable part is the subtraction: no initialize handshake, no Mcp-Session-Id, no Redis."
pubDate: 2026-07-28
tags:
  - "mcp"
  - "ai-agents"
  - "http"
  - "architecture"
---

On 2026-07-23 GitHub announced that [the GitHub MCP Server supports the next MCP specification](https://github.blog/changelog/2026-07-23-github-mcp-server-supports-the-next-mcp-specification/), the revision dated `2026-07-28`, days before that date landed. Running a not-yet-published revision in front of production traffic is a bet. What makes the announcement worth reading is that the headline changes are all subtractions: Redis session storage, packet inspection in the proxy layer, and a database write on every client connect.

## The handshake and the session header are gone

The `2026-07-28` revision removes the `initialize` and `notifications/initialized` handshake, and it removes the `Mcp-Session-Id` header from Streamable HTTP. Everything the handshake used to establish now rides on each individual request inside `_meta`, mirrored into HTTP headers so a load balancer can route without parsing the body:

```http
POST /mcp HTTP/1.1
Content-Type: application/json
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: get_weather

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": { "location": "Seattle, WA" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "ExampleClient", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

The body stays the source of truth. If a header disagrees with it, the server must answer `400 Bad Request` with JSON-RPC error `-32020` (`HeaderMismatch`), which stops a gateway routing on one value while the server executes another.

That single change is why the Redis dependency could go. A session store existed only so the second request from a client could find the state the first one created. With no handshake there is no state to find, so any request can land on any instance and initialization stops writing to a database.

## The two changes that cost real work

Server-initiated requests are gone. Sampling, roots, and elicitation used to arrive as JSON-RPC requests pushed from the server. Under Multi Round-Trip Requests (SEP-2322) the server instead returns `resultType: "input_required"` with an `inputRequests` array, and the client retries the original call carrying `inputResponses`. GitHub handled both eras behind a Go SDK wrapper rather than breaking older clients.

Resumability is gone too. The `Last-Event-ID` header and SSE event IDs are removed, so a dropped response stream loses the in-flight request and the client must reissue it under a new request ID. If your server assumed replay on reconnect, that assumption is now yours to handle.

Also worth noting before you plan a migration: Tasks moved out of core into the `io.modelcontextprotocol/tasks` extension with `tasks/list` removed, and Roots, Sampling, and Logging are now formally deprecated with a twelve-month window.

## Where that leaves your server

If you already run Streamable HTTP with no session ID generator, you are most of the way there, which is the practical argument for [picking Streamable HTTP over stdio or the legacy SSE transport](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) for anything networked. The tier 1 SDKs shipped beta support while preserving backwards compatibility, so existing deployments need no action to keep working. Read the [full list of changes](https://modelcontextprotocol.io/specification/draft/changelog) before you assume that is true of your own code.
