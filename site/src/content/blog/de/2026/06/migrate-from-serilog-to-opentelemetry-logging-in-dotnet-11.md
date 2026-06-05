---
title: "Von Serilog zu OpenTelemetry-Logging in .NET 11 migrieren"
description: "Eine Schritt-für-Schritt-Anleitung, um eine .NET-11-App von Serilog auf OpenTelemetry-Logging umzustellen: die risikoarme Serilog.Sinks.OpenTelemetry-Brücke, der vollständige Umstieg auf Microsoft.Extensions.Logging, was bricht, wie Sie verifizieren und wie Sie zurückrollen."
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
lang: "de"
translationOf: "2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-05
---

Wenn Ihr Team sich für Traces und Metriken auf OpenTelemetry standardisiert hat, ist das Logging meist der Ausreißer, das immer noch über Serilog und einen Datei- oder Seq-Sink läuft. Diese Anleitung stellt eine .NET-11-App (OpenTelemetry .NET SDK 1.15.x, Serilog 4.x) von diesem geteilten Setup auf OpenTelemetry-Logging um. Es gibt zwei Wege: eine Brücke an einem Abend, die Serilog behält und nur den Sink austauscht, und einen vollständigen Umstieg auf `Microsoft.Extensions.Logging`, der Serilog komplett entfernt. Die Brücke ist in einem einzigen Commit umkehrbar und bricht fast nichts. Die vollständige Migration dauert auf einer echten Codebasis ein bis zwei Tage, betrifft jedes `BeginScope` und jedes Message-Template und lohnt sich nur, wenn das Entfernen der Serilog-Abhängigkeit und die Vereinheitlichung auf eine Logging-API ein tatsächliches Ziel sind und nicht nur ein Nice-to-have.

## Warum Logging überhaupt auf OpenTelemetry umstellen

- **Eine Pipeline für drei Signale.** Traces, Metriken und Logs verlassen den Prozess über denselben OTLP-Exporter und landen im selben Backend, korreliert über `TraceId` und `SpanId`. Kein separater Seq-Endpunkt, der neben Ihrem Trace-Backend betrieben werden muss.
- **Anbieterneutrales Wire-Format.** OTLP ist ein stabiles Protokoll. Sie können dieselbe App lokal auf das Aspire Dashboard, auf selbst gehostetes Jaeger oder SigNoz oder auf ein kommerzielles Backend ausrichten, indem Sie einen Endpunkt ändern, nicht indem Sie ein Sink-Paket austauschen.
- **Automatische Trace-Korrelation.** Logs, die innerhalb einer aktiven `Activity` ausgegeben werden, tragen die Trace- und Span-IDs ohne Enricher, sodass "zeige mir jede Log-Zeile für diese Anfrage" über Services hinweg funktioniert.
- **Weniger bewegliche Teile in CI und Produktion.** Das Wegfallen des Serilog-Bootstraps und der Sink-Konfiguration eliminiert eine Klasse von "Logs sind still stehen geblieben"-Vorfällen, die durch Sink-Pufferung und Flush-on-Shutdown-Bugs verursacht werden.

Wenn Sie OpenTelemetry-Traces noch nicht verdrahtet haben, tun Sie das zuerst: [OpenTelemetry mit .NET 11 und einem kostenlosen Backend verwenden](/de/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) deckt das Exporter- und Backend-Setup ab, das diese Anleitung als bereits vorhanden voraussetzt.

## Was bricht

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| Sink-Konfiguration | Datei-/Konsolen-/Seq-Sinks ersetzt durch den OTLP-Exporter oder `Serilog.Sinks.OpenTelemetry` | hoch (vollständig) / niedrig (Brücke) |
| `Log.Logger`-Static + `CreateBootstrapLogger()` | In der vollständigen Migration entfernt; kein zweistufiges Startup-Logging | hoch (nur vollständig) |
| `LogContext.PushProperty`-Enricher | Ersetzt durch `ILogger.BeginScope` plus `IncludeScopes = true` | mittel (nur vollständig) |
| Destrukturierungsoperator `{@Order}` | Kein Äquivalent in `Microsoft.Extensions.Logging`; skalare Felder loggen oder explizit serialisieren | mittel (nur vollständig) |
| `UseSerilogRequestLogging()` | Ersetzt durch ASP.NET Core OTel-Instrumentierung oder `AddHttpLogging` | mittel (nur vollständig) |
| `MinimumLevel`-Konfigurationsblock | Wandert in den Abschnitt `Logging:LogLevel` in `appsettings.json` | niedrig (nur vollständig) |
| Severity-Namen | Serilog `Verbose` wird auf OTel `Trace` abgebildet; `Information` bleibt | niedrig |

Die Spalte "Brücke" ist entscheidend: Wenn Sie Weg A wählen, gilt nur die erste Zeile und der Schweregrad ist niedrig. Alles andere betrifft die vollständige Migration.

## Pre-Flight-Checkliste

- **.NET 11 SDK installiert.** Bestätigen Sie mit `dotnet --version` (erwartet wird `11.0.x`).
- **OpenTelemetry-Traces exportieren bereits über OTLP.** Diese Anleitung verwendet diesen Exporter und diese Ressource wieder.
- **Ein Backend, das OTLP-Logs aufnimmt.** Das Aspire Dashboard, SigNoz und Seq akzeptieren alle OTLP/HTTP. Seq stellt einen OTLP-Ingestion-Endpunkt unter `/ingest/otlp/v1/logs` bereit, sodass Sie Seq auch nach dem Wegfall des Serilog-Seq-Sinks als Ziel behalten können.
- **Eine grüne Testsuite und ein sauberer Arbeitsbaum**, bevor Sie beginnen, damit `git diff` nur Migrationsänderungen zeigt.
- **Kennen Sie Ihren OTLP-Endpunkt und Ihr Protokoll.** Standard-gRPC ist `http://localhost:4317`; Standard-HTTP/protobuf ist `http://localhost:4318`. Der HTTP-Exporter hängt `/v1/logs` an den Basis-Endpunkt an.

## Migrationsschritte

### 1. Die Paketversionen festpinnen

Entscheiden Sie sich für den Weg und installieren Sie dann die passenden Pakete. Beide Wege zielen auf dieselbe SDK-Linie.

```xml
<!-- .NET 11, both routes -->
<!-- Route A (bridge): keep Serilog, swap the sink -->
<PackageReference Include="Serilog.AspNetCore" Version="9.0.0" />
<PackageReference Include="Serilog.Sinks.OpenTelemetry" Version="4.2.0" />

<!-- Route B (full): Microsoft.Extensions.Logging + OpenTelemetry -->
<PackageReference Include="OpenTelemetry.Extensions.Hosting" Version="1.15.3" />
<PackageReference Include="OpenTelemetry.Exporter.OpenTelemetryProtocol" Version="1.15.3" />
```

Verifizieren: `dotnet restore` läuft erfolgreich durch und `dotnet build` ist sauber, bevor Sie Code ändern.

### 2a. Weg A -- den Serilog-Sink gegen OTLP austauschen

Das ist der risikoarme Pfad. Behalten Sie jeden Enricher, jedes Message-Template und jeden `LogContext`-Aufruf, den Sie bereits haben. Ersetzen Sie nur die Sink-Konfiguration.

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

Der Sink liest `Activity.Current` und injiziert `TraceId` und `SpanId` automatisch in jeden Log-Datensatz (`IncludedData.TraceIdField` und `SpanIdField` sind standardmäßig aktiv), sodass die signalübergreifende Korrelation ohne zusätzlichen Enricher funktioniert. Ihre `_logger.LogInformation("Placed order {OrderId}", id)`-Templates fließen unverändert durch.

Verifizieren: Starten Sie die App, setzen Sie eine Anfrage ab und bestätigen Sie, dass die Log-Zeile in Ihrem OTLP-Backend mit derselben `TraceId` wie der Trace der Anfrage erscheint.

### 2b. Weg B -- auf Microsoft.Extensions.Logging umstellen

Entfernen Sie `UseSerilog()` / `AddSerilog()` und den `Log.Logger`-Bootstrap aus `Program.cs`. Verdrahten Sie stattdessen OpenTelemetry in den eingebauten Logging-Builder.

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

Wenn Ihre App bereits `builder.Services.AddOpenTelemetry()` für Traces und Metriken aufruft, bevorzugen Sie die vereinheitlichte Form, damit alle drei Signale eine Ressource und einen Exporter teilen:

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

`UseOtlpExporter()` (hinzugefügt in SDK 1.8) registriert den OTLP-Exporter für jedes Signal auf einmal, sodass Sie den Endpunkt nicht dreimal wiederholen.

Verifizieren: `dotnet run`, dann bestätigen Sie, dass eine `ILogger`-Zeile mit dem korrekten `service.name` und einem befüllten Body das Backend erreicht.

### 3. Enricher in Scopes übersetzen (nur Weg B)

Serilogs `LogContext.PushProperty("UserId", id)` hat kein Äquivalent in `Microsoft.Extensions.Logging`. Verwenden Sie `ILogger.BeginScope`, und die Eigenschaften fließen in den OTLP-Datensatz, weil Sie `IncludeScopes = true` gesetzt haben.

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

Verifizieren: Der ausgegebene Log-Datensatz trägt `UserId` als Attribut. Wenn es fehlt, haben Sie `IncludeScopes = true` vergessen.

### 4. Request-Logging ersetzen (nur Weg B)

`app.UseSerilogRequestLogging()` produzierte eine zusammengefasste Log-Zeile pro Anfrage. Mit OpenTelemetry gibt die ASP.NET Core-Instrumentierung bereits einen HTTP-Server-Span pro Anfrage aus, was das bessere Primitiv für "was ist in dieser Anfrage passiert" ist. Wenn Sie dennoch eine Log-Zeile möchten, fügen Sie HTTP-Logging hinzu:

```csharp
// .NET 11
builder.Services.AddHttpLogging(o => { });
// ...
app.UseHttpLogging();
```

Verifizieren: Jede Anfrage produziert einen HTTP-Server-Span (und einen optionalen HTTP-Log-Eintrag), korreliert über `TraceId`.

### 5. Level-Konfiguration nach appsettings verschieben

Serilogs `MinimumLevel`-Block wird durch den standardmäßigen Abschnitt `Logging:LogLevel` ersetzt, den der OpenTelemetry-Provider wie jeder andere respektiert.

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

Verifizieren: Setzen Sie eine Kategorie auf `Warning` und bestätigen Sie, dass deren `Information`-Zeilen nicht mehr im Backend erscheinen.

## Verifizierungs-Checkliste

Führen Sie diese nach beiden Wegen aus, bevor Sie die alten Pakete löschen:

- `dotnet build` ist sauber, ohne unerwartete `Serilog`-Warnungen.
- `dotnet test` läuft ohne Fehler durch.
- Eine Anfrage produziert Log-Datensätze im Backend mit einem nicht leeren Body (`IncludeFormattedMessage` funktioniert).
- Diese Datensätze teilen sich die `TraceId` der Anfrage (Korrelation funktioniert).
- Strukturierte Eigenschaften (`OrderId`, Scope-Werte) erscheinen als Attribute, nicht eingebacken in den Message-String (`ParseStateValues` und `IncludeScopes` funktionieren).
- Das Log-Volumen im Backend entspricht den Erwartungen; kein Level-Filter verwirft oder flutet still.
- Shutdown flusht: Stoppen Sie die App mitten in einer Anfrage und bestätigen Sie, dass die letzten Zeilen noch ankommen (der Batch-Prozessor flusht beim Dispose).

## Rollback-Plan

**Weg A ist in einem Commit umkehrbar.** Setzen Sie den `WriteTo.OpenTelemetry(...)`-Block auf Ihre alte `WriteTo.Seq(...)` / `WriteTo.File(...)`-Konfiguration zurück und entfernen Sie das `Serilog.Sinks.OpenTelemetry`-Paket. Nichts anderes hat sich geändert, also gibt es keine Risikofläche.

**Weg B ist umkehrbar, aber nicht trivial.** Behalten Sie die Serilog-Pakete installiert und den alten `Program.cs`-Bootstrap in Ihrer Git-Historie, bis die neue Pipeline einen Release-Zyklus lang in Produktion gelaufen ist. Falls Sie zurückrollen müssen, stellen Sie `UseSerilog()`, den `Log.Logger`-Bootstrap wieder her und konvertieren Sie die `BeginScope`-Aufrufe zurück zu `LogContext.PushProperty`. Da der Umstieg Scopes und Request-Logging quer durch die Codebasis betrifft, behandeln Sie das Zurückrollen als eigene kleine Migration, nicht als einzeiligen Schalter. Löschen Sie die Serilog-Pakete erst aus der `.csproj`, wenn die Verifizierung in Produktion bestanden ist.

## Stolpersteine, die wir trafen

**Leere Log-Bodies im Backend.** Wenn `IncludeFormattedMessage` auf seinem Standardwert `false` belassen wird, geht der OTLP-Datensatz mit strukturierten Attributen, aber ohne gerenderte Nachricht raus, und manche Backends zeigen eine leere Zeile. Schalten Sie es ein. Kombinieren Sie es mit `ParseStateValues = true`, damit die benannten Platzhalter (`{OrderId}`) ebenfalls als Attribute landen statt nur innerhalb des formatierten Strings.

**Scope-Eigenschaften verschwinden.** `IncludeScopes` ist standardmäßig `false`. Jeder `BeginScope`-Wert, und alles, was ASP.NET Core in den Request-Scope legt, wird verworfen, bis Sie es aktivieren. Das ist die mit Abstand häufigste "meine Migration hat die Hälfte meines Log-Kontexts verloren"-Meldung.

**Keine `{@Object}`-Destrukturierung.** Serilogs `_logger.LogInformation("Got {@Order}", order)` serialisierte das gesamte Objekt. `Microsoft.Extensions.Logging` behandelt `@` als wörtlichen Text. Loggen Sie die skalaren Felder, die Sie tatsächlich abfragen, oder serialisieren Sie explizit mit `System.Text.Json`. Das Dumpen ganzer Objekte sprengt außerdem die Attribut-Kardinalität, die manche Backends abrechnen.

**Verlust des zweistufigen Bootstrap-Loggings.** Serilogs `CreateBootstrapLogger()` erfasste Fehler, die vor dem Bauen des Hosts auftreten. Der OpenTelemetry-Provider existiert erst nach `builder.Build()`, sodass sehr frühe Startup-Ausnahmen nur an die Konsole gehen. Wenn Observability beim frühen Start wichtig ist, behalten Sie einen minimalen Konsolen-Logger für dieses Zeitfenster.

**Überraschungen beim Severity-Mapping.** Serilog `Verbose` wird zu OTel `Trace`, und `Fatal` wird zu `Critical`. Wenn Sie nachgelagert nach Severity-Namen filtern oder alarmieren, aktualisieren Sie diese Regeln. `Debug`, `Information`, `Warning` und `Error` werden eins zu eins abgebildet.

Wenn Sie das Logging ohnehin straffen, lohnt es sich, neu zu betrachten, wie Sie strukturierte Daten überhaupt ausgeben; [strukturiertes Logging mit Serilog und Seq in .NET 11 einrichten](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) deckt die Message-Template-Muster ab, die sauber auf `ILogger` übertragen werden, und [ASP.NET Core 11s natives OpenTelemetry-Tracing](/de/2026/04/aspnetcore-11-native-opentelemetry-tracing/) erklärt, warum Sie möglicherweise keine zusätzlichen Instrumentierungspakete brauchen, sobald Sie auf der vereinheitlichten Pipeline sind. Für Hintergrundjobs und gehostete Services zeigt [Hintergrundjobs ohne Hangfire überwachen](/de/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) dieselbe Korrelation außerhalb des Anfragepfads in Aktion, und das [Aspire 13.2.4 OpenTelemetry-Baggage-Advisory](/de/2026/04/aspire-13-2-4-opentelemetry-cve-2026-40894-baggage-dos/) ist eine Erinnerung, die OTel-Pakete gepatcht zu halten.

Wählen Sie die Brücke, es sei denn, das Entfernen von Serilog ist ein echtes Ziel. Sie liefert Ihnen OTLP-Logs und Trace-Korrelation noch heute Abend, und Sie können den vollständigen Umstieg später vornehmen, wenn Sie einen ruhigen Sprint haben, um Scopes und Request-Logging ordentlich zu übersetzen.

## Quellen

- [OpenTelemetry .NET logs documentation](https://opentelemetry.io/docs/languages/dotnet/logs/)
- [Serilog.Sinks.OpenTelemetry on GitHub](https://github.com/serilog/serilog-sinks-opentelemetry)
- [OTLP Exporter for OpenTelemetry .NET](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Exporter.OpenTelemetryProtocol/README.md)
- [.NET observability with OpenTelemetry (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel)
- [OpenTelemetry.Exporter.OpenTelemetryProtocol on NuGet](https://www.nuget.org/packages/OpenTelemetry.Exporter.OpenTelemetryProtocol)
