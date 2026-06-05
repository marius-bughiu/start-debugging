---
title: "Migrate from Serilog to OpenTelemetry logging in .NET 11"
description: "A step-by-step guide to moving a .NET 11 app off Serilog and onto OpenTelemetry logging: the low-risk Serilog.Sinks.OpenTelemetry bridge, the full Microsoft.Extensions.Logging cut-over, what breaks, how to verify, and how to roll back."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "serilog"
  - "opentelemetry"
  - "dotnet-11"
  - "logging"
  - "observability"
---

If your team has standardized on OpenTelemetry for traces and metrics, the odd one out is usually logging, which is still going through Serilog and a file or Seq sink. This guide moves a .NET 11 app (OpenTelemetry .NET SDK 1.15.x, Serilog 4.x) off that split setup and onto OpenTelemetry logging. There are two routes: a one-evening bridge that keeps Serilog and swaps only the sink, and a full cut-over to `Microsoft.Extensions.Logging` that removes Serilog entirely. The bridge is reversible in a single commit and breaks almost nothing. The full migration takes a day or two on a real codebase, touches every `BeginScope` and message template, and is worth it only if removing the Serilog dependency and unifying on one logging API is an actual goal rather than a nice-to-have.

## Why move logging to OpenTelemetry at all

- **One pipeline for three signals.** Traces, metrics, and logs leave the process through the same OTLP exporter and land in the same backend, correlated by `TraceId` and `SpanId`. No separate Seq endpoint to operate next to your trace backend.
- **Vendor-neutral wire format.** OTLP is a stable protocol. You can point the same app at the Aspire Dashboard locally, Jaeger or SigNoz self-hosted, or a commercial backend, by changing one endpoint, not by swapping a sink package.
- **Automatic trace correlation.** Logs emitted inside an active `Activity` carry the trace and span IDs without an enricher, so "show me every log line for this request" works across services.
- **Fewer moving parts in CI and prod.** Dropping the Serilog bootstrap and sink configuration removes a class of "logs silently stopped" incidents caused by sink buffering and flush-on-shutdown bugs.

If you have not wired OpenTelemetry traces yet, do that first: [use OpenTelemetry with .NET 11 and a free backend](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) covers the exporter and backend setup this guide assumes is already in place.

## What breaks

| Area | Change | Severity |
| --- | --- | --- |
| Sink configuration | File/console/Seq sinks replaced by the OTLP exporter or `Serilog.Sinks.OpenTelemetry` | high (full) / low (bridge) |
| `Log.Logger` static + `CreateBootstrapLogger()` | Removed in full migration; no two-stage startup logging | high (full only) |
| `LogContext.PushProperty` enrichers | Replaced by `ILogger.BeginScope` plus `IncludeScopes = true` | medium (full only) |
| Destructuring operator `{@Order}` | No equivalent in `Microsoft.Extensions.Logging`; log scalar fields or serialize explicitly | medium (full only) |
| `UseSerilogRequestLogging()` | Replaced by ASP.NET Core OTel instrumentation or `AddHttpLogging` | medium (full only) |
| `MinimumLevel` config block | Moves to the `Logging:LogLevel` section in `appsettings.json` | low (full only) |
| Severity names | Serilog `Verbose` maps to OTel `Trace`; `Information` stays | low |

The "bridge" column matters: if you take route A, only the first row applies and the severity is low. Everything else is a full-migration concern.

## Pre-flight checklist

- **.NET 11 SDK installed.** Confirm with `dotnet --version` (expect `11.0.x`).
- **OpenTelemetry traces already exporting over OTLP.** This guide reuses that exporter and resource.
- **A backend that ingests OTLP logs.** The Aspire Dashboard, SigNoz, and Seq all accept OTLP/HTTP. Seq exposes an OTLP ingestion endpoint at `/ingest/otlp/v1/logs`, so you can keep Seq as the destination even after dropping the Serilog Seq sink.
- **A green test suite and a clean working tree** before you start, so `git diff` shows only migration changes.
- **Know your OTLP endpoint and protocol.** Default gRPC is `http://localhost:4317`; default HTTP/protobuf is `http://localhost:4318`. The HTTP exporter appends `/v1/logs` to the base endpoint.

## Migration steps

### 1. Pin the package versions

Decide the route, then install the matching packages. Both routes target the same SDK line.

```xml
<!-- .NET 11, both routes -->
<!-- Route A (bridge): keep Serilog, swap the sink -->
<PackageReference Include="Serilog.AspNetCore" Version="9.0.0" />
<PackageReference Include="Serilog.Sinks.OpenTelemetry" Version="4.2.0" />

<!-- Route B (full): Microsoft.Extensions.Logging + OpenTelemetry -->
<PackageReference Include="OpenTelemetry.Extensions.Hosting" Version="1.15.3" />
<PackageReference Include="OpenTelemetry.Exporter.OpenTelemetryProtocol" Version="1.15.3" />
```

Verify: `dotnet restore` succeeds and `dotnet build` is clean before you change any code.

### 2a. Route A -- swap the Serilog sink for OTLP

This is the low-risk path. Keep every enricher, message template, and `LogContext` call you already have. Replace only the sink configuration.

```csharp
// .NET 11, C# 14, Serilog 4.x, Serilog.Sinks.OpenTelemetry 4.2.0
using Serilog;
using Serilog.Sinks.OpenTelemetry;

Log.Logger = new LoggerConfiguration()
    .Enrich.FromLogContext()
    .WriteTo.OpenTelemetry(options =>
    {
        options.Endpoint = "http://localhost:4318/v1/logs";
        options.Protocol = OtlpProtocol.HttpProtobuf;
        options.ResourceAttributes = new Dictionary<string, object>
        {
            ["service.name"] = "orders-api",
            ["service.version"] = "2.4.0"
        };
    })
    .CreateLogger();
```

The sink reads `Activity.Current` and injects `TraceId` and `SpanId` into every log record automatically (`IncludedData.TraceIdField` and `SpanIdField` are on by default), so cross-signal correlation works with no extra enricher. Your `_logger.LogInformation("Placed order {OrderId}", id)` templates flow through unchanged.

Verify: start the app, place one request, and confirm the log line appears in your OTLP backend with the same `TraceId` as the request's trace.

### 2b. Route B -- cut over to Microsoft.Extensions.Logging

Remove `UseSerilog()` / `AddSerilog()` and the `Log.Logger` bootstrap from `Program.cs`. Wire OpenTelemetry into the built-in logging builder instead.

```csharp
// .NET 11, C# 14, OpenTelemetry .NET SDK 1.15.3
using OpenTelemetry.Logs;
using OpenTelemetry.Resources;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.AddOpenTelemetry(options =>
{
    options.IncludeScopes = true;            // keep BeginScope properties
    options.IncludeFormattedMessage = true;  // populate the log body
    options.ParseStateValues = true;         // capture structured attributes
    options.SetResourceBuilder(
        ResourceBuilder.CreateDefault()
            .AddService("orders-api", serviceVersion: "2.4.0"));
    options.AddOtlpExporter(o =>
    {
        o.Endpoint = new Uri("http://localhost:4318");
    });
});

var app = builder.Build();
```

If your app already calls `builder.Services.AddOpenTelemetry()` for traces and metrics, prefer the unified form so all three signals share one resource and exporter:

```csharp
// .NET 11, OpenTelemetry .NET SDK 1.15.3
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("orders-api", serviceVersion: "2.4.0"))
    .WithTracing(t => t.AddAspNetCoreInstrumentation())
    .WithMetrics(m => m.AddAspNetCoreInstrumentation())
    .UseOtlpExporter(); // one call: configures OTLP for traces, metrics, AND logs

// Logs still need the provider on the logging builder:
builder.Logging.AddOpenTelemetry(o =>
{
    o.IncludeScopes = true;
    o.IncludeFormattedMessage = true;
    o.ParseStateValues = true;
});
```

`UseOtlpExporter()` (added in SDK 1.8) registers the OTLP exporter for every signal at once, so you do not repeat the endpoint three times.

Verify: `dotnet run`, then confirm an `ILogger` line reaches the backend with the correct `service.name` and a populated body.

### 3. Translate enrichers to scopes (Route B only)

Serilog's `LogContext.PushProperty("UserId", id)` has no equivalent in `Microsoft.Extensions.Logging`. Use `ILogger.BeginScope` and the properties flow into the OTLP record because you set `IncludeScopes = true`.

```csharp
// Before (Serilog)
using (LogContext.PushProperty("UserId", userId))
{
    _logger.LogInformation("Loaded cart");
}

// After (.NET 11, Microsoft.Extensions.Logging)
using (_logger.BeginScope(new Dictionary<string, object> { ["UserId"] = userId }))
{
    _logger.LogInformation("Loaded cart");
}
```

Verify: the emitted log record carries `UserId` as an attribute. If it is missing, you forgot `IncludeScopes = true`.

### 4. Replace request logging (Route B only)

`app.UseSerilogRequestLogging()` produced one summarized log line per request. With OpenTelemetry, the ASP.NET Core instrumentation already emits an HTTP server span per request, which is the better primitive for "what happened in this request". If you still want a log line, add HTTP logging:

```csharp
// .NET 11
builder.Services.AddHttpLogging(o => { });
// ...
app.UseHttpLogging();
```

Verify: each request produces an HTTP server span (and an optional HTTP log entry) correlated by `TraceId`.

### 5. Move level configuration to appsettings

Serilog's `MinimumLevel` block is replaced by the standard `Logging:LogLevel` section, which the OpenTelemetry provider respects like any other.

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    }
  }
}
```

Verify: set a category to `Warning`, confirm its `Information` lines stop appearing in the backend.

## Verification checklist

Run this after either route, before you delete the old packages:

- `dotnet build` is clean with no `Serilog` warnings you did not expect.
- `dotnet test` passes with zero failures.
- A request produces log records in the backend with a non-empty body (`IncludeFormattedMessage` working).
- Those records share the request's `TraceId` (correlation working).
- Structured properties (`OrderId`, scope values) appear as attributes, not baked into the message string (`ParseStateValues` and `IncludeScopes` working).
- Log volume in the backend matches expectations; no level filter is silently dropping or flooding.
- Shutdown flushes: stop the app mid-request and confirm the last lines still arrive (the batch processor flushes on dispose).

## Rollback plan

**Route A is reversible in one commit.** Revert the `WriteTo.OpenTelemetry(...)` block back to your old `WriteTo.Seq(...)` / `WriteTo.File(...)` configuration and remove the `Serilog.Sinks.OpenTelemetry` package. Nothing else changed, so there is no risk surface.

**Route B is reversible but not trivial.** Keep the Serilog packages installed and the old `Program.cs` bootstrap in your git history until the new pipeline has run in production for a release cycle. If you need to revert, restore `UseSerilog()`, the `Log.Logger` bootstrap, and convert the `BeginScope` calls back to `LogContext.PushProperty`. Because the cut-over touches scopes and request logging across the codebase, treat the revert as its own small migration, not a one-line toggle. Do not delete the Serilog packages from the `.csproj` until verification has passed in production.

## Gotchas we hit

**Empty log bodies in the backend.** If `IncludeFormattedMessage` is left at its default `false`, the OTLP record ships with structured attributes but no rendered message, and some backends show a blank line. Turn it on. Pair it with `ParseStateValues = true` so the named placeholders (`{OrderId}`) also land as attributes rather than only inside the formatted string.

**Scope properties vanish.** `IncludeScopes` defaults to `false`. Every `BeginScope` value, and anything ASP.NET Core puts in the request scope, is dropped until you enable it. This is the single most common "my migration lost half my log context" report.

**No `{@Object}` destructuring.** Serilog's `_logger.LogInformation("Got {@Order}", order)` serialized the whole object. `Microsoft.Extensions.Logging` treats `@` as literal text. Log the scalar fields you actually query on, or serialize explicitly with `System.Text.Json`. Dumping whole objects also explodes attribute cardinality, which some backends bill on.

**Losing two-stage bootstrap logging.** Serilog's `CreateBootstrapLogger()` captured failures that happen before the host is built. The OpenTelemetry provider only exists after `builder.Build()`, so very early startup exceptions go only to the console. If early-startup observability matters, keep a minimal console logger for that window.

**Severity mapping surprises.** Serilog `Verbose` becomes OTel `Trace`, and `Fatal` becomes `Critical`. If you filter or alert on severity names downstream, update those rules. `Debug`, `Information`, `Warning`, and `Error` map one-to-one.

If you are tightening up logging anyway, it is worth revisiting how you emit structured data in the first place; [set up structured logging with Serilog and Seq in .NET 11](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) covers the message-template patterns that carry over cleanly to `ILogger`, and [ASP.NET Core 11's native OpenTelemetry tracing](/2026/04/aspnetcore-11-native-opentelemetry-tracing/) explains why you may not need extra instrumentation packages once you are on the unified pipeline. For background jobs and hosted services, [monitoring background jobs without Hangfire](/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) shows the same correlation working outside the request path, and the [Aspire 13.2.4 OpenTelemetry baggage advisory](/2026/04/aspire-13-2-4-opentelemetry-cve-2026-40894-baggage-dos/) is a reminder to keep the OTel packages patched.

Pick the bridge unless removing Serilog is a real goal. It gives you OTLP logs and trace correlation tonight, and you can take the full cut-over later when you have a quiet sprint to translate scopes and request logging properly.

## Sources

- [OpenTelemetry .NET logs documentation](https://opentelemetry.io/docs/languages/dotnet/logs/)
- [Serilog.Sinks.OpenTelemetry on GitHub](https://github.com/serilog/serilog-sinks-opentelemetry)
- [OTLP Exporter for OpenTelemetry .NET](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Exporter.OpenTelemetryProtocol/README.md)
- [.NET observability with OpenTelemetry (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel)
- [OpenTelemetry.Exporter.OpenTelemetryProtocol on NuGet](https://www.nuget.org/packages/OpenTelemetry.Exporter.OpenTelemetryProtocol)
