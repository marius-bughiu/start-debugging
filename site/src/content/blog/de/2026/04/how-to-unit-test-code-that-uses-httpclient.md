---
title: "So testen Sie Code, der HttpClient verwendet, mit Unit Tests"
description: "Eine vollständige Anleitung zum Testen von HttpClient in .NET 11: warum Sie HttpClient nicht direkt mocken sollten, wie Sie einen HttpMessageHandler-Stub schreiben, den Primary Handler mit IHttpClientFactory austauschen, Polly-Retries verifizieren und die Option WireMock.Net."
pubDate: 2026-04-26
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "testing"
  - "httpclient"
lang: "de"
translationOf: "2026/04/how-to-unit-test-code-that-uses-httpclient"
translatedBy: "claude"
translationDate: 2026-04-26
---

Um Code, der mit einer HTTP-API spricht, mit Unit Tests zu prüfen, mocken Sie nicht `HttpClient` selbst. Ersetzen Sie dessen `HttpMessageHandler` durch einen Stub, der die gewünschte Antwort liefert, und injizieren Sie dann den entstehenden `HttpClient` (oder eine `IHttpClientFactory`, die einen ausgibt) in die zu testende Klasse. Der Handler ist der Erweiterungspunkt, nicht der Client. Alles Folgende zielt auf .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14) mit xUnit 2.9 ab, doch das Muster bleibt unter .NET 6, 8, 9 und 10 unverändert.

## Warum es falsch ist, HttpClient direkt zu mocken

`HttpClient` hat eine öffentliche Oberfläche (`GetAsync`, `PostAsync`, `SendAsync`), die mockbar wirkt, und Moq lässt Sie ohne Murren ein Mock anlegen. Das Problem ist, was diese Methoden tatsächlich tun: jede mündet in `HttpMessageInvoker.SendAsync(HttpRequestMessage, CancellationToken)` auf dem zugrundeliegenden `HttpMessageHandler`. Die komfortablen Methoden auf `HttpClient` sind nicht `virtual`, also fängt ein `Mock<HttpClient>` sie entweder gar nicht ab oder ist auf Werkzeuge wie Moqs `Protected()` angewiesen, um auf private Interna zuzugreifen.

Zwei praktische Konsequenzen:

1. Tests, die `HttpClient.GetAsync` direkt mocken, umgehen still die Handler-Pipeline. Alles, was Sie in `IHttpClientFactory` eingehängt haben, Retry Handler, Logging Handler, Authentifizierungs-Handler, läuft im Test nicht, sodass ein grüner Test eine kaputte Handler-Kette in Produktion ausliefern kann.
2. Wenn Sie von `GetAsync` auf `Send` wechseln, bricht der Test, obwohl das Verhalten identisch ist.

Die offizielle Microsoft-Dokumentation, jede vernünftige Stack-Overflow-Antwort seit 2018 und der Quellcode von `HttpClient` selbst zeigen auf denselben Erweiterungspunkt: den `HttpMessageHandler` ersetzen. Der Handler hat genau eine Methode zum Überschreiben (`SendAsync`), ist `protected internal virtual` und ist der Vertrag, auf den sich der Rest der Pipeline ohnehin bezieht.

## Ein minimaler Stub Handler

Die einfachste Implementierung ist eine Klasse, die einen Delegaten kapselt. Kein Mocking-Framework nötig:

```csharp
// .NET 11, C# 14
public sealed class StubHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _handler;
    public List<HttpRequestMessage> Requests { get; } = new();

    public StubHttpMessageHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler)
    {
        _handler = handler;
    }

    public StubHttpMessageHandler(HttpStatusCode status, string? body = null, string mediaType = "application/json")
        : this((_, _) => Task.FromResult(new HttpResponseMessage(status)
        {
            Content = body is null ? null : new StringContent(body, Encoding.UTF8, mediaType),
        }))
    {
    }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        Requests.Add(request);
        return _handler(request, cancellationToken);
    }
}
```

Zwei Konstruktoren decken die meisten Tests ab: ein Delegate-Konstruktor für Tests, die die Anfrage prüfen müssen, und eine Status/Body-Abkürzung für den trivialen Fall "gib 200 mit diesem JSON zurück". Die Liste `Requests` erlaubt dem Test, das Gesendete zu überprüfen.

## Die zu testende Klasse

Damit der Rest konkret wird, hier die typische Form des Codes, den man testen möchte:

```csharp
// .NET 11, C# 14
public sealed record Repo(int Id, string Name, int Stars);

public sealed class GitHubClient
{
    private readonly HttpClient _http;

    public GitHubClient(HttpClient http) => _http = http;

    public async Task<Repo> GetRepoAsync(string owner, string name, CancellationToken ct = default)
    {
        var path = $"/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(name)}";
        using var response = await _http.GetAsync(path, ct);
        response.EnsureSuccessStatusCode();

        var dto = await response.Content.ReadFromJsonAsync<RepoDto>(ct);
        return new Repo(dto!.Id, dto.Full_Name, dto.Stargazers_Count);
    }

    private sealed record RepoDto(int Id, string Full_Name, int Stargazers_Count);
}
```

Der Konstruktor erhält einen `HttpClient`, keine statische Referenz und keinen frisch erzeugten. Diese eine Designentscheidung macht alles Folgende möglich.

## Ein Test, der eine vorgefertigte Antwort liefert

```csharp
// .NET 11, C# 14, xUnit 2.9
[Fact]
public async Task GetRepoAsync_returns_parsed_repo_when_api_returns_200()
{
    var json = """
    { "id": 42, "full_name": "octocat/hello-world", "stargazers_count": 1300 }
    """;

    var handler = new StubHttpMessageHandler(HttpStatusCode.OK, json);
    var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com") };
    var sut = new GitHubClient(http);

    var repo = await sut.GetRepoAsync("octocat", "hello-world");

    Assert.Equal(42, repo.Id);
    Assert.Equal("octocat/hello-world", repo.Name);
    Assert.Equal(1300, repo.Stars);

    var sent = Assert.Single(handler.Requests);
    Assert.Equal(HttpMethod.Get, sent.Method);
    Assert.Equal("/repos/octocat/hello-world", sent.RequestUri!.AbsolutePath);
}
```

Drei Dinge fallen auf. Der Handler wird mit Status und Body aufgebaut, der `HttpClient` mit diesem Handler und einer `BaseAddress`, und der Test prüft sowohl das geparste Ergebnis als auch die ausgehende Anfrage. Die dritte Assertion ist die, die die meisten Tests auslassen und die die meisten Regressionen aufdeckt, ein falscher Pfad, ein vergessener Header, ein leerer Body, der nicht leer sein dürfte.

## Pro Anfrage unterschiedliche Antworten zurückgeben

Für eine Klasse, die mehrere Aufrufe absetzt (paginierte Liste, Retry, bedingtes GET), reichen Sie einen Delegaten herein:

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_throws_on_404()
{
    var handler = new StubHttpMessageHandler((req, _) =>
        Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
        {
            RequestMessage = req,
            Content = new StringContent("""{ "message": "Not Found" }""", Encoding.UTF8, "application/json"),
        }));

    var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com") };
    var sut = new GitHubClient(http);

    await Assert.ThrowsAsync<HttpRequestException>(() => sut.GetRepoAsync("octocat", "ghost"));
}
```

Für sequentielle Antworten (erster Aufruf liefert 401, zweiter Aufruf liefert 200 nach einem Token-Refresh) führen Sie einen Zähler im Delegaten:

```csharp
// .NET 11, C# 14
var calls = 0;
var handler = new StubHttpMessageHandler((req, _) =>
{
    var status = calls++ == 0 ? HttpStatusCode.Unauthorized : HttpStatusCode.OK;
    return Task.FromResult(new HttpResponseMessage(status)
    {
        Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                    Encoding.UTF8, "application/json"),
    });
});
```

Das genügt für nahezu jedes Unit-Test-Szenario. Kein Mocking-Framework, keine Tricks mit geschützten Membern, keine Zeremonie.

## Die Moq-Variante und warum ich sie meide

Wenn Ihre Codebasis ohnehin Moq standardisiert, lautet das Äquivalent:

```csharp
// .NET 11, C# 14, Moq 4.20
var handler = new Mock<HttpMessageHandler>(MockBehavior.Strict);
handler
    .Protected()
    .Setup<Task<HttpResponseMessage>>(
        "SendAsync",
        ItExpr.IsAny<HttpRequestMessage>(),
        ItExpr.IsAny<CancellationToken>())
    .ReturnsAsync(new HttpResponseMessage(HttpStatusCode.OK)
    {
        Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                    Encoding.UTF8, "application/json"),
    });

var http = new HttpClient(handler.Object) { BaseAddress = new Uri("https://api.github.com") };
```

Es funktioniert. Die Nachteile:

- `"SendAsync"` ist ein String. Würde das Framework jemals umbenennen (wird es nicht, aber das Prinzip gilt), bemerkt es der Compiler nicht.
- `Protected()` benötigt `using Moq.Protected;` und zwingt jeden Entwickler, der den Test liest, den Trick zu kennen.
- Die gleiche `HttpResponseMessage`-Instanz aus einem Singleton-Setup zurückzugeben, leckt Zustand zwischen Aufrufen, sobald die Antwort mehrfach enumeriert wird. Der Stub Handler im vorherigen Abschnitt erzeugt pro Aufruf eine frische Antwort.

Für Einzeltests ist Moq in Ordnung. Für eine Testklasse mit fünf HTTP-Szenarien ist der handgeschriebene Stub kürzer, schneller zu lesen und einfacher zu debuggen.

## Testen über IHttpClientFactory

In Produktionscode, der `IHttpClientFactory` verwendet (und das tut der meiste moderne Code), erhält die zu testende Einheit eine `IHttpClientFactory` oder einen typed Client, und die Factory baut einen `HttpClient` mit der Handler-Kette, die Sie in `Program.cs` registriert haben. Der Test-Erweiterungspunkt verschiebt sich von "einen `HttpClient` direkt konstruieren" zu "den Primary Handler der Factory konfigurieren".

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http 11.0
[Fact]
public async Task TypedClient_uses_registered_handler_chain()
{
    var stub = new StubHttpMessageHandler(HttpStatusCode.OK,
        """{ "id": 7, "full_name": "a/b", "stargazers_count": 5 }""");

    using var provider = new ServiceCollection()
        .AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
        .ConfigurePrimaryHttpMessageHandler(() => stub)
        .Services
        .BuildServiceProvider();

    var sut = provider.GetRequiredService<GitHubClient>();

    var repo = await sut.GetRepoAsync("a", "b");
    Assert.Equal(7, repo.Id);
}
```

`ConfigurePrimaryHttpMessageHandler` tauscht das untere Ende der Kette aus. Jeder andere Handler, den Sie registriert haben (Logging, Retry, Auth), läuft weiter, und genau das ist der Punkt. Wollen Sie die ganze Kette ersetzen (was Sie fast nie wollen), nutzen Sie `AddHttpMessageHandler` plus einen Stub Handler am Ende, oder bauen Sie den `HttpClient` manuell wie in den vorherigen Beispielen.

## Verifizieren, dass ein Polly-Retry tatsächlich erneut versucht hat

Das ist der Test, den Moq schmerzhaft macht und den der Stub Handler trivial macht. Angenommen, Ihre `Program.cs` registriert:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 9.0
builder.Services.AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
    .AddStandardResilienceHandler();
```

Der Standard Resilience Handler wiederholt 5xx- und Timeout-Fehler standardmäßig dreimal. Um das im Test zu beweisen:

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_retries_on_503()
{
    var calls = 0;
    var handler = new StubHttpMessageHandler((_, _) =>
    {
        calls++;
        var status = calls < 3 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK;
        return Task.FromResult(new HttpResponseMessage(status)
        {
            Content = new StringContent("""{ "id": 1, "full_name": "x/y", "stargazers_count": 0 }""",
                                        Encoding.UTF8, "application/json"),
        });
    });

    using var provider = new ServiceCollection()
        .AddHttpClient<GitHubClient>(c => c.BaseAddress = new Uri("https://api.github.com"))
        .AddStandardResilienceHandler()
        .Services
        .ConfigureAll<HttpClientFactoryOptions>(o => o.HttpMessageHandlerBuilderActions.Add(b =>
            b.PrimaryHandler = handler))
        .BuildServiceProvider();

    var sut = provider.GetRequiredService<GitHubClient>();
    var repo = await sut.GetRepoAsync("x", "y");

    Assert.Equal(3, calls);
    Assert.Equal(1, repo.Id);
}
```

Die Assertion `Assert.Equal(3, calls)` macht daraus einen Integrationstest der Handler-Kette. Ein reines Mock von `HttpClient.GetAsync` hätte Polly gar nicht aufgerufen, und die Assertion wäre `calls == 1` gewesen, das stille Versagen, vor dem ich vorhin gewarnt habe.

## Cancellation und Timeout

Cancellation ist unkompliziert: der Stub Handler erhält das `CancellationToken`, und Sie können ihn dieses beobachten lassen.

```csharp
// .NET 11, C# 14
[Fact]
public async Task GetRepoAsync_propagates_cancellation()
{
    var handler = new StubHttpMessageHandler(async (_, ct) =>
    {
        await Task.Delay(TimeSpan.FromSeconds(5), ct);
        return new HttpResponseMessage(HttpStatusCode.OK);
    });

    var http = new HttpClient(handler) { BaseAddress = new Uri("https://x") };
    var sut = new GitHubClient(http);

    using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));

    await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        sut.GetRepoAsync("a", "b", cts.Token));
}
```

`HttpClient.Timeout` selbst tritt als `TaskCanceledException` zutage (mit einer inneren `TimeoutException` seit .NET 5). Wollen Sie Timeout-Verhalten testen, setzen Sie `http.Timeout = TimeSpan.FromMilliseconds(50)` und lassen Sie den Handler länger als das mit `await Task.Delay` warten. Siehe [So brechen Sie eine lang laufende Task in C# ohne Deadlock ab](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) für die kooperativen Cancellation-Muster, denen der Produktionscode ohnehin folgen sollte.

## Assertions auf Request Bodies

Für `POST` und `PUT` erfassen und lesen Sie den Request Content innerhalb des Handler-Delegaten:

```csharp
// .NET 11, C# 14
string? captured = null;
var handler = new StubHttpMessageHandler(async (req, ct) =>
{
    captured = req.Content is null ? null : await req.Content.ReadAsStringAsync(ct);
    return new HttpResponseMessage(HttpStatusCode.Created);
});
```

Lesen Sie den Body innerhalb des Handlers, nicht danach. Sobald `SendAsync` zurückkehrt, kann der Request Stream verworfen sein.

## Header, Query Strings und Basisadressen

`BaseAddress` plus relativer Pfad ist die sauberste Konfiguration, doch achten Sie auf den abschließenden Schrägstrich. `new Uri("https://api.example.com/v1")` plus eine Anfrage an `/users` verwirft `/v1`, weil die URI keinen abschließenden Schrägstrich hat. `https://api.example.com/v1/` plus `users` (ohne führenden Schrägstrich) ergibt `/v1/users`. Testen Sie es:

```csharp
// .NET 11, C# 14
Assert.Equal("/v1/users", handler.Requests[0].RequestUri!.AbsolutePath);
```

Default Header gehören an den `HttpClient`, nicht an jede Anfrage, und sind für den Handler sichtbar:

```csharp
// .NET 11, C# 14
http.DefaultRequestHeaders.Add("User-Agent", "start-debugging/1.0");
// in the handler:
Assert.Contains("start-debugging/1.0", req.Headers.UserAgent.ToString());
```

## Wann WireMock.Net die bessere Wahl ist

Der Stub-Handler-Ansatz ist ein Unit Test, kein Socket, kein echtes HTTP. Für Komponenten- oder Integrationstests, die den echten HTTP-Stack ausreizen (TLS, Content Negotiation, echte Chunked-Übertragung, server-seitige Timeouts), greifen Sie zu [WireMock.Net](https://github.com/WireMock-Net/WireMock.Net):

```csharp
// .NET 11, C# 14, WireMock.Net 1.6
using var server = WireMockServer.Start();
server
    .Given(Request.Create().WithPath("/repos/octocat/hello-world").UsingGet())
    .RespondWith(Response.Create()
        .WithStatusCode(200)
        .WithHeader("Content-Type", "application/json")
        .WithBody("""{ "id": 42, "full_name": "octocat/hello-world", "stargazers_count": 1300 }"""));

var http = new HttpClient { BaseAddress = new Uri(server.Url!) };
var sut = new GitHubClient(http);
var repo = await sut.GetRepoAsync("octocat", "hello-world");
```

WireMock.Net startet einen echten HTTP-Server auf einem Localhost-Port. Langsamer als ein Stub Handler, realistischer, fragiler (Port-Konflikte, TLS, asynchroner Start). Ich nutze es für Tests, die Verhalten verifizieren müssen, das das Framework nur für echte Sockets erzeugt, ansonsten ist der Stub Handler schneller und stiller. Für einen vergleichbaren Ansatz beim Mocken anderer Abhängigkeiten siehe [So schreiben Sie einen eigenen JsonConverter in System.Text.Json](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), auf den der Deserialisierungsschritt in `GetRepoAsync` ohnehin angewiesen ist.

## Fehler, die in Code Reviews auffallen

Eine kurze Liste an Punkten, die ich auf mehr als einem PR markiert habe:

- `HttpClient` innerhalb der zu testenden Klasse konstruieren (`private readonly HttpClient _http = new();`). Der Test kann keinen Fake-Handler injizieren, also ruft er ein echtes Netzwerk auf oder schlägt fehl. Nehmen Sie die Abhängigkeit als Parameter.
- `MockBehavior.Loose` am `HttpMessageHandler`-Mock benutzen und dann vergessen, die Anfrage zu verifizieren. Der Test geht durch, obwohl der Produktionscode die API nie aufruft.
- Dieselbe `HttpResponseMessage`-Instanz aus mehreren Test-Aufrufen zurückgeben. Der Content Stream wird einmal gelesen, also sieht der zweite Aufruf einen leeren Body. Bauen Sie pro Aufruf eine frische Antwort (Delegate-Konstruktor) oder kopieren Sie den Body in einen frischen `StringContent`.
- Auf `response.StatusCode` statt auf Verhalten asserten. Sinn des Tests ist, was `GetRepoAsync` mit einer 503 macht, nicht dass ein von Ihnen konstruiertes `HttpResponseMessage`-Literal genau den Statuscode hat, mit dem Sie es konstruiert haben.
- Direkt über `Mock<HttpClient>` mocken. Wie oben gezeigt, übergeht das die Handler-Kette und bricht still die Resilience- oder Auth-Handler.

Der Handler ist der Erweiterungspunkt, der Rest folgt. Wenn Ihr Test Moq, NSubstitute, FakeItEasy oder WireMock braucht, gut, aber konfigurieren Sie den Erweiterungspunkt, nicht die Oberfläche.

## Quellen

- [HttpMessageHandler.SendAsync (MS Learn)](https://learn.microsoft.com/dotnet/api/system.net.http.httpmessagehandler.sendasync)
- [IHttpClientFactory-Leitfaden (MS Learn)](https://learn.microsoft.com/dotnet/core/extensions/httpclient-factory)
- [ConfigurePrimaryHttpMessageHandler (MS Learn)](https://learn.microsoft.com/dotnet/api/microsoft.extensions.dependencyinjection.httpclientbuilderextensions.configureprimaryhttpmessagehandler)
- [Microsoft.Extensions.Http.Resilience](https://learn.microsoft.com/dotnet/core/resilience/http-resilience)
- [WireMock.Net](https://github.com/WireMock-Net/WireMock.Net)
