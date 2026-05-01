---
title: "Wie Sie OpenTelemetry mit .NET 11 und einem kostenlosen Backend verwenden"
description: "Verbinden Sie OpenTelemetry-Traces, -Metriken und -Logs in einer ASP.NET Core .NET 11-Anwendung mit dem OTLP-Exporter und schicken Sie die Daten an ein kostenloses, selbst gehostetes Backend: das standalone Aspire Dashboard für die lokale Entwicklung, Jaeger und SigNoz für selbst gehostete Produktion und den OpenTelemetry Collector, wenn Sie beides brauchen."
pubDate: 2026-05-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "observability"
  - "opentelemetry"
lang: "de"
translationOf: "2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend"
translatedBy: "claude"
translationDate: 2026-05-01
---

Um OpenTelemetry zu einer .NET 11 ASP.NET Core-Anwendung hinzuzufügen und die Daten an etwas Kostenloses zu schicken, installieren Sie `OpenTelemetry.Extensions.Hosting` 1.15.3 und `OpenTelemetry.Exporter.OpenTelemetryProtocol` 1.15.3, registrieren das SDK mit `services.AddOpenTelemetry().WithTracing(...).WithMetrics(...).UseOtlpExporter()`, setzen `OTEL_EXPORTER_OTLP_ENDPOINT` auf Ihren Collector oder Backend, und führen das standalone Aspire Dashboard aus dem Docker-Image `mcr.microsoft.com/dotnet/aspire-dashboard` als lokalen Viewer aus. Aspire Dashboard spricht OTLP/gRPC auf `4317` und OTLP/HTTP auf `4318`, kostet nichts und rendert Traces, strukturierte Logs und Metriken in einer einzigen Oberfläche. Für selbst gehostete Observability in der Produktion tauschen Sie das Ziel gegen Jaeger 2.x (nur Traces) oder SigNoz 0.x (Traces, Metriken, Logs) und stellen den OpenTelemetry Collector davor, damit Sie verteilen und filtern können. Diese Anleitung wurde gegen .NET 11 Preview 3, C# 14 und OpenTelemetry .NET 1.15.3 geschrieben.

## Warum OpenTelemetry statt Anbieter-SDKs

Jedes ernsthafte .NET-Observability-Produkt liefert immer noch ein proprietäres SDK aus: Application Insights, Datadog, New Relic, Dynatrace, der eigene Client von Honeycomb, und so weiter. Sie machen alle ungefähr das Gleiche: Sie hängen sich an ASP.NET Core, HttpClient und EF Core an, batchen Daten und schicken sie über ihr eigenes Wire-Format. Das Problem beginnt in dem Moment, in dem Sie den Anbieter wechseln, zwei parallel betreiben oder die Daten einfach lokal sehen wollen, ohne jemandem etwas zu zahlen. Jede Umstellung ist ein eigenes Projekt von mehreren Wochen, weil die Instrumentierungs-Aufrufe über Hunderte von Dateien verteilt sind.

OpenTelemetry ersetzt dieses Bild durch ein einziges, anbieterneutrales SDK und ein einziges Wire-Format (OTLP). Sie instrumentieren einmal. Der Exporter ist ein separates Paket, beim Start austauschbar. Sie können dieselbe Telemetrie an Aspire Dashboard während der lokalen Entwicklung, an Jaeger im Staging und an ein kostenpflichtiges Backend in der Produktion leiten -- alles ohne den Anwendungscode anzufassen. ASP.NET Core 11 liefert sogar native OpenTelemetry-Tracing-Primitiven, sodass die Spans des Frameworks selbst in derselben Pipeline landen wie Ihre eigenen (siehe [die nativen OpenTelemetry-Tracing-Änderungen in .NET 11](/de/2026/04/aspnetcore-11-native-opentelemetry-tracing/) für die Details, was hochgezogen wurde).

Die Versionsnummern, die für 2026 gemerkt werden sollten: `OpenTelemetry` 1.15.3, `OpenTelemetry.Extensions.Hosting` 1.15.3, `OpenTelemetry.Exporter.OpenTelemetryProtocol` 1.15.3, die ASP.NET Core-Instrumentierung 1.15.0 und die HttpClient-Instrumentierung 1.15.0. Aspire Dashboard kommt aus `mcr.microsoft.com/dotnet/aspire-dashboard:9.5` zum Zeitpunkt dieses Schreibens.

## Bringen Sie das kostenlose Backend in 30 Sekunden zum Laufen

Vor jedem Code: Bringen Sie ein Backend zum Laufen. Das standalone Aspire Dashboard ist die aufwandsärmste Option für die lokale Entwicklung. Es stellt einen OTLP-Empfänger bereit, indiziert Traces, Metriken und Logs im Speicher und liefert eine Blazor-Oberfläche auf Port `18888`:

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

Der Container stellt intern `18889` für OTLP/gRPC und `18890` für OTLP/HTTP bereit, und Sie mappen diese außen auf die Standardports `4317`/`4318`, damit jedes OpenTelemetry-SDK mit den Standardeinstellungen sie findet. Das Setzen von `DASHBOARD__OTLP__AUTHMODE=ApiKey` zwingt Clients dazu, den Schlüssel in einem `x-otlp-api-key`-Header anzuhängen, was relevant wird, sobald Sie das Dashboard an eine Adresse außerhalb von Loopback binden. Öffnen Sie `http://localhost:18888` und Sie sehen leere Tabs für Traces, Metrics und Structured Logs, die auf Daten warten. Das Dashboard hält alles im Prozessspeicher, ein Neustart löscht den Zustand also: dies ist ein Entwicklungswerkzeug, kein Langzeitspeicher.

Wenn Sie lieber gar nichts lokal laufen lassen, hat Jaeger 2.x dieselbe Ergonomie nur für Traces:

```bash
# Jaeger 2.0 all-in-one
docker run --rm \
  --name jaeger \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  jaegertracing/jaeger:2.0.0
```

Jaeger 2.x ist selbst ein dünner Wrapper um den OpenTelemetry Collector mit einem Cassandra/Elasticsearch/Badger-Storage-Backend und akzeptiert OTLP nativ. SigNoz, das Metriken und Logs auf ClickHouse oben drauf legt, ist eine Docker-Compose-Installation statt einem Einzeiler; ziehen Sie `https://github.com/SigNoz/signoz` und führen Sie `docker compose up` aus.

## SDK und Instrumentierungspakete installieren

Für eine ASP.NET Core 11 Minimal API reichen vier Pakete für den Happy Path. Das Aggregat `OpenTelemetry.Extensions.Hosting` zieht das SDK mit; der OTLP-Exporter kümmert sich um den Transport; und die zwei Instrumentierungspakete decken die zwei Oberflächen ab, die jede Webanwendung braucht: eingehendes HTTP und ausgehendes HTTP.

```bash
# OpenTelemetry .NET 1.15.3, .NET 11
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.15.3
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.15.3
dotnet add package OpenTelemetry.Instrumentation.AspNetCore --version 1.15.0
dotnet add package OpenTelemetry.Instrumentation.Http --version 1.15.0
```

Wenn Sie zusätzlich EF Core verwenden, fügen Sie `OpenTelemetry.Instrumentation.EntityFrameworkCore` 1.15.0-beta.1 hinzu. Beachten Sie das Suffix `-beta.1`: diese Linie ist offiziell noch in der Vorschau, aber jedes Team, mit dem ich gearbeitet habe, behandelt sie als stabil. Die Instrumentierung hängt sich an die Diagnostic Source von EF Core und emittiert einen Span pro `SaveChanges`, Query und DbCommand.

## Traces, Metriken und Logs in Program.cs verdrahten

Das SDK ist eine einzige Registrierung. Seit OpenTelemetry .NET 1.8 ist `UseOtlpExporter()` der pipelineübergreifende Helper, der den OTLP-Exporter für Traces, Metriken und Logs in einem Aufruf registriert und das ältere pipeline-spezifische `AddOtlpExporter()` ersetzt:

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

Drei Dinge sind hervorzuheben. Erstens, `ConfigureResource` ist in der Praxis nicht optional: ohne `service.name` wirft jedes Backend alles unter `unknown_service:dotnet` zusammen, was unhandhabbar wird, sobald eine zweite Anwendung auftaucht. Zweitens, `AddSource("Orders.*")` legt Ihre eigenen `ActivitySource`-Instanzen offen; wenn Sie eine als `new ActivitySource("Orders.Checkout")` instanziieren, muss sie zu einem registrierten Glob passen, sonst gehen die Spans nirgendwohin. Drittens, `WithLogging()` bindet `Microsoft.Extensions.Logging` an dieselbe Pipeline an, sodass ein `ILogger<T>`-Aufruf strukturierte OpenTelemetry-Log-Records mit der aktuellen Trace-ID und Span-ID schreibt. Genau das lässt den Link "View structured logs for this trace" im Aspire Dashboard funktionieren.

## Den Exporter aus Umgebungsvariablen konfigurieren, nicht aus Code

Der Standard-OTLP-Exporter liest sein Ziel, sein Protokoll und seine Header aus Umgebungsvariablen, die in der OpenTelemetry-Spezifikation definiert sind. Diese Werte fest in `UseOtlpExporter(o => o.Endpoint = ...)` zu codieren ist ein Code Smell, weil es Ihr Binary an ein bestimmtes Backend bindet. Verwenden Sie stattdessen Umgebungsvariablen, und dasselbe Image läuft auf einem Entwickler-Laptop, in CI und in der Produktion ohne Rebuild:

```bash
# Talk to a local Aspire Dashboard over gRPC
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"
export OTEL_EXPORTER_OTLP_HEADERS="x-otlp-api-key=local-dev-key"
export OTEL_SERVICE_NAME="orders-api"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=dev"
```

Zwei Werte erwischen die meisten Leute. `OTEL_EXPORTER_OTLP_PROTOCOL` ist auf .NET 8+ standardmäßig `grpc`, auf .NET Standard 2.0-Builds aber `http/protobuf`, weil das SDK auf modernen Targets einen eigenen gRPC-Client mitbringt, auf Framework aber auf HTTP zurückfällt. Wenn Sie zwischen beiden brücken, setzen Sie den Wert explizit. Und `OTEL_EXPORTER_OTLP_HEADERS` akzeptiert eine kommaseparierte Liste von `Schlüssel=Wert`-Paaren. Backends, die mit Bearer-Tokens authentifizieren, verwenden das für `Authorization=Bearer ...`. Der API-Schlüssel des Aspire Dashboards ist `x-otlp-api-key`, nicht das gewohntere `Authorization`.

Bei der Migration von lokaler Entwicklung zu einem deployten Backend ändert sich nur der Endpoint und der Auth-Header. Das Anwendungs-Binary bleibt gleich.

## Einen eigenen Span mit ActivitySource hinzufügen

Die Instrumentierungspakete decken eingehendes und ausgehendes HTTP automatisch ab, plus EF Core, falls Sie das hinzugefügt haben. Alles andere liegt bei Ihnen. .NET liefert `System.Diagnostics.ActivitySource` als Cross-Runtime-Primitive für Spans -- OpenTelemetry .NET übernimmt diesen Typ direkt, statt einen eigenen einzuführen. Erstellen Sie eine pro logischem Bereich, registrieren Sie das Präfix in `AddSource`, und rufen Sie `StartActivity` dort auf, wo Sie einen Span wollen:

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

`StartActivity` gibt `null` zurück, wenn kein Listener angehängt ist -- die `?.SetTag`-Aufrufe sind also keine defensive Paranoia, sondern verhindern eine NullReferenceException in einem Build mit deaktiviertem OpenTelemetry. Tags folgen den semantischen Konventionen von OpenTelemetry, wo eine existiert (`http.request.method`, `db.system`, `messaging.destination.name`); bei domänenspezifischen Werten wie `order.id` versehen Sie diese mit Ihrem eigenen Präfix, damit sie abfragbar bleiben, ohne mit den Konventionen zu kollidieren.

Dasselbe Muster gilt für Metriken mit `System.Diagnostics.Metrics.Meter`. Erstellen Sie eine pro Bereich, registrieren Sie sie mit `AddMeter` und verwenden Sie `Counter<T>`, `Histogram<T>` oder `ObservableGauge<T>`, um Werte aufzuzeichnen.

## OTLP-Logs mit Traces korrelieren

Der Grund, `WithLogging()` und nicht nur `WithTracing()` zu registrieren, ist Korrelation. Jeder `ILogger<T>`-Aufruf innerhalb eines aktiven Spans bekommt automatisch die `TraceId` und `SpanId` des Spans als OTLP-Log-Record-Felder angehängt, und das Aspire Dashboard rendert das als anklickbaren Link aus der Trace-Ansicht. Dieselbe Korrelation funktioniert in jedem OpenTelemetry-fähigen Backend.

Wenn Sie bereits Serilog verwenden und es nicht aufgeben wollen, müssen Sie das nicht. Das Paket `Serilog.Sinks.OpenTelemetry` schreibt Serilog-Events als OTLP-Log-Records hinaus, und der Logging-Provider des OpenTelemetry-SDKs kann in `WithLogging()` weggelassen werden. Der Beitrag zum strukturierten Logging auf dieser Site behandelt ausführlich [das Aufsetzen von Serilog mit Seq in .NET 11](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) und dieselben Trace-Korrelationsregeln gelten, wenn Sie Seq durch OTLP ersetzen.

Für reines `Microsoft.Extensions.Logging` ist das Rezept kürzer: fügen Sie `WithLogging()` zur OpenTelemetry-Pipeline hinzu und schalten Sie den Standard-Konsolen-Provider in der Produktion aus. `LogInformation("Order {OrderId} for {CustomerId} took {Elapsed} ms", id, customer, ms)` ist bereits strukturiert, und OpenTelemetry serialisiert die benannten Platzhalter als OTLP-Log-Attribute. Der Konsolen-Provider hingegen flacht sie zurück in einen einzigen String -- genau die Regression, der Sie eigentlich entkommen wollten.

## Den OpenTelemetry Collector in der Produktion davorschalten

In der Produktion wollen Sie sehr selten, dass Ihre Anwendung direkt mit einem Observability-Backend spricht. Sie wollen einen Collector dazwischen -- einen eigenständigen Prozess, der OTLP empfängt, Sampling anwendet, PII bereinigt, batched, Retries macht und die Daten an ein oder viele Ziele verteilt. Das Collector-Image ist `otel/opentelemetry-collector-contrib:0.111.0`, und eine minimale Konfiguration, die OTLP entgegennimmt und an Jaeger plus ein gehostetes Backend weiterleitet, sieht so aus:

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

Der `OTEL_EXPORTER_OTLP_ENDPOINT` der Anwendung zeigt jetzt auf den Collector, nicht auf ein bestimmtes Backend. Ziele zu wechseln ist eine Konfigurationsänderung mit Neustart auf dem Collector, kein Redeploy jedes Service. Dasselbe Muster hält Ihr Trace-Volumen handhabbar: stellen Sie den `attributes/scrub`-Processor vor jeden Exporter, und Sie hören vom ersten Tag an auf, versehentlich Authorization-Header an Dritte zu schicken.

## Stolperfallen, vor denen die Doku nicht warnt

Drei Dinge erwischen Leute auf dem Weg zu einer funktionierenden Pipeline.

Erstens: **gRPC- und HTTP-Defaults stimmen zwischen Runtimes nicht überein**. Auf .NET 8 und höher bringt das SDK einen managed gRPC-Client mit und `OTEL_EXPORTER_OTLP_PROTOCOL` ist standardmäßig `grpc`. Auf .NET Framework 4.8 und .NET Standard 2.0 ist der Default `http/protobuf`, um die `Grpc.Net.Client`-Abhängigkeit zu vermeiden. Wenn eine einzelne Lösung beide Targets abdeckt, setzen Sie das Protokoll explizit, sonst sehen Sie unterschiedliches Verhalten desselben Codes aus zwei Assemblies.

Zweitens: **Resource-Attribute sind global, nicht pro Pipeline**. `ConfigureResource` läuft einmal, und das Ergebnis wird an jeden Trace, jede Metrik und jeden Log-Record dieses Prozesses angehängt. Der Versuch, ein Attribut pro Anfrage über die Resource-API zu setzen, macht stillschweigend nichts; was Sie dort wollen, ist `Activity.SetTag` auf dem aktiven Span oder ein `Baggage`-Eintrag, der über den Aufruf propagiert. Die Aspire 13.2.4 Baggage-DoS-CVE, dokumentiert in [der Analyse der OpenTelemetry .NET Baggage-CVE](/de/2026/04/aspire-13-2-4-opentelemetry-cve-2026-40894-baggage-dos/), erinnert daran, dass Baggage in jeder Anfrage eifrig geparst wird und damit ein nützliches, aber scharfes Werkzeug ist.

Drittens: **der OTLP-Exporter wiederholt Versuche im Hintergrund stillschweigend**. Wenn das Backend down ist, batched der Exporter weiter Events im Speicher und versucht es mit exponentiellem Backoff bis zu einer konfigurierbaren Obergrenze erneut. Das ist meist genau das, was Sie wollen; überraschend ist nur, dass das Wiederkommen des Collectors oder Dashboards keinen sofortigen Flush auslöst. Wenn Sie einen Integrationstest fahren und behaupten "Trace X ist innerhalb von 100 ms im Aspire Dashboard angekommen", geben Sie dem Exporter einen `BatchExportProcessor`-Zeitplan kürzer als die 5 Sekunden Default oder rufen Sie vor der Assertion `TracerProvider.ForceFlush()` explizit auf.

## Wie es weitergeht

Der Wert von OpenTelemetry wächst mit der Oberfläche, die Sie instrumentieren. Der Startpunkt ist ASP.NET Core plus HttpClient plus EF Core. Von dort aus sind Hintergrunddienste die Erweiterungen mit dem höchsten Hebel (jeder `IHostedService` sollte eine `Activity` pro Arbeitseinheit starten) und ausgehende Message-Broker (die Instrumentierungen `OpenTelemetry.Instrumentation.MassTransit` und Confluent.Kafka decken die meisten Teams ab). Für tieferes Profiling von Arbeitseinheiten, sobald Spans Sie auf die richtige Minute gebracht haben, durchläuft [die dotnet-trace-Anleitung auf dieser Site](/de/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) das Tool, das am häufigsten dort übernimmt, wo OpenTelemetry aufhört, und [der Beitrag zum globalen Exception-Filter](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) deckt die ASP.NET Core-Seite ab, Fehler sauber in derselben Pipeline zu erfassen.

Der Endzustand, der sich lohnt: eine Pipeline, ein Wire-Format, und ein einziger Ort, an dem zuerst nachgesehen wird, wenn etwas schiefgeht. OpenTelemetry plus das Aspire Dashboard plus ein vorgeschalteter Collector bringen Sie für den Preis eines Docker-Pulls dorthin.

Sources:

- [OpenTelemetry .NET Exporters documentation](https://opentelemetry.io/docs/languages/dotnet/exporters/)
- [OTLP Exporter for OpenTelemetry .NET](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Exporter.OpenTelemetryProtocol/README.md)
- [Use OpenTelemetry with the standalone Aspire Dashboard - .NET](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-otlp-example)
- [.NET Observability with OpenTelemetry](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel)
- [OpenTelemetry.Exporter.OpenTelemetryProtocol on NuGet](https://www.nuget.org/packages/OpenTelemetry.Exporter.OpenTelemetryProtocol)
