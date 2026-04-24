---
title: "ASP.NET Core 11 Ships Native OpenTelemetry Tracing: Drop the Extra NuGet Package"
description: "ASP.NET Core in .NET 11 Preview 2 adds OpenTelemetry semantic attributes directly to HTTP server activity, removing the need for OpenTelemetry.Instrumentation.AspNetCore."
pubDate: 2026-04-12
tags:
  - "aspnet-core"
  - "dotnet-11"
  - "opentelemetry"
  - "observability"
---

Every ASP.NET Core project that exports traces has the same line in its `.csproj`: a reference to `OpenTelemetry.Instrumentation.AspNetCore`. That package subscribes to the framework's `Activity` source and stamps each span with the semantic attributes exporters expect: `http.request.method`, `url.path`, `http.response.status_code`, `server.address`, and so on.

Starting with [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/), the framework does that work itself. ASP.NET Core now populates the standard OpenTelemetry semantic convention attributes directly on the HTTP server activity, so the separate instrumentation library is no longer required to collect baseline tracing data.

## What the framework now provides

When a request hits Kestrel in .NET 11 Preview 2, the built-in middleware writes the same attributes the instrumentation package used to add:

- `http.request.method`
- `url.path` and `url.scheme`
- `http.response.status_code`
- `server.address` and `server.port`
- `network.protocol.version`

These are the [HTTP server semantic conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/) that every OTLP-compatible backend relies on for dashboards and alerting.

## Before and after

A typical .NET 10 setup to get HTTP traces looked like this:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddAspNetCoreInstrumentation()   // requires the NuGet package
            .AddOtlpExporter();
    });
```

In .NET 11, you subscribe to the built-in activity source instead:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddSource("Microsoft.AspNetCore")  // no extra package needed
            .AddOtlpExporter();
    });
```

The `OpenTelemetry.Instrumentation.AspNetCore` package is not gone; it still exists for teams that need its enrichment callbacks or advanced filtering. But the baseline attributes that 90% of projects need are now baked into the framework.

## Why this matters

Fewer packages means a smaller dependency graph, faster restore times, and one less thing to keep in sync during major version upgrades. It also means NativeAOT-published ASP.NET Core apps get standard traces without pulling in reflection-heavy instrumentation code.

If you are already running the instrumentation package, nothing breaks. The framework attributes and the package attributes merge cleanly on the same `Activity`. You can remove the package reference when you are ready, test your dashboards, and move on.

The [full ASP.NET Core .NET 11 Preview 2 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview2/aspnetcore.md) cover the rest of the changes, including Blazor SSR TempData support and the new Web Worker project template.
