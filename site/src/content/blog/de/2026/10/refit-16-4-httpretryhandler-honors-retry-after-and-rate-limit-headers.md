---
title: "Refit 16.4 bringt HttpRetryHandler mit, der die Rate-Limit-Header von GitHub, Azure und AWS liest"
description: "Refit 16.4.0 ergänzt einen optionalen HttpRetryHandler, der idempotente Anfragen wiederholt, Retry-After und anbieterspezifische Header wie x-ratelimit-reset und x-ms-retry-after-ms beachtet und weder Polly noch ein Resilience-Paket benötigt."
pubDate: 2026-10-18
tags:
  - "dotnet"
  - "refit"
  - "httpclient"
  - "resilience"
lang: "de"
translationOf: "2026/10/refit-16-4-httpretryhandler-honors-retry-after-and-rate-limit-headers"
translatedBy: "claude"
translationDate: 2026-10-18
---

[Refit 16.4.0](https://github.com/reactiveui/refit/releases/tag/v16.4.0) ist am 2026-10-17 erschienen, und die wichtigste Neuerung ist ein Retry-Handler im Kernpaket `Refit`. `HttpRetryHandler` ist ein gewöhnlicher `DelegatingHandler` und funktioniert daher für Refit-Clients ebenso wie für jeden normalen `HttpClient`, ohne Polly oder `Microsoft.Extensions.Http.Resilience` einzubinden.

Das ist nicht bloß eine weitere Schleife mit exponentiellem Backoff. Interessant ist, wie der Handler entscheidet, wie lange er wartet.

## Server-Hinweise haben Vorrang vor Backoff

Standardmäßig erlaubt der Handler drei Wiederholungen nach dem ersten Senden, allerdings nur für `GET`, `HEAD`, `OPTIONS` und `TRACE`. Wiederholt werden HTTP 408, 429, 500, 502, 503 und 504 sowie `HttpRequestException`. Ein 403 wird nur dann wiederholt, wenn der konfigurierte Delay-Reader einen gültigen Zeithinweis findet, und genau so signalisiert GitHub ein ausgeschöpftes primäres Rate Limit.

Die Wartezeit liefert ein `DelayProvider`. Der Standard liest den üblichen `Retry-After`-Header, und `RetryDelayProviders` bringt vier anbieterspezifische Reader mit:

- `Azure`: `x-ms-retry-after-ms`, dann `retry-after-ms`, dann `Retry-After`.
- `Aws`: `x-amz-retry-after` in Millisekunden, dann `Retry-After`.
- `GitHub`: `Retry-After` oder `x-ratelimit-reset` (Unix-Sekunden), wenn das verbleibende Kontingent bei einem 403 oder 429 null ist.
- `Jira`: `Retry-After` oder das ISO-8601-Feld `X-RateLimit-Reset` bei einem 429.

Fehlt ein gültiger Hinweis, greift der Handler auf exponentiellen Backoff zurück, beginnend bei einer Sekunde, begrenzt auf 30 Sekunden, mit Full Jitter. Jitter verkürzt nie einen Server-Hinweis, und ein Hinweis oberhalb von `MaxDelay` führt dazu, dass der Handler die Antwort zurückgibt, statt zu früh erneut zu senden.

## Einbindung in einen Refit-Client

Mit `Refit.HttpClientFactory` kommt der Handler wie jeder andere Message-Handler in die Kette:

```csharp
using Refit;

services.AddRefitGeneratedClient<IGitHubApi>()
    .ConfigureHttpClient(static client =>
        client.BaseAddress = new Uri("https://api.github.com"))
    .AddHttpMessageHandler(static () => new HttpRetryHandler(new HttpRetryOptions
    {
        MaxRetries = 3,
        DelayProvider = RetryDelayProviders.GitHub,
        MaxDelay = TimeSpan.FromMinutes(2),
    }));
```

Die Factory-Lambda sollte wie oben jedes Mal einen neuen Handler zurückgeben. Handler-Instanzen gehören zu genau einer Pipeline.

Verwendet Ihre API einen anderen Header, parst `RetryDelayProviders.ReadHeader` Sekunden, Millisekunden, Unix-Zeitstempel oder Datumswerte für Sie:

```csharp
var options = new HttpRetryOptions
{
    DelayProvider = static (response, now, ct) =>
        RetryDelayProviders.ReadHeader(
            response, "X-Throttle-Reset", RetryHeaderFormat.UnixTimeSeconds, now, ct),
};
```

## Die Sicherheitsvorkehrungen

`POST`, `PUT`, `PATCH` und `DELETE` werden nur wiederholt, wenn Sie `RetryUnsafeMethods = true` setzen, und das sollten Sie nur für Endpunkte tun, die einen Idempotency Key akzeptieren. Jeder Versuch ist eine neue `HttpRequestMessage` mit kopierten Headern und Optionen. Der Body wird einmal gepuffert, mit einem Standardlimit von 1 MiB (`MaxRequestContentBufferSize`), daher passen unbegrenzte Streaming-Uploads schlecht dazu.

Zwei Details zur Reihenfolge sind wichtig. Ein Auth-Handler innerhalb des Retry-Handlers läuft bei jedem Versuch, was bei erneuerten Tokens genau richtig ist. Und `HttpClient.Timeout` deckt den gesamten Aufruf ab, einschließlich der Wartezeiten zwischen den Wiederholungen. Ein Standard-Timeout von 100 Sekunden kann also ein zweiminütiges Reset-Fenster von GitHub vorzeitig abschneiden.

Kombinieren Sie das nicht mit `AddStandardResilienceHandler`. Wählen Sie eine einzige Retry-Schicht. Wenn Sie bereits die Resilience-Pipeline von Microsoft nutzen, behalten Sie sie. Wenn Sie einen kleinen Refit-Client haben, der sich gegenüber einer API mit Rate Limit einfach höflich verhalten soll, ist das jetzt eine Änderung von zwei Zeilen.

Für Tests ergänzt `Refit.Testing` die Helfer `RetryReply.After`, `RetryReply.Header` und `StubHttp.CreateRetryHandler`, alle über `TimeProvider` gesteuert, sodass sich die Wartezeiten ohne Schlafen prüfen lassen.

Das Release bringt außerdem `[Query(Name = "client_id")]` und `[Url(AllowRelative = true)]` und behebt Routen- und Query-Parameter, die sich nur in der Groß- und Kleinschreibung unterscheiden. Es ist das größte Refit-Update, seit [16.1 begann, die Paging-Schleife mit PagedEnumerable zu generieren](/de/2026/09/refit-16-1-generates-the-paging-loop-with-pagedenumerable/).
