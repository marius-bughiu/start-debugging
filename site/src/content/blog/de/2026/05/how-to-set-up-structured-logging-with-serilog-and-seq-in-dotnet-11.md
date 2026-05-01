---
title: "Strukturierte Protokollierung mit Serilog und Seq in .NET 11 einrichten"
description: "Eine vollständige Anleitung, um Serilog 4.x und Seq 2025.2 in eine .NET 11 ASP.NET Core App einzubinden: AddSerilog vs. UseSerilog, zweistufige Bootstrap-Protokollierung, JSON-Konfiguration, Enricher, Request Logging, OpenTelemetry-Trace-Korrelation, API-Schlüssel und die Produktionsfallstricke rund um Buffering, Aufbewahrung und Signalebene."
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
lang: "de"
translationOf: "2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-01
---

Um strukturierte Logs aus einer .NET 11 ASP.NET Core App an Seq zu senden, installieren Sie `Serilog.AspNetCore` 10.0.0 und `Serilog.Sinks.Seq` 9.0.0, registrieren die Pipeline mit `services.AddSerilog((sp, lc) => lc.ReadFrom.Configuration(...).WriteTo.Seq("http://localhost:5341"))` und schalten den Request Logger des Hosts mit `app.UseSerilogRequestLogging()` ein. Konfigurieren Sie alles über `appsettings.json`, damit die Produktion das Mindestlevel ohne Redeployment ändern kann. Betreiben Sie Seq lokal als `datalust/seq` Docker-Image mit `ACCEPT_EULA=Y` und einem Port-Mapping und richten Sie den Sink auf `http://localhost:5341`. Diese Anleitung ist gegen .NET 11 preview 3 und C# 14 geschrieben, aber jeder Snippet funktioniert auch auf .NET 8, 9 und 10.

## Warum Serilog plus Seq statt nur `ILogger`

`Microsoft.Extensions.Logging` reicht für Hello-World-Demos und Unit Tests. Für die Produktion reicht es nicht. `ILogger<T>.LogInformation("Order {OrderId} for {CustomerId} took {Elapsed} ms", id, customer, ms)` ist an der Aufrufstelle strukturiert, aber der Standard-Console-Provider plättet diese Eigenschaften zu einem einzigen String und wirft die Struktur weg. Sobald in der Produktion etwas schiefgeht, durchsuchen Sie wieder einen Tarball mit grep.

Serilog erhält die Struktur. Jeder Aufruf serialisiert die benannten Platzhalter als JSON-Eigenschaften und leitet sie an den konfigurierten Sink weiter. Seq ist die Empfangsseite: ein selbst gehosteter Log-Server, der diese Eigenschaften indiziert, sodass Sie `select count(*) from stream where StatusCode >= 500 and Endpoint = '/api/orders' group by time(1m)` schreiben und in Millisekunden eine Antwort erhalten. Die Kombination ist seit einem Jahrzehnt eine Standardwahl im .NET-Umfeld, weil beide Teile von Leuten geschrieben werden, die sie auch tatsächlich nutzen.

Die für 2026 wichtigen Versionen sind Serilog 4.3.1, Serilog.AspNetCore 10.0.0, Serilog.Sinks.Seq 9.0.0 und Seq 2025.2. Die Major-Nummern folgen Microsoft.Extensions.Logging, also bleiben Sie auf .NET 11 auf der 10.x-Linie von `Serilog.AspNetCore` und der 9.x-Linie von `Serilog.Sinks.Seq`, bis Microsoft eine neue Major-Version freigibt.

## Seq lokal in 30 Sekunden starten

Bevor irgendein Code geschrieben wird, bringen Sie eine Seq-Instanz zum Laufen. Der Docker-Einzeiler ist das, was die meisten Teams verwenden, auch in CI:

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

`5341` ist der HTTP-Ingestion- und UI-Port, `5342` ist HTTPS. Das benannte Volume `seq-data` erhält Ihre Ereignisse über Container-Neustarts hinweg. Auf Windows ist die Alternative der MSI-Installer von datalust.co; er liefert dieselbe Engine und dieselben Port-Standards. Die kostenlose Stufe ist unbegrenzt für einen einzelnen Nutzer; die Team-Lizenzierung greift, sobald Sie authentifizierte Konten hinzufügen. Öffnen Sie `http://localhost:5341` im Browser, klicken Sie auf "Settings", "API Keys" und erstellen Sie einen Schlüssel. Sie verwenden ihn sowohl für die Ingestion-Authentifizierung als auch für jegliche schreibgeschützten Dashboards, die Sie später einbinden.

## Pakete installieren

Drei Pakete reichen für den Happy Path:

```bash
dotnet add package Serilog.AspNetCore --version 10.0.0
dotnet add package Serilog.Sinks.Seq --version 9.0.0
dotnet add package Serilog.Settings.Configuration --version 9.0.0
```

`Serilog.AspNetCore` zieht `Serilog`, `Serilog.Extensions.Hosting` und den Console-Sink mit. `Serilog.Sinks.Seq` ist der HTTP-Sink, der Ereignisse an Seqs Ingestion-Endpunkt batcht. `Serilog.Settings.Configuration` ist die Brücke, mit der Sie die gesamte Pipeline in `appsettings.json` beschreiben können, was die Art ist, wie Sie das in der Produktion tatsächlich betreiben wollen.

## Das minimale Program.cs

Hier ist die kleinste funktionsfähige Verdrahtung für eine .NET 11 Minimal API. Sie verwendet die `AddSerilog`-API, die nach Serilog.AspNetCore 8.0.0 zum einzigen unterstützten Einstiegspunkt wurde, nachdem die veraltete `IWebHostBuilder.UseSerilog()`-Erweiterung entfernt wurde.

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

Fünf Zeilen leisten echte Arbeit. `ReadFrom.Configuration` lädt Mindestlevel und Overrides aus `appsettings.json`. `ReadFrom.Services` lässt Sinks Scoped-Abhängigkeiten auflösen, was relevant wird, sobald Sie eigene Enricher schreiben. `Enrich.FromLogContext` ist das, was es Ihnen erlaubt, in einer Middleware einen `using (LogContext.PushProperty("CorrelationId", id))`-Block zu pushen und automatisch jede Log-Zeile innerhalb dieses Scopes mit der Eigenschaft zu versehen. `WriteTo.Console` hält die lokale Entwicklungserfahrung schnell. `WriteTo.Seq` ist der eigentliche Sink.

`UseSerilogRequestLogging` ersetzt die Standard-Request-Logging-Middleware von ASP.NET Core durch ein einzelnes, strukturiertes Ereignis pro Anfrage. Statt drei oder vier Zeilen pro Anfrage erhalten Sie eine Zeile mit `RequestPath`, `StatusCode`, `Elapsed` und allen Eigenschaften, die Sie über den `EnrichDiagnosticContext`-Callback pushen. Weniger Rauschen, mehr Signal.

## Konfiguration in appsettings.json verschieben

Hardcoding von `http://localhost:5341` ist für eine Demo in Ordnung und für die Produktion falsch. Verschieben Sie die gesamte Pipeline-Beschreibung in `appsettings.json`, damit Sie die Verbosität ohne Redeployment ändern können:

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

Ein paar Details, die wichtig sind. Das `Using`-Array ist das, was `Serilog.Settings.Configuration` 9.x zum Laden der Sink-Assemblies verwendet; ohne es weiß der JSON-Parser nicht, welche Assembly `WriteTo.Seq` enthält. Die `Override`-Map ist die am meisten unterschätzte Funktion in Serilog: Sie können das globale Level auf `Information` halten und gleichzeitig den Command Logger von EF Core auf `Warning` festlegen, damit Sie auf einem ausgelasteten Server nicht in SQL ertrinken. Fügen Sie `WithMachineName` und `WithThreadId` nur hinzu, wenn Sie `Serilog.Enrichers.Environment` und `Serilog.Enrichers.Thread` installieren; entfernen Sie sie sonst, sonst schlägt die Konfiguration beim Start mit einem leisen "method not found"-Fehler fehl.

Die Eigenschaft `Application` ist der Schlüssel, um eine Seq-Instanz für viele Services zu nutzen. Schieben Sie den Namen jeder App über `Properties` durch und Sie erhalten einen kostenlosen Filter in der Seq-UI: `Application = 'Orders.Api'`.

## Bootstrap-Protokollierung: den Crash vor dem Logging-Start abfangen

Konfigurationsgesteuertes Logging hat eine Schwäche. Wenn `appsettings.json` fehlerhaft ist, explodiert der Host, bevor die konfigurierten Sinks aktiv sind, und Sie bekommen nichts. Das offizielle Muster, und was `Serilog.AspNetCore` dokumentiert, ist der zweistufige Bootstrap: einen minimalen Logger installieren, bevor der Host gebaut wird, und ihn dann ersetzen, sobald die Konfiguration geladen ist.

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

`CreateBootstrapLogger` gibt einen Logger zurück, der sowohl jetzt nutzbar als auch später ersetzbar ist, sodass dasselbe statische `Log.Logger` weiter funktioniert, nachdem `AddSerilog` die Implementierung austauscht. `Log.CloseAndFlush()` im `finally`-Block sorgt dafür, dass der In-Memory-Batch in `Serilog.Sinks.Seq` tatsächlich geleert wird, bevor der Prozess endet. Lassen Sie es weg, und Sie verlieren bei einem sauberen Shutdown die letzten paar Sekunden an Logs, also genau das Zeitfenster, in dem die interessanten Ereignisse leben.

## Request Logging, das tatsächlich nützlich ist

`UseSerilogRequestLogging` schreibt ein Ereignis pro Anfrage auf `Information` für 2xx und 3xx, `Warning` für 4xx und `Error` für 5xx. Die Standardwerte sind vernünftig. Um es produktionstauglich zu machen, überschreiben Sie das Message-Template und reichern jedes Ereignis mit der Benutzeridentität und der Trace-ID an:

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

Die Zeile mit `TraceId` ist der wertvollste Enricher, den Sie hinzufügen können. In Kombination mit der Trace-ID-Erfassung, die in Serilog 3.1 gelandet ist, trägt jedes Log-Ereignis, das Ihr Code innerhalb einer Anfrage schreibt, dieselbe `TraceId` wie die Anfrage selbst. In Seq können Sie auf jedes Ereignis klicken und zu "alle Ereignisse mit dieser TraceId anzeigen" pivotieren, um die vollständige Aufrufkette in einer Abfrage zu erhalten.

## OpenTelemetry-Trace-Korrelation einbinden

Wenn Sie auch Traces über OpenTelemetry exportieren, fügen Sie keinen separaten Logging-Exporter hinzu. Serilog versteht bereits `Activity.Current` und schreibt `TraceId` und `SpanId` automatisch, wenn vorhanden. Das native OpenTelemetry-Tracing in ASP.NET Core 11 bedeutet, dass Traces an der eingehenden Anfrage beginnen und sich durch `HttpClient`, EF Core und jede andere instrumentierte Bibliothek fortpflanzen. Serilog übernimmt denselben `Activity`-Kontext, sodass jedes Log-Ereignis mit dem Trace korreliert wird, ohne zusätzliche Verdrahtung auf der Logging-Seite. Lesen Sie [die native OpenTelemetry-Tracing-Pipeline in .NET 11](/de/2026/04/aspnetcore-11-native-opentelemetry-tracing/) für die Trace-seitige Konfiguration.

Um diese Traces an Seq statt an ein separates Backend zu senden, installieren Sie `Serilog.Sinks.Seq` plus die OTLP-Unterstützung, die mit Seq 2025.2 ausgeliefert wird, und richten Sie den OpenTelemetry-Exporter auf `http://localhost:5341/ingest/otlp/v1/traces`. Seq zeigt Traces und Logs in derselben UI an, verbunden über `TraceId`.

## Levels, Sampling und "wir werden für nichts gepaged"

Das Standardlevel `Information` auf einer ausgelasteten API erzeugt Hunderte von Ereignissen pro Sekunde. Zwei Stellschrauben steuern das Volumen.

Die erste ist die oben gezeigte `MinimumLevel.Override`-Map. Schieben Sie laute Framework-Logs auf `Warning` und Sie reduzieren den Wasserfall um eine Größenordnung, ohne Ihre eigenen Anwendungslogs zu verlieren. Überschreiben Sie immer `Microsoft.AspNetCore` auf `Warning`, sobald Sie `UseSerilogRequestLogging` einschalten, sonst bekommen Sie die Zeile pro Anfrage zweimal: einmal vom Framework, einmal von Serilog.

Die zweite ist Sampling. Serilog hat keinen eingebauten Sampler, aber Sie können den Seq-Sink mit einem `Filter.ByExcluding`-Prädikat umschließen, um Ereignisse mit geringem Wert zu verwerfen, bevor sie den Prozess verlassen:

```csharp
// .NET 11, C# 14: drop /health probe noise
.Filter.ByExcluding(le =>
    le.Properties.TryGetValue("RequestPath", out var p) &&
    p is ScalarValue { Value: string path } &&
    path.StartsWith("/health", StringComparison.OrdinalIgnoreCase))
```

Bei hohem Verkehrsaufkommen ist eine bessere Antwort, `Information` für das Request-Log zu behalten und alles andere auf `Warning` zu erhöhen, und dann Seqs "Signal"-Funktion zu verwenden, um den kleinen Ausschnitt zu markieren, auf den Sie tatsächlich alarmieren wollen.

## Fallstricke in der Produktion

Eine Handvoll Probleme erwischen jedes Team, das Serilog plus Seq zum ersten Mal ausliefert.

**Sink-Batching verbirgt Ausfälle.** `Serilog.Sinks.Seq` puffert Ereignisse bis zu 2 Sekunden oder 1000 Ereignisse vor dem Flush. Wenn Seq nicht erreichbar ist, versucht der Sink es mit exponentiellem Backoff erneut, aber der Puffer ist begrenzt. Bei einem anhaltenden Seq-Ausfall werden Ereignisse stillschweigend verworfen. Produktionsdeployments sollten `bufferBaseFilename` setzen, damit der Sink zuerst auf die Festplatte spillt und sie wieder einspielt, sobald Seq zurück ist:

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

**Synchrone Aufrufe in den Seq-Sink sind nicht kostenlos.** Auch wenn der Sink asynchron ist, leistet der Aufruf von `LogInformation` Arbeit auf dem aufrufenden Thread, um das Message-Template zu rendern und in den Channel zu pushen. Auf einem Hot Path taucht das in Profilen auf. Verwenden Sie `Async` ([`Serilog.Sinks.Async`](https://github.com/serilog/serilog-sinks-async)), um den Seq-Sink in einen dedizierten Hintergrund-Thread zu wickeln, damit der Request-Thread sofort zurückkehrt.

**API-Schlüssel in `appsettings.json` sind ein Leck, das nur darauf wartet zu passieren.** Verschieben Sie sie in der Entwicklung in User Secrets und in der Produktion in Ihren Secret Store (Key Vault, AWS Secrets Manager). Serilog liest jeden Konfigurationsanbieter, den der Host registriert, also ändern Sie nur, woher der Wert kommt.

**Die Aufbewahrung in Seq ist nicht unendlich.** Das Standard-Docker-Volume `seq-data` wächst, bis die Festplatte vollläuft und Seq beginnt, Ingestion zu verwerfen. Konfigurieren Sie Aufbewahrungsrichtlinien in der Seq-UI unter "Settings", "Data". Ein üblicher Ausgangspunkt ist 30 Tage für `Information`, 90 Tage für `Warning` und höher.

**`UseSerilogRequestLogging` muss vor `UseEndpoints` und nach `UseRouting` kommen.** Wenn Sie es früher platzieren, sieht es nicht den gematchten Endpunkt, und `RequestPath` enthält die rohe URL statt des Route-Templates, was Seq-Dashboards deutlich weniger nützlich macht.

## Wo das in Ihren Stack passt

Serilog plus Seq ist das Logging-Bein eines dreibeinigen Observability-Stacks: Logs (Serilog/Seq), Traces (OpenTelemetry) und Exceptions ([globale Exception Handler](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)). Wenn auf einer Produktions-API etwas nicht stimmt, beginnen Sie in Seq, finden die fehlschlagende Anfrage, kopieren die `TraceId` und pivotieren entweder zur Trace-Ansicht oder zum Quellcode, der geworfen hat. Dieser Round-Trip ist der ganze Sinn. Wenn Sie das nicht in unter einer Minute schaffen, verdient Ihr Logging seinen Unterhalt nicht.

Wenn Sie eine bestimmte Verlangsamung statt eines Laufzeitfehlers aufspüren, gehen Sie stattdessen mit [einer `dotnet-trace`-Profiling-Schleife](/de/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) weiter. Seq ist ausgezeichnet für "was passiert ist", `dotnet-trace` ist das richtige Werkzeug für "warum ist das langsam". Und wenn die Antwort am Ende "wir serialisieren zu viel pro Anfrage" lautet, deckt der [Leitfaden zu eigenen JsonConvertern](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) die System.Text.Json-Seite ab.

Quell-Links:

- [Serilog.AspNetCore release notes](https://github.com/serilog/serilog-aspnetcore/releases)
- [Serilog.Sinks.Seq on NuGet](https://www.nuget.org/packages/Serilog.Sinks.Seq/)
- [Seq documentation](https://docs.datalust.co/docs)
- [Datalust seq-extensions-logging](https://github.com/datalust/seq-extensions-logging)
