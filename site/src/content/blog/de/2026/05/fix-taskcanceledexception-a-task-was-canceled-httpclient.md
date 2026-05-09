---
title: "Fix: TaskCanceledException: A task was canceled in HttpClient"
description: "HttpClient wirft TaskCanceledException aus drei verschiedenen Gründen: Timeout, Abbruch durch den Aufrufer oder Verbindungsabbruch. Unterscheiden Sie sie über InnerException und CancellationToken.IsCancellationRequested und beheben Sie dann die richtige Ursache."
pubDate: 2026-05-09
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "httpclient"
  - "cancellation"
lang: "de"
translationOf: "2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient"
translatedBy: "claude"
translationDate: 2026-05-09
---

Die Lösung: `HttpClient` löst `TaskCanceledException` (eine Unterklasse von `OperationCanceledException`) aus drei verschiedenen Ursachen aus, und Sie müssen diese unterscheiden, bevor Sie handeln können. Wenn `ex.InnerException is TimeoutException`, hat die Anfrage `HttpClient.Timeout` (Standard 100 Sekunden) erreicht, also erhöhen Sie das Timeout oder verlagern Sie langlaufende Aufrufe auf eine `CancellationTokenSource` pro Anfrage. Wenn Ihr eigenes `CancellationToken` abgebrochen wurde (`ex.CancellationToken.IsCancellationRequested == true`), bricht der Aufrufer ab, hier ist nichts weiter zu tun, als die Ausnahme weiterzureichen. Wenn keines davon zutrifft, liegt ein Abbruch auf Transportebene vor (DNS, TCP, TLS, Server-Reset), was meist auf die Infrastruktur und nicht auf Ihren Code hinweist.

```text
System.Threading.Tasks.TaskCanceledException: The request was canceled due to the configured HttpClient.Timeout of 100 seconds elapsing.
 ---> System.TimeoutException: The operation was canceled.
 ---> System.Threading.Tasks.TaskCanceledException: The operation was canceled.
   at System.Threading.Tasks.TaskCompletionSource`1.TrySetCanceled(CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(...)
   at System.Net.Http.HttpClient.<SendAsync>g__Core|...
   at MyApp.Program.<Main>$(String[] args)
```

Dieser Leitfaden bezieht sich auf .NET 11 Preview 4 und `System.Net.Http` 11.0.0-preview.4. Der Ausnahmetyp und die Form der eingebetteten `TimeoutException` haben sich seit .NET 5 nicht geändert, aber der Meldungstext wurde in .NET 8 verschärft, um zu benennen, welches Timeout ausgelöst wurde ("The request was canceled due to the configured `HttpClient.Timeout` of 100 seconds elapsing"). Auf .NET 6 und früher erhielten Sie nur das generische "A task was canceled.", weshalb so viele Ratschläge vor 2024 empfehlen, die Inner Exception manuell zu protokollieren.

## Warum HttpClient für alles TaskCanceledException wirft

Die Pipeline von `HttpClient.SendAsync` basiert auf `Task` und einem einzigen `CancellationToken`-Parameter. Das Timeout, das Token des Aufrufers und der interne Verbindungsabbruch werden alle in einer einzigen `CancellationTokenSource` verknüpft, bevor die Anfrage auf den Socket geht. Wenn eine dieser Quellen auslöst, wird der Vorgang mit demselben `OperationCanceledException`-Fehler abgeschlossen, unabhängig davon, welche zuerst ausgelöst hat.

Microsoft hat diese Designentscheidung in [dotnet/runtime#21965](https://github.com/dotnet/runtime/issues/21965) bestätigt: das Timeout wird nicht direkt als `TimeoutException` zurückgegeben, da eine Änderung des Typs ein binär-brechender Eingriff wäre. Stattdessen hat .NET 5 eine `InnerException` vom Typ `TimeoutException` ergänzt, damit Aufrufer die Fälle unterscheiden können, und .NET 8 hat den expliziten Meldungstext hinzugefügt. Die `CancellationToken`-Eigenschaft der Ausnahme, die von der Laufzeit gesetzt wird, ist der zweite Unterscheidungspunkt.

Dieselbe Ausnahme deckt also drei völlig unterschiedliche Probleme ab. Bei "task was canceled" zu handeln, ohne zu prüfen, in welchem Fall Sie sich befinden, ist der häufigste Grund, warum dieser Bug wochenlang ungelöst bleibt.

## Eine minimale Reproduktion für jede Ursache

```csharp
// .NET 11, C# 14, System.Net.Http 11.0.0-preview.4
using System.Net.Http;

// Cause 1: HttpClient.Timeout elapsed
using var c1 = new HttpClient { Timeout = TimeSpan.FromMilliseconds(50) };
try
{
    await c1.GetAsync("https://httpbin.org/delay/3");
}
catch (TaskCanceledException ex)
{
    Console.WriteLine($"Inner: {ex.InnerException?.GetType().Name}");
    // Inner: TimeoutException
}

// Cause 2: caller's CancellationToken cancelled
using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
using var c2 = new HttpClient();
try
{
    await c2.GetAsync("https://httpbin.org/delay/3", cts.Token);
}
catch (TaskCanceledException ex)
{
    Console.WriteLine($"Token cancelled: {ex.CancellationToken.IsCancellationRequested}");
    Console.WriteLine($"Linked token: {cts.Token == ex.CancellationToken}");
    // Token cancelled: True
}

// Cause 3: connection-level abort (DNS/TCP/TLS) - simulated with a closed port
using var c3 = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
try
{
    await c3.GetAsync("http://10.255.255.1/");
}
catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException)
{
    Console.WriteLine("Looks like a timeout, was actually connect failure under timeout.");
}
catch (HttpRequestException ex)
{
    Console.WriteLine($"True transport failure: {ex.HttpRequestError}");
    // .NET 8+ exposes ex.HttpRequestError = ConnectionError, NameResolutionError, etc.
}
```

Der dritte Fall ist interessant. Wenn das Connect-Timeout erreicht wird, erhalten Sie `HttpRequestException` mit `ex.HttpRequestError == HttpRequestError.ConnectionError`. Wenn der Connect erfolgreich ist, die Antwort aber lange genug stockt, um `HttpClient.Timeout` auszulösen, sind Sie wieder bei Fall 1. Beide sehen in Logs nahezu identisch aus, benötigen aber unterschiedliche Lösungen.

## Lösung im Detail

### 1. Erst diagnostizieren, mit einem Exception-Filter

Bevor Sie ein Timeout ändern, protokollieren Sie, in welchem Fall Sie sich befinden. Sonst erhöhen Sie `Timeout` auf 5 Minuten und stellen fest, dass das eigentliche Problem ein Aufrufer war, der abgebrochen hat.

```csharp
// .NET 11, C# 14
try
{
    return await client.GetAsync(url, ct);
}
catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException)
{
    logger.LogWarning(ex,
        "HttpClient.Timeout elapsed for {Url} (configured: {Timeout})",
        url, client.Timeout);
    throw;
}
catch (OperationCanceledException ex) when (ct.IsCancellationRequested)
{
    logger.LogInformation("Caller cancelled request to {Url}", url);
    throw;
}
catch (TaskCanceledException ex)
{
    logger.LogError(ex, "Unknown cancellation cause for {Url}", url);
    throw;
}
```

`OperationCanceledException` ist der Basistyp und das, was Sie für den Zweig "Aufrufer hat abgebrochen" möchten, da der genaue Laufzeittyp je nach Stelle in der Pipeline, an der der Abbruch ausgelöst wurde, `OperationCanceledException` oder `TaskCanceledException` sein kann.

### 2. HttpClient.Timeout erhöhen, aber nur für Clients, die es brauchen

`HttpClient.Timeout` gilt pro Client und für jede Anfrage, die kein eigenes Token mit eigenem Timeout übergibt. Der Standardwert von 100 Sekunden ist für typische REST-Aufrufe in Ordnung. Wenn Sie einen langlaufenden Endpunkt haben, geben Sie ihm einen dedizierten Client.

```csharp
// .NET 11
builder.Services.AddHttpClient("LongRunning", c =>
{
    c.Timeout = TimeSpan.FromMinutes(10);
    c.BaseAddress = new Uri("https://reports.example.com/");
});

builder.Services.AddHttpClient("Default", c =>
{
    c.Timeout = TimeSpan.FromSeconds(30);
});
```

Erhöhen Sie `Timeout` nicht am globalen Client, nur damit ein langsamer Aufruf funktioniert. Sie verbergen damit zukünftige Regressionen: ein Aufruf, der 200 ms dauern sollte, aber plötzlich 90 s braucht, passiert die gelockerte Schranke unbemerkt und zeigt sich als hängende UI. Engere Timeouts erkennen Performance-Regressionen früh. Die [Anleitung zum Unit-Testen von HttpClient](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/) zeigt, wie Sie diese Timeout-Grenzen in Tests durchspielen, damit eine Regression hier nicht durch CI rutscht.

### 3. Auf CancellationTokenSource pro Anfrage umstellen für feine Steuerung

`HttpClient.Timeout` ist ein grobes Werkzeug. Innerhalb eines `BackgroundService` oder einer Anfrage-Pipeline, die bereits ein Token hat, verknüpfen Sie sie:

```csharp
// .NET 11, C# 14
using var perCallCts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
using var linked = CancellationTokenSource.CreateLinkedTokenSource(
    perCallCts.Token, requestAborted);

try
{
    var response = await client.GetAsync(url, linked.Token);
    return await response.Content.ReadAsStringAsync(linked.Token);
}
catch (OperationCanceledException) when (perCallCts.IsCancellationRequested
                                          && !requestAborted.IsCancellationRequested)
{
    // Per-call timeout, not caller cancellation. Surface as your own timeout type.
    throw new TimeoutException($"GET {url} exceeded 15 seconds.");
}
```

Dieses Muster lässt sich sauber mit `IHttpClientFactory` kombinieren: setzen Sie das `Timeout` des Named Client hoch (oder auf `Timeout.InfiniteTimeSpan`) und erzwingen Sie das eigentliche Budget an der Aufrufstelle mit dem verknüpften CTS. Der Grund, warum `Timeout.InfiniteTimeSpan` hier funktioniert: `HttpClient` fügt sein `Timeout` nur dann zum verknüpften Token hinzu, wenn es positiv ist, ein unendliches Client-`Timeout` bedeutet also "der Aufrufer hat die Kontrolle". Die [Anleitung zum Cancellation-Deadlock](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) behandelt das Linked-Token-Muster ausführlicher, einschließlich der Unterscheidung von Timeouts und Aufrufer-Abbrüchen auf höheren Ebenen.

### 4. HttpCompletionOption.ResponseHeadersRead für streamende Bodies verwenden

`HttpClient.Timeout` deckt die Zeit von `SendAsync` bis "bereit zum Lesen des Body" nur dann ab, wenn der Standardwert `HttpCompletionOption.ResponseContentRead` verwendet wird. Mit `ResponseHeadersRead` gilt das Timeout nur bis zum Empfang der Header. Das Lesen des Body müssen Sie selbst zeitlich begrenzen, wie in [der HttpCompletionOption-Dokumentation](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpcompletionoption) bestätigt.

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));
using var response = await client.GetAsync(
    url, HttpCompletionOption.ResponseHeadersRead, cts.Token);

response.EnsureSuccessStatusCode();
await using var stream = await response.Content.ReadAsStreamAsync(cts.Token);
await using var file = File.Create(path);
await stream.CopyToAsync(file, cts.Token);
```

Geben Sie überall dasselbe Token weiter. Ein verbreiteter Fehler ist, `cts.Token` an `GetAsync` zu übergeben, es aber bei `CopyToAsync` zu vergessen. Dann gilt `HttpClient.Timeout` nicht mehr für den Body, und ein stockender Producer hängt für immer. Der [Beitrag zu Streaming aus ASP.NET Core](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) behandelt den symmetrischen serverseitigen Fehler, bei dem das Vergessen, das `CancellationToken` der Anfrage weiterzureichen, dasselbe Hängen auf der Producer-Seite verursacht.

### 5. Connect-Timeout separat konfigurieren ab .NET 8

`HttpClient.Timeout` deckt die gesamte Anfrage ab, aber DNS und TCP-Connect sind Teil dieses Budgets. Wenn DNS oder Connect unabhängig vom Anfrage-Timeout schnell scheitern sollen, setzen Sie `SocketsHttpHandler.ConnectTimeout`:

```csharp
// .NET 11, C# 14
var handler = new SocketsHttpHandler
{
    ConnectTimeout = TimeSpan.FromSeconds(5),
    PooledConnectionLifetime = TimeSpan.FromMinutes(2),
};

builder.Services.AddHttpClient("Api", c =>
{
    c.Timeout = TimeSpan.FromSeconds(30);
    c.BaseAddress = new Uri("https://api.example.com/");
}).ConfigurePrimaryHttpMessageHandler(() => handler);
```

Ein kurzes Connect-Timeout verwandelt "30 Sekunden auf nichts warten" in "in 5 Sekunden scheitern, anderen Endpunkt versuchen". Connect- von Response-Timeouts zu unterscheiden, ist der Unterschied zwischen einem Polly-Circuit-Breaker, der schnell öffnet, und einem, der jeden Aufrufer durch das volle Timeout-Fenster zieht.

## Häufige Konstellationen, die diesen Fehler auslösen

### IHttpClientFactory typed client mit dem falschen Timeout

Ein Typed Client übernimmt das `Timeout`, das Sie in `AddHttpClient` konfiguriert haben, nicht die Eigenschaft, die Sie später am `HttpClient` setzen. Code, der `_client.Timeout = TimeSpan.FromMinutes(5)` aus dem Konstruktor setzt, wirft `InvalidOperationException`, sobald bereits eine Anfrage durch den Client gegangen ist. Die Factory recycelt den darunterliegenden Handler, aber die `HttpClient`-Instanz ist für `Timeout`-Zwecke einmalig nutzbar. Konfigurieren Sie das Timeout in `AddHttpClient`, nicht im Konstruktor des Typed Client.

### Ein Task.WhenAll mit nicht passenden Tokens

Wenn Sie N HTTP-Aufrufe mit `Task.WhenAll(tasks)` aufächern und einer abbricht, wirft nur dieser eine. Die übrigen laufen weiter und können ebenfalls in Timeouts laufen. Wenn Ihr Code den ersten Abbruch weiterwirft, werden die überlebenden Tasks unbeobachtet, und ihre Ausnahmen tauchen in `TaskScheduler.UnobservedTaskException` auf. Verwenden Sie `Task.WhenAll` mit einem gemeinsamen verknüpften CTS, das Sie beim ersten Fehler abbrechen, damit die übrigen Anfragen ebenfalls stoppen.

### Eine Polly-Retry-Policy verbirgt das innere Timeout

Ein Polly-Retry-Handler, der `TaskCanceledException` schluckt und erneut versucht, kann das zugrundeliegende Timeout vollständig maskieren. Wenn das Upstream-System tatsächlich langsam ist, machen Sie aus einer 100-Sekunden-Wartezeit drei davon, und geben dann auf. Konfigurieren Sie Polly so, dass es bei innerer `TimeoutException` abbricht und der Aufrufer entscheiden lässt.

```csharp
// .NET 11, Microsoft.Extensions.Http.Resilience 11.0.0-preview.4
builder.Services.AddHttpClient("Api")
    .AddStandardResilienceHandler(options =>
    {
        options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(10);
        options.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(30);
        options.Retry.ShouldHandle = args => args.Outcome switch
        {
            { Exception: HttpRequestException } => PredicateResult.True(),
            { Exception: TaskCanceledException tce } when tce.InnerException is TimeoutException
                => PredicateResult.False(),
            _ => PredicateResult.False(),
        };
    });
```

`AddStandardResilienceHandler` aus dem Paket `Microsoft.Extensions.Http.Resilience` trennt Per-Attempt- und Total-Request-Timeouts sauber, was der saubere Ersatz für selbstgebauten Polly- plus-Linked-CTS-Code ist.

### Synchrones Wait oder Result auf einem HttpClient-Aufruf

`client.GetAsync(url).Result` führt unter einem singlethreaded Sync-Kontext (klassisches ASP.NET, WPF) zum Deadlock und zeigt sich als `TaskCanceledException`, wenn `HttpClient.Timeout` schließlich nach 100 Sekunden auslöst. Die Lösung lautet `await`, Punkt. Der Deadlock sorgt dafür, dass die Anfrage die Response-Phase nie beginnt, der Timer schließlich auslöst, und das Symptom sieht aus wie ein Netzwerk-Timeout. Wenn Sie "task was canceled" ohne ausgehenden Netzwerkverkehr in Ihren Traces sehen, suchen Sie im Aufrufstapel nach blockierenden synchronen Aufrufen. Der [Beitrag zum BackgroundService-Muster](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/) behandelt die Async-bis-ganz-unten-Regel für Hosted Services, wo dieser Fehler am stärksten beißt.

### Wiederverwendung von HttpRequestMessage

`HttpRequestMessage` kann nicht zweimal gesendet werden. Das zweite `SendAsync` wirft `InvalidOperationException: The request message was already sent`. Manche Retry-Bibliotheken übertünchen das, und der Fehler zeigt sich als Abbruch einer anderen Anfrage, die ein Token mit der scheiternden geteilt hat. Erstellen Sie immer eine neue `HttpRequestMessage` pro Versuch.

## Varianten, die wie dieser Fehler aussehen, es aber nicht sind

### "The operation was canceled" ohne Inner Exception, auf .NET Framework 4.8

Auf .NET Framework ist die `InnerException` selten eine `TimeoutException`. Das Unterscheidungsmuster aus Schritt 1 funktioniert nur ab .NET 5. Wenn Sie noch auf Framework sind, ist Ihr bestes Signal, `ex.CancellationToken` mit dem von Ihnen übergebenen Token zu vergleichen und die verstrichene Zeit vor dem Wurf zu erfassen. Die Ergonomie dieses Falls ist einer der besseren Gründe, die Migration von Framework eher früher als später abzuschließen.

### "An error occurred while sending the request" umhüllt SocketException

Eine völlig andere Ausnahmeklasse (`HttpRequestException`), fast immer ein Transportproblem (DNS, TCP RST, TLS-Handshake-Fehler). Ab .NET 8 zählt `ex.HttpRequestError` die Ursache auf: `ConnectionError`, `NameResolutionError`, `SecureConnectionError` usw. Die Lösung liegt in DNS-, Firewall- oder Zertifikatkonfiguration, nicht in Ihrem Code.

### "The SSL connection could not be established"

Inner Exception ist `AuthenticationException` aus `System.Net.Security`. Das ist ein TLS-Aushandlungsfehler, kein Timeout, auch wenn er Sekunden dauern kann und oberflächlich ähnlich aussieht. Prüfen Sie die Zertifikatskette, den SNI-Hostnamen und die TLS-Protokollversion (`SslProtocols.Tls12 | SslProtocols.Tls13` ist der Standard in .NET 11).

### "A connection attempt failed because the connected party did not properly respond"

`SocketException` mit `ErrorCode == 10060` (WSAETIMEDOUT). Wird ausgelöst, wenn nie ein SYN-ACK eintrifft. Meist eine Firewall-Verwerfung auf Netzwerkebene. Es zeigt sich nur dann als `TaskCanceledException`, wenn das umschließende `HttpClient.Timeout` kürzer ist als das OS-seitige Connect-Timeout, sonst erhalten Sie eine `HttpRequestException`.

### "Request was forcibly aborted" durch CancelPendingRequests

Der Aufruf von `HttpClient.CancelPendingRequests` bricht jede laufende Anfrage auf diesem Client ab, nicht nur eine. Wenn Ihre Anwendung einen Client wiederverwendet und eine Komponente `CancelPendingRequests` aufruft, scheitert die ausstehende Anfrage jeder anderen Komponente mit derselben `TaskCanceledException`. Das ist einer der stärksten Gründe, `IHttpClientFactory` statt eines langlebigen statischen Clients zu verwenden. Die per Aufruf erstellten Typed Clients der Factory sind kurzlebige Fassaden, sodass ein verirrtes `CancelPendingRequests` nur den Aufrufer betrifft.

## Verwandt

Für das vollständige Cancellation-Muster behandelt die [Anleitung zum Abbrechen eines langlaufenden Tasks](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) `CancellationToken`, `Task.WaitAsync` und das oben verwendete Linked-Token-Muster. Die [Anleitung zum Unit-Testen von HttpClient](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/) zeigt, wie Sie Timeouts in Tests fälschen, damit die Timeout-Zweige tatsächlich durchlaufen werden. Für streamende Downloads behandelt der [Beitrag zu Streaming aus ASP.NET Core](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) die passende serverseitige Cancellation-Weiterleitung. Wenn Ihre Background-Worker diese Aufrufe absetzen, behandelt die [BackgroundService-Anleitung](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/) die Lebensdauer- und Cancellation-Regeln, die das Linked-Token-Muster bei Host-Shutdown korrekt halten.

## Quellen

- [`HttpClient.Timeout` property](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpclient.timeout), Microsoft Learn.
- [`HttpCompletionOption` enum](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpcompletionoption), Microsoft Learn.
- [`SocketsHttpHandler.ConnectTimeout`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.socketshttphandler.connecttimeout), Microsoft Learn.
- [`HttpRequestError` enum](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httprequesterror), Microsoft Learn.
- [HttpClient throws TaskCanceledException on timeout](https://github.com/dotnet/runtime/issues/21965), dotnet/runtime issue.
- [How to identify HttpClient connect timeout errors?](https://github.com/dotnet/runtime/issues/78070), dotnet/runtime issue.
- [`Microsoft.Extensions.Http.Resilience` standard handler](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience), Microsoft Learn.
