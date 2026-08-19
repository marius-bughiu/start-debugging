---
title: "Semantic Kernel 1.80.0 Stops OpenAPI Plugins From Following Redirects"
description: "Semantic Kernel .NET 1.80.0 ships a breaking change: the OpenAPI plugin's default HttpClient no longer follows redirects, closing an SSRF bypass. Here is what changes and why your own HttpClient reopens the hole."
pubDate: 2026-08-19
tags:
  - "dotnet"
  - "semantic-kernel"
  - "ai-agents"
  - "security"
  - "csharp"
---

Semantic Kernel .NET 1.80.0 went out on August 18, 2026, and the changelog line that matters is the terse one: [".NET: [Breaking] Update OpenAPI HTTP client defaults"](https://github.com/microsoft/semantic-kernel/pull/14293). It closes a hole that Semantic Kernel had been documenting as a known limitation in its own XML docs since May.

## The validation was real, the redirect was the escape hatch

Since [PR #14029](https://github.com/microsoft/semantic-kernel/pull/14029) landed in May 2026, `RestApiOperationServerUrlValidationOptions` has been applied by default to every OpenAPI plugin. Leave `ServerUrlValidationOptions` null and you still get a default-constructed instance that enforces https-only for anything off the allowlist and rejects hosts resolving to loopback, link-local (including the cloud metadata address `169.254.169.254`), RFC1918, `fc00::/7`, carrier-grade NAT, multicast, and reserved ranges.

The problem was ordering. Validation runs against the URL before the request goes out. The default `HttpClient` followed redirects, so a public host you allowed could answer with a `302` pointing at `http://169.254.169.254/latest/meta-data/` and the handler would chase it, having already passed the gate. Semantic Kernel said so in the type's own remarks and told you to configure `AllowAutoRedirect = false` yourself.

## What 1.80.0 actually changed

The plugin factory no longer resolves its default client through `HttpClientProvider.GetHttpClient()`. It now calls a new `GetNonRedirectingHttpClient()`, backed by a separate non-disposable handler singleton with redirects off:

```csharp
public static HttpClient GetNonRedirectingHttpClient()
    => new(NonDisposableHttpClientHandler.NonRedirectingInstance, disposeHandler: false);
```

Every entry point routes through it: `ImportPluginFromOpenApiAsync`, `CreatePluginFromOpenApiAsync`, `OpenApiKernelPluginFactory.CreateFromOpenApiAsync`, plus the API Manifest and Copilot Agent Plugin extensions. A redirect now surfaces as an `HttpOperationException` carrying the `3xx` status instead of being silently followed.

## Your HttpClient is still your problem

This is the part to check before you upgrade `Microsoft.SemanticKernel.Plugins.OpenApi` to 1.80.0. The new default only applies when Semantic Kernel builds the client. Pass one in, and it is used verbatim:

```csharp
var handler = new HttpClientHandler { AllowAutoRedirect = false };
using var http = new HttpClient(handler);

await kernel.ImportPluginFromOpenApiAsync(
    pluginName: "partner",
    uri: new Uri("https://partner.example.com/openapi.json"),
    executionParameters: new OpenApiFunctionExecutionParameters
    {
        HttpClient = http,
    });
```

The subtle case is DI. The kernel extensions fall back to `kernel.Services.GetService<HttpClient>()` before reaching the default, so a plain `AddHttpClient()` registration wins and brings `AllowAutoRedirect = true` back with it. If you are wiring plugins up inside a host, as in [running a Semantic Kernel plugin from a BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/), configure the primary handler explicitly.

The breaking part is genuine: an internal API that answers `301` on a trailing-slash mismatch used to work and now throws. Fix the `servers[].url` in the document rather than handing the plugin a redirecting client.
