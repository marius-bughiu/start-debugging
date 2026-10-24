---
title: "Agent Framework 1.26: AG-UI Endpoints Stop Turning Scoped Agents into Singletons"
description: "Microsoft Agent Framework 1.26.0 makes MapAGUIServer resolve the keyed AIAgent, its AgentSessionStore, and the isolation key provider per request, and adds a selector overload that picks the agent from the HttpContext."
pubDate: 2026-10-24
tags:
  - "agent-framework"
  - "ag-ui"
  - "dotnet"
  - "aspnetcore"
  - "ai-agents"
---

[Microsoft Agent Framework dotnet-1.26.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.26.0) shipped on October 23, 2026, with `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` at `1.26.0-preview.261023.1`. The headline item for anyone hosting agents behind AG-UI is [PR #9382](https://github.com/microsoft/agent-framework/pull/9382): the AG-UI endpoint now respects the DI lifetime you registered your agent with, and you can pick the agent per request.

## The captive dependency in 1.25 and earlier

Before this release, `MapAGUIServer(agentName)` and `MapAGUIServer(IHostedAgentBuilder)` resolved the keyed `AIAgent`, its keyed `AgentSessionStore`, and the `AgentIsolationKeyProvider` from the root service provider, once, when the endpoint was mapped. Whatever lifetime you registered was ignored. A Scoped agent became a singleton in practice, and so did everything it captured.

That bites when the agent depends on per-request state:

```csharp
builder.Services.AddScoped<TenantContext>();

builder.Services.AddKeyedScoped<AIAgent>("support", (sp, _) =>
{
    var tenant = sp.GetRequiredService<TenantContext>();
    return chatClient.AsAIAgent(
        name: "support",
        instructions: $"You answer support questions for {tenant.Name}.");
});
```

On 1.25, the first `TenantContext` to be resolved won. Every later request, from every tenant, got the same agent with the same instructions. It is the classic captive dependency, just hidden behind an endpoint mapping instead of a constructor.

From 1.26, those three services come from `HttpContext.RequestServices` on each request. Scoped and Transient agents get a fresh instance per request. Singletons registered through `IHostedAgentBuilder` are still resolved once at mapping time, so there is no extra cost for the common case. Missing registrations are still reported at startup: the check uses `IServiceProviderIsKeyedService`, so it never resolves a scoped instance from the root provider.

## Choosing the agent from the request

The same PR adds a new overload:

```csharp
public static IEndpointConventionBuilder MapAGUIServer(
    this IEndpointRouteBuilder endpoints,
    [StringSyntax("route")] string pattern,
    Func<HttpContext, AIAgent?> agentSelector)
```

The selector runs once per request, so the agent can come from a route value, a header, or a claim:

```csharp
app.MapAGUIServer("/agents/{agent}", ctx =>
{
    var name = ctx.GetRouteValue("agent") as string;
    return name is null
        ? null
        : ctx.RequestServices.GetKeyedService<AIAgent>(name);
});
```

Returning `null` produces a `404 Not Found` before any session state is loaded. The selected agent's `Name` is used as the session storage identity, so a conversation survives even though a new agent instance is built for every request. The XML docs are explicit that selection is not an authorization boundary: put an authorization policy on the endpoint (`.RequireAuthorization(...)`) rather than returning `null` for users who should not reach an agent.

## One behavior change to check

A follow-up commit in the PR changes how named agents mapped by instance are identified. `MapAGUIServer(pattern, AIAgent)` now uses the agent's name as its identity, matching the named, hosted, and selector mappings. Previously, the same agent exposed through a named mapping and an instance mapping did not share conversations. Now it does. Unnamed agents still use instance identity. The instance overload also resolves its session store per request now.

The same release adds `AgentSessionStore.DeleteSessionAsync` as an abstract method, so a custom store that derives from `AgentSessionStore` will not compile until you implement it. If you moved to `MapAGUIServer` after [the AG-UI .NET SDK 1.0 renames](/2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework/) and register anything other than singleton agents, this is the upgrade that makes those registrations mean what they say.
