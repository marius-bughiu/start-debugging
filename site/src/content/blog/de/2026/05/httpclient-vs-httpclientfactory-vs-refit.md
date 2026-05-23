---
title: "HttpClient vs HttpClientFactory vs Refit: Was sollten Sie in .NET 11 verwenden?"
description: "Erstellen Sie niemals einen HttpClient pro Anfrage. Verwenden Sie IHttpClientFactory zur Verwaltung der Lebensdauer und legen Sie Refit darauf, wenn Sie eine typisierte Schnittstelle statt handgeschriebenem Anfragecode wollen. Ein reiner Singleton-HttpClient taugt nur für die einfachsten Fälle."
pubDate: 2026-05-23
template: vs
tags:
  - "comparison"
  - "httpclient"
  - "httpclientfactory"
  - "refit"
  - "dotnet"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/httpclient-vs-httpclientfactory-vs-refit"
translatedBy: "claude"
translationDate: 2026-05-23
---

Das Erste, was man verstehen muss: Diese drei sind keine echten Konkurrenten. Sie sind drei Schichten desselben Stacks. `IHttpClientFactory` verwaltet die Lebensdauer von `HttpClient`, und Refit generiert die `HttpClient`-Aufrufe für Sie, oben auf der Factory. Die eigentliche Frage lautet also, wie hoch im Stack Sie ansetzen sollten. Für neuen .NET-11-Code im Jahr 2026 gilt: Registrieren Sie Ihre Clients über die **IHttpClientFactory**, damit Verbindungslebensdauer und DNS korrekt behandelt werden, und greifen Sie zu **Refit**, wenn Sie eine typisierte Schnittstelle statt handgeschriebenem Code zum Aufbau von Anfragen wollen. Ein reiner, langlebiger `HttpClient`-Singleton ist nur für die einfachsten Fälle mit einem einzigen Aufruf akzeptabel, und `new HttpClient()` pro Anfrage ist das einzige Muster, das immer falsch ist.

Jedes Beispiel hier zielt auf `<TargetFramework>net11.0</TargetFramework>` mit dem .NET-11-SDK und C# 14. Refit bezieht sich auf Version 10.1.6 (veröffentlicht am 2026-03-21, aktuell stabil auf NuGet), und die Resilienz-Teile verwenden `Microsoft.Extensions.Http.Resilience` 10.6.0. `IHttpClientFactory` liegt in `Microsoft.Extensions.Http`, das mit den SDKs für ASP.NET Core und Worker ab Werk geliefert wird.

## Die Funktionsmatrix auf einen Blick

Das ist die Tabelle, wegen der Sie gekommen sind. Die Spalten sind die drei Arten, auf die Sie einen HTTP-Aufruf tatsächlich verdrahten werden, und die Zeilen sind die Entscheidungen, die ändern, welche Sie wählen.

| Kriterium | Reiner HttpClient (Singleton) | IHttpClientFactory | Refit (+ HttpClientFactory) |
| ------- | -------------------------- | ------------------ | --------------------------- |
| Sicher gegen Socket-Erschöpfung | Ja, wenn wirklich Singleton | Ja | Ja |
| Berücksichtigt DNS-Änderungen | Nur mit `PooledConnectionLifetime` | Ja, der Handler rotiert (standardmäßig 2 Min.) | Ja, erbt von der Factory |
| Handler-Pipeline über DI | Manuell | Erstklassig (`AddHttpMessageHandler`) | Erstklassig, erbt von der Factory |
| Eingebaute Resilienz | Selbst gebaut | `AddStandardResilienceHandler` | `AddStandardResilienceHandler` |
| Benannte / typisierte Clients | Nein | Ja | Ja, die Schnittstelle ist der Client |
| Code zum Aufbau von Anfragen, den Sie schreiben | Alles | Alles | Nichts, zur Kompilierzeit generiert |
| Stark typisierte Antworten | Manuelle Deserialisierung | Manuelle Deserialisierung | Automatisch |
| Native AOT / Trimming | Ja | Ja | Ja, seit 9.0.2 auf .NET 10+ |
| Zusätzliche NuGet-Abhängigkeit | Keine (ab Werk) | Keine für ASP.NET Core | `Refit`, `Refit.HttpClientFactory` |
| Am besten für | Ein oder zwei einfache Aufrufe | Den meisten serverseitigen Code | Viele Endpunkte gegen eine API |

Das Muster in der Tabelle ist, dass jede Spalte die Sicherheitsgarantien der Spalte links von ihr erbt und Ergonomie obendrauf legt. Der Preis für den Schritt nach rechts ist eine Abhängigkeit und etwas Indirektion, nicht die Korrektheit.

## Wann reiner HttpClient tatsächlich in Ordnung ist

Es gibt einen hartnäckigen Mythos, dass man `HttpClient` niemals direkt verwenden dürfe. Das ist eine Überkorrektur. Ein einzelner, langlebiger `HttpClient`, der über die gesamte Anwendung geteilt wird, ist ein vollkommen gültiges und gut unterstütztes Muster. Die Gefahr war nie `HttpClient` selbst, sondern das Erzeugen eines neuen pro Anfrage innerhalb eines `using`-Blocks, was Sockets in `TIME_WAIT` leckt und unter Last irgendwann den Portbereich erschöpft.

Ein statischer Singleton vermeidet die Socket-Erschöpfung, führt aber ein zweites, subtileres Problem ein: `HttpClient` löst DNS nur auf, wenn er eine Verbindung öffnet, und ein langlebiger Verbindungspool löst nie erneut auf. Wenn der Zielhost auf eine neue IP umschaltet, hämmert Ihr Singleton weiter auf die alte ein. Die Lösung unter .NET Core und .NET 5+ besteht darin, die Verbindungslebensdauer am Handler zu begrenzen:

```csharp
// .NET 11, C# 14 - a singleton that still picks up DNS changes
using System.Net;

var handler = new SocketsHttpHandler
{
    // Recycle pooled connections so DNS failover is respected
    PooledConnectionLifetime = TimeSpan.FromMinutes(2),
    AutomaticDecompression = DecompressionMethods.All
};

// Construct once, reuse for the entire process lifetime
var http = new HttpClient(handler)
{
    BaseAddress = new Uri("https://api.example.com")
};
```

Verwenden Sie dies, wenn Sie ein Konsolentool, einen kleinen Worker oder eine Bibliothek ohne DI-Container haben und Aufrufe an einen oder zwei Endpunkte machen. In dem Moment, in dem Sie einen DI-Container und mehr als ein paar Clients haben, reimplementieren Sie die `IHttpClientFactory` von Hand und sollten innehalten und das Original verwenden.

## Wann IHttpClientFactory der richtige Standard ist

Für nahezu allen serverseitigen Code im Jahr 2026 ist die `IHttpClientFactory` die Grundlinie. Sie kapselt die oben beschriebene Lebensdauerverwaltung, sodass Sie nicht über `PooledConnectionLifetime` oder DNS-Rotation nachdenken müssen: Die Factory poolt `HttpMessageHandler`-Instanzen und rotiert sie in einem konfigurierbaren Intervall (standardmäßig zwei Minuten), was Ihnen Socket-Wiederverwendung und DNS-Aktualität gleichzeitig verschafft.

Der größere Gewinn ist die Message-Handler-Pipeline. Sie können querschnittliche Belange (Auth-Header, Logging, Korrelations-IDs, Wiederholungen) als `DelegatingHandler`-Instanzen in der DI registrieren, und jeder von der Factory erstellte Client setzt sie der Reihe nach zusammen. Ein typisierter Client bindet einen konfigurierten `HttpClient` an eine bestimmte Service-Klasse:

```csharp
// .NET 11, C# 14 - typed client registered through the factory
using Microsoft.Extensions.DependencyInjection;

builder.Services.AddHttpClient<GitHubService>(client =>
{
    client.BaseAddress = new Uri("https://api.github.com");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
})
.AddStandardResilienceHandler(); // Polly-backed retries, timeout, circuit breaker

public sealed class GitHubService(HttpClient client)
{
    public async Task<Repo?> GetRepoAsync(string owner, string name, CancellationToken ct)
    {
        // You still hand-write the path, the verb, and the deserialize
        return await client.GetFromJsonAsync<Repo>($"/repos/{owner}/{name}", ct);
    }
}

public record Repo(long Id, string FullName, int StargazersCount);
```

`AddStandardResilienceHandler` (aus `Microsoft.Extensions.Http.Resilience` 10.6.0) stapelt einen Rate Limiter, einen Gesamt-Timeout der Anfrage, Wiederholung, einen Circuit Breaker und einen Timeout pro Versuch mit vernünftigen Standardwerten. Das ist der moderne Ersatz für das manuelle Verdrahten von Polly-Policies, und es ist eine einzige Zeile. Wenn Sie nach dem Hinzufügen weiterhin Timeouts sehen, liegt die Ursache meist an einem falsch konfigurierten Timeout pro Versuch und nicht am Handler selbst, was eine häufige Quelle einer [TaskCanceledException, eine Aufgabe wurde abgebrochen](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) ist.

Das Einzige, was die Factory nicht tut, ist Ihren Anfragecode zu schreiben. Sie verfassen weiterhin für jeden Aufruf den Pfad, das HTTP-Verb, den Querystring und die Deserialisierung. Für einen oder zwei Endpunkte ist das in Ordnung. Für eine REST-API mit dreißig Endpunkten sind das dreißig Methoden nahezu identischen Boilerplate-Codes, und genau diese Lücke füllt Refit.

## Wann Refit seine Abhängigkeit verdient

Refit verwandelt eine C#-Schnittstelle in einen funktionierenden REST-Client. Sie deklarieren die Form der API mit Attributen, und der Source Generator von Refit gibt die Implementierung zur Kompilierzeit aus. Es gibt keinen Anfrageaufbau pro Aufruf und keine manuelle Deserialisierung:

```csharp
// .NET 11, C# 14, Refit 10.1.6 - the interface IS the client
using Refit;

public interface IGitHubApi
{
    [Get("/repos/{owner}/{name}")]
    Task<Repo> GetRepoAsync(string owner, string name, CancellationToken ct = default);

    [Get("/users/{user}/repos")]
    Task<IReadOnlyList<Repo>> GetUserReposAsync(string user, [Query] string sort = "updated");

    [Post("/repos/{owner}/{name}/issues")]
    Task<Issue> CreateIssueAsync(string owner, string name, [Body] NewIssue issue);
}

public record Repo(long Id, string FullName, int StargazersCount);
public record Issue(long Number, string Title);
public record NewIssue(string Title, string Body);
```

Registrieren Sie ihn gegen dieselbe Factory-Infrastruktur mit `Refit.HttpClientFactory`, sodass Sie jede Garantie für Lebensdauer, DNS und Resilienz aus der darunterliegenden Schicht behalten:

```csharp
// .NET 11, C# 14, Refit.HttpClientFactory 10.1.6
using Refit;
using Microsoft.Extensions.DependencyInjection;

builder.Services
    .AddRefitClient<IGitHubApi>()
    .ConfigureHttpClient(c =>
    {
        c.BaseAddress = new Uri("https://api.github.com");
        c.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
    })
    .AddStandardResilienceHandler(); // same resilience stack as a typed client
```

Das ist der gesamte Client. Drei Schnittstellenmethoden ersetzen, was sonst drei handgeschriebene Methoden plus deren Logik zum Aufbau und Parsen von Anfragen wären. Für eine Codebasis, die mit einer großen Drittanbieter-API spricht, ist die Reduktion an Code, den Sie lesen und pflegen müssen, das ganze Argument. Refit behandelt auch die unbequemen Teile gut: `[Query]` für Querystrings, `[Body]` mit Serialisierung, `[Header]` und `[Authorize]` für Authentifizierung, Multipart-Uploads und `ApiResponse<T>`, wenn Sie den Statuscode und die Header statt nur des deserialisierten Bodys brauchen.

Zwei praktische Hinweise für 2026. Erstens: Refit 9.0.2 (November 2025) fügte Unterstützung für Native AOT und Trimming für .NET 10 und höher hinzu, sodass Refit nicht länger von getrimmten Containern und Scale-to-Zero-Funktionen ausgeschlossen ist, wie es reflexionslastige Clients sind. Für den AOT-Pfad liefern Sie quellgenerierte `System.Text.Json`-Metadaten über einen `JsonSerializerContext`, damit der Serializer reflexionsfrei bleibt, dieselbe Disziplin, die in [Native AOT vs ReadyToRun vs JIT in .NET 11](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) behandelt wird. Zweitens: Wenn Ihre API durch ein OpenAPI-Dokument beschrieben wird, schreiben Sie die Schnittstelle nicht einmal von Hand: Werkzeuge können Refit-Schnittstellen aus der Spezifikation ausgeben, was sich mit [einen stark typisierten Client aus einer OpenAPI-Spezifikation generieren](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) überschneidet.

## Wie hoch der Overhead tatsächlich ist

Die ehrliche Antwort zur Performance lautet: Bei HTTP-Aufrufen dominiert das Netzwerk, und die Wahl zwischen diesen dreien geht im Rauschen unter. Ein Roundtrip zu einer echten API wird in Millisekunden bis Hunderten von Millisekunden gemessen; der Overhead für den Anfrageaufbau wird in Mikrosekunden gemessen. Refit einem typisierten Client vorzuziehen, um CPU zu sparen, heißt, die falsche Schicht zu optimieren.

Das gesagt, der Overhead ist nicht null, und es lohnt sich zu wissen, wo er steckt:

| Aspekt | Reiner / typisierter Client | Refit |
| ------ | ------------------ | ----- |
| Anfrageaufbau pro Aufruf | Direkt, handgeschrieben | Generiert, nahezu direkt auf .NET 8+ |
| Reflexion zur Laufzeit | Keine | Keine mit dem Source Generator |
| Startkosten | Keine | Einmalige Registrierung generierter Stubs |
| Allokation pro Aufruf | Basislinie | Vergleichbar, das Parsen von Attributen erfolgt zur Kompilierzeit |

Der methodische Kernpunkt: Refit ist auf einen Roslyn-Source-Generator (den `InterfaceStubGenerator`) umgestiegen, sodass die Analyse der Schnittstelle zur Kompilierzeit geschieht, nicht bei jedem Aufruf. Die alten Kosten aus Reflexion und `Reflection.Emit`, die AOT nicht tolerieren konnte, sind weg. Wenn Sie eine echte Zahl für Ihre eigenen Objektformen wollen, lassen Sie BenchmarkDotNet gegen Ihre DTOs laufen, statt einer generischen Angabe zu vertrauen, aber erwarten Sie, dass der Unterschied zwischen einem typisierten Client und einem Refit-Client bei zig Nanosekunden gegenüber einem Netzwerkaufruf liegt, der Millisekunden dauert. Die Entscheidung dreht sich um Code, den Sie pflegen, nicht um Taktzyklen, die Sie verbrauchen.

## Der Haken, der für Sie entscheidet

Ein paar Randbedingungen klären die Wahl, bevor die Vorliebe ins Spiel kommt.

**`new HttpClient()` pro Anfrage ist nie die Antwort.** Das ist das einzige wirklich falsche Muster, und es ist für alle drei Spalten falsch. Es erschöpft Sockets unter Last, obwohl `HttpClient` `IDisposable` ist und so aussieht, als wolle es ein `using`. Wenn Sie eine einzige Sache mitnehmen, dann diese: Erstellen Sie `HttpClient` einmal, oder lassen Sie die Factory ihn für Sie erstellen, aber niemals pro Aufruf.

**Singletons, die einen typisierten Client erfassen, hebeln die Factory aus.** Einen typisierten oder einen Refit-Client zu registrieren und ihn dann innerhalb eines Singletons zu erfassen, fixiert einen Handler für immer, was bedeutet, dass er aufhört zu rotieren und keine DNS-Änderungen mehr sieht, genau das Problem, zu dessen Lösung die Factory existiert. Injizieren Sie den Client dort, wo Sie ihn verwenden, oder injizieren Sie die `IHttpClientFactory` und erstellen Sie bei Bedarf. Verstauen Sie ihn nicht in einem statischen Feld.

**Refit braucht eine Antwort, die zum Vertrag passt.** Da die Deserialisierung automatisch erfolgt, taucht eine Antwort, die nicht zu Ihrem Record passt (ein umhüllendes Envelope, eine andere Schreibweise, ein mit einem 200 zurückgegebener Fehler-Body), als Deserialisierungsfehler auf, statt als etwas, das Sie inline behandeln. Verwenden Sie `ApiResponse<T>`, wenn Sie Status und Header inspizieren müssen, und konfigurieren Sie den Serializer genauso, wie Sie es anderswo täten. Das Testen dieser Clients ist ebenfalls etwas anders, weil es keinen Methodenrumpf zum Mocken gibt; Sie mocken den `HttpMessageHandler`, derselbe Ansatz wie beim [Unit-Testen von Code, der HttpClient verwendet](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/).

**Lizenzierung ist hier kein Faktor.** Anders als bei manchen Mapper- und Mediator-Debatten im Jahr 2026 sind alle drei Optionen kostenlos und permissiv lizenziert. `HttpClient` und `IHttpClientFactory` werden mit .NET ausgeliefert, und Refit ist MIT. Es gibt kein kommerzielles Tor, das Sie zu einer von ihnen hin- oder von ihr wegdrängt.

## Die Entscheidung, in einer Zeile

Für neuen .NET-11-Code im Jahr 2026: Machen Sie die `IHttpClientFactory` zu Ihrem Standard, damit Lebensdauer, DNS und Resilienz für Sie erledigt werden, und legen Sie Refit obendrauf, wenn Sie viele Endpunkte gegen eine API aufrufen und den Anfragecode generiert statt handgeschrieben haben wollen. Behalten Sie reinen `HttpClient` für den wirklich einfachen Fall (ein Singleton mit `PooledConnectionLifetime`, ein oder zwei Aufrufe, kein DI), und erstellen Sie niemals einen pro Anfrage. Das sind keine drei rivalisierenden Bibliotheken, zwischen denen Sie wählen; es sind drei Sprossen einer Leiter, und Sie steigen auf die Sprosse, die dazu passt, wie viel der HTTP-Klempnerei Sie aufhören wollen, selbst zu schreiben.

## Verwandte Beiträge

- [Einen stark typisierten Client aus einer OpenAPI-Spezifikation in .NET 11 generieren](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Code, der HttpClient verwendet, mit Unit-Tests testen](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Fix: TaskCanceledException, eine Aufgabe wurde abgebrochen in HttpClient](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [System.Text.Json vs Newtonsoft.Json im Jahr 2026](/de/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## Quellen

- [Use IHttpClientFactory to implement resilient HTTP requests](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-factory) - benannte und typisierte Clients, Handler-Lebensdauer und die Message-Handler-Pipeline.
- [HttpClient guidelines for .NET](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines) - Socket-Erschöpfung, DNS und das `PooledConnectionLifetime`-Muster für Singletons.
- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) - `AddStandardResilienceHandler` und der Standard-Resilienz-Stack.
- [Refit on GitHub](https://github.com/reactiveui/refit) - der Source Generator, die Attributreferenz und die Integration mit `Refit.HttpClientFactory`.
- [Refit.HttpClientFactory 10.1.6 on NuGet](https://www.nuget.org/packages/refit.httpclientfactory) - aktuelle stabile Version und Ziel-Frameworks.
