---
title: "Migrate an MCP C# SDK 1.x Server to 2.x Without Breaking Old Clients"
description: "ModelContextProtocol 2.0.0 flipped HTTP transport to stateless by default, which is the one change that can drop every client still speaking 2025-11-25. HttpServerSessionMode.StatefulForInitializeClients in 2.2.0 serves both revisions on one endpoint. Here is the ordered upgrade, the ten breaking changes that matter, and the discover-probe bug that only a 2.1.0 client fixes."
pubDate: 2026-09-02
updatedDate: 2026-09-02
template: migration
tags:
  - "migration"
  - "mcp"
  - "ai-agents"
  - "llm"
  - "dotnet"
  - "csharp"
---

**Short answer:** budget half a day for a server, and do the package bump and the transport decision as two separate commits. `ModelContextProtocol` 2.0.0 (shipped 2026-07-28, alongside the protocol revision of the same name) defaults `HttpServerTransportOptions.Stateless` to `true`, and that single default is what strands clients still negotiating `2025-11-25`. Since 2.2.0 (2026-08-13) you do not have to choose: set `SessionMode = HttpServerSessionMode.StatefulForInitializeClients` and one endpoint serves handshake clients with real sessions while serving `2026-07-28` clients statelessly. Everything else on the breaking-change list is a compile error or a warning, which means the compiler finds it for you. The transport default is the only one that fails silently, in production, on somebody else's client.

The nine other breaking changes in 2.0.0 are real but cheap. The expensive part of this migration is the part nobody writes down: the order you do it in, so that CI stays green and no consumer of your server has a bad afternoon.

## What you get for the upgrade

- **Horizontal scale with no sticky routing.** Stateless mode never issues `Mcp-Session-Id`, so any replica can answer any request. If you were running a Redis session store purely to satisfy the transport, you delete it, the same subtraction [GitHub's MCP server made](/2026/07/github-mcp-server-goes-stateless-redis-session-store/).
- **Cacheable tool lists.** SEP-2549 caching hints ride on cacheable results, and because `tools/list` no longer varies per connection, a host spawning short-lived subagents stops paying `O(subagents x servers)` calls on the hot path.
- **Interactive tools without a held-open connection.** Multi Round-Trip Requests replace server-initiated elicitation. The handler returns, the client resolves the input, the client retries.
- **OAuth that actually validates the issuer.** 2.0.0 enforces RFC 9207 issuer matching and requires the authorization server to advertise PKCE S256 in `code_challenge_methods_supported`.

## What breaks

Compiled against `ModelContextProtocol.AspNetCore` 2.2.0 on .NET 10.0.201, upgrading from 1.4.1:

| Area | Change | Severity |
| --- | --- | --- |
| HTTP transport | `Stateless` defaults to `true`; no sessions, no standalone `GET` stream, no unsolicited server-to-client requests | high |
| Negotiation | Clients probe `server/discover` (SEP-2575) before falling back to `initialize` | high |
| Tasks | 1.4.x experimental Tasks removed; no API or wire compatibility with `ModelContextProtocol.Extensions.Tasks` | high |
| OAuth (client) | `AuthorizationRedirectDelegate` obsolete as `MCP9007`; issuer and PKCE validation now enforced | high |
| Sampling / roots / logging | Deprecated per SEP-2577, warn as `MCP9005`, and throw at runtime on a stateless server | medium |
| Structured content | Non-object results emit the raw value: `structuredContent: 72`, not `{ "result": 72 }` | medium |
| Tool deserialization | A `Tool` payload without `inputSchema` throws `JsonException` instead of defaulting | medium |
| SSE errors | Explicit SSE connections surface `HttpRequestException` or `TimeoutException` instead of always wrapping in `IOException` | medium |
| OAuth step-up | A repeated `insufficient_scope` challenge that adds no scope throws `McpException` | low |
| Error codes | JSON-RPC codes renumbered; `UnsupportedProtocolVersion` is now `-32022` | low |

Only the first two can break a client you do not control. Work them first, and treat the rest as a cleanup pass.

## Before you touch the csproj

Three things, in this order.

**Write down who your clients are and what they negotiate.** If your server is internal and every consumer is a Claude Code or VS Code install you can push an update to, you can go straight to `Stateless` and skip the hybrid mode entirely. If your server has a published URL, assume some caller is pinned to a 1.x SDK for the next year.

**Capture a baseline handshake.** Against the running 1.x server:

```bash
# ModelContextProtocol.AspNetCore 1.4.1
curl -sS -D- -o- https://localhost:7099/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"baseline","version":"1.0.0"}}}'
```

Keep the response headers. The `Mcp-Session-Id` line is what you are going to check for again after the upgrade, and its presence or absence is the whole test.

**Make warnings visible without breaking the build.** If you build with `TreatWarningsAsErrors`, the upgrade commit fails on `MCP9004` and `MCP9006` before you get a chance to read them:

```xml
<!-- Directory.Build.props, .NET 10 SDK -->
<PropertyGroup>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  <!-- temporary: remove once SessionMode is set explicitly -->
  <WarningsNotAsErrors>MCP9004;MCP9006;MCP9005;MCP9007</WarningsNotAsErrors>
</PropertyGroup>
```

Prefer `WarningsNotAsErrors` over `NoWarn`. The warnings are the checklist, and the full diagnostic set is worth reading before you start: the [MCP9004, MCP9005 and MCP9006 breakdown](/2026/08/fix-mcp9004-mcp9005-mcp9006-warnings-after-mcp-csharp-sdk-2-0/) covers what each one actually flags and why `#pragma warning disable CS0618` does nothing to any of them.

## Migration steps

1. **Bump the packages and build.** `dotnet add package ModelContextProtocol --version 2.2.0` plus `ModelContextProtocol.AspNetCore` at the same version. Do not change any code in this commit. Verify: `dotnet build` succeeds and the only new diagnostics are `MCP9###` warnings. If you get `JsonException` in tests, jump to step 6 first.

2. **Set `SessionMode` explicitly, before you deploy anything.** This is the commit that decides whether old clients survive. Verify: the curl from the pre-flight section still returns an `Mcp-Session-Id` header when you send `initialize`.

   ```csharp
   // ModelContextProtocol.AspNetCore 2.2.0, .NET 10.0.201
   builder.Services.AddMcpServer()
       .WithHttpTransport(options =>
       {
           // Stateless                    -> 2026-07-28 only, no session ever
           // Stateful                     -> handshake clients only; 2026-07-28 clients get an error
           //                                 and must downgrade
           // StatefulForInitializeClients -> both, on one endpoint (2.2.0+)
           options.SessionMode = HttpServerSessionMode.StatefulForInitializeClients;
       })
       .WithToolsFromAssembly();

   var app = builder.Build();
   app.MapMcp();
   ```

   `HttpServerSessionMode.Stateful` is not the safe choice despite the name. It tracks a session for every client and requires affinity, and a client negotiating `2026-07-28` gets an error and has to downgrade to the handshake, which costs you a round trip and the cacheable tool list. The hybrid value is the one that means "do not break anybody".

3. **Delete `EnableLegacySse` if you set it.** `MCP9004` is not advisory: legacy SSE has no request backpressure, and combined with the new stateless default the app throws at startup. If you still have HTTP+SSE clients, that is [a separate transport migration](/2026/07/migrate-an-mcp-server-from-sse-to-streamable-http/) and it should not ride along with this one. Verify: the app starts.

4. **Move Tasks to the extension package.** The 1.4.x experimental implementation is gone and there is no wire compatibility with the replacement, so a 1.4.x client and a 2.x server cannot share a task. Add `ModelContextProtocol.Extensions.Tasks`, register with `.WithTasks(store)`, and replace every `RequestMethods.Tasks*` constant with its `TasksProtocol` member. Verify: a long-running tool round-trips a task id against a 2.x client.

5. **Fix the OAuth client path.** `AuthorizationRedirectDelegate` warns as `MCP9007`, and this one is a security warning wearing an obsolete-API costume: the old delegate cannot carry the RFC 9207 issuer or the authorization-response state, so both checks are simply skipped. Move to `ClientOAuthOptions.AuthorizationCallbackHandler`. Verify: your authorization server advertises `S256` in `code_challenge_methods_supported`, or every flow now fails.

6. **Update anything that parses tool JSON.** Two changes bite here. A `Tool` payload without `inputSchema` throws `JsonException` on deserialization instead of defaulting, so hand-written test fixtures and proxy layers need an explicit schema (`{}` is enough). And a tool with `UseStructuredContent = true` returning a non-object now emits the raw value. Verify: assert on `structuredContent: 72`, not `{"result":72}`.

   ```csharp
   // ModelContextProtocol 2.2.0
   [McpServerTool(Name = "temp", UseStructuredContent = true), Description("Current temperature.")]
   public static int Temp() => 72;
   // 1.4.1 wire: "structuredContent": { "result": 72 }
   // 2.x wire:   "structuredContent": 72
   ```

7. **Upgrade your own client apps to 2.1.0 or newer before pointing them at anything.** See the gotcha below; a 2.0.0 client against a down-level server is the one combination that fails at connect time. Verify: the client connects to both an old and a new server without a pinned `ProtocolVersion`.

8. **Deal with sampling, roots and logging last.** `MCP9005` is advisory and the wire format did not change, so down-level connections keep working. But `SampleAsync` throws on a stateless server, and `InputRequest.ForSampling` and `InputRequest.ForRootsList` are themselves marked `MCP9005`, so Multi Round-Trip Requests do not launder the deprecation. Only elicitation comes out clean. Gate MRT on `server.IsMrtrSupported`, which is `true` when the negotiated revision is `2026-07-28` or the session is stateful under `2025-11-25`.

## Verifying you did not break the old path

Two curls and one negative check. Against the upgraded server in `StatefulForInitializeClients` mode:

```bash
# 1. A 2026-07-28 client: discovery first, and no session header in the response.
curl -sS -D- -o- https://localhost:7099/ \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}' | grep -i 'mcp-session-id' || echo "OK: stateless path issues no session"

# 2. A 2025-11-25 client: handshake still answered, session header still present.
curl -sS -D- -o- https://localhost:7099/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"legacy","version":"1.0.0"}}}' | grep -i 'mcp-session-id'
```

If the second one prints nothing, you are in `Stateless` mode and you shipped the break. If the first one prints a session id, you are in `Stateful` mode and your new clients are silently downgrading.

The third check is a real 1.x client. Keep one pinned `ModelContextProtocol` 1.4.1 integration test in the suite until you have retired the old clients for real. A curl proves the transport answers; only a 1.x client proves the whole negotiation still works.

## Rollback

The package downgrade is clean as long as you stopped at step 3. Revert to 1.4.1, remove the `SessionMode` line, rebuild. Nothing on the wire changed for handshake clients.

After step 4 it is one way. The Tasks rewrite has no wire compatibility in either direction, so a rollback strands any task a 2.x client created. If you need a true rollback window, land steps 1 through 3, run them in production for a week, and only then start on Tasks.

## Gotchas that cost real time

**A 2.0.0 client cannot talk to a 1.x server behind a strict proxy.** Under SEP-2575 a client with `ProtocolVersion` unset probes `server/discover` and is supposed to fall back to `initialize` for down-level servers. In 2.0.0 that fallback only triggered on a JSON-RPC error response. If the old server, or a gateway in front of it, answers the probe with an HTTP 404, the connection fails instead of falling back. [PR #1766](https://github.com/modelcontextprotocol/csharp-sdk/pull/1766), merged 2026-07-31 and shipped in 2.1.0 on 2026-08-05, treats a 404 as evidence of a handshake server. Upgrade the client past 2.0.0; do not debug this at the proxy.

**The probe costs 5 seconds against a server that ignores it.** `McpClientOptions.DiscoverProbeTimeout` defaults to 5 seconds and only applies when the client prefers `2026-07-28`. An old server that silently drops `server/discover` rather than answering makes every connect pay it. The stopgap is to pin the revision and skip the probe entirely:

```csharp
// ModelContextProtocol 2.2.0
var client = await McpClient.CreateAsync(
    new HttpClientTransport(new HttpClientTransportOptions { Endpoint = new Uri("https://legacy.internal/mcp") }),
    new McpClientOptions
    {
        // Stopgap only. Removing this is the last step of the migration, not the first.
        ProtocolVersion = "2025-11-25",
    });
```

Treat that pin as debt. It also opts you out of caching hints and MRT, and when the server finally upgrades you will get `-32022` on a version mismatch, which is [its own debugging session](/2026/08/fix-mcp-unsupported-protocol-version-2025-11-25-vs-2026-07-28/).

**`Stateful` mode is not backwards compatibility.** It is the reverse: it breaks the new clients rather than the old ones. The only value that breaks neither is `StatefulForInitializeClients`, and it only exists as of 2.2.0. If you upgraded to 2.0.0 or 2.1.0 in early August and picked `Stateful` for safety, that is the line to change.

**Your session-scoped application state is still your problem.** The hybrid mode keeps the transport session alive for old clients, but any request served on the stateless path has `SessionId` null and no memory of the previous call. If a tool stashed a browser handle or a cart keyed on the session, that code has to move to explicit handles threaded through tool arguments before you enable the stateless path for anyone. The full accounting of [what actually breaks when the session goes away](/2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away/) is the thing to read before you write that code, because the survey behind SEP-2567 found only about 10% of servers touch session state at all, and knowing which side you are on decides whether this migration is an afternoon or a sprint.

### Read next

- [MCP C# SDK 2.0: stateless by default and MCP9005 on your old code](/2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005/) for what shipped on 2026-07-28 and why.
- [Fix: MCP9004, MCP9005 and MCP9006 after upgrading the MCP C# SDK to 2.0](/2026/08/fix-mcp9004-mcp9005-mcp9006-warnings-after-mcp-csharp-sdk-2-0/) for the diagnostic-by-diagnostic fix.
- [Route MCP traffic through a gateway with the Mcp-Method and Mcp-Name headers](/2026/08/route-mcp-traffic-through-a-gateway-with-mcp-method-and-mcp-name-headers/) if you are putting a proxy in front of the upgraded endpoint.

### Sources

- [Announcing v2.0 of the official MCP C# SDK](https://devblogs.microsoft.com/dotnet/announcing-v20-of-the-official-mcp-csharp-sdk/)
- [csharp-sdk v2.0.0 release notes](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.0.0)
- [csharp-sdk v2.2.0 release notes](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.2.0)
- [HttpServerSessionMode API reference](https://csharp.sdk.modelcontextprotocol.io/v2/api/ModelContextProtocol.AspNetCore.HttpServerSessionMode.html)
- [McpClientOptions API reference](https://csharp.sdk.modelcontextprotocol.io/v2/api/ModelContextProtocol.Client.McpClientOptions.html)
- [SEP-2575: Make MCP Stateless](https://modelcontextprotocol.io/seps/2575-stateless-mcp)
- [SEP-2567: Sessionless MCP via Explicit State Handles](https://modelcontextprotocol.io/seps/2567-sessionless-mcp)
- [MCP C# SDK list of diagnostics](https://github.com/modelcontextprotocol/csharp-sdk/blob/main/docs/list-of-diagnostics.md)
