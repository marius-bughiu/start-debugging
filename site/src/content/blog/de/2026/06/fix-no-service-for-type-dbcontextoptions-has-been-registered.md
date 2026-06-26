---
title: "Fix: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered"
description: "EF Core wirft dies, wenn AddDbContext nie lief, nach Build lief oder der Konstruktor des Kontexts die falschen DbContextOptions erhält. Registrieren Sie vor Build und verwenden Sie DbContextOptions<IhrKontext>."
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "dependency-injection"
lang: "de"
translationOf: "2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered"
translatedBy: "claude"
translationDate: 2026-06-26
---

Die Lösung: Der Dependency-Injection-Container wurde nach `DbContextOptions` gefragt, während er Ihren `DbContext` baute, und hatte nichts zurückzugeben. In fast allen Fällen bedeutet das, dass `AddDbContext<IhrKontext>(...)` nie aufgerufen wurde, nach `builder.Build()` aufgerufen wurde, in einer `ConfigureServices`-Methode liegt, die nicht mehr läuft, oder dass der Konstruktor Ihres Kontexts einen Parameter deklariert, den der Container nicht registriert. Fügen Sie `builder.Services.AddDbContext<IhrKontext>(...)` vor `Build()` hinzu und geben Sie dem Konstruktor einen `DbContextOptions<IhrKontext>`-Parameter, nicht das nicht generische `DbContextOptions`.

```text
System.InvalidOperationException: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered.
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService[T](IServiceProvider provider)
```

Dieselbe Grundursache kann Ihnen auch über den Aktivierungspfad begegnen, mit der generischen Backtick-Form des Typnamens:

```text
System.InvalidOperationException: Unable to resolve service for type 'Microsoft.EntityFrameworkCore.DbContextOptions`1[MyApp.Data.AppDbContext]' while attempting to activate 'MyApp.Data.AppDbContext'.
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.GetService(...)
```

Dieser Leitfaden wurde gegen .NET 11, EF Core 11.0.0 (`Microsoft.EntityFrameworkCore` 11.0.0) und `Microsoft.Extensions.DependencyInjection` 11.0.0 geschrieben. Das hier beschriebene Verhalten ist seit EF Core 3.0 stabil, daher gelten die Lösungen genauso für EF Core 6, 8 und 10.

## Die zwei Meldungsformen sind derselbe Fehler

Der Container von .NET gibt zwei verschiedene Sätze für ein einziges zugrunde liegendes Problem aus, und welchen Sie erhalten, hängt davon ab, wie die Auflösung begonnen hat:

- `No service for type 'X' has been registered.` stammt von `GetRequiredService<X>()`. Etwas hat den Provider direkt nach `X` gefragt, und `X` war nicht in der Sammlung.
- `Unable to resolve service for type 'X' while attempting to activate 'Y'.` stammt von `ActivatorUtilities`. Der Container baute `Y`, traf auf einen Konstruktorparameter vom Typ `X` und konnte ihn nicht befriedigen.

In beiden Fällen ist `X` hier `DbContextOptions` (oder dessen generische Form `DbContextOptions<AppDbContext>`, die die Laufzeit als ``DbContextOptions`1[AppDbContext]`` ausgibt). `Y` ist, sofern vorhanden, Ihr Kontext. Lesen Sie die Typnamen, bevor Sie etwas ändern: Der Fehler betrifft das Optionsobjekt, das EF Core zur Konfiguration des Kontexts braucht, nicht den Kontext selbst.

## Was AddDbContext tatsächlich registriert

Die Lösung zu verstehen heißt zu verstehen, was `AddDbContext<TContext>` in den Container legt. Intern registriert es zwei Dinge für die Optionen (`Microsoft.EntityFrameworkCore.EntityFrameworkServiceCollectionExtensions`, die Methode `AddCoreServices`):

```csharp
// EF Core 11.0.0 - paraphrased from AddCoreServices
serviceCollection.TryAdd(
    new ServiceDescriptor(
        typeof(DbContextOptions<TContextImplementation>),
        CreateDbContextOptions<TContextImplementation>,
        optionsLifetime));

serviceCollection.Add(
    new ServiceDescriptor(
        typeof(DbContextOptions),
        p => p.GetRequiredService<DbContextOptions<TContextImplementation>>(),
        optionsLifetime));
```

Daraus ergeben sich zwei Tatsachen, die jede Variante des Fehlers erklären:

1. Das generische `DbContextOptions<TContext>` ist die eigentliche Registrierung. Es wird mit `TryAdd` hinzugefügt, sodass für diesen geschlossenen Typ der erste Aufruf gewinnt.
2. Das nicht generische `DbContextOptions` ist ein Weiterleiter, der mit `Add` (bedingungslos) hinzugefügt wird. Es ruft im Hintergrund einfach `GetRequiredService<DbContextOptions<TContext>>()` auf. Da es `Add` und nicht `TryAdd` ist, fügt jeder `AddDbContext`-Aufruf einen weiteren Weiterleiter hinzu, und wenn Sie das nicht generische `DbContextOptions` auflösen, **gewinnt der zuletzt registrierte**.

Wenn Sie also `AddDbContext` nie aufrufen, existiert keine der beiden Registrierungen, und das Anfragen einer der beiden Formen wirft die Ausnahme. Und wenn Sie zwei Kontexte registrieren, einer davon aber das nicht generische `DbContextOptions` erhält, bekommt dieser Kontext stillschweigend die Optionen des anderen Kontexts. Beide Fälle werden unten behandelt.

## Minimale Reproduktion

Das kleinste .NET-11-Programm, das den Fehler wirft, indem es die Registrierung komplett vergisst:

```csharp
// .NET 11, EF Core 11.0.0, Microsoft.AspNetCore.App 11.0.0
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// No builder.Services.AddDbContext<AppDbContext>(...) here.
builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();

public sealed class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
    public DbSet<Product> Products => Set<Product>();
}

public sealed class Product
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

[ApiController]
[Route("products")]
public sealed class ProductsController(AppDbContext db) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(db.Products.Count());
}
```

Rufen Sie `GET /products` auf, und MVC bittet den Container, `ProductsController` zu aktivieren, der einen `AppDbContext` braucht, der ein `DbContextOptions<AppDbContext>` braucht. Nichts hat es registriert, also erhalten Sie die Aktivierungsform des Fehlers. Genau diese Form trifft Sie direkt nach dem Scaffolding eines Controllers in Visual Studio gegen einen Kontext, den Sie noch nicht in `Program.cs` verdrahtet haben.

## Lösung eins: Registrieren Sie den Kontext, bevor der Host gebaut wird

Die Antwort in den allermeisten Fällen. Fügen Sie die Registrierung in `Program.cs` hinzu und stellen Sie sicher, dass sie vor `builder.Build()` läuft:

```csharp
// .NET 11, EF Core 11.0.0
var connectionString = builder.Configuration.GetConnectionString("DefaultConnection")
    ?? throw new InvalidOperationException("Connection string 'DefaultConnection' not found.");

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(connectionString));

var app = builder.Build();
```

`builder.Build()` erstellt einen Snapshot der Service-Sammlung. Alles, was Sie nach dieser Zeile zu `builder.Services` hinzufügen, wird vom laufenden Host stillschweigend ignoriert, also ist dies falsch:

```csharp
// .NET 11 - bug: registration after Build is discarded
var app = builder.Build();
builder.Services.AddDbContext<AppDbContext>(options => options.UseSqlServer(cs)); // too late
app.Run();
```

Wenn Sie das ältere `Startup`-Modell verwenden, gehört die Registrierung in `ConfigureServices`, und die klassische Variante dieses Fehlers ist eine zweite `ConfigureServices`-Überladung oder eine auskommentierte `services.AddDbContext`-Zeile, die jemand beim Debuggen deaktiviert und nie wiederhergestellt hat. Suchen Sie im gesamten Projekt nach `AddDbContext` und bestätigen Sie, dass der gefundene Aufruf tatsächlich auf dem Codepfad liegt, den der Host ausführt.

Wenn Sie einen `DbContext` außerhalb der Request-Pipeline bauen, gilt dieselbe Regel innerhalb des jeweils gebauten Providers. Das Auflösen eines scoped `DbContext` aus dem Root-Provider oder vor `app.Run()` ohne Erstellen eines Scopes schlägt aus demselben Grund fehl:

```csharp
// .NET 11 - resolve a scoped DbContext correctly outside a request
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.MigrateAsync();
}
```

## Lösung zwei: Geben Sie dem Konstruktor ein DbContextOptions<IhrKontext>

Wenn die Registrierung vorhanden ist und Sie den Fehler trotzdem erhalten, sehen Sie sich den Konstruktor an. Die DI-Registrierung von EF Core erzeugt `DbContextOptions<AppDbContext>`, also ist das der Parameter, den der Konstruktor deklarieren sollte:

```csharp
// Right: generic, tied to this specific context type
public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
```

Die nicht generische Version kompiliert und funktioniert mit einem einzigen registrierten Kontext sogar, weil der oben beschriebene Weiterleiter sie auflöst. Aber sie ist fragil:

```csharp
// Risky: non-generic. Works with one context, breaks with two.
public AppDbContext(DbContextOptions options) : base(options) { }
```

Sobald ein zweiter Kontext registriert wird, fügen beide `AddDbContext`-Aufrufe einen nicht generischen `DbContextOptions`-Weiterleiter hinzu, der letzte gewinnt, und Ihr Kontext erhält die falschen Optionen, meist die falsche Verbindungszeichenfolge oder sogar den falschen Datenbankprovider. Der Fehler kann sich als `No service`-Fehler während einer teilweisen Registrierung zeigen oder, schlimmer, als ein Kontext, der stillschweigend die falsche Datenbank abfragt. Die Microsoft-Dokumentation ist dazu eindeutig:

> Die meisten `DbContext`-Unterklassen, die ein `DbContextOptions` akzeptieren, sollten die generische Variante `DbContextOptions<TContext>` verwenden. Das stellt sicher, dass die richtigen Optionen für den spezifischen `DbContext`-Untertyp aus der Dependency Injection aufgelöst werden, selbst wenn mehrere `DbContext`-Untertypen registriert sind.

Es gibt eine legitime Verwendung der nicht generischen Form: eine Basisklasse, von der geerbt werden soll. Die Basis erhält ein nicht generisches `DbContextOptions`, damit jede konkrete Unterklasse ihr eigenes `DbContextOptions<TKonkret>` übergeben kann:

```csharp
// .NET 11, EF Core 11.0.0 - base class shared by several contexts
public abstract class AppDbContextBase : DbContext
{
    protected AppDbContextBase(DbContextOptions options) : base(options) { }
}

public sealed class CatalogDbContext : AppDbContextBase
{
    public CatalogDbContext(DbContextOptions<CatalogDbContext> options) : base(options) { }
}

public sealed class OrdersDbContext : AppDbContextBase
{
    public OrdersDbContext(DbContextOptions<OrdersDbContext> options) : base(options) { }
}
```

Jeder konkrete Kontext stellt weiterhin den generischen Konstruktor bereit, sodass DI ihm die richtigen Optionen übergibt; die Basis liefert nur einen Konstruktor, an den die Unterklassen verketten. Ein Kontext, der sowohl direkt instanziiert als auch beerbt werden muss, sollte beide Konstruktoren bereitstellen, den generischen public und den nicht generischen protected.

## Lösung drei: Entwurfszeit-Werkzeuge (Migrationen und Scaffolding)

Eine eigene Ausprägung dieses Fehlers tritt nur auf, wenn Sie `dotnet ef` ausführen:

```text
Unable to create a 'DbContext' of type ''. The exception 'Unable to resolve service for type
'Microsoft.EntityFrameworkCore.DbContextOptions`1[MyApp.Data.AppDbContext]' while attempting to
activate 'MyApp.Data.AppDbContext'.' was thrown while attempting to create an instance.
```

Zur Entwurfszeit gibt es keinen laufenden Web-Host, daher kann EF Core die Optionen nicht aus dem DI-Container Ihrer Anwendung ziehen. Es versucht trotzdem, den Kontext zu bauen, und scheitert am Optionsparameter. Zwei zuverlässige Lösungen:

1. Lassen Sie EF Ihren App-Host finden. Wenn Ihr `DbContext` im Startprojekt liegt und `Program.cs` `AddDbContext` aufruft, können die Werkzeuge von EF den Service-Provider der App verwenden. Halten Sie Entwurfszeit- und Laufzeitprojekt identisch oder übergeben Sie `--startup-project`.
2. Stellen Sie eine explizite Factory bereit. Implementieren Sie `IDesignTimeDbContextFactory<TContext>` neben dem Kontext. EF entdeckt sie automatisch und verwendet sie, statt zu raten:

```csharp
// .NET 11, EF Core 11.0.0 - found automatically by dotnet ef
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

public sealed class AppDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=DesignTime;ConnectRetryCount=0")
            .Options;

        return new AppDbContext(options);
    }
}
```

Die Factory baut `DbContextOptions<AppDbContext>` von Hand, sodass Entwurfszeit-Befehle nie die DI Ihrer Anwendung berühren. Das ist die kanonische Lösung, wenn der Kontext in einer Klassenbibliothek ohne eigenen Start-Host liegt. Für die umfassendere Variante dieses Fehlers siehe die eigene Anleitung dazu, [warum `dotnet ef migrations add` "Unable to create an object of type DbContext" meldet](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

## Einen Kontext von Hand erstellen

Wenn Sie überhaupt keine DI verwenden, ist die nicht generische `DbContextOptions`-Registrierung irrelevant. Bauen Sie die Optionen selbst und übergeben Sie sie an den Konstruktor:

```csharp
// .NET 11, EF Core 11.0.0 - no DI container involved
var options = new DbContextOptionsBuilder<AppDbContext>()
    .UseSqlServer(connectionString)
    .Options;

using var db = new AppDbContext(options);
```

Das ist die richtige Form für ein Konsolentool, einen Test oder ein Hintergrund-Hilfsprogramm ohne `IServiceProvider`. Beachten Sie, dass der Builder ebenfalls generisch ist: `DbContextOptionsBuilder<AppDbContext>` erzeugt ein `DbContextOptions<AppDbContext>`, das zum generischen Konstruktor passt.

## Varianten, die irrtümlich auf dieser Seite landen

Mehrere ähnlich aussehende Fälle werden gleich gesucht, lösen sich aber unterschiedlich:

- **`No connection string named 'DefaultConnection' could be found`.** Der Kontext wurde korrekt registriert; die Suche nach der Verbindungszeichenfolge schlug fehl. Andere Schicht, andere Lösung. Siehe [den DefaultConnection-Verbindungszeichenfolgenfehler](/de/2026/05/fix-no-connection-string-named-defaultconnection/).
- **`Unable to resolve service for type 'X' while attempting to activate 'Y'`, wobei X Ihr eigener Service ist, nicht `DbContextOptions`.** Das ist eine schlichte fehlende Registrierung in Ihrem Code, kein EF-Core-Verdrahtungsproblem. Siehe [den allgemeinen Resolve-Service-Fehler](/de/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- **`Cannot consume scoped service 'AppDbContext' from singleton 'Y'`.** Der Kontext ist korrekt registriert; ein Singleton fängt ihn ab. Die Lösung ist ein Scope, keine Registrierung.
- **`A second operation was started on this context instance`.** Der Kontext wurde korrekt aufgelöst und wird über Threads geteilt oder falsch erwartet (await).
- **`AddDbContextPool` und `AddDbContextFactory`.** Beide registrieren `DbContextOptions<TContext>` genauso wie `AddDbContext`, daher ist die Konstruktorregel identisch: Gepoolte und per Factory gebaute Kontexte erfordern ebenfalls den generischen `DbContextOptions<TContext>`-Parameter. Wenn Sie den Kontext in Tests über die gepoolte Factory austauschen, siehe [das Entfernen einer gepoolten DbContext-Factory für einen Test-Austausch in EF Core 11](/de/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).

## Die Verdrahtung in zehn Sekunden bestätigen

Wenn die Registrierung korrekt aussieht, der Fehler aber bleibt, beweisen Sie es aus einem Scope, statt zu raten:

```csharp
// .NET 11 - remove before commit
using (var scope = app.Services.CreateScope())
{
    var options = scope.ServiceProvider.GetService<DbContextOptions<AppDbContext>>();
    Console.WriteLine(options is null ? "OPTIONS NOT REGISTERED" : "options OK");

    var ctx = scope.ServiceProvider.GetService<AppDbContext>();
    Console.WriteLine(ctx is null ? "CONTEXT NOT REGISTERED" : ctx.GetType().FullName);
}
```

Wenn die Optionszeile `OPTIONS NOT REGISTERED` ausgibt, lief `AddDbContext` nie auf diesem Provider, und Sie sind bei Lösung eins. Wenn die Optionen sich auflösen, der Kontext aber nicht, ist der Konstruktorparameter falsch, und Sie sind bei Lösung zwei. Sie können auch die Validierung zur Build-Zeit aktivieren, damit der Host sich weigert, mit einem kaputten Graphen zu starten, statt bei der ersten Anfrage zu scheitern:

```csharp
// .NET 11
builder.Host.UseDefaultServiceProvider(o =>
{
    o.ValidateScopes = true;
    o.ValidateOnBuild = true;
});
```

`ValidateOnBuild` durchläuft jede Registrierung einmal und scheitert früh, was einen Laufzeit-500 in einen Startfehler verwandelt, den Sie nicht übersehen können. Kombinieren Sie den generischen Konstruktor mit `AddDbContext` vor `Build`, und der `DbContextOptions`-Fehler kommt nicht wieder. Für die Muster hinter Unit-Tests, die Kontexte ganz ohne DI bauen, behandelt der Begleittext über das [Mocken von DbContext ohne das Change-Tracking zu zerstören](/de/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) die Kompromisse.

## Quellen

- Microsoft Learn, [DbContext Lifetime, Configuration, and Initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), einschließlich des Abschnitts `DbContextOptions` versus `DbContextOptions<TContext>`.
- Microsoft Learn, [Design-time DbContext Creation](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation) und `IDesignTimeDbContextFactory<TContext>`.
- EF-Core-Quellcode, [`EntityFrameworkServiceCollectionExtensions.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Extensions/EntityFrameworkServiceCollectionExtensions.cs), wo `AddCoreServices` die generischen und nicht generischen Optionen registriert.
- dotnet/efcore-Issue [#32936](https://github.com/dotnet/efcore/issues/32936) zum Entwurfszeit-Aktivierungsfehler und der Factory-Lösung.
