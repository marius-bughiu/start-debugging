---
title: ".NET Extensions 10.11: buffered logs can finally keep their scopes"
description: "Microsoft.Extensions.Telemetry 10.11.0, released October 15, 2026, adds an experimental IncludeScopes option to global and per-request log buffering, so OrderId and TenantId from BeginScope survive a Flush() instead of being silently dropped."
pubDate: 2026-10-16
tags:
  - "dotnet"
  - "logging"
  - "observability"
  - "aspnetcore"
  - "csharp"
---

[.NET Extensions 10.11.0](https://github.com/dotnet/extensions/releases/tag/v10.11.0) shipped to NuGet on October 15, 2026. Most of the AI fixes are small, but one telemetry change closes a gap that has been there since log buffering first appeared: buffered log records lost every `ILogger.BeginScope` value. You buffered `Information` logs, an exception fired, you called `Flush()`, and the records came out without the `OrderId`, `TenantId` or request ID you had pushed into scope. Exactly the context you wanted when debugging the failure.

## What a flush looked like before

Log buffering lives in `Microsoft.Extensions.Telemetry` (global buffer) and `Microsoft.AspNetCore.Diagnostics.Middleware` (per-request buffer). Records that match a rule are held in a circular buffer and only written when you call `Flush()`. Here is a minimal repro with the JSON console logger, which normally prints scopes when `IncludeScopes` is on:

```csharp
var builder = Host.CreateApplicationBuilder();
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(o => o.IncludeScopes = true);
builder.Logging.AddGlobalBuffer(o =>
{
    o.Rules.Add(new LogBufferingFilterRule(logLevel: LogLevel.Information));
    o.IncludeScopes = true; // new in 10.11.0, EXTEXP0003
});
using var host = builder.Build();
var logger = host.Services.GetRequiredService<ILogger<Program>>();
var buffer = host.Services.GetRequiredService<GlobalLogBuffer>();

using (logger.BeginScope(new Dictionary<string, object?> { ["OrderId"] = 4711, ["TenantId"] = "contoso" }))
{
    logger.LogInformation("Reserving stock for {Sku}", "SKU-42");
    buffer.Flush();
}
```

I ran it as a file-based app on SDK 10.0.302. Against `Microsoft.Extensions.Telemetry` 10.10.0 (without the `IncludeScopes` line, which does not compile there), the flushed record has no trace of the scope, even though the flush happens inside it:

```text
{"EventId":0,"LogLevel":"Information","Category":"Program","Message":"Reserving stock for SKU-42","Exception":"","State":{"Message":null,"Sku":"SKU-42","{OriginalFormat}":"Reserving stock for {Sku}"}}
```

On 10.11.0 with `IncludeScopes = true`:

```text
{"EventId":0,"LogLevel":"Information","Category":"Program","Message":"Reserving stock for SKU-42","Exception":"","State":{"Message":null,"Sku":"SKU-42","OrderId":"4711","TenantId":"contoso","{OriginalFormat}":"Reserving stock for {Sku}"}}
```

## How it works

[PR #7813](https://github.com/dotnet/extensions/pull/7813) captures the scopes at the moment a record is buffered, not at flush time, which is what you want: by the time something calls `Flush()` the original scope is usually long gone. The buffers get an `IExternalScopeProvider` from DI (shared with `ExtendedLoggerFactory`) and copy each scope's name/value pairs into the record.

A few details worth knowing:

- Scopes show up as **attributes**, not as scopes. `IBufferedLogger` providers see them in `BufferedLogRecord.Attributes`; other providers get them merged into the state passed to `ILogger.Log`. That is why they land in `State` above rather than in a `Scopes` array.
- Only scopes that implement `IEnumerable<KeyValuePair<string, object?>>` are captured. A plain string scope such as `BeginScope("Checkout")` is skipped, and `{OriginalFormat}` pairs are dropped. `ActivityTrackingOptions` scopes (trace ID, span ID) are included.
- It is off by default, experimental under `EXTEXP0003`, and bindable from configuration. The options are re-read on every buffered record, so a config reload takes effect immediately.

For ASP.NET Core per-request buffering, the same switch exists on `PerRequestLogBufferingOptions`:

```csharp
builder.Logging.AddPerIncomingRequestBuffer(o =>
{
    o.Rules.Add(new LogBufferingFilterRule(logLevel: LogLevel.Information));
    o.IncludeScopes = true;
});
```

## Also in 10.11.0

The release fixes an `ArgumentNullException` in per-request buffering at the end of a request (#7811) and a buffering race caused by a rule-selector cache (#7803). If you use the experimental HTTP latency enricher, `AddHttpLatencyTelemetry` is now `AddHttpServerLatencyTelemetry` (#7730). On the AI side, `FunctionInvocationContext.Terminate` is now honored when the function throws (#7801), and `ChatResponseUpdate.Clone` keeps `ContinuationToken` (#7699). The previous release in this series was [Microsoft.Extensions.AI 10.10.1](/2026/09/microsoft-extensions-ai-10-10-1-fixes-openai-2-14-typeloadexception/).

To upgrade:

```bash
dotnet add package Microsoft.Extensions.Telemetry --version 10.11.0
```

If you buffer logs and correlate them by scope values, turn `IncludeScopes` on. Without it, the logs you flush when something fails are missing the IDs you need to correlate them.
