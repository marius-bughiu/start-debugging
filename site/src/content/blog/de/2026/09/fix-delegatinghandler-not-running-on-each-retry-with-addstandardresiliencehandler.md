---
title: "Fix: Eigener DelegatingHandler läuft mit AddStandardResilienceHandler nicht bei jedem Retry erneut"
description: "Ein DelegatingHandler, der vor AddStandardResilienceHandler registriert wird, läuft einmal pro logischer Anfrage, nicht einmal pro Retry. Verschieben Sie ihn hinter den Resilience-Handler und machen Sie ihn idempotent, denn der Retry sendet dieselbe HttpRequestMessage erneut. Gemessen mit Microsoft.Extensions.Http.Resilience 10.10.0 und 8.10.0."
pubDate: 2026-09-23
template: how-to
tags:
  - "dotnet-10"
  - "httpclient"
  - "resilience"
  - "polly"
  - "aspnetcore"
lang: "de"
translationOf: "2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler"
translatedBy: "claude"
translationDate: 2026-09-23
---

**Kurze Antwort:** `IHttpClientFactory` baut die Handler-Kette in Registrierungsreihenfolge auf, der zuerst registrierte Handler liegt ganz außen. Wenn Sie `AddHttpMessageHandler<MyHandler>()` *vor* `AddStandardResilienceHandler()` aufrufen, sitzt Ihr Handler außerhalb der Retry-Schleife und läuft genau einmal, egal wie viele Versuche Polly darunter unternimmt. Registrieren Sie ihn *nach* dem Resilience-Handler, läuft er einmal pro Versuch. Danach ist der zweite Bug zu beheben, den diese Verschiebung sichtbar macht: Der Standard-Retry sendet **dasselbe** `HttpRequestMessage`-Objekt erneut, sodass jedes `request.Headers.Add(...)` in einem Handler pro Versuch doppelte Werte anhäuft und ein nicht durchsuchbarer `StreamContent`-Body beim zweiten Versuch `InvalidOperationException: The stream was already consumed` wirft.

Alles Folgende wurde mit einer dateibasierten Testsonde auf .NET 10.0.10 (SDK 10.0.302) gegen `Microsoft.Extensions.Http.Resilience` 10.10.0, die aktuelle stabile Version, gemessen und mit 8.10.0 wiederholt. Beide Versionen lieferten identische Ausgaben, es handelt sich also weder um eine Regression noch um etwas, das ein Paket-Upgrade ändert. So ist die Pipeline aufgebaut.

## Warum der Handler nur einmal läuft

`AddStandardResilienceHandler` ist keine Einstellung am Client. Es ist ein weiterer `DelegatingHandler` vom Typ `ResilienceHandler`, angehängt an dieselbe geordnete Liste, an die auch `AddHttpMessageHandler` anhängt. Die ASP.NET Core-Dokumentation beschreibt die Regel in einem Satz: Handler [können in der Reihenfolge registriert werden, in der sie ausgeführt werden sollen](https://learn.microsoft.com/aspnet/core/fundamentals/http-requests#outgoing-request-middleware), und jeder umschließt den nächsten.

Innerhalb von `ResilienceHandler.SendAsync` führt die Polly-Pipeline einen Callback aus, der `base.SendAsync(request, ...)` aufruft, also den nächsten Handler in der Kette. Entscheidet die Retry-Strategie, es erneut zu versuchen, ruft sie diesen Callback noch einmal auf. Deshalb werden nur die Handler **unterhalb** von `ResilienceHandler` erneut ausgeführt. Alles darüber hat `base.SendAsync` bereits einmal aufgerufen und wartet schlicht auf das Endergebnis.

Das ist der ganze Bug. Tutorials und älterer Code registrieren übergreifende Handler oft zuerst und hängen die Resilience am Ende an, weil sich das natürlich liest:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddTransient<SigningHandler>();

builder.Services.AddHttpClient<PaymentsClient>(c => c.BaseAddress = new("https://payments.example"))
    .AddHttpMessageHandler<SigningHandler>()   // outermost: runs once
    .AddStandardResilienceHandler();           // retries happen below this line
```

Wenn `SigningHandler` einen Zeitstempel und eine HMAC-Signatur setzt, geht jeder Retry mit der für den ersten Versuch berechneten Signatur hinaus. Holt er ein kurzlebiges Token, kann ein Retry nach einem langsamen 503 mit einem inzwischen abgelaufenen Token hinausgehen. Protokolliert er "sending request", sehen Sie eine Logzeile für drei Netzwerkaufrufe.

## Die gemessene Handler-Kette

Ich habe `IHttpMessageHandlerFactory.CreateHandler("c")` aufgelöst und bin über `InnerHandler` bis zum primären Handler hinabgegangen. Der primäre Handler war ein Stub, der zweimal `503` und dann `200` zurückgibt, und die Retry-Verzögerungen waren auf null gesetzt, damit die Sonde sofort durchläuft. Ein `CountingHandler` protokolliert jeden Aufruf, den er sieht.

Registriert **vor** `AddStandardResilienceHandler`:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> CountingHandler -> ResilienceHandler
       -> LoggingHttpMessageHandler -> StubPrimary
final: 200, primary calls: 3
CountingHandler #1 X-Attempt=[]
CountingHandler #1 <- 200
```

Drei Anfragen gingen über die Leitung. Der Handler lief einmal und sah nur das finale `200`.

Registriert **nach** `AddStandardResilienceHandler`:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> ResilienceHandler -> CountingHandler
       -> LoggingHttpMessageHandler -> StubPrimary
final: 200, primary calls: 3
CountingHandler #2 <- 503
CountingHandler #3 <- 503
CountingHandler #4 <- 200
```

Jetzt läuft er pro Versuch und sieht jedes `503`. Beachten Sie, wo der factory-eigene `LoggingHttpMessageHandler` sitzt: immer ganz innen, direkt über dem primären Handler. Deshalb zeigt die eingebaute Log-Kategorie `System.Net.Http.HttpClient.<name>.ClientHandler` bereits einen Eintrag pro Versuch, während ein zuerst registrierter Handler einen Eintrag pro Aufruf zeigt. Wenn Ihre Logs und Ihr Handler sich bei der Anzahl der Anfragen widersprechen, ist das der Grund.

## In drei Schritten beheben

1. Entscheiden Sie pro Handler, ob seine Arbeit zum **logischen Aufruf** oder zu **jedem Versuch** gehört. Signieren, Token-Beschaffung, Protokollierung und Metriken pro Versuch gehören zum Versuch. Ein Idempotenzschlüssel, eine Korrelations-ID, die über Retries stabil bleiben soll, und alles, was genau einmal passieren muss, gehören zum Aufruf.
2. Registrieren Sie Handler pro Versuch **nach** `AddStandardResilienceHandler()` (oder `AddResilienceHandler(...)`) und Handler pro Aufruf davor.
3. Machen Sie jeden Handler pro Versuch sicher für die wiederholte Ausführung auf derselben `HttpRequestMessage`: Header ersetzen statt hinzufügen, und sicherstellen, dass der Request-Body mehr als einmal gelesen werden kann.

Die Registrierung für das Zahlungsbeispiel wird zu:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddTransient<IdempotencyKeyHandler>();
builder.Services.AddTransient<SigningHandler>();

var payments = builder.Services
    .AddHttpClient<PaymentsClient>(c => c.BaseAddress = new("https://payments.example"));

payments.AddHttpMessageHandler<IdempotencyKeyHandler>(); // once per call: same key on every retry
payments.AddStandardResilienceHandler();
payments.AddHttpMessageHandler<SigningHandler>();        // once per attempt: fresh signature
```

Behalten Sie den `IHttpClientBuilder` in einer Variablen. Sie können `.AddHttpMessageHandler<T>()` nicht an `AddStandardResilienceHandler()` anhängen, weil dieses einen `IHttpStandardResiliencePipelineBuilder` zurückgibt, nicht den Client-Builder. Der Versuch lässt den Build scheitern:

```text
error CS1929: 'IHttpStandardResiliencePipelineBuilder' does not contain a definition for
'AddHttpMessageHandler' and the best extension method overload
'HttpClientBuilderExtensions.AddHttpMessageHandler<SigningHandler>(IHttpClientBuilder)'
requires a receiver of type 'Microsoft.Extensions.DependencyInjection.IHttpClientBuilder'
```

Ich vermute, dass dieser Compilerfehler der eigentliche Grund ist, warum so viel Code Handler zuerst registriert: Die Fluent-Kette kompiliert nur in der falschen Reihenfolge, also setzen die Leute die Resilience ans Ende und machen weiter. Ein zweiter Aufruf von `AddHttpClient<PaymentsClient>()` für denselben Client funktioniert ebenfalls, da er einen Builder für denselben Namen zurückgibt, aber die Variable macht die Reihenfolge sichtbar.

Beim Idempotenzschlüssel liegen viele in die entgegengesetzte Richtung falsch. Wenn Sie *jeden* Handler in den Retry verschieben, um das Signieren zu reparieren, sendet ein Handler, der `Idempotency-Key: Guid.NewGuid()` erzeugt, nun pro Versuch einen anderen Schlüssel, und der Server kann einen Retry nicht mehr von einer neuen Zahlung unterscheiden. Der ganze Sinn des Schlüssels ist, dass er über Retries konstant bleibt, also muss er außerhalb der Schleife leben.

## Der Retry sendet dieselbe HttpRequestMessage erneut

Das hat mich überrascht. Ich hatte erwartet, dass der Resilience-Handler die Anfrage pro Versuch klont. Beim Standard-Handler (Retry) tut er das nicht. Die Sonde protokollierte in jedem Versuch den Hashcode der Anfrage, und es war jedes Mal dasselbe Objekt. Ein Handler pro Versuch, der `Headers.Add` verwendet, erzeugt dann Folgendes:

```text
chain: ... -> ResilienceHandler -> HeaderHandler -> CountingHandler -> ...
CountingHandler #5 X-Attempt=[1]
CountingHandler #6 X-Attempt=[1,1]
CountingHandler #7 X-Attempt=[1,1,1]
```

Beim dritten Versuch hat der Header drei Werte. Für einen Signatur-Header bedeutet das, dass der Server `X-Signature: abc, def, ghi` erhält und ablehnt. Der Code in `ResilienceHandler` bestätigt es: Der Pipeline-Callback ruft `GetRequestMessage(context, state.request)` auf, das die ursprüngliche Anfrage zurückgibt, sofern keine äußere Strategie eine andere in den Kontext gelegt hat. Das tut nur Hedging.

Die Lösung besteht darin, Header mit "Set"-Semantik zu schreiben. `Authorization` ist eine einwertige typisierte Eigenschaft, eine Zuweisung ersetzt also den alten Wert. Bei eigenen Headern entfernen Sie zuerst:

```csharp
// .NET 10, C# 14
public sealed class SigningHandler(ISigner signer, TimeProvider clock) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var timestamp = clock.GetUtcNow().ToUnixTimeSeconds().ToString();

        request.Headers.Remove("X-Timestamp");
        request.Headers.Remove("X-Signature");
        request.Headers.Add("X-Timestamp", timestamp);
        request.Headers.Add("X-Signature", await signer.SignAsync(request, timestamp, cancellationToken));

        return await base.SendAsync(request, cancellationToken);
    }
}
```

Mit `Remove` gefolgt von `Add` zeigte die Sonde `X-Attempt=[1]`, `[2]`, `[3]` über die drei Versuche: ein Wert, jedes Mal aufgefrischt. Dasselbe gilt für einen Token-Handler: `request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);` lässt sich bereits gefahrlos wiederholen.

## Request-Bodys müssen wiederholbar lesbar sein

Weil dieselbe `HttpRequestMessage` erneut hinausgeht, gilt das auch für denselben `HttpContent`. `StringContent`, `ByteArrayContent`, `JsonContent` und `FormUrlEncodedContent` liegen im Speicher und lassen sich beliebig oft serialisieren. Der primäre Handler der Sonde kopierte den Body mit `CopyToAsync`, genau wie `SocketsHttpHandler`, und ein `StringContent`-POST kam bei allen drei Versuchen unversehrt an.

Ein `StreamContent` über einem nicht durchsuchbaren Stream (ein Netzwerk-Stream, eine Pipe, ein weitergeleiteter Upload) übersteht das nicht:

```text
primary #1 body='{"a":1}'
primary #2 InvalidOperationException: The stream was already consumed. It cannot be read again.
```

`InvalidOperationException` gehört nicht zu den Exceptions, die der Standard-Retry als transient behandelt, also schlägt der Aufruf beim zweiten Versuch mit dieser Exception fehl, statt es erneut zu versuchen. Ein durchsuchbarer Stream funktioniert, weil `StreamContent` vor jedem Senden auf seine Startposition zurückspult.

Sie haben drei Optionen:

```csharp
// .NET 10, C# 14
// Option 1: buffer it (fine for small bodies)
var content = new StreamContent(uploadStream);
await content.LoadIntoBufferAsync(cancellationToken);   // probe: all 3 attempts sent the full body

// Option 2: copy to a seekable stream first
var ms = new MemoryStream();
await uploadStream.CopyToAsync(ms, cancellationToken);
ms.Position = 0;
var seekable = new StreamContent(ms);

// Option 3: do not retry this request at all
builder.Services.AddHttpClient("uploads")
    .AddStandardResilienceHandler()
    .Configure(o => o.Retry.DisableForUnsafeHttpMethods());
```

Bei großen Uploads ist Option 3 meist die ehrliche Antwort. Einen Body von 500 MB in den Speicher zu puffern, nur um ihn wiederholbar zu machen, ist ein schlimmerer Fehlermodus, als den Fehler durchzureichen. `DisableForUnsafeHttpMethods` verhindert außerdem generell, dass der Standard-Handler `POST`, `PUT`, `PATCH` und `DELETE` wiederholt, was Sie bei nicht idempotenten Endpunkten ohnehin oft wollen.

## Aspire und ConfigureHttpClientDefaults setzen Ihren Handler bereits nach innen

Wenn Ihr Projekt die `ServiceDefaults` von .NET Aspire nutzt, haben Sie diesen Bug womöglich gar nicht. `AddServiceDefaults()` ruft `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())` auf, und Standardaktionen laufen immer vor der eigenen Konfiguration eines benannten oder typisierten Clients. Ich habe den Resilience-Handler über `ConfigureHttpClientDefaults` registriert und einen `CountingHandler` am benannten Client:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> ResilienceHandler -> CountingHandler
       -> LoggingHttpMessageHandler -> StubPrimary
CountingHandler #8 <- 503
CountingHandler #9 <- 503
CountingHandler #10 <- 200
```

Jeder clientspezifische Handler landet innerhalb des Retrys, unabhängig von der Reihenfolge von `AddServiceDefaults()` und `AddHttpClient(...)` in `Program.cs`. Das ist die richtige Voreinstellung für Signaturen und Tokens und die falsche für Idempotenzschlüssel. Wenn Sie in einer Aspire-App einen Handler pro Aufruf brauchen, müssen Sie den Standard-Resilience-Handler für diesen Client entfernen und nach Ihrem Handler erneut hinzufügen, wie in [den Standard-Resilience-Handler überschreiben, den Aspire registriert](/de/2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers/) beschrieben. Ein zweites `AddStandardResilienceHandler()` ersetzt das erste nicht, es wird gestapelt.

## Hedging verhält sich anders

`AddStandardHedgingHandler()` ist die Ausnahme von der Regel "dasselbe Anfrageobjekt". Beim Hedging können mehrere Versuche gleichzeitig unterwegs sein, deshalb erstellt es einen Snapshot der ursprünglichen Anfrage und sendet pro Versuch einen Klon. Die Kette enthält außerdem zwei `ResilienceHandler`-Instanzen, eine für die Hedging-Pipeline und eine für die Strategien pro Endpunkt:

```text
chain: ... -> ResilienceHandler -> ResilienceHandler -> HeaderHandler -> CountingHandler -> ...
final: 503, primary calls: 2
CountingHandler #16 req@9c43c1 X-Attempt=[1]
CountingHandler #17 req@17e61ce X-Attempt=[1]
```

Zwei verschiedene Anfrageobjekte, jedes mit genau einem Header-Wert, selbst mit der `Headers.Add`-Version des Handlers. Handler, die nach dem Hedging-Handler registriert sind, laufen weiterhin pro Versuch. Verlassen Sie sich aber nicht auf das Klonen: Code, der nur unter Hedging korrekt ist, bricht an dem Tag, an dem jemand zurück auf den Standard-Handler wechselt.

## Was sich sonst ändert, sobald der Handler innen liegt

Einen Handler unter den Resilience-Handler zu verschieben, stellt ihn unter das **Timeout pro Versuch** (standardmäßig 10 Sekunden) und in das Blickfeld des **Circuit Breakers**. Drei Konsequenzen:

- Langsame Arbeit im Handler zählt gegen jeden Versuch. Ein Token-Endpunkt, der 8 Sekunden braucht, lässt 2 Sekunden für die eigentliche Anfrage, bevor der Versuch in das Timeout läuft. Cachen Sie Tokens und erneuern Sie sie vor Ablauf, statt im Anfragepfad.
- Exceptions, die Ihr Handler wirft, sind Ergebnisse, die Retry und Circuit Breaker auswerten. Eine von Ihrem Handler geworfene `HttpRequestException` wird wiederholt und zählt für den Breaker als Fehler. Werfen Sie etwas Nicht-Transientes (oder geben Sie eine Antwort zurück) bei Fehlern, die ein Retry nicht beheben kann, etwa fehlender Konfiguration.
- Ein Handler, der abkürzt und seine eigene `HttpResponseMessage` zurückgibt (etwa bei einem Cache-Treffer), unterliegt ebenfalls dem `ShouldHandle` des Retrys. Ein synthetisches `503` aus der Schleife heraus wird wie ein echtes wiederholt.

`DelegatingHandler`-Instanzen, die mit `AddHttpMessageHandler<T>()` registriert werden, müssen transient sein, und daran ändert sich nichts. Die Factory erstellt eine Kette pro Handler-Lebensdauer (standardmäßig zwei Minuten) und verwendet sie über Anfragen hinweg wieder, daher gehört Zustand pro Anfrage an die `HttpRequestMessage` (`request.Options`), nicht in Felder des Handlers.

## So prüfen Sie Ihre eigene Kette

Vertrauen Sie nicht dem Registrierungscode, prüfen Sie die aufgebaute Kette. Dieser Test funktioniert für jeden Client:

```csharp
// .NET 10, xUnit v3, Microsoft.Extensions.Http.Resilience 10.10.0
[Fact]
public void SigningHandler_runs_inside_the_retry()
{
    var services = new ServiceCollection();
    services.AddTransient<SigningHandler>();
    services.AddSingleton<ISigner, FakeSigner>();
    services.AddSingleton(TimeProvider.System);
    var payments = services.AddHttpClient("payments");
    payments.AddStandardResilienceHandler();
    payments.AddHttpMessageHandler<SigningHandler>();

    using var sp = services.BuildServiceProvider();
    var handler = sp.GetRequiredService<IHttpMessageHandlerFactory>().CreateHandler("payments");

    var names = new List<string>();
    for (HttpMessageHandler? h = handler; h is not null; h = (h as DelegatingHandler)?.InnerHandler)
        names.Add(h.GetType().Name);

    Assert.True(names.IndexOf(nameof(ResilienceHandler)) < names.IndexOf(nameof(SigningHandler)));
}
```

Für einen Verhaltenstest ersetzen Sie den primären Handler durch einen Stub, der eine feste Anzahl von Malen fehlschlägt, dieselbe Technik wie beim [Unit-Testen von Code, der HttpClient verwendet](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/), und prüfen, dass die Aufrufanzahl Ihres Handlers der Anzahl der Versuche entspricht.

## Verwandte Artikel

- [Polly vs. Resilience-Handler in .NET 11](/de/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) erklärt die fünf Strategien in `AddStandardResilienceHandler` und ihre Reihenfolge.
- [Den Standard-Resilience-Handler überschreiben, den Aspire registriert](/de/2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers/), um den Handler pro Client zu entfernen und erneut hinzuzufügen.
- [HttpClient vs. HttpClientFactory vs. Refit](/de/2026/05/httpclient-vs-httpclientfactory-vs-refit/) behandelt, wie die Factory `DelegatingHandler`-Pipelines zusammensetzt.
- [TaskCanceledException beheben: A task was canceled in HttpClient](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/), wenn das Timeout pro Versuch und nicht Ihr Handler den Aufruf scheitern lässt.
- [Polly 8.8 lädt eine Resilience-Pipeline aus Ihrem eigenen IOptionsMonitor neu](/de/2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor/), falls Sie Retry-Einstellungen zur Laufzeit anpassen.

## Quellen

- [Make outgoing HTTP requests: outgoing request middleware](https://learn.microsoft.com/aspnet/core/fundamentals/http-requests#outgoing-request-middleware), Microsoft Learn
- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/dotnet/core/resilience/http-resilience), Microsoft Learn
- [`ResilienceHandler.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/ResilienceHandler.cs) in dotnet/extensions
- [`Microsoft.Extensions.Http.Resilience` auf NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Http.Resilience), getestete Versionen 10.10.0 und 8.10.0
- [`HttpContent.LoadIntoBufferAsync`](https://learn.microsoft.com/dotnet/api/system.net.http.httpcontent.loadintobufferasync), Microsoft Learn
