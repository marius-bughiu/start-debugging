---
title: "MCP Server Design for a Large Internal API Surface"
description: "Mapping 200 internal REST endpoints to 200 MCP tools puts 200 KB of JSON schema in front of every request. The 2026-07-28 spec also made the usual escape hatch illegal: tools/list MUST NOT vary per-connection, so per-session dynamic registration is gone. Here are the three levers that still work, with measured wire sizes and verified code on @modelcontextprotocol/server 2.0.0."
pubDate: 2026-08-14
tags:
  - "mcp"
  - "ai-agents"
  - "llm"
  - "typescript"
  - "api-design"
---

The obvious way to put an internal API behind an agent is to generate one MCP tool per endpoint. It is also the way that produces a server nobody can use. I measured a realistic generated catalog on `@modelcontextprotocol/server` 2.0.0 against MCP protocol revision `2026-07-28`: 229 generated CRUD tools serialize to 213,628 bytes of JSON on a single `tools/list` response, roughly 933 bytes per tool. That is the fixed cost paid before the model reads its first user token.

The usual escape hatch was to register tools dynamically per session, exposing a handful up front and adding more as the conversation narrowed. As of revision `2026-07-28` that is no longer legal: the spec now says the tool set "**MUST NOT** vary per-connection or as a side effect of other requests on the connection." Sessions were removed from the protocol entirely. What still works is curation, authorization-scoped tool lists, and a search-and-execute facade, plus the new cache hints that stop clients re-fetching a large catalog on every turn. This post covers all four, with code verified against the installed SDK.

## What 229 tools actually cost on the wire

Before choosing a strategy it helps to have a number. I registered N identical generated-style tools (six documented parameters each, the shape `speakeasy` or a similar OpenAPI generator emits) and measured the full `tools/list` response body:

```text
tools |  wire bytes | bytes/tool
    1 |        1120 |       1120
    8 |        7623 |        953
   30 |       28101 |        937
  120 |      111931 |        933
  229 |      213628 |        933
```

The per-tool cost is flat, which is the point: it scales linearly with your endpoint count and there is no compression anywhere in the path. At a rough four bytes per token that 229-tool catalog lands somewhere near 55k-60k tokens. Apideck, who generated a 229-tool server from their OpenAPI spec, [measured 25,000 to 40,000 tokens](https://www.apideck.com/blog/building-mcp-server-from-openapi) for their real catalog, which has terser descriptions than my synthetic one. Either way it is a five-figure token bill on every single request.

Bloat is only half the damage. AWS's writeup on [MCP tool design tradeoffs](https://aws.amazon.com/blogs/machine-learning/mcp-tool-design-practical-approaches-and-tradeoffs/) makes the second half explicit: as the catalog grows, tool-selection accuracy falls and the model burns turns calling the wrong thing with the wrong arguments. Their working limit is about eight parameters per tool. WorkOS, arguing the same case from the [REST-API-to-MCP direction](https://workos.com/blog/designing-mcp-server-from-rest-api), puts the sweet spot at 5-8 tools with 12 as a soft ceiling, and their line is worth keeping: "the number of tools you don't expose matters as much as the ones you do."

## The pattern that stopped being legal in 2026-07-28

If you read MCP advice written before August 2026, you will find the dynamic registration pattern everywhere: keep the initial tool list tiny, expose a `find_tools(intent)` meta-tool, and have the server register the three or four real tools that match, firing `notifications/tools/list_changed` so the client re-fetches. It was the standard answer for a large API surface.

Revision `2026-07-28` removed protocol-level sessions, and that pattern went with them. The [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) is blunt about the consequence: sessions and the `Mcp-Session-Id` header are gone from the Streamable HTTP transport, and "List endpoints (`tools/list`, `resources/list`, `prompts/list`) no longer vary per-connection." The [tools spec](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) states the rule directly, and then carves out the one exception that matters here:

> This set **MAY** be empty and **MAY** change over time [...] but **MUST NOT** vary per-connection or as a side effect of other requests on the connection. The set **MAY** vary by the authorization presented on the request [...] since credentials are per-request input, not connection state.

So the tool list may still differ between callers. It just has to be a pure function of the request's credentials, not of what happened earlier on the connection. That single sentence determines the whole design.

## Lever 1: curate before you generate

The cheapest tokens are the ones you never send. Run the endpoint list through four questions before any code generation:

- **Collapse (N-to-1)**: does a real agent task span several endpoints every time? An agent offboarding an employee calls the directory, the device registry, and the payroll API in a fixed order. Ship one `hris.employee.offboard` tool that does the sequence server-side. One tool definition, one round trip, no chance the model gets the order wrong.
- **Split (1-to-N)**: is one endpoint doing five jobs behind a `type` discriminator? Split it, so each tool gets a narrow schema and an unambiguous description.
- **Drop (0-to-1)**: admin operations, migrations, anything destructive with no agent use case. Most internal APIs are 30-50 percent this.
- **Demote (1-to-0)**: read-only reference data does not need to be a tool. Expose it as an MCP resource, which the client fetches on demand and which never occupies a tool slot.

Generate-then-curate is fine as a workflow. Shipping generator output directly is not.

## Lever 2: scope the tool list to the caller's credentials

This is the legal replacement for per-session registration, and for an internal API it is usually the biggest single win, because internal APIs already have scopes. A support engineer's token does not carry `billing:write`, so those tools should never reach their model.

In the TypeScript SDK the seam is the server factory. `createMcpHandler` calls it once per HTTP request with an `McpRequestContext` carrying the validated `authInfo`, which is exactly the per-request input the spec permits:

```ts
// @modelcontextprotocol/server 2.0.0, zod 4.4.3, MCP spec 2026-07-28
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

const CATALOG = [
  { name: 'billing.invoice.search',  scope: 'billing:read',  desc: 'Search invoices by customer, status, or date range.' },
  { name: 'billing.invoice.void',    scope: 'billing:write', desc: 'Void an open invoice.' },
  { name: 'hris.employee.search',    scope: 'hris:read',     desc: 'Search employees by name, team, or location.' },
  { name: 'hris.employee.offboard',  scope: 'hris:write',    desc: 'Start the offboarding workflow for an employee.' },
];

function buildServer(scopes: string[]) {
  const server = new McpServer(
    { name: 'internal-api', version: '1.0.0' },
    // Without this the SDK emits ttlMs: 0 and the client re-fetches every turn.
    { cacheHints: { 'tools/list': { ttlMs: 300_000, cacheScope: 'private' } } }
  );

  for (const t of CATALOG) {
    if (!scopes.includes(t.scope)) continue;
    server.registerTool(
      t.name,
      { description: t.desc, inputSchema: z.object({ q: z.string().describe('Free-text query') }) },
      async ({ q }) => ({ content: [{ type: 'text', text: `${t.name}(${q})` }] })
    );
  }
  return server;
}

// The factory runs per request. authInfo is pass-through: verify the token upstream.
export const handler = createMcpHandler((ctx) => buildServer(ctx.authInfo?.scopes ?? []));
```

Running that against the real handler, two callers get two different catalogs from one deployment:

```text
scopes=["billing:read"]
  tools:      billing.invoice.search
  resultType: complete
  ttlMs:      300000   cacheScope: private

scopes=["billing:read","billing:write","hris:read"]
  tools:      billing.invoice.search, billing.invoice.void, hris.employee.search
  resultType: complete
  ttlMs:      300000   cacheScope: private
```

One caveat the SDK types spell out: `authInfo` is "strictly pass-through: the handler never populates this from request headers and performs no token verification of its own." Verify the bearer token in your own middleware (the SDK ships `requireBearerAuth` and `verifyBearerToken` for this) and hand the validated result to `fetch`. The factory trusts whatever you give it.

## Lever 3: the search-and-execute facade

When curation and scoping still leave you with hundreds of tools, replace the catalog with a fixed set of meta-tools. Apideck's server exposes four -- `list_tools`, `describe_tool_input`, `execute_tool`, `list_scopes` -- and reports about 1,300 tokens of startup cost instead of 25,000-40,000, independent of whether the underlying API has 50 operations or 500.

This is still legal under `2026-07-28` precisely because the facade's own tool list is static. Nothing varies per connection: the model discovers operations by *calling a tool*, not by watching the tool list mutate underneath it. The dynamic behaviour moved from the protocol layer into tool results, which is where the spec now wants it.

The cost is real, though, and worth stating plainly: every task now pays two extra round trips before any work happens, and the model is selecting from search results it has to read rather than from schemas already in context. AWS's version of this (their "lazy loading" tier) reports the leanest baseline context of any approach they tested, with extra round trips on ambiguous queries. Use it when the catalog genuinely cannot be curated below a few dozen tools, not as a default.

Anthropic's clients solve the same problem from the other end, with server-side tool search and deferred loading. If your target is Claude specifically, [reducing the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/) covers `ENABLE_TOOL_SEARCH`, `defer_loading`, and `mcp_toolset`, which get you most of this benefit without redesigning your server.

## Make the catalog cacheable, and check the default

Revision `2026-07-28` added a `CacheableResult` interface (SEP-2549). Servers now MUST return `ttlMs` and `cacheScope` on `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, and `server/discover`. For a large catalog this is the difference between shipping 200 KB once per five minutes and shipping it on every turn.

The trap is the default. The SDK's `CacheHint` doc comment is explicit that absent fields "fall back to the conservative defaults (`ttlMs: 0`, `cacheScope: 'private'`)", and `ttlMs: 0` means the client "**SHOULD** [consider the response] immediately stale." I confirmed it on a server with no `cacheHints` configured:

```text
no cacheHints configured -> ttlMs: 0, cacheScope: private
```

That is a correct, spec-compliant server that re-sends its entire tool catalog whenever the client wants it. Set `cacheHints` explicitly.

Two smaller wins in the same area. First, the spec now says servers "**SHOULD** return tools in a deterministic order," because stable ordering lets clients cache the list *and* improves prompt-cache hit rates when the tools go into model context. If you build your catalog by iterating a hash map, sort it. Second, `tools/list` supports cursor pagination, and page size is server-determined: clients "**MUST NOT** assume a fixed page size." Each page caches independently and can carry its own `ttlMs`. Pagination reduces peak response size but not total tokens, since the client walks every page before the model sees anything. Treat it as a transport-level nicety, not a context-window fix.

## The cacheScope trap on a scoped tool list

Lever 2 and the caching section interact in a way that can leak. If you scope your tool list by credentials and then mark it `cacheScope: "public"` to get better cache hit rates, you have built a cross-tenant disclosure bug. The spec's security note is unambiguous:

> the Result from an authenticated `tools/list` call with a `"public"` `cacheScope` may be cached by a client and may be shared outside of the initial requests authorization context. (i.e. different access tokens can leverage the same cache).

`"private"` responses may be reused within one authorization context, and caches "**MUST NOT** be shared across authorization contexts." So the rule is mechanical: any list that varies by caller is `private`. `public` is only for catalogs that are byte-identical for every user. The SDK defaulting to `private` is the safe direction, which means this bug only appears when someone reaches for `public` to speed things up.

The spec adds the obvious corollary, worth repeating because it is the kind of thing that gets skipped: servers "MUST apply appropriate per-primitive access controls, and MUST NOT rely on `cacheScope` alone." Filtering the tool list is a usability and token optimisation, not an authorization boundary. Check the scope again inside every tool handler.

## Multi-step workflows without sessions

Internal APIs are full of stateful sequences: open a transaction, stage some changes, commit. With sessions gone, the spec's non-normative guidance is to mint an explicit handle from a creation tool and accept it as an argument on later calls:

```jsonc
// → tools/call
{ "name": "create_basket", "arguments": {} }
// ← result
{ "structuredContent": { "basket_id": "bsk_a1b2c3" } }

// → tools/call
{ "name": "add_item", "arguments": { "basket_id": "bsk_a1b2c3", "sku": "..." } }
```

The maintainers argue this is better than what it replaced: "the model can see the handle and thread it between tools." Four things to get right, per the spec: validate authorization against the handle on every call (a handle is a name, not a capability), keep handles opaque, state the retention policy in the creation tool's description so the model knows what it is committing to, and return a tool execution error rather than a protocol error when a handle expires, so the model can recover by making a new one.

## Three gotchas that will bite on the first deploy

**The `Mcp-Method` header is mandatory.** SEP-2243 requires `Mcp-Method` and `Mcp-Name` on Streamable HTTP POSTs. My first probe omitted it and got a hard failure, not a warning:

```text
HTTP 400
{"code":-32020,"message":"Bad Request: the request headers and body disagree:
 the body names method tools/list but the required Mcp-Method header is absent"}
```

Note the code: `-32020` is the renumbered `HeaderMismatch` error. Revision `2026-07-28` partitioned the JSON-RPC server-error range, moving `HeaderMismatch` from `-32001` to `-32020`, `MissingRequiredClientCapability` to `-32021`, and `UnsupportedProtocolVersion` to `-32022`. If you have assertions on the old numbers, they will fail.

**Tool names have rules now.** 1 to 128 characters, only ASCII letters, digits, underscore, hyphen and dot. Uniqueness is scoped to your server, so an aggregating client that mounts your `search` alongside another server's `search` has a collision to resolve. Namespace them yourself (`billing.invoice.search`) rather than hoping the client's disambiguation strategy is one you like.

**`x-mcp-header` is useful for large internal deployments.** You can mark a primitive tool parameter with `x-mcp-header: "Region"` and the client mirrors its value into an `Mcp-Param-Region` HTTP header, letting load balancers and WAFs route without parsing the body. Do not mark anything sensitive: header values are visible to every intermediary on the path.

## Where this lands

For a large internal API surface, the order is: curate hard, scope the survivors by credentials, set explicit cache hints with `cacheScope: "private"`, and reach for a search-and-execute facade only when the curated catalog is still unmanageable. Skip step one and no amount of protocol cleverness saves you, because the tokens were always the problem and the 2026-07-28 spec deliberately closed the door on hiding them behind per-session state.

If you are building the server itself, [building a custom MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) covers the scaffolding this post assumes. On transport choice, see [MCP stdio vs HTTP vs SSE](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/); only Streamable HTTP gets you the per-request `authInfo` that lever 2 depends on. The .NET side made the same journey a month earlier, documented in [MCP C# SDK 2.0 going stateless by default](/2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005/). And if your `mcp.json` still points at any of the [archived MCP reference servers](/2026/08/migrate-off-archived-mcp-reference-servers/), none of this applies to them, because they cannot negotiate past protocol `2024-11-05`.

## Sources

- [Key Changes, MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Tools, MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Caching, MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching)
- [Pagination, MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination)
- [The 2026-07-28 Specification, MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [MCP tool design: practical approaches and tradeoffs, AWS](https://aws.amazon.com/blogs/machine-learning/mcp-tool-design-practical-approaches-and-tradeoffs/)
- [Designing an MCP server from a REST API, WorkOS](https://workos.com/blog/designing-mcp-server-from-rest-api)
- [How we built an MCP server with 229 tools, Apideck](https://www.apideck.com/blog/building-mcp-server-from-openapi)
