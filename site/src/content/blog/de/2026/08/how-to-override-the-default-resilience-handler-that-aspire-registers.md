---
title: "So überschreiben Sie den Standard-Resilience-Handler, den Aspire registriert"
description: "AddServiceDefaults von Aspire legt einen Standard-Resilience-Handler vor jeden HttpClient. Ein erneuter Aufruf von AddStandardResilienceHandler stapelt einen zweiten Handler, statt den ersten zu ersetzen. Hier sind die drei echten Wege zum Überschreiben, der undokumentierte Optionsname -standard und das unendliche Timeout, das Sie erben, wenn Sie den Handler nur entfernen."
pubDate: 2026-08-10
template: how-to
tags:
  - "aspire"
  - "dotnet"
  - "dotnet-11"
  - "httpclient"
  - "resilience"
  - "polly"
  - "how-to"
lang: "de"
translationOf: "2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers"
translatedBy: "claude"
translationDate: 2026-08-10
---

Das `AddServiceDefaults()` von Aspire ruft `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())` auf und legt damit Wiederholungen, einen Circuit Breaker, einen Rate Limiter und ein Gesamt-Anfrage-Timeout von 30 Sekunden vor jeden `HttpClient` im Prozess. Ein erneuter Aufruf von `AddStandardResilienceHandler()` auf einem Client ersetzt das nicht. Er stapelt einen zweiten Handler auf den ersten, sodass aus einer einzigen logischen Anfrage sechzehn physische werden können. Es gibt genau drei Wege, den Standard tatsächlich zu überschreiben: `ServiceDefaults/Extensions.cs` bearbeiten, sofern es Ihnen gehört, `RemoveAllResilienceHandlers()` auf dem betreffenden `IHttpClientBuilder` aufrufen, bevor Sie Ihren eigenen hinzufügen, oder die benannte Optionsinstanz umkonfigurieren, die der Standard-Handler liest und die buchstäblich `-standard` heißt.

Jedes Verhalten unten wurde durch Ausführen überprüft, nicht durch Lesen der Dokumentation. Der Testcode zielt auf `net10.0` mit SDK 10.0.201 und `Microsoft.Extensions.Http.Resilience` 10.8.0, also genau dem Paket, das die ServiceDefaults-Vorlage von Aspire 13.4.6 einbindet. Das Resilienzverhalten steckt in diesem Paket und nicht in Aspire selbst, deshalb gelten dieselben Regeln für jede Anwendung mit `IHttpClientFactory`, die `ConfigureHttpClientDefaults` verwendet.

## Was AddServiceDefaults tatsächlich vor Ihren HttpClient legt

Die generierte `ServiceDefaults/Extensions.cs` enthält Folgendes:

```csharp
// Aspire 13.4.6 ServiceDefaults template
public static TBuilder AddServiceDefaults<TBuilder>(this TBuilder builder)
    where TBuilder : IHostApplicationBuilder
{
    builder.ConfigureOpenTelemetry();
    builder.AddDefaultHealthChecks();
    builder.Services.AddServiceDiscovery();

    builder.Services.ConfigureHttpClientDefaults(http =>
    {
        // Turn on resilience by default
        http.AddStandardResilienceHandler();

        // Turn on service discovery by default
        http.AddServiceDiscovery();
    });

    return builder;
}
```

`AddStandardResilienceHandler()` setzt fünf Polly-v8-Strategien zusammen, von außen nach innen: einen Rate Limiter (1000 Permits, Queue 0), ein Gesamt-Anfrage-Timeout von 30 Sekunden, eine Wiederholungsstrategie (3 Wiederholungen, exponentielles Backoff mit Jitter, 2 Sekunden Basisverzögerung), einen Circuit Breaker (Fehlerquote 10 Prozent, Mindestdurchsatz 100, Abtastfenster 30 Sekunden, Unterbrechung 5 Sekunden) und ein Timeout pro Versuch von 10 Sekunden. Wiederholung und Circuit Breaking greifen bei HTTP 5xx, 408, 429, `HttpRequestException` und der `TimeoutRejectedException` von Polly.

In dieser Methode steht noch eine Zeile, die wichtiger ist als jeder Strategie-Standardwert:

```csharp
// ResilienceHttpClientBuilderExtensions.StandardResilience.cs, dotnet/extensions
// Disable the HttpClient timeout to allow the timeout strategies to control the timeout.
_ = builder.ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan);
```

Das Hinzufügen des Standard-Handlers schaltet `HttpClient.Timeout` vollständig ab und übergibt die Timeout-Verantwortung an die Polly-Strategien. Merken Sie sich das, denn es überlebt das Entfernen des Handlers. Ich komme im Abschnitt zu den Fallstricken darauf zurück.

## Warum ein zweiter Handler den ersten nicht ersetzt

Die Intuition, dass eine Registrierung pro Client eine Standardregistrierung überschreibt, ist hier falsch. `ConfigureHttpClientDefaults` und `AddHttpClient(name)` schreiben beide in dieselbe geordnete Liste `HttpClientFactoryOptions.HttpMessageHandlerBuilderActions`, und `AddStandardResilienceHandler` ruft letztlich `AddHttpMessageHandler` auf, das anhängt. Nichts dedupliziert.

Ich habe den Defaults-Block und danach einen Handler pro Client registriert und anschließend die konstruierte Handler-Kette über `IHttpMessageHandlerFactory.CreateHandler` abgelaufen:

```text
A stacked: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
           -> ResilienceHandler -> ResilienceHandler
           -> LoggingHttpMessageHandler -> SocketsHttpHandler
```

Zwei `ResilienceHandler`-Instanzen. Das ist kein kosmetisches Duplikat. Die äußere Wiederholungsstrategie erlaubt bis zu 4 Versuche, und jeder davon durchläuft die innere Wiederholungsstrategie mit eigenen bis zu 4 Versuchen. Aus einem Aufruf in Ihrem Code werden so bis zu 16 Anfragen gegen genau die Abhängigkeit, die Sie schützen wollten. Beide Rate Limiter belasten je ein Permit, und beide Circuit Breaker beobachten unterschiedliche Ausschnitte desselben Verkehrs. Das äußere 30-Sekunden-Gesamt-Timeout ist das Einzige, was die Sache begrenzt. Ergebnis ist eine Anfrage, die nach 30 Sekunden fehlschlägt, nachdem sie den nachgelagerten Dienst mit Anfragen bombardiert hat, statt des abgestimmten Verhaltens, das Sie konfiguriert zu haben glaubten.

Dasselbe passiert, wenn Sie `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())` selbst in `Program.cs` zusätzlich zu `AddServiceDefaults()` aufrufen. Ich habe es geprüft, und die Kette zeigt zwei Handler bei jedem Client im Prozess.

## Schritte zum Überschreiben des Standards ohne gestapelte Handler

1. **Legen Sie den Geltungsbereich fest.** Sollen die neuen Einstellungen für jeden ausgehenden Aufruf des Dienstes gelten, ändern Sie `ServiceDefaults/Extensions.cs`. Ist nur eine Abhängigkeit langsam oder nicht idempotent, machen Sie es pro Client und lassen den Standard unangetastet.
2. **Entfernen vor Hinzufügen.** Rufen Sie auf dem betreffenden `IHttpClientBuilder` zuerst `RemoveAllResilienceHandlers()` und danach `AddStandardResilienceHandler(...)` auf. Die Registrierungsreihenfolge innerhalb eines Builders entscheidet über das Ergebnis.
3. **Unterdrücken Sie `EXTEXP0001`.** `RemoveAllResilienceHandlers` ist mit `[Experimental]` annotiert, und die Diagnose ist ein Fehler, keine Warnung. Ohne `#pragma warning disable` oder einen `NoWarn`-Eintrag schlägt der Build fehl.
4. **Halten Sie die Timeouts konsistent.** `TotalRequestTimeout` muss größer sein als `AttemptTimeout`, und `CircuitBreaker.SamplingDuration` muss mindestens doppelt so groß sein wie `AttemptTimeout`, sonst wirft der Host beim Start eine Ausnahme.
5. **Prüfen Sie die Kette, nicht die Absicht.** Lösen Sie `IHttpMessageHandlerFactory` in einem Test auf und zählen Sie die `ResilienceHandler`-Instanzen in der konstruierten Pipeline.

## Änderung für den gesamten Dienst in ServiceDefaults

Wenn Ihnen `ServiceDefaults` gehört, ist das Bearbeiten des Blocks die ehrliche Lösung. Microsoft liefert genau diese Form in der Chat-Vorlage von `Microsoft.Extensions.AI` aus, wo der Ollama-Endpunkt regelmäßig Minuten für eine Antwort braucht und das Timeout von 10 Sekunden pro Versuch jede Anfrage töten würde:

```csharp
// Microsoft.Extensions.Http.Resilience 10.8.0, .NET 10
public static IServiceCollection AddOllamaResilienceHandler(this IServiceCollection services)
{
    services.ConfigureHttpClientDefaults(http =>
    {
#pragma warning disable EXTEXP0001 // RemoveAllResilienceHandlers is experimental
        http.RemoveAllResilienceHandlers();
#pragma warning restore EXTEXP0001

        http.AddStandardResilienceHandler(config =>
        {
            config.AttemptTimeout.Timeout = TimeSpan.FromMinutes(3);

            // Must be at least double the AttemptTimeout to pass options validation
            config.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(10);
            config.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(10);
        });
    });

    return services;
}
```

Beachten Sie, dass dies ein zweiter `ConfigureHttpClientDefaults`-Block ist, der nach `AddServiceDefaults()` aufgerufen wird. Das Entfernen läuft vor dem erneuten Hinzufügen, weil die Aktionen in Registrierungsreihenfolge ausgeführt werden. Netto bleibt ein Handler mit Ihren Einstellungen. Die Vorlage fügt in diesem Block außerdem `AddServiceDiscovery()` erneut hinzu, was unnötig ist: `RemoveAllResilienceHandlers` entfernt nur Handler vom Typ `ResilienceHandler`, und das erneute Hinzufügen von Service Discovery beschert Ihnen zwei Service-Discovery-Handler.

## Einen einzelnen Client überschreiben, ohne ServiceDefaults anzufassen

Das ist der Fall, der in der Praxis auftritt: eine Abhängigkeit ist langsam, oder ein Endpunkt ist ein `POST`, den Sie niemals wiederholen dürfen, und der Rest des Dienstes soll die Aspire-Standards behalten.

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.8.0
builder.AddServiceDefaults();

builder.Services.AddHttpClient("reports", client =>
    {
        client.BaseAddress = new Uri("https+http://reporting");
    })
#pragma warning disable EXTEXP0001
    .RemoveAllResilienceHandlers()
#pragma warning restore EXTEXP0001
    .AddStandardResilienceHandler(o =>
    {
        o.AttemptTimeout.Timeout = TimeSpan.FromMinutes(3);
        o.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(10);
        o.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(10);
        o.Retry.DisableForUnsafeHttpMethods();
    });
```

Zwei Punkte daran sind nicht offensichtlich.

Erstens spielt die Aufrufreihenfolge von `AddServiceDefaults()` und `AddHttpClient(...)` keine Rolle. `ConfigureHttpClientDefaults` fügt seine Registrierungen an einer nachverfolgten Position in der Service Collection ein, damit Standards immer vor der Konfiguration benannter Clients laufen. Ich habe den benannten Client zuerst und den Defaults-Block danach registriert, und der Client `reports` hatte trotzdem genau einen `ResilienceHandler` mit dem Drei-Minuten-Timeout pro Versuch, während ein unbeteiligter Client bei den 10 Sekunden Standard blieb. Innerhalb einer Builder-Kette spielt die Reihenfolge dagegen sehr wohl eine Rolle: Steht `RemoveAllResilienceHandlers()` nach `AddStandardResilienceHandler()` auf demselben Client, bleibt ein Client ganz ohne Resilienz übrig.

Zweitens schaltet `DisableForUnsafeHttpMethods()` Wiederholungen für `POST`, `PATCH`, `PUT`, `DELETE` und `CONNECT` ab. Der Standard-Handler wiederholt in der Voreinstellung jede Methode, was auf einem nicht idempotenten Endpunkt ein Datenduplikationsfehler mit Ansage ist. `DisableFor(HttpMethod.Post, HttpMethod.Delete)` liefert die engere Variante.

## Der undokumentierte Optionsname: `-standard`

`AddStandardResilienceHandler` verwendet nicht die Standard-Optionsinstanz. Es berechnet einen Optionsnamen als `$"{httpClientName}-{pipelineIdentifier}"` mit dem Bezeichner `standard` und liest diese benannte Instanz dann über `IOptionsMonitor<HttpStandardResilienceOptions>`. Für einen Client namens `slow` lautet der Optionsname `slow-standard`. Innerhalb von `ConfigureHttpClientDefaults` ist der `Name` des Builders null, die Zeichenketteninterpolation erzeugt also `-standard`, mit führendem Bindestrich und nichts davor.

Das hat eine scharfe Kante. Der `Configure<HttpStandardResilienceOptions>`-Aufruf, der richtig aussieht, tut nichts:

```csharp
builder.Services.ConfigureHttpClientDefaults(h => h.AddStandardResilienceHandler());
builder.Services.Configure<HttpStandardResilienceOptions>(o => o.Retry.MaxRetryAttempts = 9);
```

```text
options[''].MaxRetryAttempts          = 9
options['-standard'].MaxRetryAttempts = 3
```

Ihr Wert landet auf der unbenannten Instanz, die kein Handler je liest, und der Handler behält den Standardwert 3. Keine Ausnahme, kein Log-Eintrag. Wenn Sie schon einmal Resilienz "konfiguriert" und null Wirkung beobachtet haben, ist das mit ziemlicher Sicherheit der Grund. Es erklärt auch, warum der Standard-Handler gegen ein einfaches `Configure` immun ist, obwohl `HttpStandardResilienceOptions` eine ganz gewöhnliche Optionsklasse ist. Der [Unterschied zwischen den Options-Zugriffsschnittstellen](/de/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) ist hier nicht das Problem; der Name ist es.

Den Namen zu kennen eröffnet einen dritten Weg, nützlich, wenn Sie `ServiceDefaults` nicht bearbeiten können (ein geteiltes Paket, eine fremde Vorlage) und nicht jeden Client einzeln aufzählen wollen:

```csharp
// Retunes the handler that AddServiceDefaults already registered.
builder.Services.Configure<HttpStandardResilienceOptions>("-standard", o =>
{
    o.AttemptTimeout.Timeout = TimeSpan.FromSeconds(20);
    o.CircuitBreaker.SamplingDuration = TimeSpan.FromSeconds(60);
    o.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(90);
});
```

Das löst sich beim Start zu `attempt=00:00:20 total=00:01:30` auf, mit einem einzigen Handler in der Kette. Es ist ein Zeichenkettenliteral, das an ein Implementierungsdetail gekoppelt ist, also setzen Sie einen Kommentar daneben. Aber es funktioniert und stapelt nicht.

Für Einstellungen pro Client, die in die Konfiguration gehören statt in den Code, binden Sie stattdessen eine Section. `AddStandardResilienceHandler(IConfigurationSection)` ist eine echte Überladung, die an `.Configure(section)` auf der korrekt benannten Optionsinstanz weiterleitet:

```json
{
  "Resilience": {
    "Slow": {
      "AttemptTimeout": { "Timeout": "00:03:00" },
      "TotalRequestTimeout": { "Timeout": "00:10:00" },
      "CircuitBreaker": { "SamplingDuration": "00:10:00" },
      "Retry": { "MaxRetryAttempts": 2 }
    }
  }
}
```

```csharp
builder.Services.AddHttpClient("slow")
#pragma warning disable EXTEXP0001
    .RemoveAllResilienceHandlers()
#pragma warning restore EXTEXP0001
    .AddStandardResilienceHandler(builder.Configuration.GetSection("Resilience:Slow"));
```

Gebundene Werte kommen exakt so an, wie sie geschrieben wurden, und weil der Standard-Handler `context.EnableReloads` aufruft, baut das Bearbeiten dieser Werte in `appsettings.json` die Pipeline ohne Neustart neu auf.

## Die Fallstricke, die wirklich weh tun

**Falsche Timeouts scheitern beim Start, nicht bei der ersten Anfrage.** Beide Validatoren werden mit `AddOptionsWithValidateOnStart` registriert, eine Inkonsistenz wirft also beim Hochfahren des Hosts. Nur `AttemptTimeout` auf 3 Minuten zu setzen und den Rest unverändert zu lassen ergibt dies:

```text
Microsoft.Extensions.Options.OptionsValidationException: Total request timeout resilience
strategy must have a greater timeout than the attempt resilience strategy. Total Request
Timeout: 30s, Attempt Timeout: 180s; The sampling duration of circuit breaker strategy needs
to be at least double of an attempt timeout strategy’s timeout interval, in order to be
effective. Sampling Duration: 30s,Attempt Timeout: 180s
```

Die Verdopplungsregel ist ein fest verdrahteter Multiplikator von 2 in `HttpStandardResilienceOptionsCustomValidator`. Ein höheres `AttemptTimeout` bedeutet immer auch ein höheres `TotalRequestTimeout` und eine höhere `CircuitBreaker.SamplingDuration`. Wenn Sie diese Art von Prüfung für Ihre eigenen Einstellungen wollen, steht dieselbe Maschinerie über die [Validierung beim Start mit `IValidateOptions<T>`](/de/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/) bereit.

**Das Entfernen des Handlers lässt Sie ganz ohne Timeout zurück.** Das ist der schlimmste Punkt. `RemoveAllResilienceHandlers()` entfernt die `ResilienceHandler`-Instanzen, macht aber das `ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan)` nicht rückgängig, das `AddStandardResilienceHandler` registriert hat. Ein Client, der mit `AddHttpClient("bare").RemoveAllResilienceHandlers()` und ohne Ersatz gebaut wurde, ergibt:

```text
bare client chain:   LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
                     -> LoggingHttpMessageHandler -> SocketsHttpHandler
HttpClient('bare').Timeout = -00:00:00.0010000
```

Diese negative Millisekunde ist `Timeout.InfiniteTimeSpan`. Kein Resilience-Handler, keine 100 Sekunden `HttpClient`-Standard, überhaupt kein Timeout. Eine hängende Abhängigkeit blockiert nun Ihren Anfrage-Threadpool, bis das Cancellation Token feuert, das Sie hoffentlich übergeben haben. Wenn Sie den Handler entfernen und keinen neuen hinzufügen, setzen Sie `client.Timeout` explizit. Der verwandte Fehlerfall, bei dem ein Timeout tatsächlich auslöst, ist unter [warum HttpClient eine TaskCanceledException wirft](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) beschrieben.

**Das Entfernen ist typ-, nicht kettenbezogen.** Die Implementierung läuft die zusätzlichen Handler rückwärts durch und entfernt nur jene, auf die `is ResilienceHandler` zutrifft. Eigene `DelegatingHandler`-Typen, Auth-Handler und der Service-Discovery-Handler überleben alle. Ich habe es mit einem Marker-Handler im Defaults-Block bestätigt: nach `RemoveAllResilienceHandlers()` auf einem benannten Client ist der Marker weiterhin vorhanden. Fügen Sie Service Discovery nach einem Entfernen also nicht erneut hinzu.

**gRPC-Clients brauchen `Grpc.Net.ClientFactory` 2.64.0 oder neuer.** Der Standard-Handler zusammen mit einem älteren `AddGrpcClient` wirft `System.InvalidOperationException: The ConfigureHttpClient method isn't supported when creating gRPC clients`. Es gibt dafür eine Prüfung zur Buildzeit, unterdrückbar mit `<SuppressCheckGrpcNetClientFactoryVersion>`.

**`RemoveAllResilienceHandlers` ist experimentell.** `EXTEXP0001` wird vom Analyzer in `Microsoft.Extensions.Http.Resilience` 10.8.0 als Fehler ausgegeben, das Pragma ist also Pflicht und keine Kosmetik. Die API ist seit 9.0 formstabil, aber die Annotation heißt, dass das Team sich Änderungen vorbehält.

Die Regel, die das alles abdeckt: ein Resilience-Handler ist ein Message Handler, und Message Handler komponieren, statt zu ersetzen. Wenn das verinnerlicht ist, hört "wie überschreibe ich den Aspire-Standard" auf, ein Rätsel zu sein, und wird zu "entfernen, dann hinzufügen, in dieser Reihenfolge, auf dem richtigen Builder".

## Verwandte Beiträge

- [Polly vs Resilience-Handler in .NET 11](/de/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) erklärt, auf welcher Ebene Resilienz überhaupt konfiguriert gehört.
- [Aspire zu einer bestehenden ASP.NET Core-Solution hinzufügen](/de/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) behandelt, was `AddServiceDefaults()` sonst noch einschaltet.
- [HttpClient vs HttpClientFactory vs Refit](/de/2026/05/httpclient-vs-httpclientfactory-vs-refit/) dazu, wie die Handler-Kette überhaupt entsteht.
- [IOptions vs IOptionsSnapshot vs IOptionsMonitor in .NET 11](/de/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) zum Monitor, über den der Standard-Handler seine benannten Optionen liest.
- [Aspire vs Docker Compose für lokale Multi-Service-Entwicklung](/de/2026/08/aspire-vs-docker-compose-for-local-multi-service-development/), falls Sie noch überlegen, ob Aspire überhaupt infrage kommt.

## Quellen

- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) auf MS Learn, für die Standardwerte-Tabelle des Standard-Handlers und die bekannten Probleme.
- [`ResilienceHttpClientBuilderExtensions.StandardResilience.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/ResilienceHttpClientBuilderExtensions.StandardResilience.cs) in dotnet/extensions, für den Optionsnamen und das unendliche Client-Timeout.
- [`HttpStandardResilienceOptionsCustomValidator.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/Internal/Validators/HttpStandardResilienceOptionsCustomValidator.cs), für die genauen Validierungsregeln und Meldungen.
- [`OllamaResilienceHandlerExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/ProjectTemplates/Microsoft.Extensions.AI.Templates/templates/AIChatWeb-CSharp/AIChatWeb-CSharp.Web/OllamaResilienceHandlerExtensions.cs), Microsofts eigene Überschreibung des Aspire-Standards.
- [Aspire service defaults](https://aspire.dev/get-started/csharp-service-defaults/), für den generierten `AddServiceDefaults`-Quellcode.
