---
title: "Fehler beheben: Cannot consume scoped service 'X' from singleton 'Y'"
description: "Die Scope-Validierung von ASP.NET Core wirft diese Ausnahme, wenn ein Singleton eine scoped Abhängigkeit über die gesamte Prozesslebensdauer einfangen würde. Machen Sie den Konsumenten scoped oder injizieren Sie IServiceScopeFactory und erstellen Sie bei Bedarf einen Scope."
pubDate: 2026-05-10
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "de"
translationOf: "2026/05/fix-cannot-consume-scoped-service-from-singleton"
translatedBy: "claude"
translationDate: 2026-05-10
---

Die Lösung: Der Scope-Validator von ASP.NET Core hat eine eingefangene Abhängigkeit blockiert. Singleton `Y` hat den Root-Provider nach dem scoped Service `X` gefragt, was `X` an den gesamten Prozess gebunden und die Lebensdauer pro Anfrage komplett umgangen hätte. Ändern Sie `Y` auf scoped (bevorzugt, wenn `Y` innerhalb eines Anfrage-Scope konsumiert wird) oder lassen Sie `Y` als Singleton und injizieren Sie `IServiceScopeFactory`, um bei jedem Bedarf an `X` einen frischen Scope zu erstellen. Speziell für `DbContext` verwenden Sie `IDbContextFactory<T>`.

```text
System.InvalidOperationException: Cannot consume scoped service 'MyApp.Data.AppDbContext' from singleton 'MyApp.Workers.OrderProcessor'.
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.CallSiteValidator.ValidateCallSite(ServiceCallSite callSite)
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ServiceProviderEngineScope.GetService(Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProvider.GetService(Type serviceType, ServiceProviderEngineScope serviceProviderEngineScope)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.Hosting.Internal.Host.StartAsync(CancellationToken cancellationToken)
```

Diese Anleitung wurde gegen .NET 11 Preview 4, `Microsoft.Extensions.DependencyInjection` 11.0.0-preview.4 und `Microsoft.Extensions.Hosting` 11.0.0-preview.4 geschrieben. Der Ausnahmetext und der Validator, der ihn auslöst, sind seit .NET Core 2.0 stabil, sodass jede Lösung unten unverändert auf .NET Core 3.1, .NET 5, 6, 8, 10 und 11 anwendbar ist.

Die beiden Typnamen in der Nachricht sind das Erste, was Sie lesen sollten: Der **erste** Name ist der **scoped** Service, und der **zweite** Name ist der **Singleton**-Konsument, der ihn angefordert hat. Die Fehlermeldung nennt sie immer in dieser Reihenfolge, auch wenn Suchmaschinen Sie in der Hälfte der Fälle auf die falsche Hälfte der Nachricht führen.

## Warum die Scope-Validierung diese Kombination ablehnt

Ein Singleton lebt einmal pro Prozess. Ein scoped Service lebt einmal pro Anfrage-Scope (oder einmal pro `IServiceScopeFactory.CreateScope()`-Aufruf). Wenn ein Singleton eine Referenz auf einen scoped Service in einem Feld speichert, überlebt diese scoped Instanz jede folgende Anfrage und untergräbt damit den ganzen Sinn der scoped Lebensdauer: Zustand pro Anfrage, Verbindungspooling pro Scope, Change-Tracking pro Scope, Mandantenisolation pro Scope.

Die Option `ValidateScopes` in ASP.NET Core fängt das zur Auflösungszeit ab, indem sie den Call-Site-Graph durchläuft, bevor der Konstruktor jemals ausgeführt wird. In `Development` aktiviert `WebApplication.CreateBuilder` `ValidateScopes` automatisch; in `Production` nicht, und genau deshalb sehen einige Teams die Ausnahme nur lokal und liefern den Capture-Bug in die Produktion aus, wo er sich als veraltete Daten, ausgelaufene Verbindungen oder als `ObjectDisposedException` an einem `DbContext` zeigt, der bereits mit dem ursprünglichen Anfrage-Scope verworfen wurde.

Dieser Bug nimmt genau vier Formen an:

1. **Konstruktorparameter eines Singleton ist scoped.** Der häufigste Fall. Der Konstruktor des `BackgroundService` (Singleton) verlangt `IUserRepository` (scoped).
2. **Konstruktorparameter eines Singleton ist selbst Singleton, hängt aber transitiv von etwas Scoped ab.** Ein Singleton `IFooFactory` nimmt einen Singleton `IFooDeps`, der wiederum einen scoped `IUnitOfWork` nimmt. Der Validator folgt dem Graph.
3. **Singleton löst scoped direkt aus `IServiceProvider` auf.** `_provider.GetRequiredService<IUserRepository>()` aus einem Singleton heraus, wobei `_provider` der **Root**-Provider ist. Der Provider hat keinen Scope, also wirft der Validator.
4. **Hosted Service / Queue-Worker / Timer-Callback läuft außerhalb jeder Anfrage.** Der Host ruft den Singleton aus einem Thread ohne Umgebungs-Scope auf, sodass jede scoped Auflösung gegen den Root läuft.

Die ersten drei Fälle versagen beim Start oder beim ersten Aufruf. Der vierte versagt in dem Moment, in dem der Timer feuert. Gleiche Ausnahme, unterschiedliche Debug-Pfade.

## Minimale Reproduktion

Die kleinste .NET 11 Konsolenanwendung, die die Ausnahme wirft:

```csharp
// .NET 11 preview 4, Microsoft.Extensions.Hosting 11.0.0-preview.4
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddScoped<IUserRepository, UserRepository>();
builder.Services.AddHostedService<OrderProcessor>();

var host = builder.Build();
await host.RunAsync();

public interface IUserRepository
{
    string GetName(int id);
}

public sealed class UserRepository : IUserRepository
{
    public string GetName(int id) => $"user-{id}";
}

public sealed class OrderProcessor(IUserRepository repo) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            Console.WriteLine(repo.GetName(1));
            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

`AddHostedService<T>` registriert `OrderProcessor` als Singleton. Der Konstruktor verlangt `IUserRepository`, der scoped ist. Der Host-Builder ruft `GetRequiredService` während `StartAsync` auf dem Root-Provider auf, der Validator läuft die Call-Site ab, sieht die scoped-in-Singleton-Kante und wirft die Ausnahme.

## Lösung eins: Den Konsumenten scoped machen, wenn er in eine Anfrage passt

Die sauberste Lösung, wenn der Konsument **pro Anfrage** erreicht wird. Ein Controller, ein Minimal-API-Endpoint-Handler, ein MVC-Filter, eine SignalR-Hub-Methode: Sie alle laufen innerhalb eines bestehenden Scope. Wenn Sie sie versehentlich als Singleton registriert haben, ändern Sie die Registrierung:

```csharp
// .NET 11 preview 4
// Wrong: pulls AppDbContext into a process-wide singleton
builder.Services.AddSingleton<IOrderService, OrderService>();

// Right: scoped matches DbContext lifetime
builder.Services.AddScoped<IOrderService, OrderService>();
```

Diese Lösung funktioniert nicht für Hosted Services, Timer oder Hintergrundwarteschlangen. Sie haben keinen umgebenden Scope, also bewirkt das Umstellen auf scoped nichts (der Host löst sie weiterhin aus dem Root auf). Verwenden Sie für diese Fälle Lösung zwei.

Wenn Sie eine Registrierung von Singleton auf scoped umstellen, prüfen Sie die Aufrufstellen auf in Feldern gespeicherte Referenzen. Jeder andere Singleton, der `IOrderService` im Konstruktor entgegennahm, wird nun ebenfalls die Scope-Validierung verletzen, und die Kette wickelt sich nach oben ab, bis Sie einen Service erreichen, der in einen Anfrage-Scope passt.

## Lösung zwei: IServiceScopeFactory injizieren und pro Arbeitseinheit einen Scope öffnen

Wenn der Konsument **als Singleton** bleiben muss, nehmen Sie `IServiceScopeFactory` und erstellen Sie bei jeder Arbeit einen frischen Scope. Das ist das kanonische Muster für `BackgroundService` und jeden prozessweiten Konsumenten:

```csharp
// .NET 11 preview 4
public sealed class OrderProcessor(IServiceScopeFactory scopeFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            using var scope = scopeFactory.CreateScope();
            var repo = scope.ServiceProvider.GetRequiredService<IUserRepository>();

            Console.WriteLine(repo.GetName(1));

            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

Drei Regeln, um dieses Muster korrekt anzuwenden:

- **Ein Scope pro Arbeitseinheit**, nicht ein Scope pro Prozess. Der ganze Sinn ist, dass jede Iteration einen frischen `DbContext`, frischen Change-Tracker und frische Verbindung bekommt. Das Verwerfen des Scope am Ende der Iteration gibt die scoped Services frei.
- **Aus dem `ServiceProvider` des Scope auflösen**, nicht aus dem festgehaltenen Root-Provider. `scope.ServiceProvider.GetRequiredService<T>()` ist korrekt; `_rootProvider.GetRequiredService<T>()` ist der ursprüngliche Bug.
- **Keine scoped Services in Feldern** des Singleton ablegen. Die Instanz, die Sie innerhalb des Scope auflösen, darf den Scope nicht überdauern. Wenn Sie sie an eine andere Methode übergeben müssen, übergeben Sie sie als Parameter und lassen Sie sie mit dem `using` aus dem Scope fallen.

Für `IAsyncDisposable`-Services in .NET 11 (die meisten modernen `DbContext`-Konfigurationen) bevorzugen Sie die asynchron-disposable Form:

```csharp
// .NET 11 preview 4
await using var scope = scopeFactory.CreateAsyncScope();
var repo = scope.ServiceProvider.GetRequiredService<IUserRepository>();
```

`CreateAsyncScope` liefert einen `AsyncServiceScope` zurück, der scoped Services über `DisposeAsync` verwirft, sofern sie es implementieren. Für gepoolte `DbContext`-Instanzen ist das relevant: synchrones Verwerfen einer rein asynchronen Ressource wirft in .NET 11 standardmäßig.

## Lösung drei: Speziell für DbContext IDbContextFactory verwenden

EF Core liefert eine typisierte Factory genau für dieses Szenario aus. Registrieren Sie sie statt (oder zusätzlich zu) dem scoped `DbContext`:

```csharp
// .NET 11 preview 4, Microsoft.EntityFrameworkCore 11.0.0-preview.4
builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default")));
```

```csharp
// .NET 11 preview 4
public sealed class OrderProcessor(IDbContextFactory<AppDbContext> dbFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);

            var pending = await db.Orders
                .Where(o => o.Status == OrderStatus.Pending)
                .ToListAsync(stoppingToken);

            // process pending...

            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

`AddDbContextFactory` registriert `IDbContextFactory<AppDbContext>` als **Singleton**, und die Factory liefert auf Anforderung frische `DbContext`-Instanzen. Keine Scope-Diskrepanz, kein eingefangener `DbContext`, keine Scope-Zeremonie in Ihrem Worker. Das ist das Muster, das Microsoft für Blazor Server, Hosted Services und jeden nicht an Anfragen gebundenen Code, der mit EF Core spricht, empfiehlt. Die [DbContext-Factory-Dokumentation](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor) enthält die vollständige Anleitung.

Sie können sowohl `AddDbContext` als auch `AddDbContextFactory` registrieren, wenn Sie eine Mischung aus an Anfragen gebundenen und nicht gebundenen Konsumenten haben. Verwenden Sie `AddDbContextFactory<T>(..., ServiceLifetime.Scoped)`, um die Factory selbst scoped zu machen, falls Sie Pooling neben Scoping benötigen, aber prüfen Sie, ob die Lebensdauern beim Konsumenten zusammenpassen.

## Lösung vier: ValidateOnBuild fängt das beim Start ab, nicht bei der ersten Anfrage

Sobald Sie eine echte Lösung von oben angewendet haben, schalten Sie die Build-Zeit-Validierung ein, damit der nächste Capture-Bug schnell scheitert:

```csharp
// .NET 11 preview 4
builder.Host.UseDefaultServiceProvider(options =>
{
    options.ValidateScopes = true;
    options.ValidateOnBuild = true;
});
```

`ValidateScopes = true` zwingt die Laufzeit, jede Auflösung durch den Call-Site-Validator zu schicken, sogar in der Produktion. `ValidateOnBuild = true` macht das **einmal** zum Zeitpunkt von `host.Build()` für jede Registrierung im Container. Der Host weigert sich zu starten, falls eine Registrierung bei der ersten Auflösung werfen würde.

Der Preis ist ein einmaliger Validierungsdurchlauf beim Start. Der Nutzen ist, dass der nächste Entwickler, der eine eingefangene Abhängigkeit einführt, den Fehler beim lokalen Start oder im CI sieht, nicht erst im Produktionsverkehr.

Was Sie **nicht** tun sollten, auch wenn Suchergebnisse das nahelegen: `ValidateScopes` ausschalten, um die Ausnahme zu unterdrücken. Das Deaktivieren der Prüfung behebt den Bug nicht. Es versteckt ihn. Der scoped Service wird weiterhin an die Lebensdauer des Singleton geheftet; Sie werden nur nicht mehr darüber informiert. Veraltete Daten, ausgelaufene Verbindungen und `ObjectDisposedException` im weiteren Prozessverlauf sind garantiert.

## Varianten, die wie derselbe Fehler aussehen, aber anders zu lösen sind

Einige Fehlermeldungen haben Familienähnlichkeit und kosten Zeit, wenn sie gleich behandelt werden:

- **`Unable to resolve service for type 'X' while attempting to activate 'Y'`**: Registrierung fehlt, kein Lebensdauer-Mismatch. Andere Ursache, andere Lösung. Behandelt im [Beitrag zu Unable to resolve service](/de/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- **`Cannot resolve scoped service 'X' from root provider`**: Der Konsument hat den **Root**-`IServiceProvider` direkt gefragt (`app.Services.GetRequiredService<X>()` für ein scoped `X`). Die Lösung ist dieselbe wie beim Singleton-Fall: zuerst einen Scope öffnen.
- **`A circular dependency was detected for the service of type 'X'`**: Die Lebensdauer ist in Ordnung, aber der Call-Site-Graph enthält einen Zyklus. Suchen Sie nach einem Service, der sich selbst oder einen Verwandten in seinem Konstruktor nimmt.
- **`Cannot access a disposed object. Object name: 'AppDbContext'`**: Ein eingefangener scoped Service, der **bereits** der Scope-Validierung entkommen ist (weil sie aus war oder der Service über einen nicht validierten Pfad aufgelöst wurde) und nun verwendet wird, nachdem der ursprüngliche Scope verworfen wurde. Die Lösung ist, an der Aufrufstelle einen frischen Scope zu öffnen.

## Warum es Hosted Services härter trifft als alles andere

`AddHostedService<T>` und `AddSingleton<IHostedService, T>` sind dieselbe Registrierung: Jeder Hosted Service ist ein Singleton. Der Host löst sie während `StartAsync` aus dem Root-Provider auf. Wenn der Konstruktor Ihres Hosted Service irgendetwas entgegennimmt, das die Datenbank berührt, mit einem Mandantenresolver spricht oder `HttpContext` umhüllt, wird es scoped sein, und der Validator wird werfen.

Dieselbe Falle existiert für:

- **Konsumenten von `IHttpClientFactory`, die scoped Delegating-Handler aus einem Singleton auflösen.** `IHttpClientFactory` selbst ist Singleton, aber Per-Request-Handler können scoped registriert sein. Den benannten Client aus einem Singleton aufzulösen, löst den Validator aus.
- **Polly-Resilienz-Pipelines**, die in .NET 11 standardmäßig scoped registriert sind und aus einem Singleton konsumiert werden.
- **`IOptionsSnapshot<T>`**, das **scoped** ist. Ein Singleton, der von `IOptionsSnapshot<T>` abhängt, wird die Validierung verletzen. Verwenden Sie stattdessen `IOptionsMonitor<T>` (Singleton). Die Änderung ist eine einzige Zeile am Konstruktor.
- **MediatR / `ISender` als scoped registriert.** `Mediator.Send` aus einem Hosted Service muss innerhalb eines Scope laufen.
- **EF Core Interceptors**, die einen festgehaltenen `IServiceProvider` halten. Verwenden Sie die scope-freundlichen Registrierungs-Overloads, keinen festgehaltenen Root-Provider.

## Randfälle, die einen Namen verdienen

- **`IServiceProvider` in einen Singleton injiziert**. Erlaubt, aber der Provider, den Sie erhalten, ist der **Root**-Provider. Etwas Scoped daraus aufzulösen löst dieselbe Ausnahme aus. Wenn Sie scoped auflösen müssen, fragen Sie stattdessen nach `IServiceScopeFactory` und rufen Sie `CreateScope()` auf.
- **Manuell registrierte `Func<T>`-Factories**. Wenn `T` scoped ist und die Factory von einem Singleton festgehalten wird, sieht die Factory bei der Inspektion in Ordnung aus, fliegt aber bei der ersten Aufrufung außerhalb eines Scope um die Ohren. Ersetzen Sie die manuelle Factory durch `IServiceScopeFactory` plus `GetRequiredService<T>()`.
- **Test-Hosts, die Scope-Validierung deaktivieren**. `WebApplicationFactory<T>` lässt die Validierung in .NET 8+ standardmäßig an. Wenn Ihre Tests grün sind und die Produktion fällt, prüfen Sie, ob Sie nicht `ValidateScopes = false` im Test-Host hinzugefügt haben.
- **Native AOT- und getrimmte Builds**. Die Scope-Validierung läuft auf demselben Standard-Container, daher ändert AOT diese Regel nicht. Der Trimmer kann einen Typ entfernen, der nur per Reflexion in einer festgehaltenen Factory verwendet wird; das Symptom dort ist `Unable to resolve`, nicht die Capture-Ausnahme.
- **Generische Hosted Services**. `AddHostedService<MyHostedService<MyArg>>()` ist weiterhin Singleton. Der Validator inspiziert den Konstruktor des geschlossenen Generics, ein Konstruktorparameter `IRepo<MyArg>`, der scoped registriert ist, löst denselben Fehlerpfad aus.

## Verwandt

- Der ergänzende Registrierungsfehler zu diesem hier: [unable to resolve service for type while attempting to activate](/de/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- Ein konkretes Beispiel für das Singleton-mit-Scope-Factory-Muster: [running a Semantic Kernel plugin from a BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- Die nächste EF-Core-Ausnahme, die auftritt, wenn ein `DbContext` versehentlich seinen Scope überdauert: [a second operation was started on this context instance](/de/2026/05/fix-second-operation-was-started-on-this-context-instance/).
- Test-Zeit-DI-Ersatz, ohne die Scope-Validierung zu brechen: [integration tests against a real SQL Server with Testcontainers](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Ein Konfigurations-Fehlermodus, der oft direkt neben Lebensdauer-Bugs auftritt: [no connection string named 'DefaultConnection' could be found](/de/2026/05/fix-no-connection-string-named-defaultconnection/).

## Quellen

- Microsoft Learn, [Dependency injection guidelines: scope validation](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines#scope-validation).
- Microsoft Learn, [Dependency injection in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection).
- Microsoft Learn, [Using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- ASP.NET Core Quellcode, [`CallSiteValidator.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/CallSiteValidator.cs), wo die Capture-Prüfung feuert.
- ASP.NET Core Quellcode, [`ServiceProviderEngineScope.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs), wo die Unterscheidung zwischen Root und Scope durchgesetzt wird.
