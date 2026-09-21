---
title: "Migrate a stdio MCP Server to a Remote OAuth-Protected HTTP Server (MCP 2026-07-28: CIMD First, DCR as Fallback)"
description: "Move a local stdio MCP server to a remote Streamable HTTP server behind OAuth on MCP spec 2026-07-28 and TypeScript SDK 2.0.0. Dynamic Client Registration is now deprecated, so use Client ID Metadata Documents first and keep DCR only as a fallback. Covers the steps, a measured CIMD/DCR test matrix, and the misleading error you get when the two sides disagree."
pubDate: 2026-09-21
updatedDate: 2026-09-21
template: migration
tags:
  - "migration"
  - "mcp"
  - "oauth"
  - "ai-agents"
  - "claude-code"
  - "typescript"
---

**Short answer:** keep your tool code, wrap it in a server factory, and serve that factory two ways: over stdio for existing users, and over Streamable HTTP behind `requireBearerAuth` with a Protected Resource Metadata document for everyone else. The server does not register clients. Your authorization server does that, and under [MCP spec revision 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration), Dynamic Client Registration (DCR) is **deprecated** in favor of Client ID Metadata Documents (CIMD). So pick an authorization server that advertises `client_id_metadata_document_supported: true`, and leave its `registration_endpoint` enabled only for older clients. The deprecated features keep working for at least twelve months. Everything below was run against `@modelcontextprotocol/server`, `client`, `express` and `node` 2.0.0, `jose` 6.2.12, `express` 5.2.1 and `zod` 4.6.5 on Node 26.4.0, with client behavior checked against Claude Code's changelog up to 2.1.278.

Plan on one day for the server changes and most of a week for the rest: picking the authorization server, handling upstream credentials, and moving every client config off `command` and onto `url`. You can undo the change as long as you keep shipping the stdio build.

## Why a stdio server has no auth story to migrate

A stdio server has no authentication layer. The spec says outright that implementations using stdio "**SHOULD NOT** follow this specification, and instead retrieve credentials from the environment". So a typical local server looks like this, and the "auth" is one environment variable that the user pasted into their client config:

```js
// BEFORE: stdio server. @modelcontextprotocol/server 2.0.0, zod 4.6.5, Node 26.4.0
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';

const API_KEY = process.env.TICKETS_API_KEY; // one key, one user, set by the client's config

serveStdio(() => {
  const server = new McpServer({ name: 'tickets', version: '1.0.0' });
  server.registerTool('list_tickets',
    { description: 'List open tickets assigned to the caller', inputSchema: z.object({ status: z.string().default('open') }) },
    async ({ status }) => ({ content: [{ type: 'text', text: await callTicketsApi(API_KEY, status) }] }));
  return server;
});
```

When you move it to a remote server, that one assumption goes away. There is no longer one user per process, no environment set by the user, and no filesystem shared with the user's machine. Everything in the "What breaks" table below follows from that. If you are still deciding whether to go remote at all, the trade-offs are in [MCP stdio vs HTTP vs SSE transport](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/).

## Why migrate now, and why not to DCR

- **Team and hosted use.** A remote server lets a whole org use one deployment with per-user identity and revocation, instead of each laptop holding a long-lived API key in plain text in a JSON file.
- **Clients now expect OAuth, not pasted keys.** Claude Code runs the whole flow from `/mcp` or `claude mcp login <name>` (from 2.1.186), refreshes tokens on a `401`, and retries once.
- **DCR has an expiry date.** [SEP-2577](https://blog.modelcontextprotocol.io/posts/2026-07-28/) deprecated it in 2026-07-28. The SDK's `registerClient` is now marked `@deprecated` with the note "Remains functional during the deprecation window (at least twelve months)". The earliest possible removal is the first spec revision on or after 2027-07-28. A migration you do today should not be built on DCR.
- **CIMD removes the registration step entirely.** The client's `client_id` is an HTTPS URL that points at a JSON document the client hosts. The authorization server fetches it, checks that `client_id` matches the URL exactly and that the redirect URI appears in the document, and moves on. No registration database, and no pile of orphaned client records.

## What breaks

| Area | Stdio behavior | Remote behavior | Severity |
| --- | --- | --- | --- |
| Credentials | `process.env.API_KEY`, one per process | Bearer token per request, per user (`ctx.http.authInfo`) | high |
| Upstream API calls | Server uses the user's own key | The MCP token **MUST NOT** be passed through; the server needs its own upstream credential or a token exchange | high |
| Client registration | None | CIMD, pre-registration, or (deprecated) DCR, handled by your authorization server | high |
| Local file and process tools | Run on the user's machine | Run on your server; tools that read local paths stop making sense | high |
| Client config | `command` + `args` + `env` | `type: "http"` + `url` (+ optional `oauth` block) | medium |
| Discovery | None | `401` + `WWW-Authenticate` with `resource_metadata`, plus `/.well-known/oauth-protected-resource/<path>` | medium |
| Logging | Never write to stdout | stdout is free again; log `sub` and `client_id` per call | low |

The upstream-credential row surprises people the most. On stdio, the tool called the tickets API with the user's key. On a remote server, the token the client sends you has your MCP server as its audience. The security considerations say the server "**MUST NOT** pass through the token it received from the MCP client." You either hold a service credential and enforce per-user authorization yourself, or you become an OAuth client of the upstream API and exchange tokens.

## Pre-flight checklist

1. Pick the public URL now and never derive it from the request: `https://mcp.example.com/mcp`, with a path and no trailing slash. It becomes the `resource` in your metadata and the `aud` you validate. A mismatch here produces the error in [the `aud` mismatch fix](/2026/09/fix-mcp-401-invalid-token-audience-does-not-match-server-url/).
2. Check what your authorization server actually supports. Vendor marketing pages disagree about which identity providers support CIMD, so read the metadata:

   ```bash
   # Any OAuth 2.0 / OIDC issuer; try oauth-authorization-server first, then openid-configuration
   curl -s https://auth.example.com/.well-known/oauth-authorization-server \
     | jq '{cimd: .client_id_metadata_document_supported, dcr: .registration_endpoint,
            pkce: .code_challenge_methods_supported, iss_param: .authorization_response_iss_parameter_supported}'
   ```

   You want `cimd: true`, `pkce` containing `"S256"`, and ideally `iss_param: true` (the spec expects to upgrade `iss` in authorization responses from SHOULD to MUST). `dcr` is optional. Also confirm that the issuer puts the RFC 8707 `resource` value into `aud`, because several popular ones do not by default.
3. Decide how you will get upstream credentials (service account, token exchange, or a per-user OAuth grant stored server-side).
4. List the tools that touch the local filesystem or spawn local processes. They either stay stdio-only or need a server-side equivalent.

## Migration steps

1. Split the transport from the server by sharing one factory.
2. Replace the environment credential with the per-request auth context.
3. Publish Protected Resource Metadata and put `requireBearerAuth` in front of `/mcp`.
4. Configure the authorization server: CIMD on, DCR as a fallback, loopback redirects allowed.
5. Repoint clients from `command` to `url`, with a pre-registered client ID as the last resort.
6. Keep the stdio build for a deprecation window, then remove it.

### Step 1: one factory, two transports

`serveStdio` and `createMcpHandler` both take the same `() => McpServer` factory in SDK 2.0.0, so the tool definitions stay in one place:

```js
// tickets-server.mjs, @modelcontextprotocol/server 2.0.0
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export function createTicketsServer(getCaller) {
  const server = new McpServer({ name: 'tickets', version: '2.0.0' });
  server.registerTool('list_tickets',
    { description: 'List open tickets assigned to the caller', inputSchema: z.object({ status: z.string().default('open') }) },
    async ({ status }, ctx) => {
      const caller = getCaller(ctx); // stdio: env, HTTP: token
      return { content: [{ type: 'text', text: await callTicketsApi(caller, status) }] };
    });
  return server;
}
```

The stdio entry point becomes `serveStdio(() => createTicketsServer(() => ({ apiKey: process.env.TICKETS_API_KEY })))`. **Verify:** run your existing client against the stdio build and confirm that `tools/list` output has not changed.

### Step 2: identity comes from the token, not the process

On HTTP, the validated token arrives on every request as `ctx.http.authInfo`. Whatever your verifier returns is what the tool sees, so put the subject in `extra`:

```js
// HTTP caller resolution, @modelcontextprotocol/server 2.0.0
const getCaller = (ctx) => {
  const auth = ctx.http?.authInfo;
  if (!auth) throw new Error('unauthenticated'); // requireBearerAuth should make this unreachable
  return { userId: auth.extra.sub, clientId: auth.clientId, scopes: auth.scopes };
};
```

`callTicketsApi` now uses your server's own upstream credential and filters by `userId`. It no longer uses a key the user supplied. **Verify:** a tool call logs a `sub` value that you can trace back to a real user.

### Step 3: resource server endpoints

The v2 server packages only do the resource-server half: `requireBearerAuth`, `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl`. There is no authorization server or `/register` handler in `@modelcontextprotocol/express` 2.0.0, and that is intentional. This is the server I ran:

```js
// server.mjs: @modelcontextprotocol/server|express|node 2.0.0, jose 6.2.12, express 5.2.1, Node 26.4.0
import { createMcpHandler, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { createMcpExpressApp, mcpAuthMetadataRouter, requireBearerAuth,
         getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { jwtVerify, createRemoteJWKSet, errors } from 'jose';
import { createTicketsServer } from './tickets-server.mjs';
import { getCaller } from './caller.mjs'; // Step 2

const RESOURCE = new URL(process.env.MCP_RESOURCE ?? 'https://mcp.example.com/mcp'); // constant, never from req
const ISSUER = process.env.AUTH_ISSUER ?? 'https://auth.example.com';
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/jwks`));
const asMeta = await (await fetch(`${ISSUER}/.well-known/oauth-authorization-server`)).json();

const verifier = {
  async verifyAccessToken(token) {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: RESOURCE.href });
      return { token, clientId: String(payload.client_id), scopes: String(payload.scope ?? '').split(' ').filter(Boolean),
               expiresAt: payload.exp, resource: RESOURCE, extra: { sub: payload.sub } };
    } catch (e) {
      if (e instanceof errors.JOSEError) throw new OAuthError(OAuthErrorCode.InvalidToken, e.message);
      throw e;
    }
  },
};

const mcp = toNodeHandler(createMcpHandler(() => createTicketsServer(getCaller)));
const app = createMcpExpressApp();
app.use(mcpAuthMetadataRouter({ resourceServerUrl: RESOURCE, oauthMetadata: asMeta, scopesSupported: ['tickets:read'] }));
app.all('/mcp',
  requireBearerAuth({ verifier, requiredScopes: ['tickets:read'],
                      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(RESOURCE) }),
  (req, res) => mcp(req, res, req.body)); // createMcpExpressApp already ran express.json()
app.listen(3000);
```

**Verify:** an anonymous request must return a challenge the client can follow. From the lab:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", scope="tickets:read", resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"

GET /.well-known/oauth-protected-resource/mcp
{"resource":"http://localhost:3000/mcp","authorization_servers":["http://localhost:9000"],"scopes_supported":["tickets:read"]}
```

### Step 4: registration lives on the authorization server

The client-side order is fixed by the spec: pre-registered credentials first, then CIMD if the authorization server advertises `client_id_metadata_document_supported`, then DCR if it has a `registration_endpoint`, and only then ask the user. I wanted to see what that looks like in the SDK's real `auth()` flow, so I ran a small lab authorization server (auto-consent, PKCE S256, `iss` in the redirect, ES256 tokens with `aud` set to the `resource` value). It could advertise CIMD, DCR, both, or neither. The SDK client ran against it with and without a `clientMetadataUrl`, followed by a real `tools/call` against the server above:

| AS advertises | Client has `clientMetadataUrl` | What happened | `client_id` in the token |
| --- | --- | --- | --- |
| CIMD + DCR | no | `POST /register`, tool call OK | random UUID |
| CIMD + DCR | yes | AS fetched the metadata document, no `/register` | `https://localhost:4443/oauth/client.json` |
| DCR only | no | `POST /register`, tool call OK | random UUID |
| DCR only | yes | Fell back to `POST /register`, tool call OK | random UUID |
| CIMD only | no | **failed**: `Incompatible auth server: does not support dynamic client registration` | none |
| CIMD only | yes | CIMD, tool call OK | metadata URL |
| neither | either | **failed**, same message | none |

Advertising both is the right setting for a server with public clients during the deprecation window: CIMD-capable clients never hit `/register`, and older ones still get in. Every DCR request the SDK sent included `application_type: "native"` and `grant_types: ["authorization_code", "refresh_token"]`, derived from the loopback redirect URI (SEP-837 and SEP-2207). An OIDC provider that rejects `127.0.0.1` redirects for `web` clients will accept it.

If you ship your own client as well, CIMD on the client side means hosting a document like this at a stable HTTPS URL and setting `clientMetadataUrl` on your `OAuthClientProvider`:

```json
{
  "client_id": "https://app.example.com/oauth/client.json",
  "client_name": "Tickets Desktop",
  "client_uri": "https://app.example.com",
  "redirect_uris": ["http://127.0.0.1:53682/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

The SDK rejects a `clientMetadataUrl` that is not HTTPS with a non-root path before it sends anything. Serve the document with a real `Cache-Control`, because authorization servers are told to cache it according to HTTP cache headers.

**Verify:** watch the authorization server logs during a first login. With a CIMD-capable client you should see a GET of the metadata URL and no POST to the registration endpoint.

### Step 5: repoint the clients

In Claude Code the config change is one line (CIMD support landed in 2.1.81):

```bash
# Claude Code 2.1.81+
claude mcp add --transport http tickets https://mcp.example.com/mcp
claude mcp login tickets   # 2.1.186+, or run /mcp inside a session
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "tickets": { "type": "http", "url": "https://mcp.example.com/mcp" }
  }
}
```

If your authorization server supports neither CIMD nor DCR (common with corporate Entra ID or Okta tenants), use pre-registration. Register one public client with a fixed loopback redirect and hand out its ID:

```bash
# Claude Code: pre-registered public client, redirect http://localhost:8080/callback registered on the IdP
claude mcp add --transport http --client-id tickets-mcp --callback-port 8080 tickets https://mcp.example.com/mcp
```

Remove `TICKETS_API_KEY` from every config you control while you are there. A leftover `headers.Authorization` also blocks OAuth: Claude Code reports the connection as failed instead of falling back. **Verify:** `claude mcp get tickets` shows the HTTP URL, and `/mcp` lists the server as connected after login.

### Step 6: run both, then delete stdio

Keep publishing the stdio build (same factory, same tools) for one release cycle and log which transport each call comes in on. When remote traffic dominates, stop publishing the stdio package, or keep it for the local-only tools from the pre-flight list. **Verify:** the stdio entry point still passes the Step 1 check until the day you delete it.

## Post-migration smoke test

- [ ] `curl -i -X POST https://mcp.example.com/mcp` without a token returns `401` with `resource_metadata` and `scope` in `WWW-Authenticate`.
- [ ] `curl -s .../.well-known/oauth-protected-resource/mcp | jq -r .resource` prints exactly the URL your verifier expects.
- [ ] The authorization server metadata shows `client_id_metadata_document_supported: true`.
- [ ] A fresh login from Claude Code completes, and a tool call logs a real `sub`.
- [ ] A token minted for another resource gets `401 invalid_token`, not `200`.
- [ ] A token without `tickets:read` gets `403 insufficient_scope`.
- [ ] Revoking the user at the IdP stops access within one token lifetime.

## Rollback

This migration is reversible as long as Step 6 has not happened. Point clients back at `command`/`args` with the environment key and the stdio build runs as before. Tokens and client registrations only exist on the remote side, so nothing needs to be undone there. Once you have removed the upstream API keys from users' machines, rolling back means handing keys out again, so do the key rotation last.

## Gotchas I hit

**The DCR error message hides a CIMD problem.** With an authorization server that supports only CIMD and a client that has no `clientMetadataUrl`, SDK 2.0.0 throws `Incompatible auth server: does not support dynamic client registration`. That message is accurate but not useful. The real fix is on the client (set a metadata URL), or on the AS (enable DCR during the window). Claude Code's docs send you to `--client-id` for this message, which also works.

**Custom clients get a SEP-2352 warning.** An `OAuthClientProvider` without `saveDiscoveryState()`/`discoveryState()` logs `the SEP-2352 callback-leg authorization-server binding cannot be checked` on every login. Persist the discovery state next to the code verifier and the warning goes away. The point of the check is to avoid sending an authorization code to a different authorization server's token endpoint.

**Changing authorization servers orphans DCR clients, not CIMD ones.** Clients **MUST** key stored credentials by the issuer and re-register when your Protected Resource Metadata points somewhere new. A CIMD `client_id` is a URL that any authorization server can resolve, so it moves with you.

**CIMD makes your authorization server fetch URLs from the internet.** That is an SSRF surface, and the spec tells authorization servers to account for it and to warn on `localhost`-only redirect URIs. It also means a client document on a private network cannot be fetched by a SaaS identity provider.

**Claude desktop sign-ins on CIMD servers failed before 2.1.243** with "Invalid redirect URI" (Linear was the example in the changelog). If a user reports that error, check their version before touching your redirect list.

**Redirects and audience still break things after a successful login.** If your MCP URL redirects to another host, the client drops `Authorization`. That case is covered in [the cross-origin redirect fix](/2026/09/fix-mcp-client-drops-authorization-header-on-cross-origin-redirect/). If the gateway in front rewrites hosts, keep the resource URL constant, as described in [routing MCP traffic through a gateway](/2026/08/route-mcp-traffic-through-a-gateway-with-mcp-method-and-mcp-name-headers/).

## Related

- [MCP stdio vs HTTP vs SSE transport: which should you choose](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) for the decision this migration assumes.
- [Migrate an MCP server from SSE to Streamable HTTP](/2026/07/migrate-an-mcp-server-from-sse-to-streamable-http/) if part of your fleet is still on the legacy HTTP transport.
- [Stateful vs stateless MCP servers](/2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away/), which matters as soon as the remote server runs on more than one instance.
- [Fix: remote MCP server returns 401 invalid_token because `aud` doesn't match](/2026/09/fix-mcp-401-invalid-token-audience-does-not-match-server-url/) for the most common failure after Step 3.
- [How to build an MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) for a typical stdio server you would start this migration from.

## Sources

- [MCP Authorization, spec 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): stdio exclusion, resource indicators, `iss` validation.
- [Client Registration, spec 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration): CIMD requirements, priority order, DCR deprecation, authorization server binding.
- [Authorization server discovery, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery) and [security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations): well-known paths, SSRF and localhost risks, no token passthrough.
- [The 2026-07-28 Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/), MCP blog: DCR deprecation and the twelve-month window.
- [OAuth Client ID Metadata Document draft](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00) and [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591).
- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp): `--transport http`, `--client-id`, `--callback-port`, `claude mcp login`.
- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md): CIMD in 2.1.81, desktop "Invalid redirect URI" fix in 2.1.243.
