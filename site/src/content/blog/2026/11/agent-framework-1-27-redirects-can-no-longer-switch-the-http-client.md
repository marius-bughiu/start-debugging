---
title: "Agent Framework 1.27: A Redirect Can No Longer Switch Your Declarative Workflow to an Authenticated HttpClient"
description: "Microsoft Agent Framework for .NET 1.27.0 makes DefaultHttpRequestHandler throw HttpRequestException when its client-provider callback returns a client for a redirect destination. Here is why that hole existed, what breaks, and how to rewrite the callback."
pubDate: 2026-11-02
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "security"
  - "breaking-changes"
---

Microsoft Agent Framework for .NET [1.27.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.27.0) shipped on October 30, 2026 with two changes tagged `[BREAKING]`. The one most likely to surprise you at runtime is small and lives in `Microsoft.Agents.AI.Workflows.Declarative`: [PR #9711](https://github.com/microsoft/agent-framework/pull/9711) stops a redirect from changing which `HttpClient` sends the request. No public signature moved, so your code still compiles. It just throws where it used to follow.

## How declarative workflows pick an HttpClient

A YAML workflow's `HttpRequestAction` is executed by whatever `IHttpRequestHandler` you put on `DeclarativeWorkflowOptions.HttpRequestHandler`. The stock implementation, `DefaultHttpRequestHandler`, takes an optional provider callback so you can route specific URLs through pre-authenticated clients:

```csharp
var handler = new DefaultHttpRequestHandler(async (request, ct) =>
{
    var uri = new Uri(request.Url);
    return uri.Host == "api.contoso.internal"
        ? contosoClient          // carries a bearer token handler
        : null;                  // null = handler's own internal client
});

var options = new DeclarativeWorkflowOptions(provider)
{
    HttpRequestHandler = handler,
};
```

The internal client disables automatic redirects on purpose, so per-request headers are not forwarded to a new destination. Instead, the handler follows `3xx` responses itself, up to 50 hops, and calls your provider again for every hop so you can veto destinations.

## The hole in 1.26

That second provider call is where it went wrong. Picture a workflow that fetches a public URL (the provider returns `null`, so the anonymous internal client is used). The server answers `302 Location: https://api.contoso.internal/admin/export`. In 1.26 the handler asked the provider about the new URL, the provider matched the host, and the redirected request went out through `contosoClient`, token attached.

Workflow definitions are executable configuration, and the URLs they hit often come from model output or user input. A redirect from a server you do not control should never be able to promote a request onto credentials you only meant for one internal API.

## What 1.27 does instead

The loop in `SendAsync` now checks the hop count before using the provider's answer:

```csharp
providedClient = await _httpClientProvider(currentRequest, ct);
if (redirectCount > 0 && providedClient is not null)
{
    throw new HttpRequestException(
        "Redirects that change the HTTP client are not allowed.");
}
```

So for a redirect destination your callback has two valid outcomes:

- Return `null`: the internal client keeps following the redirect.
- Throw: the destination is rejected before anything is sent.

Returning a client is now always an error on a redirect. Two behaviors are unchanged: supplying a client for the initial request still works, and when a supplied client gets a `3xx` back, the handler still does not follow it, because that client's redirect behavior is opaque to it.

## Rewriting the callback

`HttpRequestInfo` does not say whether a call is a redirect hop, so a host-matching provider can start throwing on legitimate traffic that used to bounce into your API. The fix is to stop relying on redirects to reach authenticated hosts and use the callback as an allowlist:

```csharp
var handler = new DefaultHttpRequestHandler(async (request, ct) =>
{
    var host = new Uri(request.Url).Host;

    if (host == "api.contoso.internal")
        return contosoClient;    // fine for the first hop only

    if (!AllowedPublicHosts.Contains(host))
        throw new HttpRequestException($"Blocked destination: {host}");

    return null;
});
```

If a workflow genuinely needs to land on `api.contoso.internal` after a redirect, point the action at the final URL directly.

If you also host on Foundry, the other breaking change in the same release moves `services.AddFoundryResponses(...)` to `builder.AddFoundryResponses(...)` and changes where local response state is stored. Check the [release notes](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.27.0) before you bump. For the previous release in this series, see [Agent Framework 1.26 resolving scoped agents per request on AG-UI endpoints](/2026/10/agent-framework-1-26-ag-ui-endpoints-resolve-scoped-agents-per-request/).
