---
title: "Integrationstests mit WebApplicationFactory<T> in ASP.NET Core 11 schreiben"
description: "Vollständiger Leitfaden zu WebApplicationFactory<TEntryPoint> in ASP.NET Core 11: den Program-Einstiegspunkt erreichbar machen, ConfigureTestServices gegenüber ConfigureWebHost, die EF-Core-Registrierung über IDbContextOptionsConfiguration ersetzen, der neue Hook ConfigureHostApplicationBuilder in .NET 11 Preview 6, simulierte Authentifizierung, WebApplicationFactoryClientOptions und UseKestrel, wenn ein echter Port nötig ist."
pubDate: 2026-07-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "xunit"
lang: "de"
translationOf: "2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-26
---

Um einen Integrationstest mit `WebApplicationFactory<TEntryPoint>` in ASP.NET Core 11 zu schreiben, referenzieren Sie `Microsoft.AspNetCore.Mvc.Testing` im Testprojekt, machen den Einstiegspunkt der Anwendung erreichbar, indem Sie `public partial class Program { }` an das Ende von `Program.cs` setzen, injizieren dann `WebApplicationFactory<Program>` über `IClassFixture<T>` in eine xUnit-Testklasse und rufen `CreateClient()` auf. Dieser `HttpClient` spricht mit Ihrer echten Middleware-Pipeline und Ihrem echten Dependency-Injection-Container über einen In-Memory-Transport, ohne Socket, ohne Port und ohne `dotnet run`. Alles Weitere (einen Dienst durch ein Testdouble ersetzen, EF Core auf eine andere Datenbank zeigen lassen, einen authentifizierten Benutzer simulieren) passiert in `ConfigureWebHost` oder `WithWebHostBuilder`. Dieser Beitrag zielt auf .NET 11 (zum Zeitpunkt des Schreibens Preview 6, GA im November 2026) mit C# 14 und weist auf die beiden seit .NET 9 neuen APIs hin: `UseKestrel` aus .NET 10 und `ConfigureHostApplicationBuilder` aus .NET 11 Preview 6. Alles andere läuft unverändert unter .NET 8, 9 und 10.

## Was die Factory tatsächlich startet

`WebApplicationFactory<TEntryPoint>` startet Ihre Anwendung nicht so wie `dotnet run`. Sie verwendet `HostFactoryResolver`, um Ihren Einstiegspunkt aufzurufen, fängt den `IHost` unmittelbar vor dessen Ausführung ab, tauscht die Serverimplementierung gegen `TestServer` und gibt Ihnen den fertig gebauten Host zurück. Die Konsequenz lohnt sich zu verinnerlichen, denn sie erklärt fast jedes überraschende Verhalten:

- Ihre `Program.cs` wird ausgeführt. Jeder `builder.Services.Add*`-Aufruf, jede Middleware-Registrierung und jedes `MapGet` laufen genau wie in der Produktion.
- Es wird kein Netzwerk-Socket geöffnet. `TestServer` implementiert `IServer` über einen In-Memory-`HttpMessageHandler`, Anfragen überspringen die Transportschicht also vollständig. Kestrel ist nicht beteiligt, was auch bedeutet, dass HTTPS-Weiterleitung, HTTP/2-Aushandlung und Verbindungslimits nicht geprüft werden.
- Der Dependency-Injection-Container ist der Produktionscontainer plus dem, was Sie in `ConfigureTestServices` ergänzen. Singletons leben so lange wie die Factory, Zustand tritt also zwischen Tests desselben Fixtures über, sofern Sie ihn nicht zurücksetzen.

Der letzte Punkt ist der eigentliche Nutzen. Ein Unittest sagt Ihnen, dass ein Handler das richtige Objekt zurückgibt. Ein Integrationstest sagt Ihnen, dass die Routenvorlage greift, das Modellbinding den Body parst, die Autorisierungsrichtlinie den Aufrufer zulässt, die Filterpipeline in der richtigen Reihenfolge läuft und das JSON auf der Leitung die Eigenschaftsnamen hat, die Ihr Client erwartet. Nichts davon wird geprüft, wenn Sie den Handler direkt aufrufen.

## Schritte für einen Test mit WebApplicationFactory

1. Legen Sie ein Testprojekt an und referenzieren Sie `Microsoft.AspNetCore.Mvc.Testing` sowie das Projekt der zu testenden Anwendung.
2. Legen Sie den Einstiegspunkt offen, indem Sie `public partial class Program { }` an die `Program.cs` der Anwendung anhängen.
3. Injizieren Sie `WebApplicationFactory<Program>` über `IClassFixture<T>` in die Testklasse und rufen Sie `CreateClient()` auf.
4. Leiten Sie eine eigene Factory ab und überschreiben Sie `ConfigureWebHost`, wenn Sie Dienste oder Konfiguration ersetzen müssen.
5. Verwenden Sie `WithWebHostBuilder` für Überschreibungen einzelner Tests, die nicht in den Rest der Klasse übertreten sollen.
6. Setzen Sie gemeinsamen Zustand zwischen den Tests zurück, da Host und Singletons über das gesamte Fixture geteilt werden.

## Die Pakete

```xml
<!-- .NET 11 preview 6, test project -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="11.0.0-preview.6.*" />
  <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.0" />
  <PackageReference Include="xunit.v3" Version="3.1.0" />
  <PackageReference Include="xunit.runner.visualstudio" Version="3.1.0" />
</ItemGroup>

<ItemGroup>
  <ProjectReference Include="..\..\src\Orders.Api\Orders.Api.csproj" />
</ItemGroup>
```

Unter .NET 10 verwenden Sie die stabile Version `10.0.0` von `Microsoft.AspNetCore.Mvc.Testing`. Wenn Sie xUnit v2 noch nicht verlassen haben, funktioniert `xunit` 2.9.x für alles Folgende identisch, mit Ausnahme der Signatur von `IAsyncLifetime`, die im Abschnitt zum Lebenszyklus behandelt wird.

`Microsoft.AspNetCore.Mvc.Testing` ist trotz des Namens nicht MVC-spezifisch. Es funktioniert für Minimal APIs, Controller, Razor Pages und Blazor Server. Es liefert außerdem ein MSBuild-Target mit, das ein `WebApplicationFactoryContentRootAttribute` in das Test-Assembly schreibt, damit die Factory den Content Root der Anwendung findet, was für statische Dateien und Razor-Views wichtig ist.

## Den Einstiegspunkt erreichbar machen

Hier bleiben die meisten ersten Versuche stecken. Top-Level-Anweisungen kompilieren zu einer Klasse namens `Program`, deren Sichtbarkeit `internal` ist, ein Verweis aus einem Test-Assembly scheitert also bereits beim Kompilieren:

```
error CS0122: 'Program' is inaccessible due to its protection level
```

Die Lösung ist eine Zeile ganz unten in `Program.cs`, nach `app.Run()`:

```csharp
// .NET 11, C# 14 -- Program.cs, last line
app.Run();

public partial class Program { }
```

Der Compiler führt Ihre partielle Deklaration mit der generierten zusammen, und die Klasse wird public. Die Alternative ist `[assembly: InternalsVisibleTo("Orders.Api.Tests")]` im Anwendungsprojekt, was `Program` internal belässt, aber auch jeden anderen internen Typ für das Test-Assembly öffnet. Wählen Sie die partielle Klasse, sofern keine Richtlinie dagegen spricht.

Ein verwandter Fehler sieht zur Laufzeit so aus:

```
System.InvalidOperationException: The entry point exited without ever building an IHost.
```

Das bedeutet, der Resolver hat Ihre `Program.cs` vollständig ausgeführt, ohne dass jemals ein Host gebaut wurde. Die üblichen Ursachen sind ein früher `return` auf einem Argumentpfad, ein `Main`, das `Environment.Exit` aufruft, oder eine beim Start geworfene und verschluckte Ausnahme. Beachten Sie, dass der Startcode der Anwendung während des Tests wirklich ausgeführt wird: Eine `Program.cs`, die eine Verbindungszeichenfolge liest und bei deren Fehlen wirft, wirft auch hier. Konfiguration, auf die Sie beim Start angewiesen sind, muss dem Testprozess zur Verfügung stehen.

## Der erste Test

Mit offengelegtem Einstiegspunkt braucht die Standard-Factory überhaupt keine Ableitung:

```csharp
// .NET 11, xUnit v3
using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;

public sealed class OrdersEndpointTests
    : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public OrdersEndpointTests(WebApplicationFactory<Program> factory)
        => _client = factory.CreateClient();

    [Fact]
    public async Task Unknown_order_returns_404()
    {
        var response = await _client.GetAsync("/orders/does-not-exist");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Theory]
    [InlineData("/health")]
    [InlineData("/orders")]
    public async Task Endpoint_returns_json(string url)
    {
        var response = await _client.GetAsync(url);

        response.EnsureSuccessStatusCode();
        Assert.Equal("application/json; charset=utf-8",
            response.Content.Headers.ContentType?.ToString());
    }
}
```

`IClassFixture<T>` baut die Factory einmal pro Testklasse und gibt sie nach dem letzten Test dieser Klasse frei. `CreateClient` lässt sich mehrfach aufrufen; jeder Aufruf liefert einen frischen `HttpClient`, der an denselben Host gebunden ist und einen eigenen Cookie-Container besitzt.

## Dienste mit ConfigureTestServices ersetzen

Sobald Sie ein gefälschtes Zahlungs-Gateway oder eine andere Datenbank brauchen, leiten Sie die Factory ab und überschreiben `ConfigureWebHost`. Verwenden Sie `ConfigureTestServices`, nicht `ConfigureServices`:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

public sealed class OrdersApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");

        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IPaymentGateway>();
            services.AddSingleton<IPaymentGateway, StubPaymentGateway>();
        });
    }
}
```

Der Unterschied ist wichtig. `ConfigureServices`-Callbacks laufen in Registrierungsreihenfolge zusammen mit denen der Anwendung, Ihrer kann also vor der Registrierung in `Program.cs` ausgeführt werden. `ConfigureTestServices` wird bewusst zurückgestellt, bis die Dienstregistrierung der Anwendung abgeschlossen ist, und genau das macht das Überschreiben nach dem Prinzip "der letzte gewinnt" verlässlich.

"Der letzte gewinnt" gilt nur beim Auflösen eines einzelnen Dienstes. `GetRequiredService<IPaymentGateway>()` liefert die letzte Registrierung, `GetRequiredService<IEnumerable<IPaymentGateway>>()` liefert jedoch beide, und alles, was als `IEnumerable<T>` injiziert wird (Validatoren, Health Checks, Hosted Services, `IStartupFilter`), sieht auch das Original. Deshalb steht `RemoveAll<T>` vor dem `Add`. Für per Schlüssel registrierte Dienste bietet die Dependency Injection in .NET 11 `RemoveAllKeyed<T>`, passend zur [Registrierung und Auflösung von Diensten mit Schlüssel](/de/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/).

Für eine einmalige Überschreibung, die den Rest der Klasse nicht betreffen soll, verwenden Sie `WithWebHostBuilder`. Er liefert eine neue Factory, die nichts außer der übergebenen Konfiguration teilt:

```csharp
[Fact]
public async Task Gateway_timeout_maps_to_502()
{
    var client = _factory.WithWebHostBuilder(builder =>
    {
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<IPaymentGateway>();
            services.AddSingleton<IPaymentGateway, TimingOutGateway>();
        });
    }).CreateClient();

    var response = await client.PostAsJsonAsync("/orders",
        new { customerId = "C-1", amount = 10m });

    Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
}
```

## Die Falle bei der EF-Core-Registrierung

Tutorials aus der Zeit vor EF Core 9 sagen Ihnen, Sie sollen den Deskriptor von `DbContextOptions<TContext>` suchen und entfernen, bevor Sie Ihren eigenen Provider hinzufügen. Dieses Snippet tut nicht mehr, was es verspricht. Seit EF Core 9 registriert `AddDbContext` die Providerkonfiguration über `IDbContextOptionsConfiguration<TContext>` in `Microsoft.EntityFrameworkCore.Infrastructure`, und wer nur `DbContextOptions<TContext>` entfernt, lässt die ursprüngliche SQL-Server-Konfiguration stehen. Sie fügen dann einen zweiten Provider hinzu, und EF wirft:

```
System.InvalidOperationException: Only a single database provider can be registered
in a service provider. If possible, ensure that Entity Framework is managing its
service provider by removing the call to UseInternalServiceProvider.
```

In EF Core 9, 10 und 11 ist diese Registrierung zu entfernen:

```csharp
// .NET 11, EF Core 11
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;

builder.ConfigureTestServices(services =>
{
    var registrations = services
        .Where(d => d.ServiceType ==
            typeof(IDbContextOptionsConfiguration<OrdersDbContext>))
        .ToList();

    foreach (var registration in registrations)
    {
        services.Remove(registration);
    }

    services.AddDbContext<OrdersDbContext>(options =>
        options.UseSqlite(_connection));
});
```

Beachten Sie, dass die SQLite-Verbindung ein Feld der Factory ist, einmal geöffnet und offen gehalten, denn eine SQLite-Datenbank im Arbeitsspeicher wird zerstört, sobald ihre letzte Verbindung schließt. Greifen Sie hier nicht zum In-Memory-Provider von EF Core: Er hat keine relationale Semantik, Fremdschlüssel, Eindeutigkeitsbedingungen und Spaltentypen bleiben also ungeprüft. Wenn der Test belegen soll, dass eine Bedingung greift, führen Sie ihn gegen die echte Engine aus, wie in [Integrationstests gegen einen echten SQL Server mit Testcontainers](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) beschrieben, und sehen Sie sich [DbContext simulieren, ohne die Änderungsverfolgung zu brechen](/de/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) für die Fälle an, in denen eine Datenbank wirklich zu viel des Guten ist.

## Konfiguration und Umgebung

`UseEnvironment("Testing")` ist der günstigste Hebel: `IWebHostEnvironment.EnvironmentName` liefert dann `Testing`, `appsettings.Testing.json` wird geladen, falls vorhanden, und Produktionscode kann über `env.IsProduction()` verzweigen, ohne Sonderfälle für Tests.

Bei einzelnen Einstellungen ist der Zeitpunkt der Überschreibung das Heikle. `ConfigureAppConfiguration` innerhalb von `ConfigureWebHost` läuft, nachdem `WebApplication.CreateBuilder` bereits zurückgekehrt ist. Ein dort ergänzter Wert ist damit für jeden Code in `Program.cs` unsichtbar, der `builder.Configuration` beim Start liest, und dazu zählen die meisten `AddOptions`- und `Bind`-Aufrufe. .NET 11 Preview 6 ergänzt einen Hook, der früh genug läuft:

```csharp
// .NET 11 preview 6 and later
private static readonly KeyValuePair<string, string?>[] s_settings =
[
    new("Payments:Endpoint", "https://localhost/stub"),
    new("Features:UseNewPricing", "true"),
];

protected override void ConfigureHostApplicationBuilder(
    IHostApplicationBuilder hostApplicationBuilder)
{
    hostApplicationBuilder.Configuration.AddInMemoryCollection(s_settings);
    base.ConfigureHostApplicationBuilder(hostApplicationBuilder);
}
```

Die Konfigurationsquelle steht bereit, bevor `CreateBuilder` zurückkehrt, der Startcode sieht sie also. Unter .NET 10 und früher entspricht dem, `CreateHost` zu überschreiben und `builder.ConfigureHostConfiguration(...)` vor `base.CreateHost(builder)` aufzurufen, oder schlicht Umgebungsvariablen im Testprozess zu setzen, bevor der Host gebaut wird.

## Einen authentifizierten Benutzer simulieren

Versuchen Sie nicht, in einem Test ein echtes Token zu beschaffen. Registrieren Sie ein Test-Authentifizierungsschema, das immer erfolgreich ist, und machen Sie es zum Standard:

```csharp
// .NET 11, C# 14
public sealed class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string Scheme = "Test";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        Claim[] claims =
        [
            new(ClaimTypes.NameIdentifier, "user-1"),
            new(ClaimTypes.Name, "Test User"),
            new("scope", "orders:write"),
        ];

        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme));
        var ticket = new AuthenticationTicket(principal, Scheme);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}

// in ConfigureTestServices
services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = TestAuthHandler.Scheme;
    options.DefaultChallengeScheme = TestAuthHandler.Scheme;
})
.AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(
    TestAuthHandler.Scheme, _ => { });
```

Setzen Sie dann `client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(TestAuthHandler.Scheme)`, und die Anfrage kommt authentifiziert an. Ihre Autorisierungsrichtlinien laufen weiterhin echt, und genau darum geht es: Getestet wird die Richtlinie, nicht das Tokenformat. Wenn Sie tatsächlich die Tokenvalidierung prüfen wollen, ist das ein anderer Test, und die beteiligten Parameter behandelt [JWT-Bearer-Authentifizierung in einer Minimal API einrichten](/de/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/).

## Client-Optionen, die das Ergebnis verändern

`CreateClient` nimmt ein `WebApplicationFactoryClientOptions` entgegen, und zwei seiner Eigenschaften entscheiden regelmäßig darüber, ob ein Test besteht:

```csharp
var client = factory.CreateClient(new WebApplicationFactoryClientOptions
{
    AllowAutoRedirect = false,          // default true
    BaseAddress = new Uri("https://localhost"),
    HandleCookies = true,               // default true
    MaxAutomaticRedirections = 7,
});
```

`AllowAutoRedirect` ist standardmäßig `true`, einem Handler, der `302` liefert, wird also stillschweigend gefolgt, und Ihre Prüfung auf `HttpStatusCode.Redirect` scheitert mit `200 OK`. Schalten Sie es ab, wenn die Weiterleitung selbst das geprüfte Verhalten ist. Die `BaseAddress` `https://localhost` spielt eine Rolle, wenn die Pipeline `UseHttpsRedirection` enthält, denn eine Anfrage an `http://localhost` wird mit einer Weiterleitung statt mit der Ressource beantwortet.

## Wenn ein echter Port nötig ist

`TestServer` kann keinen Browser bedienen. Seit .NET 10 kann `WebApplicationFactory` stattdessen auf Kestrel laufen und einen echten Loopback-Port binden:

```csharp
// .NET 10 and .NET 11
var factory = new OrdersApiFactory();
factory.UseKestrel(0);      // 0 means "pick a free port"
factory.StartServer();

var client = factory.CreateClient();
// client.BaseAddress is now the real bound address, for example
// http://127.0.0.1:53127/, taken from IServerAddressesFeature
await page.GotoAsync(client.BaseAddress!.ToString());
```

`UseKestrel` muss aufgerufen werden, bevor die Factory initialisiert ist, also vor jedem `CreateClient`- oder `StartServer`-Aufruf, sonst wirft sie `InvalidOperationException`. Sobald Kestrel im Spiel ist, gibt `CreateClient` einen gewöhnlichen `HttpClient` zurück, dessen `BaseAddress` aus dem `IServerAddressesFeature` des Servers stammt, sodass Playwright oder Selenium denselben Host steuern können, den Ihre übrigen Tests im Arbeitsspeicher prüfen. Es gibt außerdem die Überladungen `UseKestrel()` und `UseKestrel(Action<KestrelServerOptions>)`, wenn Sie Limits oder HTTPS konfigurieren müssen.

## Lebensdauer, Freigabe und gemeinsamer Zustand

`WebApplicationFactory<T>` ist disposable, und xUnit gibt das Fixture für Sie frei. Wenn Ihre Factory zusätzliche Ressourcen besitzt (eine SQLite-Verbindung, einen Container, ein temporäres Verzeichnis), implementieren Sie `IAsyncLifetime` darauf. In xUnit v3 leitet die Schnittstelle von `IAsyncDisposable` ab und beide Methoden liefern `ValueTask`, die v2-Signaturen mit `Task` kompilieren nach einer Migration also nicht mehr:

```csharp
// xUnit v3
public sealed class OrdersApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly SqliteConnection _connection = new("DataSource=:memory:");

    public async ValueTask InitializeAsync() => await _connection.OpenAsync();

    public override async ValueTask DisposeAsync()
    {
        await _connection.DisposeAsync();
        await base.DisposeAsync();
    }
}
```

Die Wahl des Gültigkeitsbereichs ist ein Kompromiss: `IClassFixture<T>` startet einen Host pro Testklasse, `ICollectionFixture<T>` teilt einen Host über alle Klassen der Collection (und serialisiert sie), und ein Assembly-Fixture teilt einen über den gesamten Lauf. Der Hoststart dauert typischerweise 200 bis 500 ms, pro Klasse ist also ein vernünftiger Standard, aber denken Sie daran, dass jeder Singleton der Anwendung für diese Zeit geteilt wird. Ein Cache, ein `static`-Zähler, ein `IMemoryCache` oder eine In-Process-Outbox tragen Zustand von einem Test in den nächsten. Setzen Sie ihn im Test explizit zurück, oder wählen Sie einen engeren Gültigkeitsbereich für das Fixture.

Für alles, was von der Uhr abhängt, gilt: nicht schlafen. Registrieren Sie `TimeProvider` in der Anwendung und tauschen Sie ihn in `ConfigureTestServices` gegen `FakeTimeProvider`, wie in [zeitabhängigen Code mit TimeProvider und FakeTimeProvider testen](/de/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/) beschrieben. Und wenn die Anwendung nach außen über HTTP aufruft, ersetzen Sie den Handler statt des Clients, nach dem Muster aus [Code mit HttpClient in Unittests prüfen](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/).

Eine letzte Falle: `xunit.runner.visualstudio` erstellt in manchen Konfigurationen standardmäßig Shadow Copies der Test-Assemblies, was die Ermittlung des Content Root bricht, auf die statische Dateien und Razor-Views angewiesen sind. Wenn eine Seite in der Produktion rendert, im Test aber 404 liefert, ergänzen Sie `xunit.runner.json` mit `"shadowCopy": false` und lassen es in das Ausgabeverzeichnis kopieren.

Das mentale Modell, das all das zusammenhält: `WebApplicationFactory` ist Ihr Produktionshost mit genau zwei Änderungen, der Serverimplementierung und dem, was Sie in `ConfigureTestServices` bewusst überschreiben. Jede Überraschung, die sie produziert, geht auf etwas in Ihrem echten Startpfad zurück, von dem Sie vergessen hatten, dass es ausgeführt wird.

## Verwandte Beiträge

- [Integrationstests gegen einen echten SQL Server mit Testcontainers schreiben](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)
- [Zeitabhängigen Code mit TimeProvider und FakeTimeProvider in .NET 11 testen](/de/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)
- [Code, der HttpClient verwendet, in Unittests prüfen](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [JWT-Bearer-Authentifizierung in einer Minimal API in ASP.NET Core 11 einrichten](/de/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)
- [Dienste mit Schlüssel in der Dependency Injection von .NET 11 registrieren und auflösen](/de/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)
- [WebApplication.CreateBuilder gegenüber CreateSlimBuilder und CreateEmptyBuilder in ASP.NET Core 11](/de/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/)

## Quellen

- [Integrationstests in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests)
- [WebApplicationFactory&lt;TEntryPoint&gt;.UseKestrel (API-Referenz)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.testing.webapplicationfactory-1.usekestrel)
- [Quellcode von WebApplicationFactory.cs (dotnet/aspnetcore)](https://github.com/dotnet/aspnetcore/blob/main/src/Mvc/Mvc.Testing/src/WebApplicationFactory.cs)
- [IDbContextOptionsConfiguration&lt;TContext&gt; (EF-Core-API-Referenz)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.idbcontextoptionsconfiguration-1)
- [Unittests von xUnit v2 auf v3 migrieren](https://xunit.net/docs/getting-started/v3/migration)
