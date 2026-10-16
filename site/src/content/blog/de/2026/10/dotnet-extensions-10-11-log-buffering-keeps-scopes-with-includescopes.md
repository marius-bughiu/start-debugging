---
title: ".NET Extensions 10.11: Gepufferte Logs behalten endlich ihre Scopes"
description: "Microsoft.Extensions.Telemetry 10.11.0, veröffentlicht am 2026-10-15, ergänzt globales und anfragebezogenes Log Buffering um eine experimentelle Option IncludeScopes, sodass OrderId und TenantId aus BeginScope ein Flush() überstehen, statt stillschweigend verloren zu gehen."
pubDate: 2026-10-16
tags:
  - "dotnet"
  - "logging"
  - "observability"
  - "aspnetcore"
  - "csharp"
lang: "de"
translationOf: "2026/10/dotnet-extensions-10-11-log-buffering-keeps-scopes-with-includescopes"
translatedBy: "claude"
translationDate: 2026-10-16
---

[.NET Extensions 10.11.0](https://github.com/dotnet/extensions/releases/tag/v10.11.0) ist am 2026-10-15 auf NuGet erschienen. Die meisten KI-Fixes sind klein, aber eine Telemetrie-Änderung schließt eine Lücke, die es gibt, seit Log Buffering eingeführt wurde: Gepufferte Log-Einträge verloren jeden Wert aus `ILogger.BeginScope`. Man pufferte `Information`-Logs, eine Exception trat auf, man rief `Flush()` auf, und die Einträge kamen ohne die `OrderId`, die `TenantId` oder die Request-ID heraus, die man in den Scope gelegt hatte. Genau der Kontext, den man zum Debuggen des Fehlers braucht.

## So sah ein Flush bisher aus

Log Buffering steckt in `Microsoft.Extensions.Telemetry` (globaler Puffer) und `Microsoft.AspNetCore.Diagnostics.Middleware` (Puffer pro Anfrage). Einträge, die zu einer Regel passen, landen in einem Ringpuffer und werden erst geschrieben, wenn `Flush()` aufgerufen wird. Hier ein minimales Repro mit dem JSON-Konsolenlogger, der Scopes normalerweise ausgibt, wenn `IncludeScopes` aktiv ist:

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

Ich habe es als dateibasierte App mit dem SDK 10.0.302 ausgeführt. Mit `Microsoft.Extensions.Telemetry` 10.10.0 (ohne die Zeile `IncludeScopes`, die dort nicht kompiliert) enthält der ausgegebene Eintrag keine Spur des Scopes, obwohl der Flush innerhalb des Scopes passiert:

```text
{"EventId":0,"LogLevel":"Information","Category":"Program","Message":"Reserving stock for SKU-42","Exception":"","State":{"Message":null,"Sku":"SKU-42","{OriginalFormat}":"Reserving stock for {Sku}"}}
```

Mit 10.11.0 und `IncludeScopes = true`:

```text
{"EventId":0,"LogLevel":"Information","Category":"Program","Message":"Reserving stock for SKU-42","Exception":"","State":{"Message":null,"Sku":"SKU-42","OrderId":"4711","TenantId":"contoso","{OriginalFormat}":"Reserving stock for {Sku}"}}
```

## Wie es funktioniert

[PR #7813](https://github.com/dotnet/extensions/pull/7813) erfasst die Scopes in dem Moment, in dem ein Eintrag gepuffert wird, nicht erst beim Flush. Das ist das gewünschte Verhalten: Wenn etwas `Flush()` aufruft, ist der ursprüngliche Scope meist längst beendet. Die Puffer erhalten einen `IExternalScopeProvider` aus der DI (gemeinsam mit `ExtendedLoggerFactory`) und kopieren die Name/Wert-Paare jedes Scopes in den Eintrag.

Einige Details sind wichtig:

- Scopes erscheinen als **Attribute**, nicht als Scopes. `IBufferedLogger`-Provider sehen sie in `BufferedLogRecord.Attributes`; andere Provider erhalten sie im State, der an `ILogger.Log` übergeben wird. Deshalb stehen sie oben in `State` und nicht in einem `Scopes`-Array.
- Erfasst werden nur Scopes, die `IEnumerable<KeyValuePair<string, object?>>` implementieren. Ein einfacher String-Scope wie `BeginScope("Checkout")` wird übersprungen, und `{OriginalFormat}`-Paare werden verworfen. Scopes aus `ActivityTrackingOptions` (Trace-ID, Span-ID) sind enthalten.
- Die Option ist standardmäßig aus, experimentell unter `EXTEXP0003` und aus der Konfiguration bindbar. Die Optionen werden bei jedem gepufferten Eintrag neu gelesen, ein Konfigurations-Reload wirkt also sofort.

Für das anfragebezogene Buffering in ASP.NET Core gibt es denselben Schalter in `PerRequestLogBufferingOptions`:

```csharp
builder.Logging.AddPerIncomingRequestBuffer(o =>
{
    o.Rules.Add(new LogBufferingFilterRule(logLevel: LogLevel.Information));
    o.IncludeScopes = true;
});
```

## Außerdem in 10.11.0

Das Release behebt eine `ArgumentNullException` im anfragebezogenen Buffering am Ende einer Anfrage (#7811) und eine Race Condition im Buffering, die durch einen Cache im Regel-Selektor entstand (#7803). Wer den experimentellen HTTP-Latenz-Enricher nutzt: `AddHttpLatencyTelemetry` heißt jetzt `AddHttpServerLatencyTelemetry` (#7730). Auf der KI-Seite wird `FunctionInvocationContext.Terminate` jetzt beachtet, wenn die Funktion eine Exception wirft (#7801), und `ChatResponseUpdate.Clone` behält das `ContinuationToken` (#7699). Das vorherige Release dieser Reihe war [Microsoft.Extensions.AI 10.10.1](/de/2026/09/microsoft-extensions-ai-10-10-1-fixes-openai-2-14-typeloadexception/).

Zum Aktualisieren:

```bash
dotnet add package Microsoft.Extensions.Telemetry --version 10.11.0
```

Wer Logs puffert und sie über Scope-Werte korreliert, sollte `IncludeScopes` einschalten. Ohne die Option fehlen den Logs, die beim Fehlerfall ausgegeben werden, genau die IDs, die man zum Korrelieren braucht.
