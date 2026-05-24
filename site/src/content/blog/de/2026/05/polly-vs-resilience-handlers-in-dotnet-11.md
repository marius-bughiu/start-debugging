---
title: "Polly vs. Resilience Handler in .NET 11: Was sollten Sie verwenden?"
description: "Verwenden Sie den Resilience Handler aus Microsoft.Extensions.Http.Resilience für HttpClient-Aufrufe, denn er ist Polly mit HTTP-bewussten Standardwerten und Telemetrie in einer einzigen Zeile. Greifen Sie nur dann direkt zu Pollys ResiliencePipeline, wenn Sie etwas absichern, das kein HttpClient ist."
pubDate: 2026-05-24
tags:
  - "comparison"
  - "polly"
  - "resilience"
  - "httpclient"
  - "dotnet"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/polly-vs-resilience-handlers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-24
---

Die Formulierung "Polly vs. Resilience Handler" ist leicht falsch, und zu erkennen, warum, ist bereits die ganze Antwort. Der Resilience Handler, `AddStandardResilienceHandler` aus dem Paket `Microsoft.Extensions.Http.Resilience`, ist keine Alternative zu Polly. Er ist Polly, eingehüllt in eine HTTP-bewusste, Dependency-Injection-freundliche Schicht, die sich direkt in `IHttpClientFactory` einklinkt. Die eigentliche Frage lautet also nicht "welche Bibliothek", sondern "auf welcher Schicht konfiguriere ich Resilienz". Für neuen .NET-11-Code im Jahr 2026 gilt: Wenn das, was Sie absichern, ein `HttpClient`-Aufruf ist, verwenden Sie den Resilience Handler, denn er liefert Ihnen Pollys Strategien mit HTTP-bewussten Standardwerten, Telemetrie und Konfigurationsbindung in einer einzigen Zeile. Greifen Sie nur dann direkt zur `ResiliencePipeline`-API von Polly, wenn die Operation keine `HttpClient`-Anfrage ist: eine Datenbankabfrage, eine Veröffentlichung an einen Message-Broker, ein manuell aufgerufener gRPC-Aufruf oder ein beliebiges Delegate.

Alle Beispiele hier zielen auf `<TargetFramework>net11.0</TargetFramework>` mit dem .NET-11-SDK und C# 14. "Polly" bezeichnet Polly v8 (das Paket `Polly.Core`, 8.6.6 auf NuGet), dessen `ResiliencePipeline`-API die alten `Policy`-Typen ersetzt hat. "Resilience Handler" bezeichnet `Microsoft.Extensions.Http.Resilience` 10.6.0, das von `Microsoft.Extensions.Resilience` und von Polly abhängt. Die beiden sind dieselbe Maschine, aus zwei Höhen betrachtet.

## Die Funktionsmatrix auf einen Blick

Das ist die Tabelle, für die Sie gekommen sind. Die Spalten sind die zwei Arten, wie Sie Resilienz tatsächlich verdrahten, und die Zeilen sind die Entscheidungen, die ändern, welche Sie wählen.

| Aspekt | Polly `ResiliencePipeline` | Resilience Handler (`Microsoft.Extensions.Http.Resilience`) |
| ------- | ------------------------- | ---------------------------------------------------------- |
| Was umhüllt wird | Beliebiges Delegate oder beliebige Operation | Nur `HttpClient`-Anfragen |
| Aufgebaut auf | `Polly.Core` (die Maschine) | `Polly.Core`, umhüllt |
| Wie es läuft | Sie rufen `pipeline.ExecuteAsync(...)` explizit auf | Transparent, innerhalb der `HttpMessageHandler`-Pipeline |
| HTTP-bewusste Standardwerte (5xx, 408, 429) | Sie schreiben `ShouldHandle` selbst | Eingebaut |
| Eine sinnvolle Standard-Pipeline in einer Zeile | Nein, Sie setzen sie zusammen | Ja, `AddStandardResilienceHandler()` |
| Telemetrie (Metriken + Traces) | Über `Microsoft.Extensions.Resilience` oder manuell | Eingebaut |
| Konfigurationsbindung + Hot-Reload | Manuell | Erstklassig (`EnableReloads`) |
| Integration mit Dependency Injection | `ResiliencePipelineRegistry<TKey>` | `IHttpClientBuilder` |
| NuGet-Paket | `Polly.Core` 8.6.6 | `Microsoft.Extensions.Http.Resilience` 10.6.0 |
| Am besten für | Datenbankaufrufe, Queues, gRPC, beliebiger Code | Benannte oder typisierte `HttpClient`-Aufrufe |

Das Muster in der Tabelle ist, dass der Resilience Handler die rechte Spalte ist, die die Maschine links erbt und HTTP-Wissen, Telemetrie und Dependency-Injection-Verdrahtung obendrauf legt. Der Preis der Bewegung nach rechts ist, dass Sie auf Allgemeinheit verzichten: Der Handler läuft nur gegen `HttpClient`.

## Warum der Resilience Handler nur Polly in Uniform ist

Wenn Sie `AddStandardResilienceHandler` aufrufen, baut das Paket eine Polly-`ResiliencePipeline<HttpResponseMessage>` und installiert sie als `DelegatingHandler` in der Message-Handler-Pipeline, die `IHttpClientFactory` für diesen Client zusammensetzt. Jeder Wiederholungsversuch, jedes Auslösen des Circuit Breakers, jeder Timeout wird von `Polly.Core` ausgeführt. Es gibt keine zweite Resilienz-Maschine in .NET. Microsoft hat die Wiederholungen nicht neu implementiert; es nahm Polly v8, gab ihm auf HTTP abgestimmte Standardwerte, verband es mit dem Optionssystem und gab OpenTelemetry-kompatible Metriken und Traces darum herum aus.

Deshalb ist "sollte ich Polly oder den Resilience Handler verwenden?" für HTTP-Code ein Kategorienfehler. Den Handler zu verwenden bedeutet, Polly zu verwenden. Die Entscheidung ist, ob Sie die HTTP-förmige Komfortschicht wollen oder ob Sie die rohe Maschine brauchen, weil Ihre Operation kein HTTP ist.

## Wann der Resilience Handler die richtige Wahl ist

Für jede Resilienz, die auf einem über `IHttpClientFactory` aufgelösten `HttpClient` liegt, gewinnt der Handler. Der Standard-Handler ist eine einzige Zeile auf einem typisierten Client:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 10.6.0
using Microsoft.Extensions.DependencyInjection;

builder.Services.AddHttpClient<GitHubService>(client =>
{
    client.BaseAddress = new Uri("https://api.github.com");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
})
.AddStandardResilienceHandler(); // rate limiter, total timeout, retry, breaker, attempt timeout
```

Dieser eine Aufruf stapelt fünf Strategien mit HTTP-bewussten Standardwerten: Er weiß bereits, dass HTTP 500+, 408 und 429 transient sind, dass `HttpRequestException` und Pollys `TimeoutRejectedException` wiederholt werden sollten und dass ein `Retry-After`-Header beachtet werden soll. Sie haben für nichts davon ein `ShouldHandle`-Prädikat geschrieben. Dies ist der moderne Ersatz für das händische Verdrahten von Polly-Policies auf einem Client und der richtige Standard für nahezu jeden serverseitigen HTTP-Code.

Wenn die Standardwerte nicht ganz passen, steigen Sie nicht zum rohen Polly hinab. Sie bleiben in der Handler-Schicht und passen an, denn der Handler stellt dieselben Polly-Optionen über HTTP-spezifische Optionstypen bereit. Verwenden Sie `AddResilienceHandler`, um eine benannte, vollständig angepasste Pipeline zu bauen:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 10.6.0
using System.Net;
using Microsoft.Extensions.Http.Resilience;
using Polly;

httpClientBuilder.AddResilienceHandler("CustomPipeline", static builder =>
{
    builder.AddRetry(new HttpRetryStrategyOptions
    {
        BackoffType = DelayBackoffType.Exponential,
        MaxRetryAttempts = 5,
        UseJitter = true
    });

    builder.AddCircuitBreaker(new HttpCircuitBreakerStrategyOptions
    {
        SamplingDuration = TimeSpan.FromSeconds(10),
        FailureRatio = 0.2,
        MinimumThroughput = 3,
        ShouldHandle = static args => ValueTask.FromResult(args is
        {
            Outcome.Result.StatusCode:
                HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests
        })
    });

    builder.AddTimeout(TimeSpan.FromSeconds(5));
});
```

Beachten Sie die Typen: `HttpRetryStrategyOptions` und `HttpCircuitBreakerStrategyOptions`. Dies sind die HTTP-gefärbten Versionen von Pollys `RetryStrategyOptions<T>` und `CircuitBreakerStrategyOptions<T>`, die Annehmlichkeiten wie `DisableForUnsafeHttpMethods()` mitbringen, die nur für HTTP Sinn ergeben. Sie sind weiterhin in Polly, nur in dem Teil von Polly, der `HttpResponseMessage` versteht.

Der Handler bindet sich auch an die Konfiguration und lädt zur Laufzeit neu. Binden Sie `HttpStandardResilienceOptions` an einen Abschnitt der `appsettings.json`, rufen Sie `EnableReloads` innerhalb einer `AddResilienceHandler`-Überladung auf, die den `ResilienceHandlerContext` bereitstellt, und das Ändern der JSON justiert die laufende Pipeline ohne Neustart neu. Diese Installation ist gegen rohes Polly nicht kostenlos von Hand zu schreiben, und der Handler gibt sie Ihnen.

## Was der Standard-Handler tatsächlich konfiguriert

Leser kommen zu diesem Vergleich, weil sie wissen wollen, was `AddStandardResilienceHandler` tut, bevor sie ihm vertrauen. Die Standardkonfiguration verkettet fünf Strategien, von außen nach innen. Die folgenden Zahlen sind die Standardwerte von .NET 11 / `Microsoft.Extensions.Http.Resilience` 10.6.0:

| Reihenfolge | Strategie | Standard |
| ----- | -------- | ------- |
| 1 | Rate Limiter | Permit: `1_000`, Queue: `0` |
| 2 | Gesamt-Timeout der Anfrage | 30s über alle Versuche |
| 3 | Retry | Max. Wiederholungen: `3`, exponentielles Backoff, Jitter an, Basisverzögerung 2s |
| 4 | Circuit Breaker | Fehlerquote: 10%, min. Durchsatz: `100`, Abtastung 30s, Öffnung 5s |
| 5 | Timeout pro Versuch | 10s pro einzelnem Versuch |

Die Reihenfolge ist wichtig. Das Gesamt-Timeout (30s) sitzt außerhalb der Wiederholungen, sodass drei Wiederholungen, die jeweils das Timeout pro Versuch von 10s erreichen, nicht ewig laufen können: Die gesamte Operation ist auf 30s gedeckelt. Der Circuit Breaker sitzt innerhalb des Retry, sodass er die Fehler einzelner Versuche zählt, und sobald 10% von mindestens 100 abgetasteten Aufrufen innerhalb von 30s fehlschlagen, öffnet er für 5s und schließt alles darunter kurz. Wenn Sie sich nur eines über die Standardwerte merken: Wiederholungen sind durch eine 30s-Wanduhr begrenzt, nicht nur durch eine Anzahl.

## Wann Sie direkt zu Polly greifen

Der Handler ist keine Option mehr, sobald das, was Sie absichern, kein `HttpClient`-Aufruf ist. Es gibt kein `AddStandardResilienceHandler` für eine Datenbankabfrage, ein `ServiceBusSender.SendMessageAsync`, einen Redis-Aufruf oder einen Block von Geschäftslogik, der gelegentlich eine Ausnahme wirft. Dafür bauen Sie eine Polly-`ResiliencePipeline` und rufen sie explizit auf:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - resilience around a non-HTTP operation
using Polly;
using Polly.Retry;

ResiliencePipeline pipeline = new ResiliencePipelineBuilder()
    .AddRetry(new RetryStrategyOptions
    {
        MaxRetryAttempts = 3,
        BackoffType = DelayBackoffType.Exponential,
        UseJitter = true,
        // Only retry the transient failures this dependency actually throws
        ShouldHandle = new PredicateBuilder().Handle<TimeoutException>()
    })
    .AddTimeout(TimeSpan.FromSeconds(5))
    .Build();

await pipeline.ExecuteAsync(
    async token => await SaveOrderAsync(order, token),
    cancellationToken);
```

Die Form ist dieselbe Maschine, die Sie im Handler gesehen haben: `AddRetry`, `AddTimeout`, `AddCircuitBreaker`, derselbe `DelayBackoffType` und `ShouldHandle`. Was sich ändert, ist, dass Sie `ExecuteAsync` selbst aufrufen, selbst wählen, was als transienter Fehler gilt (hier `TimeoutException`, weil es keinen HTTP-Statuscode zu prüfen gibt), und die Pipeline buchstäblich jedes Delegate umhüllen kann.

Für typisierte Ergebnisse verwenden Sie den generischen Builder, damit die Pipeline über den Rückgabewert und nicht nur über Ausnahmen nachdenken kann:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - a pipeline that inspects the result
using Polly;

ResiliencePipeline<DbResult> pipeline = new ResiliencePipelineBuilder<DbResult>()
    .AddRetry(new()
    {
        MaxRetryAttempts = 3,
        ShouldHandle = static args => ValueTask.FromResult(
            args.Outcome.Result is { Status: DbStatus.Throttled })
    })
    .Build();

DbResult result = await pipeline.ExecuteAsync(
    async token => await QueryAsync(token),
    cancellationToken);
```

In einer Anwendung mit Dependency Injection instanziieren Sie keine Pipelines an den Aufrufstellen. Sie registrieren sie einmal mit `AddResiliencePipeline`, und sie landen in der `ResiliencePipelineRegistry<TKey>`, sodass Sie sie überall über `ResiliencePipelineProvider<TKey>` auflösen können:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - register once, resolve anywhere
using Microsoft.Extensions.DependencyInjection;
using Polly;
using Polly.Registry;

builder.Services.AddResiliencePipeline("db-writes", static b =>
{
    b.AddRetry(new()).AddTimeout(TimeSpan.FromSeconds(5));
});

// elsewhere, injected ResiliencePipelineProvider<string> provider
ResiliencePipeline pipeline = provider.GetPipeline("db-writes");
await pipeline.ExecuteAsync(static async ct => await DoWorkAsync(ct), ct);
```

Wenn Sie zusätzlich `Microsoft.Extensions.Resilience` einbinden, erhalten diese registrierten Pipelines dieselbe Telemetriebehandlung, die der HTTP-Handler genießt, sodass eine Pipeline, die kein HTTP ist, weiterhin Metriken und Traces ausgeben kann. Das ist das Nächste an "der Handler-Erfahrung" für Code, der kein HTTP ist, und das richtige Werkzeug, wenn Sie Resilienz um Ihre Daten- oder Messaging-Schicht statt um Ihr ausgehendes HTTP wollen.

## Ist eines schneller als das andere?

Nein, und die Frage offenbart das Missverständnis. Da der Resilience Handler unter der Haube eine Polly-`ResiliencePipeline` ausführt, ist der Overhead pro Aufruf von "dem Handler" und "rohem Polly" dieselbe Maschine, die dieselben Strategien ausführt. Es gibt keine Polly-Steuer, die Sie durch händisches Bauen einer Pipeline vermeiden, und keine Handler-Steuer, die Sie für die Bequemlichkeit zahlen. Polly v8 wurde speziell neu geschrieben, um Allokationen gegenüber v7 zu senken, und beide Einstiegspunkte ruhen auf dieser Neufassung.

Was sich unterscheidet, ist nicht der Durchsatz, sondern das, was Sie rund um die Ausführung erhalten: Der Handler fügt Telemetrie, Konfigurationsbindung und die Lebensdauergarantien von `IHttpClientFactory` kostenlos hinzu, während eine rohe Pipeline Ihnen diese nur gibt, wenn Sie sie verdrahten. Wenn Sie eine echte Zahl für Ihre eigene Arbeitslast wollen, führen Sie BenchmarkDotNet gegen Ihr eigenes Delegate mit und ohne die Pipeline aus; wählen Sie zwischen diesen beiden nicht auf Basis der Leistung, denn die Leistung ist nicht die Achse, die sie trennt.

## Das Detail, das für Sie entscheidet

Einige harte Einschränkungen klären die Wahl, bevor die Vorliebe ins Spiel kommt.

**Der Handler funktioniert nur auf `HttpClient` über `IHttpClientFactory`.** Wenn Ihr Code nicht über `AddHttpClient` und einen injizierten Client läuft, gibt es keinen Handler hinzuzufügen. Ein statischer Singleton-`HttpClient`, ein `DbContext`, ein Kafka-Producer: Keiner von ihnen kann einen Resilience Handler annehmen. Sie nehmen eine Polly-Pipeline oder nichts. Diese eine Tatsache entscheidet die meisten realen Fälle.

**Stapeln Sie keine Resilience Handler.** Die Empfehlung von Microsoft ist eindeutig: Fügen Sie genau einen Resilience Handler pro Client hinzu. Wenn Sie eine andere Form brauchen, rufen Sie zuerst `RemoveAllResilienceHandlers()` auf und fügen Sie dann Ihren eigenen hinzu. Das Stapeln eines Standard-Handlers und eines benutzerdefinierten Handlers schachtelt zwei vollständige Pipelines und erzeugt Wiederholungszahlen und Timeouts, die sich auf eine Weise multiplizieren, die niemand beabsichtigt.

**Wiederholungen mit nicht idempotenten Verben duplizieren Daten.** Der Standard-Handler wiederholt standardmäßig jede HTTP-Methode. Ein wiederholter `POST`, der den Server bereits erreicht hat, kann denselben Datensatz zweimal einfügen. Rufen Sie `options.Retry.DisableForUnsafeHttpMethods()` auf, um Wiederholungen für `POST`, `PATCH`, `PUT`, `DELETE` und `CONNECT` zu überspringen, oder `DisableFor(HttpMethod.Post, ...)` für eine bestimmte Liste. Dies ist eine Angelegenheit der Handler-Schicht, bei der rohes Polly nicht helfen kann, denn rohes Polly weiß nicht, was ein HTTP-Verb ist.

**Polly wirft `TimeoutRejectedException`, nicht `TimeoutException`.** Wenn Sie ein `ShouldHandle`-Prädikat auf einem Retry schreiben und erwarten, den Fehler der Timeout-Strategie abzufangen, denken Sie daran, dass er als Pollys `TimeoutRejectedException` auftaucht. Dies falsch zu behandeln ist eine häufige Quelle einer [TaskCanceledException, die anzeigt, dass eine Aufgabe abgebrochen wurde](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) und dort hochsteigt, wo Sie einen Retry erwartet haben.

## Die Entscheidung, in einer Zeile

Für neuen .NET-11-Code im Jahr 2026 gilt: Wenn Sie Resilienz zu einem über `IHttpClientFactory` aufgelösten `HttpClient` hinzufügen, verwenden Sie den Resilience Handler, denn `AddStandardResilienceHandler` ist Polly mit HTTP-bewussten Standardwerten, Telemetrie und Konfigurationsbindung in einer einzigen Zeile, und `AddResilienceHandler` lässt Sie anpassen, ohne diese Schicht zu verlassen. Steigen Sie nur dann direkt zur `ResiliencePipeline`-API von Polly hinab, wenn die Operation kein `HttpClient`-Aufruf ist: Datenbankzugriff, Message-Broker, gRPC, das Sie von Hand aufrufen, oder beliebige Delegates. Sie wählen nie wirklich zwischen zwei Resilienz-Bibliotheken, denn es gibt nur eine. Sie wählen, ob Sie Polly durch die HTTP-förmige Tür oder durch die für allgemeine Zwecke verwenden, und die Art der Operation, die Sie absichern, wählt die Tür für Sie.

## Verwandt

- [HttpClient vs. HttpClientFactory vs. Refit: Was sollten Sie in .NET 11 verwenden?](/de/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [Behebung: TaskCanceledException, eine Aufgabe wurde im HttpClient abgebrochen](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Wie man eine lange laufende Task in C# ohne Deadlock abbricht](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Wie man OpenTelemetry mit .NET 11 und einem kostenlosen Backend verwendet](/de/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [Wie man Code, der HttpClient verwendet, mit Unit-Tests testet](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/)

## Quellen

- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) - `AddStandardResilienceHandler`, `AddResilienceHandler`, die Standardwerte der Standard-Pipeline und die Liste der transienten Ergebnisse.
- [Introduction to resilient app development](https://learn.microsoft.com/en-us/dotnet/core/resilience/) - wie `Microsoft.Extensions.Resilience` auf Polly aufbaut und Telemetrie hinzufügt.
- [Polly docs: Resilience pipelines](https://www.pollydocs.org/pipelines/) - `ResiliencePipelineBuilder`, `ExecuteAsync` und das Registry.
- [Polly docs: Advanced dependency injection](https://www.pollydocs.org/advanced/dependency-injection/) - `AddResiliencePipeline`, `ResiliencePipelineRegistry` und dynamische Neuladevorgänge.
- [Polly v7 to v8 migration guide](https://www.pollydocs.org/migration-v8.html) - warum die `Policy`-API durch `ResiliencePipeline` ersetzt wurde.
- [Microsoft.Extensions.Http.Resilience on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Http.Resilience) - aktuelle Paketversion und ihre Abhängigkeiten.
</content>
