---
title: "How to use OpenTelemetry with .NET 11 and a free backend"
description: "Wire OpenTelemetry traces, metrics, and logs into a .NET 11 ASP.NET Core app with the OTLP exporter, then ship them to a free, self-hosted backend: the standalone Aspire Dashboard for local dev, Jaeger and SigNoz for self-hosted production, and the OpenTelemetry Collector when you need both."
pubDate: 2026-05-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "observability"
  - "opentelemetry"
---

To add OpenTelemetry to a .NET 11 ASP.NET Core app and ship the data to something free, install `OpenTelemetry.Extensions.Hosting` 1.15.3 and `OpenTelemetry.Exporter.OpenTelemetryProtocol` 1.15.3, register the SDK with `services.AddOpenTelemetry().WithTracing(...).WithMetrics(...).UseOtlpExporter()`, set `OTEL_EXPORTER_OTLP_ENDPOINT` to your collector or backend, and run the standalone Aspire Dashboard from the `mcr.microsoft.com/dotnet/aspire-dashboard` Docker image as your local viewer. Aspire Dashboard speaks OTLP/gRPC on `4317` and OTLP/HTTP on `4318`, costs nothing, and renders traces, structured logs, and metrics in one UI. For self-hosted production observability, swap the destination for Jaeger 2.x (traces only) or SigNoz 0.x (traces, metrics, logs) and put the OpenTelemetry Collector in front so you can fan out and filter. This guide is written against .NET 11 preview 3, C# 14, and OpenTelemetry .NET 1.15.3.

## Why OpenTelemetry instead of vendor SDKs

Every serious .NET observability product still ships a proprietary SDK: Application Insights, Datadog, New Relic, Dynatrace, Honeycomb's own client, you name it. They all do roughly the same thing -- attach to ASP.NET Core, HttpClient, and EF Core, batch some data, send it over their wire format. The problem starts the second you want to switch vendors, run two of them in parallel, or just see the data locally without paying anyone. Each rewrite is its own multi-week project, because the instrumentation calls are scattered across hundreds of files.

OpenTelemetry replaces that picture with a single, vendor-neutral SDK and a single wire format (OTLP). You instrument once. The exporter is a separate package, swappable at startup. You can pipe the same telemetry to Aspire Dashboard during local development, to Jaeger in staging, and to a paid backend in production -- all without touching application code. ASP.NET Core 11 even ships with native OpenTelemetry tracing primitives so the framework's own spans land in the same pipeline as your custom ones (see [the .NET 11 native OpenTelemetry tracing changes](/2026/04/aspnetcore-11-native-opentelemetry-tracing/) for what got upstreamed).

The version numbers worth pinning for 2026: `OpenTelemetry` 1.15.3, `OpenTelemetry.Extensions.Hosting` 1.15.3, `OpenTelemetry.Exporter.OpenTelemetryProtocol` 1.15.3, the ASP.NET Core instrumentation 1.15.0, and the HttpClient instrumentation 1.15.0. Aspire Dashboard ships out of `mcr.microsoft.com/dotnet/aspire-dashboard:9.5` at the time of writing.

## Run the free backend in 30 seconds

Before any code, get a backend running. The standalone Aspire Dashboard is the lowest-effort option for local development. It exposes an OTLP receiver, indexes traces, metrics, and logs in memory, and gives you a Blazor UI on port `18888`:

```bash
# Aspire Dashboard 9.5, default ports
docker run --rm \
  --name aspire-dashboard \
  -p 18888:18888 \
  -p 4317:18889 \
  -p 4318:18890 \
  -e DASHBOARD__OTLP__AUTHMODE=ApiKey \
  -e DASHBOARD__OTLP__PRIMARYAPIKEY=local-dev-key \
  mcr.microsoft.com/dotnet/aspire-dashboard:9.5
```

The container exposes `18889` for OTLP/gRPC and `18890` for OTLP/HTTP internally, and you map them to the standard `4317`/`4318` outside so any OpenTelemetry SDK with default settings finds them. Setting `DASHBOARD__OTLP__AUTHMODE=ApiKey` forces clients to attach the key in an `x-otlp-api-key` header, which matters the moment you bind the dashboard to a non-loopback address. Open `http://localhost:18888` and you will see empty Traces, Metrics, and Structured Logs tabs waiting for data. The dashboard keeps everything in process memory, so a restart wipes state -- this is a development tool, not a long-term store.

If you would rather run nothing locally, Jaeger 2.x has the same ergonomics for traces only:

```bash
# Jaeger 2.0 all-in-one
docker run --rm \
  --name jaeger \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  jaegertracing/jaeger:2.0.0
```

Jaeger 2.x is itself a thin wrapper around the OpenTelemetry Collector with a Cassandra/Elasticsearch/Badger storage backend, and it accepts OTLP natively. SigNoz, which adds metrics and logs on top of ClickHouse, is a Docker Compose installation rather than a one-liner; pull `https://github.com/SigNoz/signoz` and run `docker compose up`.

## Install the SDK and instrumentation packages

For an ASP.NET Core 11 minimal API, four packages get you the happy path. The aggregate `OpenTelemetry.Extensions.Hosting` pulls in the SDK; the OTLP exporter handles transport; and the two instrumentation packages cover the two surfaces every web app needs: incoming HTTP and outgoing HTTP.

```bash
# OpenTelemetry .NET 1.15.3, .NET 11
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.15.3
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.15.3
dotnet add package OpenTelemetry.Instrumentation.AspNetCore --version 1.15.0
dotnet add package OpenTelemetry.Instrumentation.Http --version 1.15.0
```

If you also use EF Core, add `OpenTelemetry.Instrumentation.EntityFrameworkCore` 1.15.0-beta.1. Note the `-beta.1` suffix: that line is still officially in preview but every team I have worked with treats it as stable. The instrumentation hooks into EF Core's diagnostic source and emits one span per `SaveChanges`, query, and DbCommand.

## Wire up traces, metrics, and logs in Program.cs

The SDK is a single registration. As of OpenTelemetry .NET 1.8, `UseOtlpExporter()` is the cross-cutting helper that registers the OTLP exporter for traces, metrics, and logs in one call, replacing the older per-pipeline `AddOtlpExporter()`:

```csharp
// .NET 11, C# 14, OpenTelemetry 1.15.3
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r
        .AddService(
            serviceName: "orders-api",
            serviceVersion: typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0",
            serviceInstanceId: Environment.MachineName))
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddSource("Orders.*"))
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddRuntimeInstrumentation()
        .AddMeter("Orders.*"))
    .WithLogging()
    .UseOtlpExporter();

var app = builder.Build();

app.MapGet("/orders/{id:int}", (int id) => new { id, status = "ok" });
app.Run();
```

Three things are worth highlighting. First, `ConfigureResource` is not optional in practice -- without `service.name`, every backend will lump everything under `unknown_service:dotnet`, which becomes unworkable the moment a second app shows up. Second, `AddSource("Orders.*")` is what surfaces your custom `ActivitySource` instances; if you instantiate one as `new ActivitySource("Orders.Checkout")`, it has to match a glob you registered or the spans go nowhere. Third, `WithLogging()` ties `Microsoft.Extensions.Logging` into the same pipeline so an `ILogger<T>` call writes structured OpenTelemetry log records with the current trace and span IDs attached. That is what makes the Aspire Dashboard's "View structured logs for this trace" link work.

## Configure the exporter from environment variables, not code

The default OTLP exporter reads its destination, protocol, and headers from environment variables defined by the OpenTelemetry specification. Hard-coding them inside `UseOtlpExporter(o => o.Endpoint = ...)` is a smell because it ties your binary to a specific backend. Use environment variables instead and the same image runs on a developer laptop, in CI, and in production with no rebuild:

```bash
# Talk to a local Aspire Dashboard over gRPC
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"
export OTEL_EXPORTER_OTLP_HEADERS="x-otlp-api-key=local-dev-key"
export OTEL_SERVICE_NAME="orders-api"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=dev"
```

Two values catch most people out. `OTEL_EXPORTER_OTLP_PROTOCOL` defaults to `grpc` on .NET 8+ but to `http/protobuf` on .NET Standard 2.0 builds, because the SDK ships with a custom gRPC client on modern targets but falls back to HTTP on Framework. If you are bridging both, set the value explicitly. And `OTEL_EXPORTER_OTLP_HEADERS` accepts a comma-separated list of `key=value` pairs. Backends that authenticate with bearer tokens use this for `Authorization=Bearer ...`. Aspire Dashboard's API key is `x-otlp-api-key`, not the more common `Authorization`.

When you migrate from local dev to a deployed backend, the only change is the endpoint and the auth header. The application binary stays the same.

## Add a custom span with ActivitySource

The instrumentation packages cover incoming and outgoing HTTP automatically, plus EF Core if you added that one. Everything else is on you. .NET ships `System.Diagnostics.ActivitySource` as the cross-runtime primitive for spans -- OpenTelemetry .NET adopts it directly rather than introducing its own type. Create one per logical area, register the prefix in `AddSource`, and call `StartActivity` where you want a span:

```csharp
// Orders/CheckoutService.cs -- .NET 11, C# 14
using System.Diagnostics;

public sealed class CheckoutService(IOrdersRepository orders, IPaymentClient payments)
{
    private static readonly ActivitySource Source = new("Orders.Checkout");

    public async Task<CheckoutResult> CheckoutAsync(int orderId, CancellationToken ct)
    {
        using var activity = Source.StartActivity("checkout", ActivityKind.Internal);
        activity?.SetTag("order.id", orderId);

        var order = await orders.GetAsync(orderId, ct);
        activity?.SetTag("order.line_count", order.Lines.Count);

        var receipt = await payments.ChargeAsync(order, ct);
        activity?.SetTag("payment.provider", receipt.Provider);

        return new CheckoutResult(receipt.Id);
    }
}
```

`StartActivity` returns `null` when no listener is attached -- so the `?.SetTag` calls are not defensive paranoia, they avoid a NullReferenceException on a build with OpenTelemetry disabled. Tags follow the OpenTelemetry semantic conventions where one exists (`http.request.method`, `db.system`, `messaging.destination.name`); for domain-specific values like `order.id`, namespace them with your own prefix to keep them queryable without colliding with the conventions.

The same pattern applies to metrics with `System.Diagnostics.Metrics.Meter`. Create one per area, register it with `AddMeter`, and use `Counter<T>`, `Histogram<T>`, or `ObservableGauge<T>` to record values.

## Correlate OTLP logs with traces

The reason to register `WithLogging()` and not just `WithTracing()` is correlation. Every `ILogger<T>` call inside an active span gets the span's `TraceId` and `SpanId` automatically attached as OTLP log record fields, and the Aspire Dashboard renders this as a clickable link from the trace view. The same correlation works in any OpenTelemetry-aware backend.

If you already use Serilog and do not want to give it up, you do not have to. The `Serilog.Sinks.OpenTelemetry` package writes Serilog events out as OTLP log records, and the OpenTelemetry SDK's logging provider can be skipped on `WithLogging()`. The structured logging post on this site has a longer treatment of [setting up Serilog with Seq in .NET 11](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) and the same trace correlation rules apply when you swap Seq for OTLP.

For raw `Microsoft.Extensions.Logging`, the recipe is shorter: add `WithLogging()` to the OpenTelemetry pipeline and turn off the default console provider in production. `LogInformation("Order {OrderId} for {CustomerId} took {Elapsed} ms", id, customer, ms)` is already structured, and OpenTelemetry serialises the named placeholders as OTLP log attributes. The console provider, by contrast, flattens them back into a single string -- which is exactly the regression you were trying to escape.

## Put the OpenTelemetry Collector in front for production

In production you very rarely want your application to talk to an observability backend directly. You want a Collector in between -- a stand-alone process that receives OTLP, applies sampling, scrubs PII, batches, retries, and fans the data out to one or many destinations. The Collector image is `otel/opentelemetry-collector-contrib:0.111.0`, and a minimal config that takes OTLP in and forwards to Jaeger plus a hosted backend looks like this:

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
    send_batch_size: 512
  attributes/scrub:
    actions:
      - key: http.request.header.authorization
        action: delete
      - key: user.email
        action: hash

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true
  otlp/honeycomb:
    endpoint: api.honeycomb.io:443
    headers:
      x-honeycomb-team: ${env:HONEYCOMB_API_KEY}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, attributes/scrub]
      exporters: [otlp/jaeger, otlp/honeycomb]
```

The application's `OTEL_EXPORTER_OTLP_ENDPOINT` now points at the Collector, not at any specific backend. Switching destinations is a config-and-restart on the Collector, not a redeploy of every service. The same pattern is what keeps your trace volume sane: drop the `attributes/scrub` processor in front of every exporter and you stop accidentally shipping authorization headers to a third party on day one.

## Gotchas the docs do not warn you about

Three things bite people on the way to a working pipeline.

First, **gRPC vs HTTP defaults disagree across runtimes**. On .NET 8 and later the SDK ships a managed gRPC client and defaults `OTEL_EXPORTER_OTLP_PROTOCOL` to `grpc`. On .NET Framework 4.8 and .NET Standard 2.0 the default is `http/protobuf` to avoid the `Grpc.Net.Client` dependency. If a single solution targets both, set the protocol explicitly or you will see different behaviour from the same code in two assemblies.

Second, **resource attributes are global, not per-pipeline**. `ConfigureResource` runs once, and the result is attached to every trace, metric, and log record from that process. Trying to set a per-request attribute via the resource API silently does nothing; what you want there is `Activity.SetTag` on the active span, or a `Baggage` entry that propagates across the call. The Aspire 13.2.4 baggage DoS CVE -- documented in [the OpenTelemetry .NET baggage CVE writeup](/2026/04/aspire-13-2-4-opentelemetry-cve-2026-40894-baggage-dos/) -- is a reminder that baggage is parsed eagerly on every request and is therefore a useful but sharp tool.

Third, **the OTLP exporter retries silently in the background**. When the backend is down the exporter keeps batching events into memory and retrying with exponential backoff up to a configurable cap. That is usually what you want; what is surprising is that the Collector or the dashboard coming back online does not flush instantaneously. If you are running an integration test and asserting "trace X arrived in Aspire Dashboard within 100 ms", give the exporter a `BatchExportProcessor` schedule shorter than the default 5 seconds, or call `TracerProvider.ForceFlush()` explicitly before the assertion.

## Where to go from here

OpenTelemetry's value compounds with the surface area you instrument. The starting point is ASP.NET Core plus HttpClient plus EF Core. From there, the high-leverage additions are background services (every `IHostedService` should start an `Activity` per work unit) and outbound message brokers (the `OpenTelemetry.Instrumentation.MassTransit` and Confluent.Kafka instrumentations cover most teams). For deeper work-unit profiling once the spans get you to the right minute, [the dotnet-trace guide on this site](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) walks through the tool that most often picks up where OpenTelemetry leaves off, and [the global exception filter post](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) covers the ASP.NET Core side of capturing failures cleanly into the same pipeline.

The end state worth aiming for is one pipeline, one wire format, and one place to look first when something is wrong. OpenTelemetry plus the Aspire Dashboard plus a Collector in front gets you there for the price of a Docker pull.

Sources:

- [OpenTelemetry .NET Exporters documentation](https://opentelemetry.io/docs/languages/dotnet/exporters/)
- [OTLP Exporter for OpenTelemetry .NET](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Exporter.OpenTelemetryProtocol/README.md)
- [Use OpenTelemetry with the standalone Aspire Dashboard - .NET](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-otlp-example)
- [.NET Observability with OpenTelemetry](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel)
- [OpenTelemetry.Exporter.OpenTelemetryProtocol on NuGet](https://www.nuget.org/packages/OpenTelemetry.Exporter.OpenTelemetryProtocol)
