---
title: "Lösung: HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR'"
description: "Ein Peer hat für eine Anfrage RST_STREAM mit PROTOCOL_ERROR gesendet. HttpClient wiederholt sie nie. Finden Sie heraus, welcher Hop den Stream zurückgesetzt hat, korrigieren Sie die abgelehnte Anfrage, wiederholen Sie nur idempotente Aufrufe oder stellen Sie diesen Hop auf HTTP/1.1 um."
pubDate: 2026-10-21
template: error-page
tags:
  - "errors"
  - "httpclient"
  - "http2"
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2026/10/fix-the-http2-server-reset-the-stream-protocol-error-httpclient"
translatedBy: "claude"
translationDate: 2026-10-21
---

`HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1)` bedeutet, dass die Gegenseite der HTTP/2-Verbindung für Ihre Anfrage einen `RST_STREAM`-Frame mit dem Fehlercode 1 gesendet hat. `HttpClient` hat nichts kaputt gemacht, er meldet nur, was der Peer gesagt hat, und wiederholt ein `PROTOCOL_ERROR` nie von selbst. Die Lösung besteht darin, den Hop zu finden, der das Reset gesendet hat (Ihre Kestrel-App oder ein Proxy, Load Balancer oder Sidecar davor), zu beheben, was an dieser konkreten Anfrage abgelehnt wurde, idempotente Anfragen mit einem Resilience-Handler zu wiederholen und als letzten Ausweg mit dem fehlerhaften Hop HTTP/1.1 zu sprechen.

Alles unten wurde mit .NET 10.0.10 (SDK 10.0.302, ASP.NET Core 10.0.10) reproduziert, mit Kestrel und `HttpClient` in einer einzigen dateibasierten App, plus `Microsoft.Extensions.Http.Resilience` 10.0.0 für den Abschnitt zu Wiederholungen. Die relevanten Codepfade sind in .NET 8, 9 und 11 dieselben.

## Der Fehler im Kontext

Wenn das Reset vor den Antwort-Headern eintrifft, wirft `SendAsync` (oder `GetAsync`, `PostAsync`) eine `HttpRequestException`, die die `HttpProtocolException` umschließt:

```text
System.Net.Http.HttpRequestException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
 ---> System.Net.Http.HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
   at System.Net.Http.Http2Connection.ThrowRequestAborted(Exception innerException)
   at System.Net.Http.Http2Connection.Http2Stream.CheckResponseBodyState()
   at System.Net.Http.Http2Connection.Http2Stream.TryEnsureHeaders()
   at System.Net.Http.Http2Connection.Http2Stream.ReadResponseHeadersAsync(CancellationToken cancellationToken)
   at System.Net.Http.Http2Connection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at System.Net.Http.Http2Connection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(HttpRequestMessage request, Boolean async, Boolean doRequestAuth, CancellationToken cancellationToken)
   at System.Net.Http.RedirectHandler.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
```

Hat der Server bereits einen Statuscode gesendet und trifft das Reset beim Lesen des Bodys ein, ändert sich die äußere Meldung, die innere Exception bleibt identisch:

```text
System.Net.Http.HttpRequestException: Error while copying content to a stream.
 ---> System.Net.Http.HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
```

In beiden Fällen ist `HttpRequestException.HttpRequestError` gleich `HttpRequestError.HttpProtocolError` und `HttpProtocolException.ErrorCode` gleich `1`. Prüfen Sie im Code diese beiden Eigenschaften statt des Meldungstexts.

Auch die Formulierung "the HTTP/2 server reset the stream" ist wichtig, denn `SocketsHttpHandler` kennt drei verschiedene HTTP/2-Fehlermeldungen, und jede deutet auf ein anderes Problem:

| Meldung | Vom Client empfangener Frame | Umfang |
| --- | --- | --- |
| `The HTTP/2 server reset the stream. HTTP/2 error code '...'` | `RST_STREAM` | Nur diese eine Anfrage |
| `The HTTP/2 server closed the connection. HTTP/2 error code '...'` | `GOAWAY` mit einem Fehler | Jeder Stream auf dieser Verbindung |
| `The HTTP/2 server sent invalid data on the connection. HTTP/2 error code '...'` | keiner, der Client hat die Verletzung selbst erkannt | Die gesamte Verbindung |

Dieser Beitrag behandelt die erste Zeile. Sehen Sie die zweite oder dritte, ist die Verbindung selbst fehlerhaft, und die Diagnose ist eine andere.

## Warum das passiert

`PROTOCOL_ERROR` ist der generischste Code in [RFC 9113 Abschnitt 7](https://www.rfc-editor.org/rfc/rfc9113#section-7). Ein Peer sendet ihn als Stream-Fehler, wenn eine Anfrage (ihre Header, ihr Body oder ihre Framing-Struktur) gegen eine Regel verstößt und der Peer diese Anfrage ablehnen will, ohne die gemeinsame Verbindung abzubauen. Dieses Design erklärt, warum der Fehler "unter Last" zufällig wirkt: Eine HTTP/2-Verbindung trägt Hunderte gleichzeitiger Anfragen, das Reset trifft nur die eine Anfrage, die eine Prüfung ausgelöst hat, und der Rest gelingt. Mehr Traffic bedeutet mehr Anfragen mit der seltenen Eigenschaft, die die Prüfung auslöst, sodass die Fehlerrate mit der Last steigt, obwohl die Last nicht die Ursache ist.

Die Ursachen, geordnet danach, wie oft sie bei einem .NET-Client auftreten:

1. **Ein Proxy dazwischen hat etwas an dieser Anfrage abgelehnt.** Reverse Proxys, Service Meshes, Ingress-Controller und Cloud-Load-Balancer beenden alle HTTP/2 und validieren Anfragen nach eigenen Regeln: Header-Zeichen, die sie für ungültig halten, mehrzeilige Header-Werte, verbindungsspezifische Header, Größenlimits für Header oder Bodys. Echte Beispiele: Envoy, der Streams zurücksetzt, die [fehlerhafte Header-Zeichen](https://github.com/envoyproxy/envoy/issues/7061) enthalten, nginx, der bei einem [mehrzeiligen Header-Wert](https://github.com/nginx/nginx/issues/540) fehlschlägt, ohne etwas zu protokollieren, und Kestrel selbst, der [Pseudo-Header nach regulären Headern](https://github.com/dotnet/aspnetcore/issues/12190) ablehnt, die ein Envoy-Hop gesendet hat.
2. **Der Request-Body passte nicht zu seiner `Content-Length`.** Kestrel setzt den Stream mit `PROTOCOL_ERROR` zurück, wenn er mehr oder weniger DATA-Bytes als die angegebene Länge erhält (`Http2StreamErrorMoreDataThanLength` und `Http2StreamErrorLessDataThanLength` in [`Http2Stream.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Http2/Http2Stream.cs)). Ein .NET-`HttpClient` fängt seine eigene Abweichung vor dem Server ab (Sie erhalten `Sent 5 request content bytes, but Content-Length promised 50.`). Wenn Kestrel das protokolliert, handelt es sich also meist um einen Nicht-.NET-Client oder einen Proxy, der den Body umgeschrieben hat, ohne den Header anzupassen.
3. **Kestrel hat die Pseudo-Header der Anfrage abgelehnt.** Ein ungültiges `:method` oder `:path`, ein nicht passendes `:scheme`, ein fehlerhaftes `Host`/`:authority` oder ein falsch aufgebautes Extended CONNECT enden alle in `ResetAndAbort(..., Http2ErrorCode.PROTOCOL_ERROR)` in Kestrel. `HttpClient` baut diese Header selbst, Sie treffen darauf also nur über einen Proxy oder einen selbstgebauten Client.
4. **Anwendungscode hat den Stream zurückgesetzt.** Jede Middleware oder jeder Handler, der `IHttpResetFeature.Reset(1)` aufruft, erzeugt auf dem Client genau diesen Fehler. Das ist selten, aber manche Gateways und gRPC-Interceptoren tun es absichtlich, um eine "fehlerhafte Anfrage" zu signalisieren.

Eines ist meist *nicht* die Ursache: dass der .NET-Client fehlerhafte Header direkt an Kestrel sendet. In meiner Reproduktion kamen `TE: gzip`, `Connection: keep-alive` und ein 300 KB großer benutzerdefinierter Header, per h2c an Kestrel 10.0.10 gesendet, alle als normales `400 Bad Request` zurück, nicht als Reset. Sehen Sie `PROTOCOL_ERROR` gegen ein Kestrel-Backend, verdächtigen Sie zuerst das, was zwischen Client und Kestrel sitzt.

## Minimale Reproduktion

Der kleinste Weg, die exakte Exception zu reproduzieren, ist ein Kestrel-Endpunkt, der seinen eigenen Stream über `IHttpResetFeature` zurücksetzt. Aus Sicht des Clients ist das Byte für Byte dasselbe wie ein `RST_STREAM` eines Proxys.

```csharp
// .NET 10.0.10, C# 14. Run with: dotnet run repro.cs
#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=false
using System.Net;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;

var hits = 0;
var builder = WebApplication.CreateBuilder();
builder.Logging.ClearProviders();
// h2c (HTTP/2 without TLS) needs an HTTP/2-only endpoint
builder.WebHost.ConfigureKestrel(k => k.ListenLocalhost(5199, o => o.Protocols = HttpProtocols.Http2));
var app = builder.Build();
app.MapGet("/reset/{code:int}", (HttpContext ctx, int code) =>
{
    Interlocked.Increment(ref hits);
    ctx.Features.Get<IHttpResetFeature>()!.Reset(code); // 1 = PROTOCOL_ERROR, 7 = REFUSED_STREAM
    return Results.Empty;
});
await app.StartAsync();

var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version20,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact,
};

foreach (var code in new[] { 1, 7 })
{
    hits = 0;
    try { await client.GetAsync($"http://localhost:5199/reset/{code}"); }
    catch (HttpRequestException e) when (e.InnerException is HttpProtocolException p)
    {
        Console.WriteLine($"code {code}: {e.HttpRequestError}, ErrorCode={p.ErrorCode}, server hits={hits}");
        Console.WriteLine($"  outer: {e.Message}");
    }
}
await app.StopAsync();
```

Ausgabe:

```text
code 1: HttpProtocolError, ErrorCode=1, server hits=1
  outer: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
code 7: HttpProtocolError, ErrorCode=7, server hits=4
  outer: The request was aborted.
```

Die Spalte `server hits` ist der nützliche Teil. Ein Reset mit `PROTOCOL_ERROR` erreicht den Server einmal und wird an Sie weitergeworfen. Ein Reset mit `REFUSED_STREAM` wird von `SocketsHttpHandler` selbst wiederholt, weil RFC 9113 garantiert, dass der Peer einen abgelehnten Stream nicht verarbeitet hat. Der Pool gibt nach `MaxConnectionFailureRetries = 3` Wiederholungen auf, der Server sah also 4 Versuche. Die Quelle ist [`Http2Stream.OnReset`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/Http2Stream.cs), wo `canRetry` nur für `REFUSED_STREAM` und für Streams wahr ist, die ein `GOAWAY` als unverarbeitet markiert hat.

## Die Lösung im Detail

### 1. Herausfinden, welcher Hop das Reset gesendet hat

Der Client kann Ihnen nicht sagen, wer das `RST_STREAM` gesendet hat. Er weiß nur, dass der Frame vom Peer kam, mit dem er verbunden ist, also vom ersten HTTP/2-Hop: oft ein Proxy, nicht Ihr Dienst. Klären Sie das, bevor Sie Code ändern:

- **Aktivieren Sie die HTTP/2-Debug-Logs von Kestrel im Backend.** Kestrel protokolliert jeden Stream, den es zurücksetzt, in der Kategorie `Microsoft.AspNetCore.Server.Kestrel.Http2` auf Stufe `Debug`, mit Meldungen wie `HTTP/2 stream error "PROTOCOL_ERROR". A Reset is being sent to the stream.` (Event 35) und `HTTP/2 stream error.` (Event 30, mit der `Http2StreamErrorException` und dem genauen Grund, zum Beispiel `More data received than specified in the Content-Length header.`).

```json
// appsettings.Development.json, ASP.NET Core 10
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore.Server.Kestrel.Http2": "Debug",
      "Microsoft.AspNetCore.Server.Kestrel.BadRequests": "Debug"
    }
  }
}
```

- **Wenn Kestrel für die fehlgeschlagene Anfrage nichts protokolliert, kam das Reset von einem Zwischensystem.** Suchen Sie im Access-Log des Proxys im betreffenden Zeitfenster. Envoy kennzeichnet Resets in seinen Response Flags und in den Details `upstream_reset_before_response_started`, nginx protokolliert Header-Probleme auf Stufe `info` in seinem Error-Log (setzen Sie `error_log` auf `info`, um sie zu sehen), und Cloud-Load-Balancer stellen meist einen Reason-Code pro Anfrage bereit.
- **Umgehen Sie den Proxy einmal.** Rufen Sie das Backend direkt auf (Port-Forward, interne Adresse) mit derselben Anfrage. Verschwindet der Fehler, haben Sie bewiesen, welcher Hop verantwortlich ist.

### 2. Die vom Hop abgelehnte Anfrage korrigieren

Wissen Sie, welcher Hop und welche Regel, liegt die Lösung meist in der Anfrage, nicht im Transport. Protokollieren Sie Methode, Pfad, Header-Namen, Längen der Header-Werte und Body-Größe fehlgeschlagener Anfragen (nie die Werte von Auth-Headern) und vergleichen Sie sie mit erfolgreichen. Die üblichen Verdächtigen:

- Header-Werte mit Zeichen außerhalb des sichtbaren ASCII-Bereichs, eingebetteten Zeilenumbrüchen oder führenden/nachgestellten Leerzeichen, oft Benutzereingaben, die in einen benutzerdefinierten Header kopiert wurden. `HttpClient` blockiert CR, LF und NUL, aber strenge Proxys lehnen mehr ab.
- Header, die nur in HTTP/1.1 sinnvoll sind (`Connection`, `Keep-Alive`, `Proxy-Connection`, `Transfer-Encoding`, `Upgrade` und `TE` mit einem anderen Wert als `trailers`). `HttpClient` lässt Sie sie mit `TryAddWithoutValidation` hinzufügen, und Zwischensysteme dürfen einen Stream zurücksetzen, der sie trägt.
- Eine Anfrage, die größer ist als die Limits des Proxys: große Cookies, JWTs mit vielen Claims, große Bodys bei einem Proxy mit kleinen Puffern. Das sind die klassischen Fehler, die "nur bei manchen Benutzern" auftreten.
- Ein eigenes `HttpContent`, das `Headers.ContentLength` setzt und dann eine andere Anzahl Bytes schreibt, oder ein Proxy-Filter, der den Body komprimiert oder umschreibt. Das Nicht-.NET-Gegenstück dazu ist ein direktes `PROTOCOL_ERROR` von Kestrel.

### 3. Wiederholen, aber nur Anfragen, die sich gefahrlos wiederholen lassen

Stammt das Reset von Infrastruktur, die Sie nicht kontrollieren, fügen Sie eine Wiederholung hinzu. Ein Reset mit `PROTOCOL_ERROR` sagt nichts darüber, ob der Server die Anfrage verarbeitet hat (ein Proxy kann nach dem Weiterleiten zurücksetzen), beschränken Sie Wiederholungen daher auf idempotente Methoden. Mit `Microsoft.Extensions.Http.Resilience`:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.0.0
using System.Net;
using Microsoft.Extensions.Http.Resilience;
using Polly;

builder.Services.AddHttpClient("api", c =>
    {
        c.BaseAddress = new Uri("https://api.internal");
        c.DefaultRequestVersion = HttpVersion.Version20;
    })
    .AddResilienceHandler("h2-reset", pipeline =>
    {
        var retry = new HttpRetryStrategyOptions
        {
            MaxRetryAttempts = 2,
            Delay = TimeSpan.FromMilliseconds(50),
            ShouldHandle = args => ValueTask.FromResult(
                args.Outcome.Exception is HttpRequestException { HttpRequestError: HttpRequestError.HttpProtocolError }),
        };
        retry.DisableForUnsafeHttpMethods(); // never replay POST, PUT, PATCH, DELETE, CONNECT
        pipeline.AddRetry(retry);
    });
```

Gegen einen Endpunkt, der den ersten Versuch zurücksetzt und den zweiten beantwortet, lieferte ein `GET` über diesen Client `ok on attempt 2 via HTTP/2`, während ein `POST` nach einem einzigen Serverzugriff weiterhin das ursprüngliche `PROTOCOL_ERROR` warf. Wenn Sie bereits `AddStandardResilienceHandler` verwenden, behandelt dessen Standard-`ShouldHandle` eine `HttpRequestException` als vorübergehend und deckt diesen Fall ebenfalls ab, wiederholt aber jede Methode, solange Sie nicht `DisableForUnsafeHttpMethods()` auf `options.Retry` aufrufen. Beachten Sie, dass `DisableForUnsafeHttpMethods` `void` zurückgibt. Rufen Sie es also auf dem Options-Objekt auf, bevor Sie es an `AddRetry` übergeben, nicht in einer Fluent-Kette.

### 4. Den fehlerhaften Hop auf HTTP/1.1 umstellen

Stammt das Reset von einem Zwischensystem mit fehlerhafter oder übermäßig strenger HTTP/2-Implementierung, und Sie können es weder beheben noch aktualisieren, nehmen Sie HTTP/2 aus diesem Hop heraus. Auf dem Client:

```csharp
// .NET 10: ask for HTTP/1.1 for this client only
var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version11,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionOrLower,
};
```

In HTTP/1.1 gibt es keinen Stream, der zurückgesetzt werden könnte: Derselbe Endpunkt, der den Stream über HTTP/2 zurückgesetzt hat, antwortete in der Reproduktion mit `ok on attempt 2 via HTTP/1.1`. Sie verlieren das Multiplexing, rechnen Sie also unter Last mit mehr Verbindungen, und gRPC kann das gar nicht, weil es HTTP/2 voraussetzt. Betrachten Sie das als Workaround, zu dem ein Issue beim Proxy eröffnet wird, nicht als die Lösung.

## Stolperfallen und Varianten

- **`REFUSED_STREAM` sieht ähnlich aus, ist aber ein anderes Problem.** Die äußere Meldung lautet `The request was aborted.` mit der `HttpProtocolException` zu `REFUSED_STREAM` darin, und Sie sehen sie erst, nachdem der Handler bereits dreimal wiederholt hat. Sie bedeutet, dass der Server oder Proxy neue Streams ablehnt, typischerweise weil er sein Limit gleichzeitiger Streams erreicht hat oder gerade herunterfährt. Prüfen Sie `SETTINGS_MAX_CONCURRENT_STREAMS` auf dem Server und erwägen Sie `SocketsHttpHandler.EnableMultipleHttp2Connections = true`.
- **`HTTP_1_1_REQUIRED` auf einem lokalen h2c-Endpunkt.** Konfigurieren Sie Kestrel mit `HttpProtocols.Http1AndHttp2` auf einfachem `http://` und erzwingen HTTP/2 auf dem Client, erhalten Sie `The HTTP/2 server closed the connection. HTTP/2 error code 'HTTP_1_1_REQUIRED' (0xd).` Ohne TLS gibt es kein ALPN zum Aushandeln des Protokolls, h2c braucht also einen reinen `Http2`-Endpunkt.
- **Resets mitten im Body mit `ResponseHeadersRead`.** Wenn Sie die Antwort selbst streamen, wurde der Statuscode (oft `200`) bereits zurückgegeben, wenn das Reset eintrifft. Behandeln Sie einen Erfolgsstatus nicht als Beweis, dass der Body vollständig ist. Das Lesen wirft `Error while copying content to a stream.` oder direkt die `HttpProtocolException` (ohne `HttpRequestException`-Wrapper) aus `ReadAsync` auf dem Antwort-Stream.
- **Resilience-Handler können ein Reset mitten im Body nicht wiederholen.** Die Handler-Pipeline kehrt zurück, sobald die Antwort-Header eintreffen, und `HttpClient` puffert den Body danach. Ein Reset während des Bodys umgeht deshalb die Wiederholung aus Schritt 3, selbst mit dem Standard `ResponseContentRead`. Ist der Body wichtig, umschließen Sie den gesamten Vorgang "senden und lesen" für idempotente Aufrufe mit einer eigenen Wiederholung.
- **Der Peer hat die Verbindung geschlossen, statt zurückzusetzen.** Ist die innere Exception eine `HttpIOException` mit `ResponseEnded` statt einer `HttpProtocolException`, ist die Verbindung ohne HTTP/2-Frame gestorben. Das ist die Familie aus Keep-Alive und Idle-Timeout, die in [der Lösung zu "The response ended prematurely"](/de/2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient/) behandelt wird.
- **Timeouts sind keine Resets.** Hängt der Aufruf und schlägt dann mit `TaskCanceledException` fehl, hat nichts den Stream zurückgesetzt. Beginnen Sie mit [warum HttpClient "A task was canceled" wirft](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

## Verwandte Beiträge

- [Fix: HttpIOException "The response ended prematurely" in HttpClient](/de/2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient/) behandelt das Geschwister dieses Fehlers auf Verbindungsebene.
- [Polly vs resilience handlers in .NET 11](/de/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) erklärt, wo die obige Wiederholung hineinpasst und wie der Standard-Handler aufgebaut ist.
- [HttpClient vs IHttpClientFactory vs Refit](/de/2026/05/httpclient-vs-httpclientfactory-vs-refit/) zeigt, wie Sie den in diesem Beitrag verwendeten benannten Client konfigurieren.
- [Fix: The SSL connection could not be established](/de/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/) hilft, wenn der Fehler auftritt, bevor HTTP/2 überhaupt ausgehandelt wird.
- [gRPC in containers: 4 traps you can fix](/de/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/) behandelt die reinen HTTP/2-Transportprobleme, die gRPC zusätzlich mitbringt.

## Quellen

- [RFC 9113, HTTP/2: error codes (section 7) and stream errors (section 5.4.2)](https://www.rfc-editor.org/rfc/rfc9113#section-7)
- [`HttpProtocolException` class, Microsoft Learn](https://learn.microsoft.com/dotnet/api/system.net.http.httpprotocolexception)
- [`HttpProtocolException.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/HttpProtocolException.cs) und [`Http2Stream.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/Http2Stream.cs) in dotnet/runtime v10.0.0
- [Kestrel `Http2Stream.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Http2/Http2Stream.cs) und [`KestrelTrace.Http2.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Infrastructure/KestrelTrace.Http2.cs) in dotnet/aspnetcore v10.0.0
- [Build resilient HTTP apps, Microsoft Learn](https://learn.microsoft.com/dotnet/core/resilience/http-resilience)
- [envoyproxy/envoy#7061](https://github.com/envoyproxy/envoy/issues/7061), [nginx/nginx#540](https://github.com/nginx/nginx/issues/540), [dotnet/aspnetcore#12190](https://github.com/dotnet/aspnetcore/issues/12190)
