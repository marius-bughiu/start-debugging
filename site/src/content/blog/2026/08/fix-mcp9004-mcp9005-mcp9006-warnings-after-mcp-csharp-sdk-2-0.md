---
title: "Fix: MCP9004, MCP9005 and MCP9006 warnings after upgrading the MCP C# SDK to 2.0"
description: "MCP9005 is advisory, but MCP9004 crashes at startup and stateless mode makes SampleAsync throw. Here is what each diagnostic means and how to fix it properly."
pubDate: 2026-08-28
template: error-page
tags:
  - "mcp"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "errors"
---

Upgrading `ModelContextProtocol` from 1.x to 2.x (2.0.0 shipped 2026-07-28, 2.2.0 on 2026-08-13) lights up three new obsolete diagnostics. `MCP9005` is advisory and safe to suppress: SEP-2577 deprecated Roots, Sampling and Logging with no wire change. `MCP9004` and `MCP9006` are not, because the same release flipped `SessionMode` to `Stateless` by default. If you were setting `EnableLegacySse = true`, your app now throws at startup; if a tool called `SampleAsync`, it now throws on every call. Set `SessionMode` explicitly, then decide what to suppress.

## The errors in context

Compiled against `ModelContextProtocol.AspNetCore` 2.2.0 on .NET 10.0.201:

```text
Program.cs(12,9): warning MCP9004: 'HttpServerTransportOptions.EnableLegacySse' is obsolete: 'Legacy SSE transport has no built-in request backpressure and should only be used with completely trusted clients in isolated processes. Use Streamable HTTP instead.'
Program.cs(13,9): warning MCP9006: 'HttpServerTransportOptions.IdleTimeout' is obsolete: 'Stateful Streamable HTTP mode is a back-compat-only escape hatch for 2025-11-25 protocol revision clients and earlier. Set HttpServerTransportOptions.SessionMode = HttpServerSessionMode.Stateless (the default as of the 2026-07-28 protocol revision) for new code. See SEP-2567.'
Program.cs(32,28): warning MCP9005: 'McpServer.SampleAsync(IEnumerable<ChatMessage>, ChatOptions?, JsonSerializerOptions?, CancellationToken)' is obsolete: 'The Sampling feature is deprecated as of specification version 2026-07-28 and may be removed in a future version. See SEP-2577 for more information.'
```

Every one of them carries a `UrlFormat` pointing at the SDK's [list of diagnostics](https://github.com/modelcontextprotocol/csharp-sdk/blob/main/docs/list-of-diagnostics.md), which is the canonical index. Note the ID shape: obsolete APIs use `MCP9###`, the source generator uses `MCP###`, and in-development APIs use `MCPEXP###`.

## What triggers each one

Here is a server that trips all three. It is roughly what a 1.x codebase looks like after a straight package bump.

```csharp
// ModelContextProtocol.AspNetCore 2.2.0, .NET 10.0.201
using Microsoft.Extensions.AI;
using ModelContextProtocol.AspNetCore;
using ModelContextProtocol.Server;
using System.ComponentModel;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddMcpServer()
    .WithHttpTransport(options =>
    {
        options.EnableLegacySse = true;                 // MCP9004
        options.IdleTimeout = TimeSpan.FromMinutes(30); // MCP9006
        options.MaxIdleSessionCount = 1000;             // MCP9006
        options.PerSessionExecutionContext = true;      // MCP9006
    })
    .WithTools<SummarizeTool>();

var app = builder.Build();
app.MapMcp();
app.Run();

[McpServerToolType]
public class SummarizeTool
{
    [McpServerTool(Name = "summarize"), Description("Summarize text.")]
    public static async Task<string> Summarize(
        McpServer server,
        [Description("The text to summarize.")] string text,
        CancellationToken ct)
    {
        var result = await server.SampleAsync(          // MCP9005
            [new ChatMessage(ChatRole.User, "Summarize: " + text)],
            new ChatOptions { MaxOutputTokens = 256 },
            cancellationToken: ct);

        return result.Text;
    }
}
```

`MCP9005` is by far the loudest: it is attached to 57 distinct API sites across `ModelContextProtocol.Core` 2.2.0, covering the whole Roots, Sampling and Logging surface. That includes protocol types (`Root`, `SamplingMessage`, `LoggingLevel`, `CreateMessageRequestParams`), the method-name constants (`RequestMethods.SamplingCreateMessage`, `NotificationMethods.LoggingMessageNotification`), the handler properties on `McpClientHandlers`, and `McpClient.SetLoggingLevelAsync`. If you touch any of them, expect a wall of warnings from one package bump.

`MCP9006` covers six members, all of them stateful-only knobs on `HttpServerTransportOptions`: `EventStreamStore`, `SessionMigrationHandler`, `PerSessionExecutionContext`, `IdleTimeout`, `MaxIdleSessionCount`, plus the `WithDistributedCacheEventStreamStore` builder extension.

`MCP9004` covers exactly one member, `EnableLegacySse`, and it is the one that will page you.

## Why MCP9005 is safe to ignore but SampleAsync still breaks

[SEP-2577](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2577) merged on 2026-05-15 and says so explicitly in its summary: the features stay fully functional in every spec version released within a year of the deprecating version, and there are no wire-level protocol changes. The deprecation is advisory. The stated motivation is low adoption relative to implementation complexity: Roots has vague semantics that overlap with tool parameters, Sampling is hard to implement correctly (human-in-the-loop, model selection, security) and few clients shipped it, and Logging overlaps with stderr and OpenTelemetry.

So `MCP9005` on its own does not break you. What breaks you is a separate change that landed in the same release. SEP-2567 removed `Mcp-Session-Id` from the wire format and SEP-2575 removed the `initialize` handshake, so the SDK flipped `HttpServerTransportOptions.SessionMode` to `HttpServerSessionMode.Stateless`. Server-to-client requests need an open connection back to the client, and a stateless server does not have one. Call the tool above on a stateless server and the tool call comes back as an error result:

```json
{"result":{"content":[{"type":"text","text":"An error occurred invoking 'summarize'."}],"isError":true,"resultType":"complete"},"id":4,"jsonrpc":"2.0"}
```

with this in the server log:

```text
"summarize" threw an unhandled exception.
System.InvalidOperationException: Sampling is not supported in stateless mode.
```

The same applies to `ElicitAsync` and `RequestRootsAsync`. That is the actual regression in a 1.x to 2.x upgrade, and the `MCP9005` warning is a useful proxy for finding it: every site the compiler flags is a place worth checking against the new default.

## How to fix MCP9004 before it takes the process down

`EnableLegacySse` is worse than a warning. Because the default is now stateless and legacy SSE needs in-memory session state shared between `GET /sse` and `POST /message`, keeping the setting after the upgrade throws during `MapMcp()`:

```text
Unhandled exception. System.InvalidOperationException: Legacy SSE endpoints cannot be enabled in
stateless mode because SSE requires in-memory session state shared between the GET /sse and
POST /message requests. Remove the EnableLegacySse setting or disable stateless mode.
   at Microsoft.AspNetCore.Builder.McpEndpointRouteBuilderExtensions.MapMcp(IEndpointRouteBuilder endpoints, String pattern)
```

There are two correct fixes, in order of preference.

The first is to drop legacy SSE and move clients to Streamable HTTP. On the client side that means pointing `Endpoint` at the root MCP endpoint instead of `/sse`, the same URL you pass to `MapMcp()`. With the default `HttpTransportMode.AutoDetect`, the client tries Streamable HTTP first, so this is usually a one-line change. If you have not done that migration yet, the mechanics are covered in the walkthrough on [moving an MCP server off SSE onto streamable HTTP](/2026/07/migrate-an-mcp-server-from-sse-to-streamable-http/).

The second is to keep serving SSE during a transition period, which now requires opting back into sessions explicitly:

```csharp
// ModelContextProtocol.AspNetCore 2.2.0
builder.Services.AddMcpServer()
    .WithHttpTransport(options =>
    {
        options.SessionMode = HttpServerSessionMode.Stateful;
        options.EnableLegacySse = true; // still MCP9004, suppress deliberately
    })
    .WithTools<SummarizeTool>();
```

That boots, and `GET /sse` returns `200 text/event-stream` again. The tradeoff is spelled out in the warning text: legacy SSE has no built-in request backpressure, so it should only face trusted clients in isolated processes. Note also that a `2026-07-28` request against a `Stateful` server is refused with `-32022 UnsupportedProtocolVersion` so dual-path clients downgrade, which is the same error covered in the post on [protocol version mismatches between 2025-11-25 and 2026-07-28 peers](/2026/08/fix-mcp-unsupported-protocol-version-2025-11-25-vs-2026-07-28/).

If you need both eras on one endpoint without the downgrade, `HttpServerSessionMode.StatefulForInitializeClients` gives sessions to `initialize` clients and serves `2026-07-28` clients statelessly. Legacy SSE still requires full `Stateful`.

## What to do about MCP9006

`MCP9006` is genuinely informational. The SDK docs state that you can still set these options and they continue to govern stateful behavior for initialize-capable clients. The warning exists to tell you the knobs are dead code on the `2026-07-28` path.

So there are two honest resolutions. If your server is stateless, delete the settings. They do nothing:

```csharp
// ModelContextProtocol.AspNetCore 2.2.0
builder.Services.AddMcpServer()
    .WithHttpTransport(options =>
    {
        options.SessionMode = HttpServerSessionMode.Stateless;
    })
    .WithTools<SummarizeTool>();
```

If your server is deliberately stateful, keep the settings and suppress `MCP9006` at project level with a comment explaining why. Do not suppress it in a stateless server: the warning is the only signal that those lines are doing nothing.

One nuance worth knowing: the older `bool` `Stateless` property is **not** obsolete. It survives as shorthand, where `true` selects `Stateless` and `false` selects `Stateful`, and both properties write the same underlying value so the last assignment wins. Use `SessionMode` when you need `StatefulForInitializeClients`.

## What replaces SampleAsync when there is no session?

If the sampling call has to survive, you have two options and neither is `#pragma`.

The first is to stop asking the client for inference and do it server-side with an `IChatClient`. Sampling exists so a server can borrow the client's model; if your server can hold its own credentials, this removes the deprecated API, the session requirement and a whole class of client-compatibility problems in one move:

```csharp
// ModelContextProtocol.AspNetCore 2.2.0, Microsoft.Extensions.AI 10.8.3
[McpServerTool(Name = "summarize"), Description("Summarize text.")]
public static async Task<string> Summarize(
    IChatClient chat,
    [Description("The text to summarize.")] string text,
    CancellationToken ct)
{
    var response = await chat.GetResponseAsync(
        [new ChatMessage(ChatRole.User, "Summarize: " + text)],
        new ChatOptions { MaxOutputTokens = 256 },
        ct);

    return response.Text;
}
```

The second is Multi Round-Trip Requests, which is the stateless-compatible replacement for the whole server-to-client request family. Instead of the server calling the client, the tool throws `InputRequiredException` describing what it needs, the client resolves it and retries the same `tools/call` with the answers attached. Guard it with `server.IsMrtrSupported`, which is `true` when the negotiated revision is `2026-07-28` or when the session is stateful under `2025-11-25`:

```csharp
// ModelContextProtocol.AspNetCore 2.2.0, MCP spec revision 2026-07-28
[McpServerTool(Name = "delete_branch"), Description("Delete a git branch.")]
public static string DeleteBranch(
    McpServer server,
    RequestContext<CallToolRequestParams> context,
    [Description("Branch to delete.")] string branch)
{
    if (!server.IsMrtrSupported)
    {
        return "This tool needs a client that negotiates 2026-07-28.";
    }

    var responses = context.Params!.InputResponses;
    if (responses is null || !responses.TryGetValue("confirm", out var answer))
    {
        throw new InputRequiredException(new InputRequiredResult
        {
            InputRequests = new Dictionary<string, InputRequest>
            {
                ["confirm"] = InputRequest.ForElicitation(new ElicitRequestParams
                {
                    Message = $"Delete branch {branch}?",
                }),
            },
            RequestState = branch,
        });
    }

    return $"Deleted {context.Params!.RequestState}.";
}
```

Driven against a stateless server, the first call comes back incomplete, with no session ID anywhere:

```json
{"result":{"inputRequests":{"confirm":{"method":"elicitation/create","params":{"mode":"form","message":"Delete branch feature/x?"}}},"requestState":"feature/x","resultType":"input_required"},"id":2,"jsonrpc":"2.0"}
```

and the retry, carrying `requestState` and `inputResponses`, completes:

```json
{"result":{"content":[{"type":"text","text":"Deleted feature/x."}],"resultType":"complete"},"id":3,"jsonrpc":"2.0"}
```

`requestState` is what replaces server memory. It is your correlation token, round-tripped by the client. One caveat: `InputRequest.ForSampling` and `InputRequest.ForRootsList` are themselves marked `MCP9005`, so MRTR does not launder the deprecation for sampling and roots. Only elicitation comes out of this clean.

## How to suppress these warnings correctly (CS0618 does not work)

This trips people who have suppressed obsolete warnings a hundred times. All of these attributes set a custom `DiagnosticId`, which means the compiler reports `MCP9005` instead of `CS0618`, and the old suppression is inert:

```csharp
#pragma warning disable CS0618 // does NOT suppress a custom DiagnosticId
    var result = await server.SampleAsync(/* ... */);
#pragma warning restore CS0618
```

That still emits `warning MCP9005`. You have to name the actual ID:

```csharp
#pragma warning disable MCP9005
    var result = await server.SampleAsync(/* ... */);
#pragma warning restore MCP9005
```

For a project-wide decision, use `NoWarn`. And if you build with `TreatWarningsAsErrors`, these arrive as `error MCP9004` and `error MCP9006` and will break CI on the upgrade commit. `WarningsNotAsErrors` is the surgical escape hatch that keeps the warning visible while unblocking the build:

```xml
<!-- Directory.Build.props, MSBuild 17.x / .NET 10 SDK -->
<PropertyGroup>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  <!-- deliberate: stateful server, these options still apply to initialize clients -->
  <WarningsNotAsErrors>MCP9004;MCP9006</WarningsNotAsErrors>
</PropertyGroup>
```

Prefer `WarningsNotAsErrors` over `NoWarn` here. `NoWarn` hides the fact that you are still on the back-compat path, and these warnings are the thing that will remind you to finish the migration.

## Which other MCP9### diagnostics exist?

The obsolete range is not limited to these three. IDs are never reused, even after the API is removed, so the numbering has gaps.

| ID | Status | What it flags |
| --- | --- | --- |
| `MCP9001` | In place | `EnumSchema` and `LegacyTitledEnumSchema`, deprecated as of spec `2025-11-25` (SEP-1330) |
| `MCP9002` | Removed | The old `AddXxxFilter` builder extensions, superseded by `WithRequestFilters()` and `WithMessageFilters()` |
| `MCP9003` | In place | The two-argument `RequestContext<TParams>(McpServer, JsonRpcRequest)` constructor; use the overload that takes `parameters` |
| `MCP9004` | In place | `EnableLegacySse` |
| `MCP9005` | In place | Roots, Sampling and Logging (SEP-2577) |
| `MCP9006` | In place | Stateful-only `HttpServerTransportOptions` members (SEP-2567) |
| `MCP9007` | In place | `AuthorizationRedirectDelegate`, which cannot carry the RFC 9207 issuer or the authorization-response state; use `ClientOAuthOptions.AuthorizationCallbackHandler` |

`MCP9007` deserves a callout because it is a security warning wearing an obsolete-API costume: state and issuer validation are simply skipped when the old delegate is used. If your client does OAuth, treat that one as a bug, not a deprecation.

Separately, `MCPEXP002` marks the SDK extensibility surface (subclassing `McpClient` and `McpServer`, custom request handlers, alternate handlers and filters, outgoing request interception, `RunSessionHandler`). It is not a deprecation, it is a no-compatibility-guarantee marker. `MCP001` and `MCP002` come from the source generator that turns XML docs into `[Description]` attributes, and `MCP002` in particular just means your tool method needs to be `partial`.

## In what order should you work the warning list?

Bump the package, then work the list in this order.

Set `SessionMode` explicitly before anything else, even if you are choosing the new default. The docs recommend this specifically so a future default change cannot move your server underneath you. Then resolve `MCP9004`, because it is the one that will not even start. Then walk the `MCP9005` list looking only for `SampleAsync`, `ElicitAsync` and `RequestRootsAsync` call sites, since those are the ones that changed behavior; the protocol types and constants can wait. Finally decide on `MCP9006` based on the `SessionMode` you picked in step one.

## Related

If you are standing up something new rather than upgrading, start from the current shape instead of retrofitting it: the walkthrough on [building a custom MCP server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) covers the tool and DI plumbing, [choosing between stdio, HTTP and SSE transports](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) covers the decision `SessionMode` now partly makes for you, and the [2.0 release notes writeup](/2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005/) covers the other seven breaking changes that ship alongside these warnings.

## Sources

Verified against the SDK's [list of diagnostics](https://github.com/modelcontextprotocol/csharp-sdk/blob/main/docs/list-of-diagnostics.md), the [stateless and stateful mode guide](https://github.com/modelcontextprotocol/csharp-sdk/blob/main/docs/concepts/stateless/stateless.md), the [MRTR guide](https://github.com/modelcontextprotocol/csharp-sdk/blob/main/docs/concepts/mrtr/mrtr.md), [SEP-2577](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2577), and the [v2.0.0 release](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.0.0). All compiler output and wire traces above were captured against `ModelContextProtocol.AspNetCore` 2.2.0 on the .NET 10.0.201 SDK.
