---
title: "MCP C# SDK 2.0 Ships: Stateless by Default and MCP9005 on Your Old Code"
description: "ModelContextProtocol 2.0.0 landed on 2026-07-28 with the stateless HTTP transport on by default, Multi Round-Trip Requests replacing server-initiated elicitation, and an analyzer warning on ElicitAsync and SampleAsync."
pubDate: 2026-07-29
tags:
  - "mcp"
  - "dotnet"
  - "csharp"
  - "ai-agents"
---

On 2026-07-28 Jeff Handley announced [v2.0 of the official MCP C# SDK](https://devblogs.microsoft.com/dotnet/announcing-v20-of-the-official-mcp-csharp-sdk/), shipped the same day the `2026-07-28` protocol revision became final. `ModelContextProtocol` 2.0.0 is on NuGet as a stable version, targeting `net8.0`, `net9.0`, `net10.0`, and `netstandard2.0`. If you built a server against 1.x, this is not a version bump you can take without reading the diff.

## The handshake is gone

The headline change is architectural, and it is a subtraction. Under `2026-07-28` there is no `initialize` handshake and no `Mcp-Session-Id`. Clients call `server/discover`, and every subsequent request carries protocol version, client info, and capabilities in per-request `_meta`. That is what the [GitHub MCP Server deleted its Redis session store](/2026/07/github-mcp-server-goes-stateless-redis-session-store/) for.

In the C# SDK this shows up as a default flip. `HttpServerTransportOptions.Stateless` is now `true`, so a server you scaffold today is horizontally scalable with no sticky routing. You opt back into sessions explicitly:

```csharp
builder.Services
    .AddMcpServer()
    .WithHttpTransport(options => options.Stateless = false)
    .WithToolsFromAssembly();
```

## MCP9005 is the migration checklist

Server-initiated requests do not survive a stateless transport. `ElicitAsync`, `SampleAsync`, and `RequestRootsAsync` are now marked obsolete and produce diagnostic `MCP9005`. Compile against 2.0.0 and the warning list is your migration plan: anywhere the server used to reach back into the client mid-tool-call needs rewriting.

The replacement is Multi Round-Trip Requests. Instead of the server calling the client, the tool throws with the inputs it needs, the client resolves them locally, then retries the call with the answers attached:

```csharp
throw new InputRequiredException(
    inputRequests: new Dictionary<string, InputRequest>
    {
        ["closeReason"] = InputRequest.ForElicitation(...)
    },
    requestState: ticketId.ToString());
```

`requestState` is the trick that makes this work without a session: it is your correlation token, round-tripped by the client rather than parked in server memory.

Clients get the easy half. `McpClient` resolves MRTR transparently as long as you register a handler:

```csharp
var client = await McpClient.CreateAsync(
    clientTransport,
    clientOptions: new()
    {
        Handlers = new McpClientHandlers
        {
            ElicitationHandler = (requestParams, ct) =>
                ValueTask.FromResult(
                    new ElicitResult { Action = "accept" })
        }
    });
```

## What still talks to old peers

A 2.0.0 client prefers `2026-07-28` and falls back to the legacy `initialize` handshake automatically when the server does not answer `server/discover`. A 2.0.0 server keeps accepting `initialize` from 1.x clients. The one combination that does not work is an old client against a stateless server, which is exactly the case you cannot bridge, since MRTR against a `2025-11-25` client requires session state to translate into legacy elicitation.

The other sharp edge: the experimental Tasks support from 1.3.x and 1.4.x is gone, replaced by a redesigned `ModelContextProtocol.Extensions.Tasks` package aligned with SEP-2663. Apps and Tasks are now opt-in packages rather than baked into the core, enabled with `.WithTasks(store)` and `.WithMcpApps()`.

One genuinely nice addition for anyone running servers behind a gateway: `[McpHeader]` promotes a tool parameter to an HTTP header, so your proxy can route on it without parsing the JSON-RPC body.

```csharp
public static async Task<string> GetOrderStatus(
    [McpHeader("Region")] string region,
    string orderId)
```

Start with `dotnet add package ModelContextProtocol --version 2.0.0`, build, and read the `MCP9005` list before touching anything else. The [v2.0.0 release notes](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.0.0) enumerate all 10 breaking changes, including the JSON-RPC error code renumbering that moves `UnsupportedProtocolVersion` to `-32022`.
