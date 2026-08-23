---
title: "Fix: Unsupported protocol version between an MCP client and server (2025-11-25 vs 2026-07-28)"
description: "MCP error -32022 means your client opened at 2025-11-25 but the server only serves 2026-07-28. Make one side dual-era instead of pinning a version."
pubDate: 2026-08-23
template: error-page
tags:
  - "mcp"
  - "ai-agents"
  - "claude-code"
  - "errors"
  - "streamable-http"
---

Your MCP client connects, gets an HTTP `400`, and the body says `Unsupported protocol version: 2025-11-25` with a `supported` list containing only `2026-07-28`. The client is opening with the `initialize` handshake that every revision through `2025-11-25` used, and the server only serves the stateless per-request revision `2026-07-28`, which has no handshake at all. Fix it by making one side dual-era: drop `legacy: 'reject'` from `createMcpHandler` on the server, or move the client to one that probes with `server/discover` and falls back. Everything below was run against `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/client` 2.0.0, `@modelcontextprotocol/sdk` 1.30.0 and Claude Code 2.1.224 on Node 24.14.1.

## The error in context

The modern server answers with JSON-RPC error `-32022` and HTTP `400`:

```
HTTP/1.1 400 Bad Request
content-type: application/json

{"jsonrpc":"2.0","error":{"code":-32022,"message":"Unsupported protocol version: 2025-11-25","data":{"supported":["2026-07-28"],"requested":"2025-11-25"}},"id":0}
```

Pointed the other way, a legacy-only server rejects a modern request from the transport layer, before any JSON-RPC handler sees it:

```
HTTP/1.1 400 Bad Request
content-type: application/json

{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Unsupported protocol version: 2026-07-28 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)"},"id":null}
```

If you are using the official TypeScript client rather than raw `fetch`, you will not see `-32022` in the exception type at all. The `Client` class wraps it:

```
THREW: SdkHttpError
message: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32022,"message":"Unsupported protocol version: 2025-11-25","data":{"supported":["2026-07-28"],"requested":"2025-11-25"}},"id":0}
code: CLIENT_HTTP_NOT_IMPLEMENTED
data: {"status":400,"statusText":"Bad Request","text":"..."}
```

That `CLIENT_HTTP_NOT_IMPLEMENTED` code is why this is hard to search for. The SDK classifies the failure by HTTP status, and the actual protocol diagnosis is buried in `error.data.text`.

## Why the two sides cannot agree

MCP changed how version agreement works in revision `2026-07-28`, and the two models do not overlap.

Revisions through `2025-11-25` negotiate once, at connection time. The client sends `initialize` with its best `protocolVersion`, and per the [2025-11-25 lifecycle spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), if the server does not support that version it "MUST respond with another protocol version it supports". A version disagreement is normally not an error at all, it is a silent downgrade, and the client is expected to disconnect if it cannot live with the answer.

Revision `2026-07-28` removed the handshake entirely under [SEP-2575](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575). There is no session and no negotiation round trip. Every single request carries its own version in `params._meta` under `io.modelcontextprotocol/protocolVersion`, mirrored into the `MCP-Protocol-Version` HTTP header, and the server accepts or rejects each request independently. A version the server does not serve produces `UnsupportedProtocolVersionError`, code `-32022`, carrying the list of versions it does support.

So a legacy client sends `initialize` to a modern server, and `initialize` is not a method that revision defines. A modern client sends a `_meta` envelope to a legacy server, and that server's transport rejects the `MCP-Protocol-Version` header value it has never heard of. The [compatibility matrix](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) in the spec is blunt about both directions: modern client against legacy server "Fails", legacy client against modern server "Fails". Only a dual-era implementation on one side of the wire makes the pair work.

The trap is that the shipping npm SDKs are still legacy by default. Both `@modelcontextprotocol/client` 2.0.0 and `@modelcontextprotocol/server` 2.0.0 export a `SUPPORTED_PROTOCOL_VERSIONS` array capped at `2025-11-25`:

```js
// @modelcontextprotocol/client 2.0.0, Node 24.14.1
import { SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/client';
console.log(LATEST_PROTOCOL_VERSION);
// 2025-11-25
console.log(SUPPORTED_PROTOCOL_VERSIONS);
// [ '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07' ]
```

A `new Client(...)` built from that package opens at `2025-11-25`. The same package version's server entry point serves `2026-07-28` through `createMcpHandler`. Point one at the other and they do not connect.

## Minimal repro

A modern-only endpoint is three lines of configuration. The `legacy: 'reject'` option is what makes it strict:

```js
// @modelcontextprotocol/server 2.0.0, @modelcontextprotocol/node 2.0.0, zod 4.4.3, Node 24.14.1
import { createServer } from 'node:http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

const handler = createMcpHandler(() => {
  const s = new McpServer({ name: 'strict-probe', version: '1.0.0' });
  s.registerTool(
    'echo',
    { description: 'Echoes text back', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text }] })
  );
  return s;
}, { legacy: 'reject' });

createServer(toNodeHandler(handler)).listen(3997, '127.0.0.1');
```

Now connect the stock client:

```js
// @modelcontextprotocol/client 2.0.0
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'sdk-client', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3997/mcp')));
// SdkHttpError: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32022,...}}
```

Drop `{ legacy: 'reject' }` and the identical client connects, negotiates `2025-11-25`, and calls tools normally. That single option is the whole difference.

## How to make the server dual-era

This is the fix that works for the most callers, because you control the server and you do not control what every client in your organisation is running.

`createMcpHandler` is dual-era by default. Called with no options, it classifies each inbound request and routes it: a POST carrying the `_meta` envelope claim gets served statelessly under `2026-07-28`, and a claim-less POST (including an `initialize` handshake, or a 2025-era notification POST) gets the legacy stateless serving. Verified side by side against the same handler:

```
--- dual-era endpoint, modern request at 2026-07-28
HTTP 200
{"result":{"content":[{"type":"text","text":"hi"}],"resultType":"complete",
 "_meta":{"io.modelcontextprotocol/serverInfo":{"name":"probe","version":"1.0.0"}}},"jsonrpc":"2.0","id":1}

--- dual-era endpoint, legacy initialize
HTTP 200
event: message
data: {"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":true}},
       "serverInfo":{"name":"probe","version":"1.0.0"}},"jsonrpc":"2.0","id":8}
```

Same process, same tool registry, two eras answered concurrently on one endpoint. If you already have a sessionful 2025-era deployment you do not want to throw away, the SDK exports `isLegacyRequest` so you can branch to it yourself while a strict modern handler owns everything else. Route only `true` to your legacy handler: the modern path owns its own rejections, including `-32022`, `-32020`, and `-32602`.

## How to make the client dual-era

If you cannot change the server, the client has to probe. The spec defines a different probe per transport, and this is the part people get wrong.

On stdio, the client sends `server/discover` first. Every `2026-07-28` server MUST implement it; a legacy server answers with something that is not a recognized modern error, and that non-answer is the fallback signal. Claude Code 2.1.224 does exactly this. Here is the literal stdio trace from a server that only knows `initialize`:

```
IN  {"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"_meta":{
      "io.modelcontextprotocol/protocolVersion":"2026-07-28",
      "io.modelcontextprotocol/clientInfo":{"name":"claude-code","version":"2.1.224",...},
      "io.modelcontextprotocol/clientCapabilities":{"roots":{"listChanged":true},"elicitation":{}}}}}
OUT {"jsonrpc":"2.0","id":"server-discover-probe-1","error":{"code":-32601,"message":"Method not found: server/discover"}}
IN  {"method":"initialize","params":{"protocolVersion":"2025-11-25",...},"jsonrpc":"2.0","id":0}
OUT {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25",...}}
IN  {"jsonrpc":"2.0","method":"notifications/initialized"}
IN  {"method":"tools/list","jsonrpc":"2.0","id":1}
```

One failed probe, then a clean legacy handshake, then normal operation.

On Streamable HTTP the probe is different: attempt a modern request and read the body of the `400`. Modern servers return `400` for `UnsupportedProtocolVersionError` too, so the status code alone tells you nothing. A recognized modern JSON-RPC error body means the server is modern and you should retry with a version from its `supported` list. An unrecognized body, or an empty one, means fall back to `initialize`. Running Claude Code through a logging proxy in front of both endpoints produced this:

```
# modern-only endpoint
POST proto=2026-07-28 mcp-method=server/discover  -> 200
POST proto=2026-07-28 mcp-method=subscriptions/listen -> 200
POST proto=2026-07-28 mcp-method=tools/list -> 200

# legacy-only endpoint
POST proto=2026-07-28 mcp-method=server/discover  -> 400
POST proto=(none)     jsonrpc-method=initialize   -> 200
POST proto=2025-11-25 jsonrpc-method=notifications/initialized -> 202
GET  proto=2025-11-25 -> 200
POST proto=2025-11-25 jsonrpc-method=tools/list -> 200
```

Note the era determination is a property of the server, not of a request. The spec says clients SHOULD cache the verdict for the lifetime of the server process on stdio, or the origin on HTTP, and MAY persist it across restarts. If you are writing the probe yourself, cache it. Probing on every call doubles your request count against every legacy server you talk to.

## Which side should you actually change

Change the server if you own it and it has more than one consumer. Removing `legacy: 'reject'` costs you nothing but the strictness you probably added by copying an example, and it stops the problem for every client at once.

Change the client if the server is a third party you cannot influence, or if the server is deliberately modern-only for a reason such as sitting behind a gateway that routes on the `Mcp-Method` and `Mcp-Name` headers. In that case you need a client with era detection, not a version pin, because a pin fails the moment the server moves.

Do not "fix" it by hardcoding `MCP-Protocol-Version: 2026-07-28` on a legacy client. The header is a mirror of the body envelope, not a control surface. A modern server validates that the two agree and rejects the mismatch with `-32020`:

```
HTTP 400
{"jsonrpc":"2.0","error":{"code":-32020,"message":"Bad Request: the request headers and body disagree: the body envelope names protocol version 2025-11-25 but the MCP-Protocol-Version header names 2026-07-28",...},"id":4}
```

Send the header without an envelope at all and you get `-32602` instead, naming exactly what is missing:

```
HTTP 400
{"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params: the MCP-Protocol-Version header names protocol revision 2026-07-28, but the request is missing the required per-request envelope key(s): _meta","data":{"envelope":{"missing":["_meta"]}}},"id":1}
```

Three distinct codes, three distinct causes. `-32022` is a version the server does not serve, `-32020` is headers disagreeing with the body, `-32602` is a modern header on a request with no modern envelope.

## Gotchas and lookalikes

**`-32004` instead of `-32022`.** The `2026-07-28` draft originally numbered these errors in the implementation-defined range. The final revision introduced an [error code allocation policy](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-codes) reserving `-32020` to `-32099` for the spec and renumbered them: `HeaderMismatch` from `-32001` to `-32020`, `MissingRequiredClientCapability` from `-32003` to `-32021`, `UnsupportedProtocolVersion` from `-32004` to `-32022`. If you see the old numbers, one side is on a pre-release build. Upgrade it rather than special-casing both.

**A silent downgrade instead of an error.** Against a legacy server, asking for `2026-07-28` in `initialize` does not fail. It answers `2025-11-25` and the connection proceeds. If your client then sends a `subscriptions/listen` or expects `resultType` on results, it breaks much later and nowhere near the cause. Check `getNegotiatedProtocolVersion()` after connecting instead of assuming your requested version won.

**`HTTP 405` on GET or DELETE.** A `2026-07-28` server has no GET stream endpoint and no `Mcp-Session-Id`, so a 2025-era client's standalone SSE GET gets `405 Method Not Allowed`. That is the same root cause wearing a different status code. See [MCP stdio vs HTTP vs SSE transport](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) for which transport shape each revision expects.

**`-32000 Connection closed` on stdio.** Different problem entirely: the server process died on launch. That one is covered in [MCP error -32000: Connection closed in Claude Code](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/).

**Archived reference servers.** The deprecated `modelcontextprotocol/servers` packages pin very old SDKs and cannot negotiate past `2024-11-05`. No dual-era server option rescues those, because the failure is on the server side of a version floor. [Migrate off the archived MCP reference servers](/2026/08/migrate-off-archived-mcp-reference-servers/) covers the maintained replacements.

**Zod major version.** Unrelated to protocol versions but easy to misdiagnose as one: `@modelcontextprotocol/server` 2.0.0 depends on `zod` `^4.2.0`. Register a tool with a Zod 3 schema and every `tools/call` returns HTTP `500` with `-32603 Internal server error`, giving you no hint at all. Check your installed Zod major before you go looking for a negotiation bug.

## Related

- [How to route MCP traffic through a gateway with the Mcp-Method and Mcp-Name headers](/2026/08/route-mcp-traffic-through-a-gateway-with-mcp-method-and-mcp-name-headers/) explains the header-body agreement rule behind `-32020` in full.
- [Migrate an MCP server from SSE to streamable HTTP](/2026/07/migrate-an-mcp-server-from-sse-to-streamable-http/) is the transport-level move that usually precedes this version problem.
- [MCP C# SDK 2.0 ships stateless by default](/2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005/) covers the same era shift on the .NET side.
- [MCP stdio vs HTTP vs SSE transport](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) for which probe applies to which transport.
- [How to centrally control which MCP servers your team can run](/2026/08/centrally-control-which-mcp-servers-a-team-can-run/) if you want to block the stale servers rather than debug them one at a time.

## Sources

- [Versioning and Compatibility, MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), including the client and server era compatibility matrix.
- [Streamable HTTP transport, MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), for the `MCP-Protocol-Version` header rules and server validation.
- [Lifecycle, MCP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), for the `initialize` negotiation the legacy era uses.
- [Key changes in revision 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog), for the handshake removal and the error code renumbering.
- [SEP-2575](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575), the proposal that made MCP stateless and added `server/discover`.
