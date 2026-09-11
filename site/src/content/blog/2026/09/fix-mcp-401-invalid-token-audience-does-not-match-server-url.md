---
title: "Fix: remote MCP server returns 401 invalid_token because the token's aud doesn't match the canonical server URL"
description: "OAuth succeeded but every MCP call gets 401 invalid_token? Make the PRM resource, the token's aud and your validator agree on one canonical server URL."
pubDate: 2026-09-11
template: error-page
tags:
  - "mcp"
  - "ai-agents"
  - "errors"
  - "oauth"
  - "claude-code"
  - "typescript"
---

The OAuth flow finishes, the client holds a fresh access token, and every request to your remote MCP server still comes back `401` with `WWW-Authenticate: Bearer error="invalid_token"`. In most cases the token's `aud` claim is not the exact string your server compares it against. Pick one canonical server URL (lowercase scheme and host, no trailing slash, no fragment, path included, for example `https://mcp.example.com/mcp`), publish exactly that as `resource` in your Protected Resource Metadata, and compare audiences with URL normalization instead of byte-for-byte equality. Everything below was run against `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/client` 2.0.0, `@modelcontextprotocol/express` 2.0.0, `jose` 6.2.12 on Node 26.4.0, and the Python SDK `mcp` 2.2.0 on Python 3.14, following the [MCP authorization spec revision 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

## The error in context

A TypeScript MCP server built on `requireBearerAuth` from `@modelcontextprotocol/express` with a `jose` verifier answers a token whose audience has a trailing slash like this:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", error_description="unexpected \"aud\" claim value", resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"

{"error":"invalid_token","error_description":"unexpected \"aud\" claim value"}
```

The Python SDK is less talkative. With `validate_token_resource=True` the client only sees a generic challenge:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", error_description="Authentication required", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
```

and the real reason is only in the server log:

```
WARNING mcp.server.auth.middleware.bearer_auth: Bearer token resource 'https://mcp.example.com/' is not resource_server_url https://mcp.example.com/mcp
```

In Claude's connector UI, this failure surfaces as "Authorization with the MCP server failed", which the [Claude connector troubleshooting guide](https://claude.com/docs/connectors/building/troubleshooting) lists next to issuer mismatches and missing PKCE. The confusing part is the timing: discovery, consent and the token exchange all succeed, and the failure only appears on the first real MCP request.

## Why the audience does not match

The MCP spec puts three parties on the hook for the same string. The client **MUST** send an [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html) `resource` parameter on both the authorization and token requests, set to the canonical URI of the MCP server. The authorization server is expected to bind the token to that value, usually as `aud`. The server **MUST** "validate that access tokens were issued specifically for them as the intended audience" and answer anything else with `401`. If any one of the three spells the URL differently, the chain breaks at the last step.

The spec's own definition of the canonical URI leaves room for exactly that. It lists `https://mcp.example.com/mcp`, `https://mcp.example.com` and `https://mcp.example.com:8443` as valid, forbids fragments, and then says that while a trailing slash is technically valid, implementations "**SHOULD** consistently use the form without the trailing slash". It also says the canonical form uses a lowercase scheme and host, but implementations "**SHOULD** accept uppercase scheme and host components". A validator that does `aud === expected` ignores both of those SHOULDs.

In practice the mismatch comes from one of five places, roughly in this order of frequency:

1. **A trailing slash introduced by URL parsing.** `new URL('https://mcp.example.com').href` is `https://mcp.example.com/`. Anything that round-trips a bare origin through the WHATWG URL parser grows a slash.
2. **Origin versus path.** The server publishes `https://mcp.example.com` but checks `https://mcp.example.com/mcp`, or the other way around.
3. **The authorization server ignores `resource`.** Keycloak, Auth0 without its compatibility profile, and Entra ID's v2 endpoint all derive `aud` from their own configuration, so the token names an API identifier, a client ID, or nothing at all.
4. **A proxy changed the scheme or host.** The server builds its expected URL from the incoming request behind a TLS-terminating proxy and gets `http://internal-host:8080/mcp`.
5. **Case and default ports.** `HTTPS://MCP.Example.com:443/mcp` is the same resource, but not the same string.

## Minimal repro

The server side needs a signing key, a resource URL, and a verifier that passes `audience` to `jose`. This is the pattern most TypeScript servers copy:

```js
// @modelcontextprotocol/server 2.0.0, @modelcontextprotocol/express 2.0.0,
// @modelcontextprotocol/node 2.0.0, jose 6.2.12, Node 26.4.0
import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { createMcpExpressApp, mcpAuthMetadataRouter, requireBearerAuth,
         getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { jwtVerify, createRemoteJWKSet, errors } from 'jose';

const RESOURCE = new URL('http://localhost:3000/mcp');
const ISSUER = 'http://localhost:9000';
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/jwks`));

const verifier = {
  async verifyAccessToken(token) {
    try {
      // Strict: jose compares aud to RESOURCE.href byte for byte
      const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: RESOURCE.href });
      return { token, clientId: String(payload.client_id ?? payload.azp),
               scopes: String(payload.scope ?? '').split(' ').filter(Boolean),
               expiresAt: payload.exp, resource: RESOURCE };
    } catch (e) {
      if (e instanceof errors.JOSEError) throw new OAuthError(OAuthErrorCode.InvalidToken, e.message);
      throw e;
    }
  },
};

const handler = createMcpHandler(() => new McpServer({ name: 'aud-probe', version: '1.0.0' }));
const mcp = toNodeHandler(handler);
const app = createMcpExpressApp();
app.use(mcpAuthMetadataRouter({
  resourceServerUrl: RESOURCE,
  oauthMetadata: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`,
                   token_endpoint: `${ISSUER}/token`, response_types_supported: ['code'],
                   code_challenge_methods_supported: ['S256'] },
}));
app.all('/mcp',
  requireBearerAuth({ verifier, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(RESOURCE) }),
  (req, res) => mcp(req, res, req.body)); // express.json() already consumed the body
app.listen(3000);
```

Note the last line. `createMcpExpressApp` installs `express.json()`, so passing `toNodeHandler(handler)` straight to the route gives you `-32700 Parse error: Invalid JSON` on every authorized call. That looks like an auth bug when you first hit it and is not one.

I minted ES256 tokens with different `aud` values and sent the same `tools/call` to this server. With the strict verifier:

| Token `aud` | Result |
| --- | --- |
| `http://localhost:3000/mcp` | `200` |
| `http://localhost:3000/mcp/` | `401 unexpected "aud" claim value` |
| `http://localhost:3000/` | `401 unexpected "aud" claim value` |
| `HTTP://LOCALHOST:3000/mcp` | `401 unexpected "aud" claim value` |
| `api://11111111-2222-3333-4444-555555555555` | `401 unexpected "aud" claim value` |
| `["https://graph.microsoft.com", "http://localhost:3000/mcp"]` | `200` |
| (no `aud`) | `401 missing required "aud" claim` |

Two of those rejections are the same resource under the spec. The other three are genuinely wrong tokens, and the fix for them is on the authorization server, not in your validator.

## Fix 1: make the client ask for the right resource

Start with what the client sends, because the TypeScript SDK does not send the URL you typed. `selectResourceURL` in `@modelcontextprotocol/client` 2.0.0 checks that the Protected Resource Metadata `resource` is the same origin and a path prefix of the server URL, and then sends the **metadata's** value:

```js
// @modelcontextprotocol/client 2.0.0, Node 26.4.0
import { selectResourceURL } from '@modelcontextprotocol/client';

const server = new URL('https://mcp.example.com/mcp');
await selectResourceURL(server, {}, { resource: 'https://mcp.example.com/mcp' }); // https://mcp.example.com/mcp
await selectResourceURL(server, {}, { resource: 'https://mcp.example.com' });     // https://mcp.example.com/
await selectResourceURL(server, {}, { resource: 'https://api.example.com/mcp' }); // throws: Protected resource
// https://api.example.com/mcp does not match expected https://mcp.example.com/mcp (or origin)
await selectResourceURL(server, {}, undefined);                                   // undefined: no resource param at all
```

Two things fall out of that. If your metadata advertises the origin while the verifier checks the `/mcp` path, the token is minted for the origin and your own server rejects it. And the value goes out as `resource.href`, so an origin-only resource always gains a slash on the wire. That second behavior is also what [anthropics/claude-code#52871](https://github.com/anthropics/claude-code/issues/52871) reports for Claude Code 2.1.119 against a server whose metadata says `https://mcp.businesscentral.dynamics.com`: the client sent `https://mcp.businesscentral.dynamics.com/`, and Entra rejected it.

The server helper has the same habit. `buildOAuthProtectedResourceMetadata` in `@modelcontextprotocol/server` 2.0.0 writes `resourceServerUrl.href`:

```
resourceServerUrl "https://mcp.example.com"      -> PRM resource https://mcp.example.com/
resourceServerUrl "https://mcp.example.com/mcp"  -> PRM resource https://mcp.example.com/mcp
resourceServerUrl "https://mcp.example.com/mcp/" -> PRM resource https://mcp.example.com/mcp/
resourceServerUrl "HTTPS://MCP.Example.com/mcp"  -> PRM resource https://mcp.example.com/mcp
```

So the practical rule is: **give the MCP endpoint a path**, set `resourceServerUrl` to that exact path without a trailing slash, and make the verifier's expected audience the same `URL` object. A path-bearing URL survives `.href` unchanged, which removes the slash problem from every hop at once. Then check the published document before touching anything else:

```bash
# Should print exactly the string your verifier expects
curl -s https://mcp.example.com/.well-known/oauth-protected-resource/mcp | jq -r .resource
```

The Python SDK behaves better here as of `mcp` 2.2.0: `AuthSettings(resource_server_url="https://mcp.example.com")` publishes `"resource":"https://mcp.example.com"` with no slash. The long-standing bug where it did add one, [python-sdk#1265](https://github.com/modelcontextprotocol/python-sdk/issues/1265), came from Pydantic's `AnyHttpUrl`, which still renders `https://mcp.example.com/` if you build URLs with it yourself.

## Fix 2: compare audiences as URLs, not strings

Even with a consistent server, you do not control every client. Claude's connector docs say it sends the canonical form, and they also tell server authors to "accept the canonical value when checking `aud` rather than doing a strict byte-for-byte comparison". Normalize both sides before comparing:

```js
// jose 6.2.12, Node 26.4.0: canonical audience check for an MCP resource server
function canonical(uri) {
  const u = new URL(uri);          // lowercases scheme and host, drops :443 / :80
  u.hash = '';
  return u.href.endsWith('/') ? u.href.slice(0, -1) : u.href; // one trailing-slash form
}

const EXPECTED = canonical(RESOURCE);

async function verifyAccessToken(token) {
  const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER }); // no audience option here
  const auds = [payload.aud].flat().filter(Boolean).map(canonical);
  if (!auds.includes(EXPECTED)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken,
      `Token audience ${JSON.stringify(payload.aud)} does not include ${EXPECTED}`);
  }
  // ...build AuthInfo as before
}
```

The same seven tokens against this verifier:

| Token `aud` | Result |
| --- | --- |
| `http://localhost:3000/mcp` | `200` |
| `http://localhost:3000/mcp/` | `200` |
| `HTTP://LOCALHOST:3000/mcp` | `200` |
| `["https://graph.microsoft.com", "http://localhost:3000/mcp"]` | `200` |
| `http://localhost:3000/` | `401 Token audience "http://localhost:3000/" does not include http://localhost:3000/mcp` |
| `api://11111111-...` | `401 Token audience "api://11111111-..." does not include http://localhost:3000/mcp` |
| (no `aud`) | `401 Token audience undefined does not include http://localhost:3000/mcp` |

This is deliberately not a prefix match. Accepting `https://mcp.example.com/` for a server at `/mcp` would accept a token minted for every service on that host, which is the exact confused-deputy case audience binding exists to prevent. Put the actual `aud` in `error_description` as well. It costs nothing, and it turns the next report of this bug into a one-line fix.

In Python, `mcp` 2.2.0 already does the normalized comparison for you. Set `validate_token_resource=True` and return `AccessToken.resource` from your verifier (the `aud` value, or the matching entry if `aud` is a list):

```python
# mcp 2.2.0 (Python SDK), Python 3.14
from mcp.server.mcpserver import MCPServer
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings

class JwtVerifier:
    async def verify_token(self, token: str) -> AccessToken | None:
        claims = decode_and_check_signature(token)  # your JWT library, issuer + exp checked
        return AccessToken(token=token, client_id=claims["azp"], scopes=claims["scope"].split(),
                           expires_at=claims["exp"], resource=claims["aud"])

mcp = MCPServer("billing", token_verifier=JwtVerifier(), auth=AuthSettings(
    issuer_url="https://auth.example.com",
    resource_server_url="https://mcp.example.com/mcp",
    validate_token_resource=True,
))
```

The middleware compares the two as `AnyHttpUrl` values with the trailing slash stripped, so `https://mcp.example.com/mcp/` and `HTTPS://MCP.EXAMPLE.COM:443/mcp` both pass while `https://mcp.example.com/` and `api://1111` get the `401`. If you leave `validate_token_resource` unset, 2.2.0 emits an `MCPDeprecationWarning` and checks nothing; the warning says it will default to `True` in 3.0.

## Fix 3: make the authorization server honor `resource`

When the decoded token shows an `aud` that has nothing to do with your URL, no validator change is correct. Fix the issuer:

- **Keycloak** historically ignores `resource` and sets `aud` from client and scope configuration. Native support is tracked in [keycloak/keycloak#14355](https://github.com/keycloak/keycloak/issues/14355) and is not in the [26.7.0 release notes](https://www.keycloak.org/2026/07/keycloak-2670-released). Until it ships, add a client scope with an `oidc-audience-mapper` whose `included.custom.audience` is your canonical MCP URL, set it as a default scope on the client, and enable it for access tokens only.
- **Auth0** uses its own `audience` parameter. Turn on the [Resource Parameter Compatibility Profile](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile) under Settings, Advanced, and register an API whose identifier is your canonical MCP URL. If a client sends both `audience` and `resource`, Auth0 still uses `audience`.
- **Microsoft Entra ID** v2.0 access tokens carry the API's client ID GUID as `aud`, "always", per the [access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference). Your MCP URL will never appear there. Add the MCP URL as an Application ID URI on the API registration so Entra accepts the `resource` value, then validate `aud` against the API's client ID (and its `api://` URI if you also accept v1 tokens) instead of the MCP URL. That is the "whatever audience-binding mechanism your token format supports" escape hatch the Claude docs describe, and it still proves the token was minted for your API.

## Gotchas and lookalikes

**`AADSTS9010010` at the token endpoint.** This is not a `401` from your server; Entra refuses to issue the token because the `resource` it received does not match a registered Application ID URI, or conflicts with the requested scopes. A stray trailing slash is enough to trigger it. It fails before your server sees anything.

**`401` with "Missing Authorization header" after a successful login.** If the server URL redirects to another host, clients drop the `Authorization` header on the redirect, and the target sees an anonymous request. Register the URL the server actually answers on. The cross-transport side of that is in [fixing an HTTP MCP server URL that won't connect in Claude Desktop](/2026/05/fix-http-mcp-server-url-wont-connect-in-claude-desktop/).

**A gateway rewrote the host.** If your MCP server sits behind a gateway (the setup in [routing MCP traffic with the Mcp-Method and Mcp-Name headers](/2026/08/route-mcp-traffic-through-a-gateway-with-mcp-method-and-mcp-name-headers/)), configure the resource URL as a constant from the public URL. Never derive it from `req.protocol` and `req.host`, which see the internal hop.

**Tokens meant for someone else.** Do not "fix" a mismatched audience by forwarding the user's token to an upstream API or by accepting any audience from your issuer. The spec forbids token passthrough outright, and a server that accepts any audience will accept tokens the user granted to a different service.

**`403 insufficient_scope` is a different problem.** The audience was accepted and the scope set was not. That path needs a step-up authorization, not an audience change.

**It works with `aud` validation off.** That confirms the diagnosis; it does not fix anything. Decode one real token (`cut -d. -f2` plus base64) and compare its `aud` to `jq -r .resource` from your metadata; the difference is almost always visible at a glance. If you are on ASP.NET Core instead of Node or Python, the same checks apply to `ValidAudiences`, covered in [validating a JWT's issuer, audience and lifetime](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) and [why ASP.NET Core returns 401 even with a valid JWT](/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/).

## Related

- [How to build an MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) for the server skeleton this auth layer sits on.
- [How to build a custom MCP server in Python with the official SDK](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) if you are on the Python side of the repro.
- [Fix: MCP client and server negotiate different protocol versions](/2026/08/fix-mcp-unsupported-protocol-version-2025-11-25-vs-2026-07-28/), the other HTTP `400`/`401`-shaped failure you will meet after moving to `2026-07-28`.
- [How to validate a JWT's issuer, audience and lifetime in ASP.NET Core 11](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) for the .NET equivalent of the canonical audience check.

## Sources

- [MCP Authorization, specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): resource parameter, canonical server URI examples, token handling.
- [Authorization security considerations, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations): audience binding, access token privilege restriction, no token passthrough.
- [Authorization server discovery, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery): `resource_metadata` in the challenge and the well-known paths.
- [RFC 8707, Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707.html) and [RFC 9728, OAuth 2.0 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728).
- [Claude connector troubleshooting](https://claude.com/docs/connectors/building/troubleshooting): audience mismatch and the Entra `AADSTS9010010` fix.
- [anthropics/claude-code#52871](https://github.com/anthropics/claude-code/issues/52871): trailing slash added to `resource` for an origin-only server.
- [modelcontextprotocol/python-sdk#1265](https://github.com/modelcontextprotocol/python-sdk/issues/1265): trailing slash in the Python SDK's protected resource metadata.
- [Microsoft Entra access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference): `aud` in v1.0 and v2.0 tokens.
