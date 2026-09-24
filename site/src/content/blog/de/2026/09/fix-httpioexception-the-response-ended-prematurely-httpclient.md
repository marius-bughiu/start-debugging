---
title: "Lösung: HttpIOException: The response ended prematurely bei HttpClient in .NET"
description: "HttpClient verwendet eine Keep-Alive-Verbindung wieder, die der Server gerade geschlossen hat, oder der Server bricht die Verbindung mitten in der Antwort ab. Setzen Sie PooledConnectionIdleTimeout unter das Idle-Timeout des Servers und wiederholen Sie nur idempotente Anfragen."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "httpclient"
  - "networking"
lang: "de"
translationOf: "2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient"
translatedBy: "claude"
translationDate: 2026-09-24
---

`HttpIOException: The response ended prematurely. (ResponseEnded)` bedeutet, dass die TCP-Verbindung geschlossen wurde, bevor `HttpClient` eine vollständige HTTP-Antwort erhalten hat. Die häufigste Ursache ist eine Keep-Alive-Race-Condition: `HttpClient` sendet eine Anfrage über eine gepoolte Verbindung genau in dem Moment, in dem der Server sie wegen Inaktivität schließt. Setzen Sie `SocketsHttpHandler.PooledConnectionIdleTimeout` deutlich unter das Idle-Timeout des Servers (oder des Load Balancers) und wiederholen Sie `ResponseEnded` nur bei Anfragen, die gefahrlos zweimal gesendet werden können. Tritt der Fehler bei jeder Anfrage auf, sprechen Sie mit dem falschen Gegenüber: `http://` gegen einen HTTPS-Port oder ein Docker-Port-Mapping, hinter dem nichts lauscht.

Alles Folgende wurde auf .NET 10.0.10 (SDK 10.0.302) und .NET 11 RC 1 (SDK 11.0.100-rc.1.26425.128) gegen kleine Raw-Socket-Server reproduziert, die sich absichtlich fehlerhaft verhalten. Beide Laufzeiten lieferten Byte für Byte identische Ergebnisse.

## Der Fehler im Kontext

Die Exception, die Sie an der Aufrufstelle sehen, ist fast immer eine `HttpRequestException`, die die `HttpIOException` umschließt:

```text
System.Net.Http.HttpRequestException: An error occurred while sending the request.
 ---> System.Net.Http.HttpIOException: The response ended prematurely. (ResponseEnded)
   at System.Net.Http.HttpConnection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at System.Net.Http.HttpConnection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(HttpRequestMessage request, Boolean async, Boolean doRequestAuth, CancellationToken cancellationToken)
   at System.Net.Http.RedirectHandler.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpClient.<SendAsync>g__Core|83_0(HttpRequestMessage request, HttpCompletionOption completionOption, CancellationTokenSource cts, Boolean disposeCts, CancellationTokenSource pendingRequestsCts, CancellationToken originalCancellationToken)
```

Es gibt drei Varianten der Meldung, und welche Sie erhalten, verrät, wo die Verbindung abgebrochen ist:

| Äußere Meldung | Innere Meldung | Bedeutung |
| --- | --- | --- |
| `An error occurred while sending the request.` | `The response ended prematurely. (ResponseEnded)` | EOF, bevor auch nur ein Byte der Statuszeile ankam |
| `Error while copying content to a stream.` | `The response ended prematurely. (ResponseEnded)` | Header kamen an, der Body wurde abgeschnitten (gepuffertes Lesen) |
| keine, `HttpIOException` wird direkt geworfen | `The response ended prematurely, with at least 90 additional bytes expected. (ResponseEnded)` | Body abgeschnitten, während Sie den Stream selbst gelesen haben |

HTTP/2-Verbindungen fügen eine vierte hinzu: `The response ended prematurely while waiting for the next frame from the server.` Seit .NET 8 sind `HttpRequestException.HttpRequestError` und `HttpIOException.HttpRequestError` in all diesen Fällen auf `HttpRequestError.ResponseEnded` gesetzt. Genau das sollte Ihr Code prüfen, statt Meldungstexte zu parsen.

## Warum das passiert

`SocketsHttpHandler` wirft `ResponseEnded` immer dann, wenn ein Lesevorgang vom Socket 0 Bytes zurückgibt (ein sauberes FIN von der Gegenseite), während noch Daten erwartet werden. Die Quelle sind zwei Zeilen in `HttpConnection.cs`: ein leerer Lesepuffer nach dem Senden der Anfrage oder `bytesRead == 0` innerhalb von `FillAsync`. Nichts in .NET hat beschlossen, zu scheitern. Die Gegenstelle hat die Verbindung geschlossen. Die Frage ist, warum, und die Ursachen, sortiert nach Häufigkeit, sind:

1. **Keep-Alive-Race-Condition.** Der Server (oder ein Proxy oder ein Cloud-Load-Balancer) schließt inaktive Verbindungen nach N Sekunden. `HttpClient` hält inaktive Verbindungen standardmäßig 60 Sekunden lang. Ist N kürzer, geht früher oder später eine Anfrage über eine Verbindung hinaus, die der Server genau in diesem Moment schließt. Das ist die sporadische Variante, die "in 99 % der Fälle funktioniert".
2. **Nichts Echtes lauscht.** Docker Desktop, `kubectl port-forward`, SSH-Tunnel und manche Reverse Proxies nehmen die TCP-Verbindung selbst an und schließen sie dann, wenn das Backend nicht da ist. Sie erhalten `ResponseEnded` statt `Connection refused`.
3. **Falsches Protokoll auf dem Port.** Wer einfaches `http://` an einen reinen TLS-Port sendet (eine häufige Verwechslung in der `launchSettings.json` von Kestrel), bringt den Server dazu, den Handshake abzubrechen und den Socket zu schließen.
4. **Der Server ist abgestürzt oder hat mitten in der Antwort aufgegeben.** Ein Prozess, der während des Streamings stirbt, ein Proxy, der ein Größen- oder Zeitlimit erreicht, oder ein Handler, der `Content-Length` höher setzt als das, was er schreibt. Das ergibt die Varianten aus der Body-Phase.

## Minimale Reproduktion

Diese dateibasierte App startet einen rohen TCP-Server, der die erste Anfrage auf jeder Verbindung beantwortet und die Verbindung schließt, ohne die zweite zu beantworten. Genau so sieht ein serverseitiges Idle-Timeout aus, das während Ihrer Anfrage auslöst.

```csharp
// .NET 10.0.10, C# 14. Run with: dotnet run repro.cs
using System.Net;
using System.Net.Sockets;
using System.Text;

var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
int port = ((IPEndPoint)listener.LocalEndpoint).Port;
int connections = 0;

_ = Task.Run(async () =>
{
    while (true)
    {
        var tcp = await listener.AcceptTcpClientAsync();
        int connectionId = Interlocked.Increment(ref connections);
        _ = Task.Run(async () =>
        {
            using (tcp)
            {
                var stream = tcp.GetStream();
                for (int requestNo = 1; ; requestNo++)
                {
                    if (!await ReadRequestAsync(stream)) return;
                    Console.WriteLine($"  server: connection {connectionId}, request {requestNo}");
                    if (requestNo == 2) return; // idle timeout fires: close, no response
                    await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"u8.ToArray());
                }
            }
        });
    }
});

using var client = new HttpClient();
foreach (var method in new[] { HttpMethod.Get, HttpMethod.Post })
{
    for (int i = 1; i <= 2; i++)
    {
        try
        {
            using var request = new HttpRequestMessage(method, $"http://127.0.0.1:{port}/");
            if (method == HttpMethod.Post) request.Content = new StringContent("{}");
            using var response = await client.SendAsync(request);
            Console.WriteLine($"{method} #{i}: {await response.Content.ReadAsStringAsync()}");
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"{method} #{i}: {ex.HttpRequestError} / {ex.InnerException?.Message}");
        }
    }
}

// Reads one request: headers up to the blank line, then Content-Length bytes of body.
static async Task<bool> ReadRequestAsync(NetworkStream stream)
{
    var data = new List<byte>();
    var buffer = new byte[8192];
    int headerEnd;
    while ((headerEnd = Encoding.ASCII.GetString(data.ToArray()).IndexOf("\r\n\r\n")) < 0)
    {
        int read = await stream.ReadAsync(buffer);
        if (read == 0) return false;
        data.AddRange(buffer.AsSpan(0, read));
    }
    var headers = Encoding.ASCII.GetString(data.ToArray(), 0, headerEnd);
    var lengthLine = headers.Split("\r\n")
        .FirstOrDefault(h => h.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase));
    int remaining = (lengthLine is null ? 0 : int.Parse(lengthLine[15..])) - (data.Count - headerEnd - 4);
    while (remaining > 0)
    {
        int read = await stream.ReadAsync(buffer);
        if (read == 0) return false;
        remaining -= read;
    }
    return true;
}
```

Ausgabe auf .NET 10.0.10 und .NET 11 RC 1:

```text
  server: connection 1, request 1
GET #1: ok
  server: connection 1, request 2
  server: connection 2, request 1
GET #2: ok
  server: connection 2, request 2
POST #1: ResponseEnded / The response ended prematurely. (ResponseEnded)
  server: connection 3, request 1
POST #2: ok
```

Lesen Sie die Serverzeilen. Auch `GET #2` traf auf die tote Verbindung (Verbindung 1, Anfrage 2), und `SocketsHttpHandler` hat sie stillschweigend über eine brandneue Verbindung 2 erneut gesendet. `POST #1` verwendete dann Verbindung 2 wieder, wurde auf dieselbe Weise abgewiesen und reichte die Exception nach oben durch. Der Handler sendet eine fehlgeschlagene Anfrage nur dann erneut, wenn sie über eine wiederverwendete gepoolte Verbindung ging und keinen Body hatte oder ihr Body durch `Expect: 100-continue` zurückgehalten wurde (das Flag `_canRetry` in `HttpConnection.SendAsync`). Ein `POST` mit Inhalt wird nie erneut gesendet, weil der Handler nicht wissen kann, ob der Server ihn bereits verarbeitet hat. Deshalb taucht dieser Fehler in den Logs bei Ihren Schreibvorgängen auf und fast nie bei Ihren Lesevorgängen.

## Lösung 1: inaktive Verbindungen kürzer halten als der Server

Die dauerhafte Lösung für die sporadische Variante besteht darin, dafür zu sorgen, dass `HttpClient` eine inaktive Verbindung verwirft, bevor der Server es tut. Ermitteln Sie das kürzeste Idle-Timeout auf dem Weg: den Dienst selbst, jeden Reverse Proxy und den Load Balancer. Einige reale Standardwerte:

- Kestrel `KeepAliveTimeout`: 130 Sekunden, länger als der Client-Standard, daher funktioniert .NET zu .NET ohne weitere Konfiguration.
- Node.js 26 `http.Server`: `keepAliveTimeout` 5 Sekunden, `keepAliveTimeoutBuffer` 1 Sekunde.
- uvicorn: `--timeout-keep-alive` 5 Sekunden. Gunicorn: `keepalive` 2 Sekunden.
- AWS Application Load Balancer: Idle-Timeout 60 Sekunden, identisch mit dem Client-Standard, was die Race Condition bei jeder Verbindung möglich macht, die etwa eine Minute lang inaktiv ist.

Konfigurieren Sie den Handler dann unterhalb dieses Werts. Mit `IHttpClientFactory`:

```csharp
// .NET 10, Microsoft.Extensions.Http 10.0.12
builder.Services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://orders.internal/"))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        // Server or load balancer closes idle connections after 60s (AWS ALB default).
        PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
        // Also recycle connections so DNS changes are picked up.
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    });
```

Lassen Sie echten Spielraum. `PooledConnectionIdleTimeout` wird nicht geprüft, wenn eine Verbindung aus dem Pool entnommen wird. Durchgesetzt wird es von einem Scavenger-Timer im Hintergrund, der alle `PooledConnectionIdleTimeout / 4` läuft, mit einer Untergrenze von einer Sekunde (`HttpConnectionPoolManager.cs`). Eine Verbindung kann daher bis etwa zum 1,25-Fachen des konfigurierten Idle-Timeouts leben, bei kleinen Werten bis zum Idle-Timeout plus eine Sekunde. Die Hälfte des Server-Timeouts ist eine sichere Faustregel.

Was bei der Entnahme tatsächlich geprüft wird, ist der eigene Antwort-Header `Keep-Alive: timeout=N` des Servers. `HttpConnection.PrepareForReuse` ruft `CheckKeepAliveTimeoutExceeded()` auf und verwirft die Verbindung, wenn sie N Sekunden oder länger inaktiv war, sowohl bei HTTP/1.1 als auch bei 1.0. Deshalb lösen Node.js-Dienste das Problem selten aus: Node kündigt `timeout=5` an und schließt tatsächlich nach 6. Wenn Ihnen der Server gehört, ist ein `Keep-Alive`-Header mit einem Wert unterhalb des echten Timeouts eine Lösung, die jeden Client schützt, nicht nur .NET-Clients.

Ich habe alle drei Optionen gegen einen Server gemessen, der Verbindungen nach genau 2.000 ms Inaktivität schließt, mit einem Client, der alle 1.990-2.010 ms einen `POST` sendet (jeweils 150 Anfragen, .NET 10.0.10):

| Client-/Server-Konfiguration | Erfolgreich | `ResponseEnded` |
| --- | --- | --- |
| Standardwerte (`PooledConnectionIdleTimeout` 60 s) | 147 | 3 |
| `PooledConnectionIdleTimeout = 800 ms` | 150 | 0 |
| Server sendet `Keep-Alive: timeout=1` | 150 | 0 |

Drei Fehler von 150 sind genau das, was diesen Fehler in Produktion so lästig macht: Er ist selten genug, um jeden Test zu bestehen, und häufig genug, um jemanden per Pager zu wecken. Meistens kommt das FIN des Servers vor der nächsten Anfrage an, und `PrepareForReuse` erkennt die geschlossene Verbindung und öffnet stillschweigend eine neue. Nur wenn das Schließen in den wenigen Millisekunden zwischen dieser Prüfung und dem Absenden der Anfrage erfolgt, wird der Fehler sichtbar. Beide Lösungen haben ihn vollständig beseitigt. Das Idle-Timeout von 800 ms funktioniert, weil der Scavenger (bei dieser Einstellung jede Sekunde) Verbindungen vor dem Server-Timeout von 2.000 ms verwirft. Der Header funktioniert, weil der Client ihn bei jeder Entnahme synchron prüft.

## Lösung 2: `ResponseEnded` wiederholen, aber nur, wenn ein zweiter Versuch sicher ist

Timeouts verringern die Race Condition, beseitigen können sie sie nicht: Ein Server kann trotzdem neu starten, herunterskalieren oder eine Verbindung aus eigenen Gründen verwerfen. Behandeln Sie `ResponseEnded` also als transient, mit einer Bedingung. Der Server hat die Anfrage möglicherweise empfangen und verarbeitet, bevor er den Socket geschlossen hat. Mein Reproduktionsserver hat den vollständigen Body jeder Anfrage gelesen, die er anschließend verworfen hat. Bei einem `POST`, der eine Bestellung anlegt, kann eine blinde Wiederholung zwei Bestellungen erzeugen.

`AddStandardResilienceHandler()` trifft diese Unterscheidung nicht für Sie. Sein Standard-`ShouldHandle` (`HttpClientResiliencePredicates.IsTransient`) behandelt jede `HttpRequestException` als transient, für jede HTTP-Methode. Rufen Sie entweder `options.Retry.DisableForUnsafeHttpMethods()` auf oder schreiben Sie ein Prädikat, das unsichere Methoden nur dann wiederholt, wenn die Anfrage einen Idempotenzschlüssel trägt, anhand dessen der Server dedupliziert:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddHttpClient<OrdersClient>()
    .AddResilienceHandler("stale-connection", pipeline => pipeline.AddRetry(new HttpRetryStrategyOptions
    {
        MaxRetryAttempts = 1,
        Delay = TimeSpan.Zero, // a new connection is all we need, no backoff
        ShouldHandle = args => ValueTask.FromResult(
            args.Outcome.Exception is HttpRequestException { HttpRequestError: HttpRequestError.ResponseEnded }
            && args.Context.GetRequestMessage() is { } request
            && (request.Method == HttpMethod.Get
                || request.Method == HttpMethod.Put
                || request.Method == HttpMethod.Delete
                || request.Headers.Contains("Idempotency-Key"))),
    }));
```

Und an der Aufrufstelle:

```csharp
// .NET 10
using var request = new HttpRequestMessage(HttpMethod.Post, "orders") { Content = JsonContent.Create(order) };
request.Headers.Add("Idempotency-Key", order.ClientRequestId.ToString());
using var response = await http.SendAsync(request, ct);
```

Gegen den Reproduktionsserver (der auf jeder Verbindung die zweite Anfrage verwirft) lieferten drei `POST`s mit diesem Handler alle `200 ok`, mit je einer Wiederholung für den zweiten und dritten. Der Server sah fünf Anfragen auf drei Verbindungen, und genau darum geht es: Die beiden verworfenen haben ihn erreicht. Wenn Ihre Wiederholung stattdessen in einem `DelegatingHandler` steckt, denken Sie daran, [wo dieser Handler relativ zur Retry-Schleife läuft](/de/2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler/), und lesen Sie [Polly vs. die eingebauten Resilience Handler](/de/2026/05/polly-vs-resilience-handlers-in-dotnet-11/), wenn Sie zwischen den beiden APIs entscheiden.

## Lösung 3: wenn es bei jeder einzelnen Anfrage fehlschlägt

Ein konsistentes `ResponseEnded` bei der ersten Anfrage eines frischen Prozesses ist keine Race Condition. Mein Test erzeugte für beide der folgenden Fälle exakt dieselbe Exception:

**`http://` gegen einen TLS-Endpunkt.** Ein Server, der nur TLS spricht, empfängt `GET / HTTP/1.1` als unbrauchbares ClientHello, bricht den Handshake ab und schließt. Prüfen Sie Schema und Port gegen `launchSettings.json` (das Standardprofil von Kestrel lauscht auf einem `https`-Port und einem `http`-Port, und man kombiniert leicht die falschen) oder gegen `ASPNETCORE_URLS`. Der umgekehrte Fehler, `https://` gegen einen einfachen HTTP-Port, führt stattdessen zu [the SSL connection could not be established](/de/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/).

**Ein Listener, hinter dem nichts steht.** Docker veröffentlicht Ports über einen eigenen Proxy. Wenn die App im Container auf `localhost` statt auf `0.0.0.0` lauscht (`ASPNETCORE_URLS=http://+:8080` behebt das für ASP.NET Core) oder abgestürzt ist, nimmt der Proxy Ihre Verbindung an und schließt sie sofort. Führen Sie `curl -v http://localhost:8080/` auf derselben Maschine aus. Meldet curl `Empty reply from server`, liegt das Problem nicht in Ihrem .NET-Code.

## Lösung 4: wenn der Body abgeschnitten wird

Lautet die äußere Meldung `Error while copying content to a stream.` oder lesen Sie den Stream selbst und sehen `with at least N additional bytes expected`, dann sind Statuszeile und Header angekommen und die Verbindung wurde mitten im Body geschlossen. Die Antwort findet sich in den serverseitigen Logs:

- Der Upstream-Prozess ist während des Streamings abgestürzt oder wurde beendet (OOM, eine Pod-Eviction, ein Deployment).
- Ein Proxy hat die Antwort an einem Größen- oder Zeitlimit abgeschnitten. nginx `proxy_read_timeout`, ein CDN-Antwortlimit oder eine Payload-Grenze eines API-Gateways enden alle so.
- Der Server hat eine `Content-Length` angegeben, die größer ist als die geschriebenen Bytes, meist durch eine Middleware, die den Body verändert hat (Komprimierung, Umschreiben), nachdem der Header gesetzt war. .NET meldet die Differenz exakt: 90 Bytes in meiner Reproduktion, bei der der Header 100 angab und der Server 10 sendete.
- Eine Chunked-Antwort endete ohne den abschließenden Chunk der Länge null, was ebenfalls die `copying content`-Variante erzeugt.

Einen abgeschnittenen Body zu wiederholen ist nur unter denselben Idempotenzregeln wie in Lösung 2 sicher, denn der Server hat diese Anfrage mit Sicherheit verarbeitet.

## Fallstricke und ähnliche Fehler

**`HttpRequestError` gibt es erst ab .NET 8.** Unter .NET 6 und 7 ist die innere Exception eine einfache `IOException` mit der Meldung `The response ended prematurely.`, und es gibt kein Enum, auf das man prüfen könnte. Das Keep-Alive-Verhalten und alle obigen Lösungen sind dieselben.

**`Connection reset by peer` ist dieselbe Race Condition, einen Schritt später.** Schließt der Server einen Socket, in dessen Empfangspuffer noch ungelesene Anfragedaten liegen, sendet der Kernel RST statt FIN, und Sie erhalten eine `HttpRequestException`, die `IOException: Unable to read data from the transport connection: Connection reset by peer` umschließt (`An existing connection was forcibly closed by the remote host` unter Windows). Die Lösungen sind identisch.

**`PooledConnectionIdleTimeout = TimeSpan.Zero` deaktiviert das Pooling.** Das macht die Race Condition zwar unmöglich, und in meinem Test wurde der fehlschlagende `POST` damit zum Erfolg, aber jede Anfrage bezahlt dann einen neuen TCP- (und TLS-)Handshake. Nutzen Sie es nur zur Diagnose: Verschwindet der Fehler damit, haben Sie die Keep-Alive-Race-Condition bestätigt.

**`TaskCanceledException` ist ein anderer Fehler.** Eine Anfrage, die `HttpClient.Timeout` erreicht, endet mit [a task was canceled](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/), nicht mit `ResponseEnded`. Sehen Sie beides, ist der Server vermutlich langsam, und etwas vor ihm schließt Verbindungen, die zu lange warten.

**Ein neuer `HttpClient` pro Anfrage behebt das nicht.** Er verdeckt die Keep-Alive-Race-Condition, indem er Verbindungen nie wiederverwendet, und tauscht sie unter Last gegen Socket-Erschöpfung ein. [HttpClient vs. HttpClientFactory vs. Refit](/de/2026/05/httpclient-vs-httpclientfactory-vs-refit/) behandelt die Lebensdauerregeln, die tatsächlich funktionieren.

## Verwandte Artikel

- [Lösung: TaskCanceledException: A task was canceled mit HttpClient](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/), das Timeout-Gegenstück zu diesem Fehler.
- [Lösung: The SSL connection could not be established](/de/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/), für die Schema-Verwechslung in die andere Richtung.
- [Warum ein DelegatingHandler mit AddStandardResilienceHandler nicht bei jeder Wiederholung läuft](/de/2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler/).
- [Polly vs. Resilience Handler in .NET 11](/de/2026/05/polly-vs-resilience-handlers-in-dotnet-11/).
- [Wie man Code testet, der HttpClient verwendet](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/), wenn Sie einen Test möchten, der `HttpRequestException` mit `HttpRequestError.ResponseEnded` wirft, um Ihr Retry-Prädikat abzudecken.

## Quellen

- [`HttpConnection.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/HttpConnection.cs) (`SendAsync`, `FillAsync`, `PrepareForReuse`, `CheckKeepAliveTimeoutExceeded`) und [`HttpConnectionPoolManager.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/HttpConnectionPoolManager.cs) (Scavenger-Intervall) im Branch `release/10.0` von dotnet/runtime.
- [`ContentLengthReadStream.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/ContentLengthReadStream.cs) und die [Ressourcen-Strings von System.Net.Http](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/Resources/Strings.resx) für die exakten Meldungen.
- [`HttpRequestError`-Enum](https://learn.microsoft.com/dotnet/api/system.net.http.httprequesterror) und [`SocketsHttpHandler.PooledConnectionIdleTimeout`](https://learn.microsoft.com/dotnet/api/system.net.http.socketshttphandler.pooledconnectionidletimeout) auf Microsoft Learn.
- [HttpClient-Richtlinien für .NET](https://learn.microsoft.com/dotnet/fundamentals/networking/http/httpclient-guidelines), zur Lebensdauer gepoolter Verbindungen und zur Wiederverwendung von Clients.
- [`HttpClientResiliencePredicates.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Polly/HttpClientResiliencePredicates.cs) und [`HttpRetryStrategyOptionsExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Polly/HttpRetryStrategyOptionsExtensions.cs) in dotnet/extensions.
- [Node.js `server.keepAliveTimeout`](https://nodejs.org/api/http.html#serverkeepalivetimeout) und [AWS-ALB-Verbindungs-Idle-Timeout](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html#connection-idle-timeout).
