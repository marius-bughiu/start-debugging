---
title: "Stateful vs Stateless MCP Servers: What Actually Breaks When the Session Goes Away"
description: "Protocol revision 2026-07-28 deleted Mcp-Session-Id, the initialize handshake, resources/subscribe, ping, logging/setLevel and SSE resumability. An automated survey of 1000 open source MCP servers found 90% reference the session ID nowhere. Here is what the other 10% has to rewrite, with verified code on @modelcontextprotocol/server 2.0.0."
pubDate: 2026-08-30
template: vs
tags:
  - "mcp"
  - "ai-agents"
  - "llm"
  - "typescript"
  - "architecture"
---

**Short answer:** build stateless. Protocol revision `2026-07-28` removed sessions from MCP entirely, and if you need state across tool calls you mint an explicit handle (`basket_id`, `connection_id`) and let the model thread it back as an ordinary tool argument. The only thing that is genuinely hard to port is a tool handler that paused mid-execution to elicit input from the user, because that handler now has to return and be re-entered. Everything else is either a config line you delete or code your SDK already deleted for you.

The reason to take this seriously rather than treating it as a spec-nerd detail: [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) shipped with an automated survey of a 1000-repo random sample of open source MCP servers, and the distribution is lopsided. 90.0% of them never reference the MCP session ID at application level and need no migration at all. The interesting question is not "is stateless better" (it is, and the argument is settled) but "which 10% am I in, and what does that cost me".

## What a session was supposed to scope, and why it never held

The pre-`2026-07-28` spec attached five things to a session's lifetime: the negotiated protocol version and capabilities, elicitation and sampling intermediate state, application state, mutable list endpoints, and resource subscriptions.

The problem was that nobody agreed what a session *was*. SEP-2567 documents the spread across deployed clients: ChatGPT creates a fresh session for every individual tool call, Claude.ai did the same until recently, most desktop and IDE clients create one at application launch and hold it for the process lifetime, and web clients typically create one per page load. Almost none resume a session after a disconnect. A server author choosing to scope a Playwright browser instance to "the session" had no way to know whether that meant one user turn, one agent process, or one long-lived chat.

Two structural problems followed from that, and both are worth understanding before you argue for keeping sessions.

**Cardinality is fixed at exactly one per session.** An orchestrator that spawns several subagents to research products wants them to share one shopping cart but each hold their own browser context. No session boundary gives you both: if subagents share the parent's session they clobber each other's browsers, and if they get their own the cart fragments. Explicit handles let the orchestrator call `create_basket()` once, hand the `basket_id` to every subagent, and let each call `create_browser()` for itself.

**List endpoints could not be cached across sessions.** Because `tools/list` was allowed to vary per connection, a client could never reuse a list it fetched in a previous session. For a host that spawns short-lived subagents, that is `O(subagents x servers)` calls to `tools/list` on the hot path, and for a large catalog that traffic can exceed the actual tool calls. Removing sessions makes the list a stable thing to cache, which is what [SEP-2549](https://modelcontextprotocol.io/specification/2026-07-28/changelog) then puts a TTL on.

## The feature matrix

| Capability | `2025-11-25` (sessionful) | `2026-07-28` (stateless) |
| --- | --- | --- |
| Handshake | `initialize` + `notifications/initialized` | Removed. Per-request `_meta` |
| Session identity | `Mcp-Session-Id` header | Removed from the protocol |
| Version negotiation | Once, at handshake | Per request, `MCP-Protocol-Version` header plus `_meta`, `-32022` on mismatch |
| Capability discovery | `initialize` result | `server/discover`, which servers MUST implement |
| Sampling / elicitation / roots | Server-initiated requests on a held-open stream | Multi Round-Trip Requests: `resultType: "input_required"` plus a client retry |
| Resource subscriptions | `resources/subscribe` | `subscriptions/listen`, opt-in per notification type |
| Server push channel | HTTP `GET` stream | Removed. POST only |
| Liveness | `ping`, both directions | Removed. Any RPC proves liveness |
| Log level | `logging/setLevel`, once per session | `io.modelcontextprotocol/logLevel` in each request's `_meta` |
| Stream resumability | `Last-Event-ID` redelivery | Removed. Re-issue as a new request |
| Long-running work | Blocking call or experimental tasks | `io.modelcontextprotocol/tasks` extension, `tasks/get` polling |
| Cross-call state | Session-keyed server map | Explicit server-minted handles as tool arguments |
| `tools/list` stability | MAY vary per connection | MUST NOT vary per connection. Carries `ttlMs` and `cacheScope` |
| Deployment | Sticky routing plus a shared session store | Any replica, plain round robin |

## The six migration buckets, and what each one costs

SEP-2567's survey sorts real servers into buckets. In ascending order of pain:

1. **No application reference to the session ID (90.0%).** Nothing to do. Bump the SDK.
2. **`Map<sessionId, Transport>` routing (3.5%).** This was TypeScript SDK boilerplate, not your design. A sessionless transport deletes it.
3. **Transport setup only (2.8%).** You passed `sessionIdGenerator` and never read the value. Delete one constructor option.
4. **Session-keyed application state (2.5%).** Real work, but mechanical: replace the session-keyed map with a handle-keyed one, add a `create_*` tool, add the handle as a parameter on the stateful tools.
5. **Proxy and gateway sticky routing (0.7%).** The hardest bucket. Gateways that bridge HTTP to stdio by spawning one subprocess per session lose their routing key and need a designed replacement, usually the authenticated principal or a gateway-issued header. If you route on the new standard headers instead, see [routing MCP traffic through a gateway with Mcp-Method and Mcp-Name](/2026/08/route-mcp-traffic-through-a-gateway-with-mcp-method-and-mcp-name-headers/).
6. **Auth artifacts bound to the session ID (0.5%).** PKCE verifiers or session-to-user pinning maps keyed on `Mcp-Session-Id`. In the PKCE case you are already threading a correlation value through the OAuth `state` parameter, so the fix is to put a server-generated nonce there instead. Worth a careful review, since it is auth code.

Missing from that survey is the one category it could not measure: handlers that called elicitation or sampling mid-execution. That is a protocol-level pattern rather than a session-ID reference, and it is the change that actually costs you a rewrite.

## The handle pattern, verified

Handles are not a protocol feature. There is no `handles/*` method and no handle type in the schema. From the wire's perspective `basket_id` is a string in `structuredContent` and a string in a later tool's arguments. Everything below runs on `@modelcontextprotocol/server` 2.0.0.

```ts
// @modelcontextprotocol/server 2.0.0, MCP protocol revision 2026-07-28
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const baskets = new Map<string, string[]>();

export const handler = createMcpHandler(() => {
  const server = new McpServer(
    { name: 'basket', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      // Without this, every tools/list result ships ttlMs: 0 / cacheScope: 'private'.
      cacheHints: { 'tools/list': { ttlMs: 300_000, cacheScope: 'public' } },
    },
  );

  server.registerTool(
    'create_basket',
    {
      // Put the durability policy in the description: the model reads this, not your README.
      description: 'Creates a basket and returns basket_id. Baskets expire after 24h idle.',
      inputSchema: {},
    },
    async () => {
      const id = 'bsk_' + randomBytes(16).toString('base64url'); // 128 bits of entropy
      baskets.set(id, []);
      return {
        content: [{ type: 'text', text: `Created basket ${id}` }],
        structuredContent: { basket_id: id },
      };
    },
  );

  server.registerTool(
    'add_item',
    { description: 'Adds a SKU to a basket.', inputSchema: { basket_id: z.string(), sku: z.string() } },
    async ({ basket_id, sku }) => {
      const items = baskets.get(basket_id);
      if (!items) {
        // Say "expired", not "invalid argument". The model can recover from the first one.
        return {
          isError: true,
          content: [{ type: 'text', text: `basket ${basket_id} has expired, call create_basket again` }],
        };
      }
      items.push(sku);
      return { content: [{ type: 'text', text: `Added ${sku} to ${basket_id} (${items.length} items)` }] };
    },
  );

  return server;
});
```

Four design rules come out of SEP-2567's guidance, and they are the difference between a handle that works and one that leaks:

- **Opaque, not structured.** `bsk_a1b2c3` invites nothing. `cart_user42_2026-03-11` invites the model to guess the next one.
- **Possession is not authorization.** Handles land in chat logs, subagent prompts and copy-paste buffers. Validate the pair of handle and auth context on every call. If your server has no auth at all, the handle is a bearer token, so generate at least 128 bits from a CSPRNG and bound its lifetime.
- **State the durability policy in the tool description.** "Lasts until the connection closes" is no longer a thing that exists. The model decides whether to create state, so the expiry has to be in front of it.
- **Take creation parameters.** `create_context(cluster="staging")` beats `create_context()` followed by `set_cluster(ctx, "staging")`: one round trip, and the state cannot exist half-configured.

One consequence that catches people: the old trick where calling `connect_database()` made `query` and `list_tables` appear in later `tools/list` results is now illegal, because lists must not change as a side effect of another request. Expose `query` unconditionally, give it a `connection_id` argument, and let a call without a valid one fail with an error that names `connect_database`. If your catalog is large enough that this matters, [MCP server design for a large internal API surface](/2026/08/mcp-server-design-for-a-large-internal-api-surface/) covers the levers that survived.

## The one that is real work: mid-call elicitation

Under `2025-11-25` a handler could `await` an elicitation in the middle of its execution, because the session kept the call frame alive. Under `2026-07-28` there are no server-initiated requests. The handler returns an `InputRequiredResult`, the process forgets everything, the client gathers the answer, and the client retries the original request with `inputResponses` attached. Any context you need on the second pass has to travel in `requestState`, an opaque string the client echoes back verbatim.

```ts
// @modelcontextprotocol/server 2.0.0, MCP protocol revision 2026-07-28
import {
  createMcpHandler, McpServer, inputRequired, acceptedContent, createRequestStateCodec,
} from '@modelcontextprotocol/server';

// The key must be shared by every replica that might serve the retry.
const codec = createRequestStateCodec({ key: process.env.MCP_STATE_KEY!, ttlSeconds: 600 });

const server = new McpServer(
  { name: 'basket', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    // Wire this or ctx.mcpReq.requestState() silently returns undefined.
    requestState: { verify: codec.verify },
  },
);

server.registerTool(
  'checkout',
  { description: 'Checks out a basket after confirming with the user.', inputSchema: { basket_id: z.string() } },
  async ({ basket_id }, ctx) => {
    const state = ctx.mcpReq.requestState<{ basket_id: string }>();

    if (!state) {
      return inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: `Check out ${basket_id}?`,
            requestedSchema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
            },
          }),
        },
        requestState: await codec.mint({ basket_id }),
      });
    }

    const answer = acceptedContent<{ ok: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
    return {
      content: [{ type: 'text', text: answer?.ok ? `Checked out ${state.basket_id}` : 'Cancelled' }],
    };
  },
);
```

Driving that end to end against the handler produces exactly the two-round flow the spec describes: round one comes back with `"resultType": "input_required"`, an `inputRequests` map keyed `confirm`, and a 134-character `requestState`; round two, carrying `inputResponses` and the echoed state, returns `"resultType": "complete"` and the checkout text.

## Gotchas that cost me time

All of these are behaviours I hit while verifying the code above on `@modelcontextprotocol/server` 2.0.0.

**`requestState` is signed, not encrypted.** The codec's wire format is `v1.<base64url payload>.<mac>`, and the payload decodes to plain JSON such as `{"p":{"basket_id":"bsk_..."},"exp":1788081713}`. Anything you mint is readable by the client and by anyone reading the transcript. Put identifiers in there, never secrets.

**Forgetting `requestState.verify` fails silently.** If you mint state but do not pass `verify` in `ServerOptions`, `ctx.mcpReq.requestState()` returns `undefined` on the retry, your handler takes the `if (!state)` branch again, and the client loops until the SDK's `inputRequired.maxRounds` (default 8) trips. No error, just a tool that never finishes.

**Tampered state returns `-32602`.** Flip three characters of the MAC and the retry comes back with `{"code":-32602,"message":"Invalid or expired requestState","data":{"reason":"invalid_request_state"}}`. That is the frozen response: the codec's internal reason codes (`malformed`, `mac`, `expired`, `bind`) never reach the client.

**The headers have to agree with the body.** `2026-07-28` requires `Mcp-Method` and `Mcp-Name` on Streamable HTTP POSTs so a gateway can route without parsing JSON. Send a body naming `tools/call` without a matching `Mcp-Method` and you get `400` with `-32020`, the `HeaderMismatch` code.

**`GET` on the endpoint returns `405`.** The server-to-client GET stream is gone. If your health check pings the MCP endpoint with a GET, it now fails.

**Cache hints default to nothing.** A `tools/list` result ships `ttlMs: 0` and `cacheScope: "private"` unless you set `cacheHints`. The whole cross-subagent caching win that justified removing sessions is opt-in, and most servers will ship without it.

**Do not gate on `LATEST_PROTOCOL_VERSION`.** In `@modelcontextprotocol/server` 2.0.0 that constant is still `"2025-11-25"` and `SUPPORTED_PROTOCOL_VERSIONS` does not list the new revision at all. The modern revision lives on a separate constant and is always an explicit opt-in. `createMcpHandler` defaults to `legacy: 'stateless'`, which serves both eras from one endpoint; `legacy: 'reject'` makes an `initialize` attempt fail with `-32022` and `data.supported: ["2026-07-28"]`. If you are debugging that error from the client side, [the unsupported protocol version fix](/2026/08/fix-mcp-unsupported-protocol-version-2025-11-25-vs-2026-07-28/) walks through both ends.

**Logging goes quiet by default.** A server MUST NOT emit `notifications/message` for a request whose `_meta` did not carry `io.modelcontextprotocol/logLevel`. Clients that never set it get no logs and no error. Roots, Sampling and Logging are all deprecated now anyway, under a minimum twelve-month window, with stderr or OpenTelemetry as the suggested replacement.

## When staying stateful is still defensible

Two cases, and one of them is temporary.

A **stdio server relying on process lifetime** is not mechanically broken. One process per client, one in-memory browser instance, and it keeps working. SEP-2567 still says such servers SHOULD NOT rely on it, because process lifetime has the same undefined-scope problem, and because a server built that way cannot offer equivalent behaviour over HTTP where there is no process per client. If you are weighing that tradeoff, [MCP stdio vs HTTP vs SSE transport](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) is the longer version of the argument.

A **gateway that spawns one upstream subprocess per client** genuinely needs a correlation key, and the spec does not give it one. That is a transport-layer concern now: route by authenticated principal, or by a header the gateway issues itself.

Everything else should move. The rollout is a clean break with no deprecation window, so servers that still need session-scoped state stay on `2025-11-25` until they have migrated, and version negotiation handles the mixed deployment. That is a holding position, not a plan.

For durability, the thing sessions were supposed to give you and never did, the answer is the `io.modelcontextprotocol/tasks` extension. The server returns a `CreateTaskResult` with `resultType: "task"`, a `taskId`, a `ttlMs` and a `pollIntervalMs`; the client polls `tasks/get` until it reaches `completed`, `failed` or `cancelled`, and answers `input_required` states via `tasks/update`. A task ID survives a client crash. A session ID did not.

### Read next

- [GitHub's MCP server went stateless and deleted its Redis session store](/2026/07/github-mcp-server-goes-stateless-redis-session-store/) for what the subtraction looked like in production.
- [MCP C# SDK 2.0: stateless by default and MCP9005 on your old code](/2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005/) for the same migration in .NET.
- [Migrate an MCP server from SSE to streamable HTTP](/2026/07/migrate-an-mcp-server-from-sse-to-streamable-http/) if you are still on the older transport and doing both moves at once.

### Sources

- [Key Changes: the 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [SEP-2575: Make MCP Stateless](https://modelcontextprotocol.io/seps/2575-stateless-mcp)
- [SEP-2567: Sessionless MCP via Explicit State Handles](https://modelcontextprotocol.io/seps/2567-sessionless-mcp)
- [Multi Round-Trip Requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
- [MCP Tasks extension](https://modelcontextprotocol.io/docs/extensions/tasks)
- [Supporting protocol revision 2026-07-28, MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
