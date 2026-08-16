---
title: "How to Route MCP Traffic Through a Gateway With the Mcp-Method and Mcp-Name Headers"
description: "MCP 2026-07-28 mirrors the JSON-RPC method and target name into HTTP headers so a gateway can route, throttle, and audit without parsing the body. Here is a working gateway, plus the header-body agreement rule that will bite you."
pubDate: 2026-08-16
tags:
  - "mcp"
  - "ai-agents"
  - "streamable-http"
  - "api-gateway"
  - "sep-2243"
---

Protocol revision `2026-07-28` added two required HTTP headers to the Streamable HTTP transport: `Mcp-Method` carries the JSON-RPC method, and `Mcp-Name` carries the tool, prompt, or resource being targeted. Your load balancer, rate limiter, or WAF can now route and meter MCP traffic by reading headers instead of buffering and parsing a JSON-RPC body. The catch, and the part most people get wrong on the first attempt, is that the headers are a mirror and not a control surface: a server that processes the body **MUST** reject any request where a header disagrees with it, with HTTP `400` and JSON-RPC error `-32020` (`HeaderMismatch`). A gateway that rewrites `Mcp-Name` to redirect a call does not redirect anything, it just breaks the call.

Everything below was run against `@modelcontextprotocol/server` 2.0.0 on Node 24.14.1, driving `createMcpHandler` with raw `fetch` requests carrying the `2026-07-28` envelope.

## What actually rides in the headers now

Before this revision, an intermediary that wanted to know whether a POST to `/mcp` was a cheap `tools/list` or an expensive `tools/call` had exactly one option: buffer the body, parse the JSON, and hope the payload was small. That is deep packet inspection on the hot path, and it forces every routing decision to wait for the full request. [SEP-2243](https://modelcontextprotocol.io/seps/2243-http-standardization), "HTTP Header Standardization for Streamable HTTP Transport", moved the interesting fields into the envelope.

| Header | Source field | Required for |
| --- | --- | --- |
| `MCP-Protocol-Version` | `params._meta["io.modelcontextprotocol/protocolVersion"]` | every POST |
| `Mcp-Method` | `method` | every request |
| `Mcp-Name` | `params.name` or `params.uri` | `tools/call`, `resources/read`, `prompts/get` |
| `Mcp-Param-{Name}` | an `x-mcp-header`-annotated tool argument | when the argument is present |

A conforming `tools/call` looks like this:

```http
POST /mcp HTTP/1.1
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: execute_sql
Mcp-Param-Region: us-west1

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "execute_sql",
    "arguments": { "region": "us-west1", "query": "SELECT * FROM users" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "ExampleClient", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

The spec is explicit about who these are for: the transport "mirrors selected JSON-RPC body fields into HTTP headers so that intermediaries (load balancers, gateways, observability tooling) can route and inspect requests without parsing the body." Note that this only works because the same revision [retired protocol-level sessions](/2026/07/github-mcp-server-goes-stateless-redis-session-store/). Sessions and header routing are two halves of one idea: every request now carries enough context to be dispatched on its own.

## A gateway that routes without touching the body

Here is a real one. Two backend pools, a denylist, a per-tool budget, and an audit log, all driven from `req.headers` before a single byte of body is read.

```js
// Node 24.14.1, MCP spec 2026-07-28
import http from 'node:http';

const DENY = new Set(['drop_database']);
const BUDGET = { execute_sql: 3 };
const spend = new Map();

function decodeMcpValue(v) {
  if (!v) return v;
  // the Base64 sentinel from the spec: =?base64?<payload>?=
  if (v.startsWith('=?base64?') && v.endsWith('?=')) {
    return Buffer.from(v.slice(9, -2), 'base64').toString('utf8');
  }
  return v;
}

function decide(headers) {
  const method = headers['mcp-method'];
  const name = decodeMcpValue(headers['mcp-name']);
  const region = decodeMcpValue(headers['mcp-param-region']);

  if (!method) return { deny: 400, why: 'no Mcp-Method header' };
  if (method === 'tools/call' && !name) return { deny: 400, why: 'tools/call without Mcp-Name' };
  if (name && DENY.has(name)) return { method, name, deny: 403, why: `${name} is blocked at the edge` };

  if (BUDGET[name] !== undefined) {
    const used = (spend.get(name) ?? 0) + 1;
    spend.set(name, used);
    if (used > BUDGET[name]) return { method, name, deny: 429, why: `budget for ${name} exhausted` };
  }

  return { method, name, region, port: name === 'execute_sql' ? SQL_POOL : GENERAL_POOL };
}

const gateway = http.createServer((req, res) => {
  const d = decide(req.headers);

  if (d.deny) {
    res.writeHead(d.deny, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: d.why } }));
    return;
  }

  const upstream = http.request(
    { host: '127.0.0.1', port: d.port, path: req.url, method: req.method, headers: req.headers },
    (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); }
  );
  req.pipe(upstream);   // the body is streamed through, never parsed
});
```

Driving six calls through it against two `createMcpHandler` backends:

```text
A. weather call                  HTTP 200  general-pool handled get_weather {"city":"Seattle"}
B. sql call, us-west1            HTTP 200  sql-pool handled execute_sql {"region":"us-west1",...}
C. sql call, eu-west1            HTTP 200  sql-pool handled execute_sql {"region":"eu-west1",...}
D. denylisted tool               HTTP 403  drop_database is blocked at the edge
E. gateway rewrites the region   HTTP 400  the Mcp-Param-Region header decodes to "eu-west1"
                                           but the body carries region="us-west1"
F. sql call over budget          HTTP 429  budget for execute_sql exhausted
```

And the audit rows the gateway built, entirely from headers:

```text
 method       name            region      routedTo        denied  bodyBytesReadBeforeRouting
 tools/call   get_weather     null        general-pool    null    0
 tools/call   execute_sql     us-west1    sql-pool        null    0
 tools/call   execute_sql     eu-west1    sql-pool        null    0
 tools/call   drop_database   null        null            403     0
 tools/call   execute_sql     eu-west1    sql-pool        null    0
 tools/call   execute_sql     us-west1    null            429     0
```

`bodyBytesReadBeforeRouting` is zero on every row. That is the whole point: the routing, the denylist, and the quota all resolve before the request body matters, so a 2 MB `tools/call` argument blob costs the gateway nothing to classify. Compare that with a per-tool allowlist built the old way, which had to live [inside the client's configuration](/2026/08/copilot-mcp-allowlists-enterprise-managed-settings/) because the network layer could not see tool names at all.

## Routing on a tool argument with x-mcp-header

`Mcp-Method` and `Mcp-Name` are fixed, but a server can promote its own tool arguments into headers. Annotate a property in the tool's `inputSchema` with `x-mcp-header`, and conforming clients **MUST** mirror that argument's value into `Mcp-Param-{Name}`:

```json
{
  "name": "execute_sql",
  "inputSchema": {
    "type": "object",
    "properties": {
      "region": { "type": "string", "x-mcp-header": "Region" },
      "query":  { "type": "string" }
    },
    "required": ["region", "query"]
  }
}
```

That is how you get tenant-aware or region-aware routing at the edge. The annotation carries real constraints, and clients must reject tools that violate them (excluding the offending tool from `tools/list` rather than failing the whole listing):

- Primitive types only: `integer`, `string`, `boolean`. `number` is not permitted.
- The property must be *statically reachable* from the schema root through a chain of `properties` keys only. No `items`, no `oneOf`/`anyOf`/`allOf`, no `if`/`then`/`else`, no `$ref`. Nested objects are fine as long as every hop is a `properties` key.
- Names must be case-insensitively unique across the whole `inputSchema` and must be valid HTTP field-name tokens.

That reachability rule is the one that surprises people. If your tool takes `{ "target": { "oneOf": [...] } }`, you cannot promote anything underneath it, so design the schema with the routing key as a flat top-level property from the start. This is the same pressure that shapes [MCP server design for a large internal API surface](/2026/08/mcp-server-design-for-a-large-internal-api-surface/): the shape of the schema is now also the shape of your routing table.

## The rule that makes this safe: headers and body must agree

The spec's reasoning is worth reading twice, because it explains why you cannot treat these headers as an override:

> Servers that process the request body **MUST** reject requests where the values specified in the headers do not match the corresponding values in the request body. This prevents potential security vulnerabilities when different components in the network rely on different sources of truth (e.g., a load balancer routing on the header value while the MCP server executes based on the body value).

That is a confused-deputy defence. Without it, an attacker sends `Mcp-Name: get_weather` past a permissive gateway and `"name": "drop_database"` in the body, and the two components disagree about what just happened.

Probing the TypeScript SDK confirms it enforces every branch. All of these return HTTP `400` with code `-32020`:

```text
Mcp-Name missing
  the body carries params.name="get_weather" but the required Mcp-Name header is absent

Mcp-Method missing
  the body names method tools/call but the required Mcp-Method header is absent

Mcp-Name disagrees with the body
  the body carries params.name="get_weather" but the Mcp-Name header names "delete_everything"

MCP-Protocol-Version header disagrees with _meta
  the body envelope names protocol version 2026-07-28 but the
  MCP-Protocol-Version header names 2025-11-25

Mcp-Param-Region omitted while the body carries it
  the body carries region="us-west1" but the Mcp-Param-Region header is absent

Mcp-Param-Region rewritten
  the Mcp-Param-Region header decodes to "eu-west1" but the body carries region="us-west1"
```

(The wording of those messages is from `@modelcontextprotocol/server` 2.0.0. The spec mandates the `-32020` code and the `400` status, not the prose.)

Two of those deserve special attention because they are things a *well-intentioned* gateway does by default.

**Stripping headers breaks calls.** Plenty of proxies run an allowlist of forwarded headers and drop the rest. Drop `Mcp-Param-Region` and the request now fails validation at the server, because the body still carries `region` and the mirror is gone. The spec is direct about this: intermediaries that do not recognize an `Mcp-Param-{Name}` header **MUST** forward it and otherwise ignore it. Add `Mcp-*` to your forward list before you turn any of this on.

**Rewriting headers does not redirect anything.** Case E in the run above is a gateway trying to force a call into the EU pool by rewriting `Mcp-Param-Region`. It routed fine, then died at the server with `-32020`. If you want to change where a call executes, change the routing target, not the mirrored value.

There is a recovery path for the first case: when a client gets a `HeaderMismatch` because required `Mcp-Param-*` headers are missing or wrong, it **SHOULD** call `tools/list` to pick up schema changes and retry. That covers the case where a server adds an `x-mcp-header` annotation while a client is holding a stale tool list.

## Non-ASCII names and the Base64 sentinel

Tool names are only *SHOULD*-constrained to header-safe characters, and resource URIs certainly are not. When a value cannot be represented as plain ASCII, the client encodes it:

```text
Mcp-Name: =?base64?5rip5bqm6KiI?=
Mcp-Param-Greeting: =?base64?SGVsbG8sIOS4lueVjA==?=
```

The markers are lowercase and case-sensitive. Clients must also Base64-encode any plain-ASCII value that happens to match the sentinel pattern, so there is no ambiguity to resolve.

For gateway authors this is a correctness trap. If you match `Mcp-Name` against a denylist without decoding first, a tool named with a leading space or a non-ASCII character sails straight through your policy. That is why `decodeMcpValue` runs before every comparison in the gateway above. Sending a Base64-encoded `Mcp-Name` through the SDK confirms it decodes before comparing: the header check passes and the request proceeds to dispatch, where it fails with `-32602` for an unregistered tool rather than `-32020` for a header mismatch.

## Gotchas worth knowing before you ship

**Check the protocol version before trusting a header.** A client speaking `2025-11-25` sends no `Mcp-Method` at all, and nothing validates header-body agreement on its behalf. The spec's guidance for policy-enforcing intermediaries is to verify that `MCP-Protocol-Version` names a revision that requires the validation, and to reject the request otherwise, rather than trusting unvalidated header values. A gateway that fails open on a missing `Mcp-Method` is a gateway with a bypass.

**Absence of a header is not a policy signal.** Validation is defined as "headers must not disagree with the body", so a method with no corresponding body field has nothing to disagree with. In practice a stray `Mcp-Name` on a `tools/list` request is accepted with HTTP `200` by the 2.0.0 SDK. Build your rules on the headers that must be present for a given `Mcp-Method`, not on the ones that happen to be absent.

**Notifications are not covered.** The spec states plainly that header requirements for notification POSTs are not defined by this revision. Since `2026-07-28` also defines no client-to-server notifications over Streamable HTTP in the core protocol, this rarely matters, but do not write a gateway rule that assumes every POST carries `Mcp-Method`.

**SSE responses still need proxy care.** Servers **SHOULD** send `X-Accel-Buffering: no` when opening a stream, and long-lived `subscriptions/listen` streams rely on periodic SSE comment lines (`:\r\n`) as keep-alives so intermediaries do not close them during quiet periods. If your gateway buffers responses, streaming progress notifications will arrive in one clump at the end. This is the same class of problem that shows up when you [migrate an MCP server from SSE to streamable HTTP](/2026/07/migrate-an-mcp-server-from-sse-to-streamable-http/).

**GET and DELETE are gone.** A `2026-07-28`-only server answers both with `405 Method Not Allowed`, ignores `Mcp-Session-Id`, and ignores `Last-Event-ID`. If your gateway config still has rules for the old GET stream endpoint, they are dead weight. The [transport comparison](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) is a useful refresher on what each revision expects on the wire.

The practical summary: treat `Mcp-Method`, `Mcp-Name`, and `Mcp-Param-*` as a read-only routing view of a request you are not allowed to change. Route on them, meter on them, log on them, and forward them untouched. The moment your gateway edits one, the server stops trusting the request entirely, which is exactly the behaviour you want from a protocol that just handed the network layer a say in what your agent is allowed to call.

## Related reading

- [MCP stdio vs HTTP vs SSE Transport: Which Should You Choose in 2026?](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/)
- [Migrate an MCP Server from SSE to Streamable HTTP](/2026/07/migrate-an-mcp-server-from-sse-to-streamable-http/)
- [GitHub's MCP Server Went Stateless and Deleted Its Redis Session Store](/2026/07/github-mcp-server-goes-stateless-redis-session-store/)
- [MCP Server Design for a Large Internal API Surface](/2026/08/mcp-server-design-for-a-large-internal-api-surface/)
- [How to Lock Down a Coding Agent's Network Egress With a Strict Host Allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/)

## Sources

- [Streamable HTTP transport, MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [SEP-2243: HTTP Header Standardization for Streamable HTTP Transport](https://modelcontextprotocol.io/seps/2243-http-standardization)
- [SEP-2243 pull request on modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2243)
- [The 2026-07-28 Specification, MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [Tool definitions and x-mcp-header](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#x-mcp-header)
