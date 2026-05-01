---
title: "How to set up structured logging with Serilog and Seq in .NET 11"
description: "A complete guide to wiring Serilog 4.x and Seq 2025.2 into a .NET 11 ASP.NET Core app: AddSerilog vs UseSerilog, two-stage bootstrap logging, JSON configuration, enrichers, request logging, OpenTelemetry trace correlation, API keys, and the production gotchas around buffering, retention, and signal level."
pubDate: 2026-05-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "logging"
  - "serilog"
  - "seq"
---

To ship structured logs from a .NET 11 ASP.NET Core app to Seq, install `Serilog.AspNetCore` 10.0.0 and `Serilog.Sinks.Seq` 9.0.0, register the pipeline with `services.AddSerilog((sp, lc) => lc.ReadFrom.Configuration(...).WriteTo.Seq("http://localhost:5341"))`, and switch the host's request logger on with `app.UseSerilogRequestLogging()`. Configure everything from `appsettings.json` so production can change the minimum level without a redeploy. Run Seq locally as the `datalust/seq` Docker image with `ACCEPT_EULA=Y` and a port mapping, and point the sink at `http://localhost:5341`. This guide is written against .NET 11 preview 3 and C# 14, but every snippet works on .NET 8, 9, and 10 too.

## Why Serilog plus Seq instead of "just `ILogger`"

`Microsoft.Extensions.Logging` is fine for hello-world demos and unit tests. It is not enough for production. `ILogger<T>.LogInformation("Order {OrderId} for {CustomerId} took {Elapsed} ms", id, customer, ms)` is structured at the call site, but the default console provider flattens those properties into a single string and throws the structure away. The moment something goes wrong in production you are back to grepping a tarball.

Serilog keeps the structure. Each call serialises the named placeholders as JSON properties and forwards them to whatever sink you configure. Seq is the receiving end: a self-hosted log server that indexes those properties so you can write `select count(*) from stream where StatusCode >= 500 and Endpoint = '/api/orders' group by time(1m)` and get an answer in milliseconds. The combination has been a default choice in the .NET space for a decade because both pieces are written by people who actually use them.

The version numbers worth remembering for 2026 are Serilog 4.3.1, Serilog.AspNetCore 10.0.0, Serilog.Sinks.Seq 9.0.0, and Seq 2025.2. The major numbers track Microsoft.Extensions.Logging, so on .NET 11 you stay on the 10.x line of `Serilog.AspNetCore` and the 9.x line of `Serilog.Sinks.Seq` until Microsoft cuts a new major.

## Run Seq locally in 30 seconds

Before any code, get a Seq instance running. The Docker one-liner is what most teams use, including in CI:

```bash
# Seq 2025.2, default ports
docker run \
  --name seq \
  -d \
  --restart unless-stopped \
  -e ACCEPT_EULA=Y \
  -p 5341:80 \
  -p 5342:443 \
  -v seq-data:/data \
  datalust/seq:2025.2
```

`5341` is the HTTP ingestion and UI port, `5342` is HTTPS. The `seq-data` named volume keeps your events across container restarts. On Windows the alternative is the MSI installer from datalust.co; it ships the same engine and the same port defaults. The free tier is unlimited single-user; team licensing kicks in once you add authenticated accounts. Open `http://localhost:5341` in a browser, click "Settings", "API Keys", and create a key. You will use it for both ingestion auth and any read-only dashboards you wire up later.

## Install the packages

Three packages are enough for the happy path:

```bash
dotnet add package Serilog.AspNetCore --version 10.0.0
dotnet add package Serilog.Sinks.Seq --version 9.0.0
dotnet add package Serilog.Settings.Configuration --version 9.0.0
```

`Serilog.AspNetCore` pulls in `Serilog`, `Serilog.Extensions.Hosting`, and the console sink. `Serilog.Sinks.Seq` is the HTTP sink that batches events to Seq's ingestion endpoint. `Serilog.Settings.Configuration` is the bridge that lets you describe the entire pipeline in `appsettings.json`, which is how you actually want to run this in production.

## The minimal Program.cs

Here is the smallest viable wiring for a .NET 11 minimal API. It uses the `AddSerilog` API that became the only supported entry point after Serilog.AspNetCore 8.0.0 removed the obsolete `IWebHostBuilder.UseSerilog()` extension.

```csharp
// .NET 11 preview 3, C# 14
// Serilog 4.3.1, Serilog.AspNetCore 10.0.0, Serilog.Sinks.Seq 9.0.0
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSerilog((services, lc) => lc
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services)
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .WriteTo.Seq("http://localhost:5341"));

var app = builder.Build();

app.UseSerilogRequestLogging();

app.MapGet("/api/orders/{id:int}", (int id, ILogger<Program> log) =>
{
    log.LogInformation("Fetching order {OrderId}", id);
    return Results.Ok(new { id, total = 99.95m });
});

app.Run();
```

Five lines do real work. `ReadFrom.Configuration` loads minimum levels and overrides from `appsettings.json`. `ReadFrom.Services` lets sinks resolve scoped dependencies, which matters once you start writing custom enrichers. `Enrich.FromLogContext` is what lets you push a `using (LogContext.PushProperty("CorrelationId", id))` block in middleware and have every log line inside that scope tagged automatically. `WriteTo.Console` keeps the local development experience fast. `WriteTo.Seq` is the actual sink.

`UseSerilogRequestLogging` replaces the default ASP.NET Core request logging middleware with a single, structured event per request. Instead of three or four lines per request you get one line with `RequestPath`, `StatusCode`, `Elapsed`, and any properties you push via the `EnrichDiagnosticContext` callback. Less noise, more signal.

## Move the configuration into appsettings.json

Hardcoding `http://localhost:5341` is fine for a demo and wrong for production. Move the whole pipeline description into `appsettings.json` so you can change verbosity without redeploying:

```json
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Sinks.Seq" ],
    "MinimumLevel": {
      "Default": "Information",
      "Override": {
        "Microsoft.AspNetCore": "Warning",
        "Microsoft.EntityFrameworkCore.Database.Command": "Warning",
        "System.Net.Http.HttpClient": "Warning"
      }
    },
    "Enrich": [ "FromLogContext", "WithMachineName", "WithThreadId" ],
    "WriteTo": [
      { "Name": "Console" },
      {
        "Name": "Seq",
        "Args": {
          "serverUrl": "http://localhost:5341",
          "apiKey": "REPLACE_WITH_API_KEY"
        }
      }
    ],
    "Properties": {
      "Application": "Orders.Api"
    }
  }
}
```

A few details that matter. The `Using` array is what `Serilog.Settings.Configuration` 9.x uses to load sink assemblies; without it the JSON parser does not know which assembly contains `WriteTo.Seq`. The `Override` map is the single most underrated feature in Serilog: it lets you keep the global level at `Information` while pinning EF Core's command logger to `Warning` so you do not drown in SQL on a busy server. Add `WithMachineName` and `WithThreadId` only if you install `Serilog.Enrichers.Environment` and `Serilog.Enrichers.Thread`; remove them otherwise or the configuration will fail at startup with a quiet "method not found" error.

The `Application` property is the key to using one Seq instance for many services. Push every app's name through `Properties` and you get a free filter in the Seq UI: `Application = 'Orders.Api'`.

## Bootstrap logging: catch the crash before logging starts

Configuration-driven logging has one weakness. If `appsettings.json` is malformed, the host explodes before the configured sinks are alive, and you get nothing. The official pattern, and what `Serilog.AspNetCore` documents, is the two-stage bootstrap: install a minimal logger before the host is built, then replace it once the configuration has loaded.

```csharp
// .NET 11 preview 3, C# 14
using Serilog;

Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .WriteTo.Console()
    .WriteTo.Seq("http://localhost:5341")
    .CreateBootstrapLogger();

try
{
    var builder = WebApplication.CreateBuilder(args);

    builder.Services.AddSerilog((services, lc) => lc
        .ReadFrom.Configuration(builder.Configuration)
        .ReadFrom.Services(services)
        .Enrich.FromLogContext()
        .WriteTo.Console()
        .WriteTo.Seq("http://localhost:5341"));

    var app = builder.Build();

    app.UseSerilogRequestLogging();
    app.MapGet("/", () => "ok");

    app.Run();
}
catch (Exception ex) when (ex is not HostAbortedException)
{
    Log.Fatal(ex, "Host terminated unexpectedly");
    throw;
}
finally
{
    Log.CloseAndFlush();
}
```

`CreateBootstrapLogger` returns a logger that is both usable now and replaceable later, so the same `Log.Logger` static keeps working after `AddSerilog` swaps the implementation. `Log.CloseAndFlush()` in the `finally` block is what makes sure the in-memory batch in `Serilog.Sinks.Seq` actually drains before the process exits. Skip it and you will lose the last few seconds of logs on a clean shutdown, which is exactly the window where the interesting events live.

## Request logging that is actually useful

`UseSerilogRequestLogging` writes one event per request at `Information` for 2xx and 3xx, `Warning` for 4xx, and `Error` for 5xx. The defaults are reasonable. To make it production-grade, override the message template and enrich each event with the user identity and trace id:

```csharp
// .NET 11 preview 3, C# 14
app.UseSerilogRequestLogging(options =>
{
    options.MessageTemplate =
        "HTTP {RequestMethod} {RequestPath} responded {StatusCode} in {Elapsed:0} ms";

    options.EnrichDiagnosticContext = (diagnosticContext, httpContext) =>
    {
        diagnosticContext.Set("UserId", httpContext.User?.FindFirst("sub")?.Value);
        diagnosticContext.Set("ClientIp", httpContext.Connection.RemoteIpAddress?.ToString());
        diagnosticContext.Set("TraceId", System.Diagnostics.Activity.Current?.TraceId.ToString());
    };
});
```

The `TraceId` line is the single most valuable enricher you can add. Combined with the trace id collection that landed in Serilog 3.1, every log event your code writes inside a request will carry the same `TraceId` as the request itself. In Seq you can click any event and pivot to "show all events with this TraceId" to get the full call chain in one query.

## Plug in OpenTelemetry trace correlation

If you also export traces via OpenTelemetry, do not add a separate logging exporter. Serilog already understands `Activity.Current` and writes `TraceId` and `SpanId` automatically when present. The native OpenTelemetry tracing in ASP.NET Core 11 means that traces start at the inbound request and propagate through `HttpClient`, EF Core, and any other instrumented library. Serilog picks up the same `Activity` context, so every log event ends up correlated to the trace without any extra wiring on the logging side. Read [the .NET 11 native OpenTelemetry tracing pipeline](/2026/04/aspnetcore-11-native-opentelemetry-tracing/) for the trace-side configuration.

To send those traces to Seq instead of a separate backend, install `Serilog.Sinks.Seq` plus the OTLP support that ships with Seq 2025.2 and point the OpenTelemetry exporter at `http://localhost:5341/ingest/otlp/v1/traces`. Seq will display traces and logs in the same UI, joined by `TraceId`.

## Levels, sampling, and "we are getting paged for nothing"

The default `Information` level on a busy API will produce hundreds of events per second. Two knobs control the volume.

The first is the `MinimumLevel.Override` map shown above. Push noisy framework logs to `Warning` and you cut the firehose by an order of magnitude without losing your own application logs. Always override `Microsoft.AspNetCore` to `Warning` once you switch on `UseSerilogRequestLogging`, otherwise you get the per-request line twice: once from the framework, once from Serilog.

The second is sampling. Serilog has no built-in sampler, but you can wrap the Seq sink in a `Filter.ByExcluding` predicate to drop low-value events before they leave the process:

```csharp
// .NET 11, C# 14: drop /health probe noise
.Filter.ByExcluding(le =>
    le.Properties.TryGetValue("RequestPath", out var p) &&
    p is ScalarValue { Value: string path } &&
    path.StartsWith("/health", StringComparison.OrdinalIgnoreCase))
```

For high-volume traffic a better answer is to keep `Information` for the request log and bump everything else to `Warning`, then use Seq's "signal" feature to mark the small slice you actually want to alert on.

## Production gotchas

A handful of issues catch every team that ships Serilog plus Seq for the first time.

**Sink batching hides outages.** `Serilog.Sinks.Seq` buffers events for up to 2 seconds or 1000 events before flushing. If Seq is unreachable, the sink retries with exponential backoff, but the buffer is bounded. On a sustained Seq outage you will silently drop events. Production deployments should set `bufferBaseFilename` so the sink spills to disk first and replays once Seq comes back:

```json
{
  "Name": "Seq",
  "Args": {
    "serverUrl": "https://seq.internal",
    "apiKey": "...",
    "bufferBaseFilename": "/var/log/myapp/seq-buffer"
  }
}
```

**Synchronous calls into the Seq sink are not free.** Even though the sink is async, the call to `LogInformation` does work on the calling thread to render the message template and push to the channel. On a hot path this shows up in profiles. Use `Async` ([`Serilog.Sinks.Async`](https://github.com/serilog/serilog-sinks-async)) to wrap the Seq sink in a dedicated background thread so the request thread returns instantly.

**API keys in `appsettings.json` are a leak waiting to happen.** Move them into user secrets in development and into your secret store (Key Vault, AWS Secrets Manager) in production. Serilog reads any configuration provider the host registers, so the only thing you change is where the value comes from.

**Seq retention is not infinite.** The default `seq-data` Docker volume grows until the disk fills and Seq starts dropping ingestion. Configure retention policies in Seq's UI under "Settings", "Data". A common starting point is 30 days for `Information`, 90 days for `Warning` and above.

**`UseSerilogRequestLogging` must come before `UseEndpoints` and after `UseRouting`.** If you place it earlier it will not see the matched endpoint, and `RequestPath` will contain the raw URL instead of the route template, which makes Seq dashboards much less useful.

## Where this fits in your stack

Serilog plus Seq is the logging leg of a three-leg observability stack: logs (Serilog/Seq), traces (OpenTelemetry), and exceptions ([global exception handlers](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)). When something is wrong on a production API, you start in Seq, find the failing request, copy the `TraceId`, and pivot to either the trace view or the source code that threw. That round-trip is the whole point. If you cannot do it in under a minute, your logging is not earning its keep.

If you are tracking down a specific slowdown rather than a runtime error, follow up with [a `dotnet-trace` profiling loop](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) instead. Seq is excellent for "what happened", `dotnet-trace` is the right tool for "why is this slow". And if the answer ends up being "we serialise too much per request", the [custom JsonConverter guide](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) covers the System.Text.Json side.

Source links:

- [Serilog.AspNetCore release notes](https://github.com/serilog/serilog-aspnetcore/releases)
- [Serilog.Sinks.Seq on NuGet](https://www.nuget.org/packages/Serilog.Sinks.Seq/)
- [Seq documentation](https://docs.datalust.co/docs)
- [Datalust seq-extensions-logging](https://github.com/datalust/seq-extensions-logging)
