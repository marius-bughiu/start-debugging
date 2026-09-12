---
title: "Fix: an MCP client drops the Authorization header across a 308 cross-origin redirect and gets a 401"
description: "Your MCP URL 307/308-redirects to another host, the client follows it, the Authorization header is stripped, and the target answers 401. Register the final URL."
pubDate: 2026-09-12
template: error-page
tags:
  - "mcp"
  - "ai-agents"
  - "errors"
  - "oauth"
  - "typescript"
  - "python"
---

If the MCP server URL you configured answers `301`, `302`, `307` or `308` with a `Location` on a different origin (a different scheme, host or port), the HTTP client follows it and deletes the `Authorization` header on the way. The new host gets an anonymous request and answers `401`. The fix is to register the URL the server actually answers on, and to stop the MCP endpoint from redirecting at all. Do not "fix" it by re-attaching the token to the new host. Everything below was measured on `@modelcontextprotocol/client` 2.0.0 and `@modelcontextprotocol/server` 2.0.0 on Node 26.4.0, the Python SDK `mcp` 2.2.0 (on `httpx2` 2.12.0, Python 3.14.7), `HttpClient` from .NET SDK 10.0.302, and curl 8.7.1, against the [MCP authorization spec revision 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

## The error in context

The repro uses two local origins. `http://localhost:3001` is the "old" URL, and it 308-redirects `/cross-308` to `http://127.0.0.1:3002/mcp`, the real server. Both hosts protect `/mcp` with a bearer check that logs whether the header arrived. The TypeScript SDK client, configured with a static `Authorization: Bearer ...` header, fails like this:

```
SdkHttpError: Error POSTing to endpoint: {"error":"invalid_token","error_description":"Missing Authorization header"}
```

The server log is the part that tells you what happened:

```
[http://localhost:3001] POST /cross-308 authorization=present -> 308 http://127.0.0.1:3002/mcp
[http://127.0.0.1:3002] POST /mcp authorization=MISSING
```

The client sent the token. The first hop saw it. The second hop, on another origin, did not. The JSON body in the error message comes from your server's `401` response, so the wording varies (`invalid_token`, `Unauthorized`, `Missing bearer token`), but the pattern in the log is always the same.

On claude.ai the same misconfiguration surfaces as "Authorization with the MCP server failed", which the [Claude connector troubleshooting page](https://claude.com/docs/connectors/building/troubleshooting) lists under both "Couldn't reach the MCP server" and the authorization failure section. The Python SDK refuses to follow the redirect at all and says so:

```
MCPError: Redirect to http://127.0.0.1:3002/mcp not followed; use that URL as the endpoint if it is the intended server
```

## Why this happens

The header is removed on purpose. The [WHATWG Fetch standard](https://github.com/whatwg/fetch/pull/1544) (merged November 2022, shipped in Chromium, Gecko, WebKit, Deno and Node's undici) removes a caller-set `Authorization` header whenever a redirect crosses origins. It stays removed for the rest of the chain, so even an A to B to A bounce arrives at A without it. The reason is simple: a bearer token for `mcp.example.com` must not leak to whatever host a redirect happens to point at. The [MCP authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) makes that concern concrete. It requires `Authorization` on every request and requires the server to reject tokens that were not issued for it. A token leaked to the new host would be the wrong audience anyway.

"Origin" means scheme, host and port together. Every one of these counts as cross-origin:

- `https://example.com/mcp` to `https://www.example.com/mcp` (apex to `www.`)
- `https://mcp.example.com/mcp` to `https://mcp-eu.example.com/mcp` (region routing)
- `https://tools.acme.dev/mcp` to `https://acme-prod.fly.dev/mcp` (vanity domain to platform host)
- `http://mcp.example.com/mcp` to `https://mcp.example.com/mcp` (scheme upgrade, for fetch)
- `https://mcp.example.com/mcp` to `https://mcp.example.com:8443/mcp` (port change)

A path-only redirect such as `/mcp` to `/mcp/` stays on the same origin, and fetch keeps the header. .NET is the exception, covered below.

## Minimal repro

Two servers in one file. The handler is a real `McpServer` behind a hand-written bearer check, so the only variable is the redirect:

```javascript
// @modelcontextprotocol/server 2.0.0, @modelcontextprotocol/node 2.0.0, Node 26.4.0
import { createServer } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';

const A = 'http://localhost:3001';   // the URL users registered
const B = 'http://127.0.0.1:3002';   // where the server actually lives

function mcpHandler(origin) {
  return async (req, res) => {
    const auth = req.headers['authorization'];
    console.log(`[${origin}] ${req.method} ${req.url} authorization=${auth ? 'present' : 'MISSING'}`);
    if (auth !== 'Bearer secret-token') {
      res.writeHead(401, {
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ error: 'invalid_token', error_description: 'Missing Authorization header' }));
      return;
    }
    const server = new McpServer({ name: 'redirect-demo', version: '1.0.0' });
    server.registerTool('ping', { description: 'Returns pong' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}

const redirects = {
  '/cross-308': [308, `${B}/mcp`],
  '/cross-301': [301, `${B}/mcp`],
  '/same-308': [308, `${A}/mcp`],
};

const handleA = mcpHandler(A);
createServer((req, res) => {
  const r = redirects[req.url];
  if (r) { res.writeHead(r[0], { Location: r[1] }); res.end(); return; }
  handleA(req, res);
}).listen(3001, 'localhost');

createServer(mcpHandler(B)).listen(3002, '127.0.0.1');
```

And the client, exactly as most people wire a static token:

```javascript
// @modelcontextprotocol/client 2.0.0, Node 26.4.0
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'probe', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(process.argv[2]), {
  requestInit: { headers: { Authorization: 'Bearer secret-token' } },
});
await client.connect(transport);
console.log((await client.listTools()).tools.map(t => t.name));
```

Results across the clients I tested:

| Client | `/same-308` (same origin) | `/cross-308` | `/cross-301` |
| --- | --- | --- | --- |
| TS SDK 2.0.0 (fetch) | connects | follows, `401` at target | follows as `GET`, `401` at target |
| Python `mcp` 2.2.0 | connects | refuses, names the target URL | refuses |
| .NET 10 `HttpClient` | `401` (header stripped anyway) | `401` at target | not tested |
| `curl -L` 8.7.1 | n/a | follows, `401` at target | n/a |

The TypeScript SDK does not configure redirects, so it inherits fetch's `redirect: "follow"`. The Python SDK 2.2.0 does its own redirect handling in `mcp/shared/_httpx_utils.py`: `stream_within_origin` follows a redirect only if it stays on the same scheme, host and port (or is an `http` to `https` upgrade on the same host with default ports) and keeps the method. Anything else is surfaced as the error above, and the client's own `follow_redirects` setting is ignored. That difference explains the common report the Claude docs mention: a server that "works" in one client and fails with an auth error in another. The strict client failed loudly and the lenient one failed later, somewhere else.

## Fix 1: register the URL the server actually answers on

Before touching code, find where the chain ends. `curl -sI` shows one hop:

```bash
# curl 8.7.1
curl -sI https://tools.acme.dev/mcp
# HTTP/1.1 308 Permanent Redirect
# Location: https://acme-prod.fly.dev/mcp
```

Real deployments often have two or three hops (vanity domain, then `www.`, then a trailing slash), so walk the whole chain and flag every origin change:

```bash
# bash/zsh, curl 8.x
url="https://tools.acme.dev/mcp"
for i in 1 2 3 4 5; do
  loc=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST "$url")
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url")
  echo "$code $url"
  [ -z "$loc" ] && break
  url="$loc"
done
```

Probe with `POST`, because that is what an MCP client sends, and some platforms redirect `POST` differently from `HEAD`. The last line is the URL to put in `.mcp.json`, in a claude.ai custom connector, in Cursor's `mcp.json`, or in your SDK constructor. If the OAuth side is involved, that same final URL must also be the `resource` in your Protected Resource Metadata and the audience your tokens are minted for. Otherwise you trade this `401` for the audience-mismatch `401` described in [the invalid_token audience post](/2026/09/fix-mcp-401-invalid-token-audience-does-not-match-server-url/).

## Fix 2: stop the MCP endpoint from redirecting

You do not control every client's redirect policy. The durable fix is to make the MCP path answer `200`, `202` or `401` directly on every URL you have ever published. Three usual causes:

**Trailing-slash normalization.** Starlette's `Router` has `redirect_slashes=True` by default, so a FastMCP app mounted at `/mcp/` answers `/mcp` with a `307` ([python-sdk#1168](https://github.com/modelcontextprotocol/python-sdk/issues/1168)). Express routes are non-strict by default, so a `/mcp` route already answers `/mcp/` without redirecting, but nginx `location /mcp/ {}` blocks and "add trailing slash" rules on CDNs do redirect. On a hand-wired `node:http` server, normalize the path instead of redirecting:

```javascript
// Node 26.4.0, @modelcontextprotocol/node 2.0.0
createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '');
  if (path === '/mcp') return handleMcp(req, res);   // serves /mcp and /mcp/ alike
  res.writeHead(404).end();
}).listen(3000);
```

The spec's canonical URI guidance says to prefer the form without the trailing slash, so publish `/mcp` and quietly accept `/mcp/`.

**Host canonicalization at the edge.** An apex to `www.` rule, or a "force primary domain" setting on the hosting platform, applies to every path unless you exclude the MCP ones. Exclude `/mcp` and the discovery paths (`/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`) from the rule, or give the MCP server its own hostname that is never canonicalized.

**Vanity domain in front of a platform host.** If `tools.acme.dev` only exists to 308 to `acme-prod.fly.dev`, turn it into a real proxy or custom domain on the platform (so the platform serves `tools.acme.dev` directly with a certificate for it) instead of a redirect.

## Fix 3: make your own client fail fast instead of failing late

If you ship an MCP client on the TypeScript SDK, you can copy the Python SDK's behavior. The transport accepts a custom `fetch`. This one follows same-origin `307`/`308` only and throws a message that names the right URL:

```javascript
// @modelcontextprotocol/client 2.0.0, Node 26.4.0
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

function sameOriginFetch(maxRedirects = 5) {
  return async (input, init = {}) => {
    let url = new URL(input instanceof Request ? input.url : input);
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, { ...init, redirect: 'manual' });
      if (res.status < 300 || res.status > 399) return res;
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) return res;
      const next = new URL(location, url);
      const method = (init.method ?? 'GET').toUpperCase();
      if (next.origin !== url.origin) {
        throw new Error(`MCP endpoint ${url} redirects (${res.status}) to another origin: ${next}. Configure that URL instead.`);
      }
      if (method !== 'GET' && res.status !== 307 && res.status !== 308) {
        throw new Error(`MCP endpoint ${url} answered ${res.status} to a ${method}; only 307/308 keep the method and body.`);
      }
      if (hop >= maxRedirects) throw new Error(`Too many redirects from ${input}`);
      url = next;
    }
  };
}

const transport = new StreamableHTTPClientTransport(new URL('https://tools.acme.dev/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } },
  fetch: sameOriginFetch(),
});
await new Client({ name: 'my-agent', version: '1.0.0' }).connect(transport);
```

Against the repro, the same-origin redirect connects and lists `ping`, the cross-origin one throws `MCP endpoint http://localhost:3001/cross-308 redirects (308) to another origin: http://127.0.0.1:3002/mcp. Configure that URL instead.`, and a `301` on a `POST` throws before the message is lost. Node's fetch returns the real `3xx` response under `redirect: 'manual'`, which is why reading `Location` works here. In a browser it would be an opaque redirect with status `0`.

What you should not do is write the version that re-attaches `Authorization` to the new origin. That is exactly the leak the Fetch change was designed to stop, and a compliant server on the other end will reject the token as the wrong audience anyway. If the redirect target really is your server, the right move is Fix 1.

## Gotchas and lookalikes

**`301` and `302` turn the `POST` into a `GET`.** Fetch rewrites a redirected `POST` to a body-less `GET` for `301`, `302` and `303`. The repro's log shows `GET /mcp` arriving at the target for `/cross-301`. On Streamable HTTP a `GET` either opens the server-to-client SSE stream or gets a `405`, so the `initialize` request is gone even if the auth header had survived. Only `307` and `308` preserve method and body. Some ingress controllers and service meshes still mishandle a streamed body on a `307`, which is one more reason to not redirect at all. The [SSE to Streamable HTTP migration](/2026/07/migrate-an-mcp-server-from-sse-to-streamable-http/) covers the same trailing-slash trap from the server side.

**.NET strips the header even on a same-origin redirect.** `HttpClient` with the default `AllowAutoRedirect = true` clears `Authorization` on every automatic redirect, regardless of origin. In the repro, `/same-308` returned `401` from .NET while the TypeScript and Python clients connected. The documentation for [`HttpClientHandler.AllowAutoRedirect`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpclienthandler.allowautoredirect?view=net-10.0) states this, and the request to preserve it for same-origin hops is [dotnet/runtime#122609](https://github.com/dotnet/runtime/issues/122609), open and on the Future milestone. A .NET MCP client (anything built on `HttpClient`, including the C# SDK's HTTP transport) needs the exact final URL, trailing slash included.

**`http` to `https` is cross-origin for fetch.** If someone registered `http://mcp.example.com/mcp` and your edge upgrades it with a `308`, a fetch-based client arrives at the `https` URL without its token. The Python SDK treats a same-host upgrade on default ports as "within origin" and follows it. Register the `https` URL and the question never comes up.

**The `401` comes from the target, so its challenge points at the target.** After the hop, the `WWW-Authenticate` header the client parses is the one from the new host, including its `resource_metadata` URL. An OAuth-capable client then runs discovery against a resource it was never configured for. That is how a redirect turns into confusing "resource does not match" or sign-in loops instead of a clean redirect error.

**curl hides it unless you ask.** `curl -L` also drops `Authorization` when the host changes (the repro returned `401` from the target), and only `--location-trusted` sends it onward. Do not add that flag to a diagnostic script to make the problem go away. It proves the token works, not that the URL is right.

**"Works in Claude Code, fails on claude.ai" has another cause too.** If the redirect check comes back clean, the difference is usually network position: claude.ai connects from Anthropic's infrastructure, so split-horizon DNS or a WAF can be involved. Those, plus the stdio vs HTTP config mix-up, are covered in [fixing an HTTP MCP server URL that won't connect in Claude Desktop](/2026/05/fix-http-mcp-server-url-wont-connect-in-claude-desktop/). If a gateway sits in front of the server, check that it proxies instead of redirecting. The header-based routing in [routing MCP traffic with Mcp-Method and Mcp-Name](/2026/08/route-mcp-traffic-through-a-gateway-with-mcp-method-and-mcp-name-headers/) does not need a redirect anywhere.

## Related

- [Fix: remote MCP server returns 401 invalid_token because the token's aud doesn't match the canonical server URL](/2026/09/fix-mcp-401-invalid-token-audience-does-not-match-server-url/), the `401` you get once the header does arrive.
- [How to build an MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) for the server skeleton the repro is built on.
- [How to build a custom MCP server in Python with the official SDK](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) if your server is FastMCP behind Starlette.
- [Migrate an MCP server from SSE to Streamable HTTP](/2026/07/migrate-an-mcp-server-from-sse-to-streamable-http/) for endpoint layout and the trailing-slash rule.

## Sources

- [WHATWG Fetch PR #1544: remove Authorization header upon cross-origin redirect](https://github.com/whatwg/fetch/pull/1544) and the [original issue #944](https://github.com/whatwg/fetch/issues/944).
- [MCP Authorization, specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): Authorization on every request, canonical server URI, audience validation.
- [Claude connector troubleshooting](https://claude.com/docs/connectors/building/troubleshooting): "Your server URL redirects to a different host" and the diagnostic checklist.
- [modelcontextprotocol/python-sdk#1168](https://github.com/modelcontextprotocol/python-sdk/issues/1168): FastMCP plus Starlette's `redirect_slashes` producing a `307` for `/mcp`.
- [HttpClientHandler.AllowAutoRedirect](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpclienthandler.allowautoredirect?view=net-10.0) and [dotnet/runtime#122609](https://github.com/dotnet/runtime/issues/122609): .NET clearing `Authorization` on every redirect.
- [undici advisory GHSA-3787-6prv-h9w3](https://github.com/nodejs/undici/security/advisories/GHSA-3787-6prv-h9w3): Node's fetch already cleared `Authorization` cross-origin and later extended the same rule to `Proxy-Authorization`.
