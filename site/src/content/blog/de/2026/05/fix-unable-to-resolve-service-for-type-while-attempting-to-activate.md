---
title: "Lösung: Unable to resolve service for type 'X' while attempting to activate 'Y'"
description: "ASP.NET Core wirft diese Ausnahme, wenn ein Konstruktor einen Typ anfordert, der nie registriert wurde, im falschen Container registriert wurde oder erst nach dem Build des Hosts hinzugefügt wurde. Drei konkrete Lösungen decken fast jeden Fall ab."
pubDate: 2026-05-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "de"
translationOf: "2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate"
translatedBy: "claude"
translationDate: 2026-05-10
---

Die Lösung: Die `ActivatorUtilities` von ASP.NET Core sind den Konstruktor von `Y` durchgegangen, haben den `IServiceProvider` nach einem `X` gefragt und nichts zurückbekommen. Entweder haben Sie `services.AddScoped<X, XImpl>()` (oder `AddSingleton` / `AddTransient`) vergessen, Sie haben die Implementierung registriert, aber ein Interface oder eine Basisklasse angefordert, die der Container nicht kennt, oder die Registrierung lebt in einer anderen `IServiceCollection` als der, die der Host tatsächlich gebaut hat. Fügen Sie die fehlende Registrierung in `Program.cs` vor `builder.Build()` hinzu und prüfen Sie genau, ob die Typnamen exakt übereinstimmen.

```text
System.InvalidOperationException: Unable to resolve service for type 'MyApp.Data.IUserRepository' while attempting to activate 'MyApp.Api.Controllers.UsersController'.
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.ConstructorMatcher.CreateInstance(IServiceProvider provider)
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.CreateInstance(IServiceProvider provider, Type instanceType, Object[] parameters)
   at Microsoft.AspNetCore.Mvc.Controllers.ServiceBasedControllerActivator.Create(ControllerContext context)
   at Microsoft.AspNetCore.Mvc.Controllers.ControllerActivatorProvider.<>c__DisplayClass4_0.<CreateActivator>b__0(ControllerContext controllerContext)
   at Microsoft.AspNetCore.Mvc.Infrastructure.ControllerActionInvoker.Next(State& next, Scope& scope, Object& state, Boolean& isCompleted)
```

Diese Anleitung wurde gegen .NET 11 preview 4, `Microsoft.AspNetCore.App` 11.0.0-preview.4 und `Microsoft.Extensions.DependencyInjection` 11.0.0-preview.4 geschrieben. Der Text der Ausnahme ist seit ASP.NET Core 2.1 stabil, also gilt jede Lösung unten sauber zurück bis zu .NET Core 3.1, .NET 5, 6, 8 und 10.

Die beiden Typnamen in der Meldung sind der nützlichste Teil: Der **erste** Name (`X`) ist der Typ, den der Container nicht finden konnte, und der **zweite** Name (`Y`) ist der Konsument, der ihn angefordert hat. Lesen Sie sie in dieser Reihenfolge, bevor Sie irgendetwas anderes tun, denn die Suchanfrage, die Sie hierher geführt hat, trifft die Hälfte der Zeit auf die falsche Hälfte der Meldung.

## Warum der Container den Typ nicht finden konnte

Drei Ursachen erklären fast jedes Vorkommen:

1. **Für diesen Typ ist gar nichts registriert.** Sie haben `public UsersController(IUserRepository repo)` geschrieben, aber `services.AddScoped<IUserRepository, UserRepository>()` nie aufgerufen. Der Container hat keine Zuordnung vom Interface zur Implementierung.
2. **Sie haben mit dem falschen Schlüssel registriert.** Sie haben `services.AddScoped<UserRepository>()` (konkreter Typ) aufgerufen, aber der Controller fordert `IUserRepository` (Interface) an. Der Container löst nur das auf, was Sie registriert haben, nach dem exakten Typ, der als generischer Parameter oder `serviceType`-Argument verwendet wurde.
3. **Sie haben in eine andere `IServiceCollection` registriert.** Häufig in Tests, in denen der Test-Host seine eigene Collection baut, oder in ungewöhnlichen Fällen, in denen Sie `builder.Services` nach `builder.Build()` mutieren. Der Host nimmt zur Build-Zeit einen Snapshot der Collection.

Es gibt eine Handvoll seltenerer Varianten, die es wert sind, benannt zu werden: ein offener generischer Typ, der ohne den passenden geschlossenen Typ registriert ist (`AddScoped(typeof(IRepo<>), typeof(Repo<>))` ist in Ordnung; `AddScoped<IRepo<User>>(...)` ist nicht dieselbe Registrierung), ein `keyed` Service, der von einem nicht-keyed Konsumenten angefordert wird, und eine `Action` oder ein Factory-Delegate, das an einen Konstruktor übergeben wird, das die Dependency Injection nicht synthetisieren kann. Decken Sie zuerst die ersten drei ab.

## Minimale Reproduktion

Dies ist die kleinste Minimal-API in .NET 11, die die Ausnahme wirft:

```csharp
// .NET 11 preview 4, Microsoft.AspNetCore.App 11.0.0-preview.4
using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);

// Notice: no services.AddScoped<IUserRepository, UserRepository>();

builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();

public interface IUserRepository
{
    string GetName(int id);
}

public sealed class UserRepository : IUserRepository
{
    public string GetName(int id) => $"user-{id}";
}
```

```csharp
// .NET 11 preview 4
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("users")]
public sealed class UsersController(IUserRepository repo) : ControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult Get(int id) => Ok(repo.GetName(id));
}
```

Rufen Sie `GET /users/1` auf, und die Anfrage scheitert mit der Ausnahme aus dem Abschnitt oben. Der Container hat `IUserRepository` nie gesehen, also kann der Konstruktorparameter nicht erfüllt werden, wenn der `ServiceBasedControllerActivator` von MVC versucht, den Controller zu bauen.

## Lösung eins: registrieren Sie den fehlenden Service

Das Erste, was zu probieren ist, und in 80% der Fälle die Antwort:

```csharp
// .NET 11 preview 4
builder.Services.AddScoped<IUserRepository, UserRepository>();
```

Wählen Sie die Lebensdauer, die dazu passt, wie der Service verwendet wird:

- `AddScoped` ist der richtige Standard für alles, was per-Request-Zustand berührt (ein EF Core `DbContext`, ein `HttpContext`-Accessor-Wrapper, ein Tenant-Resolver). Eine Instanz pro Request-Scope.
- `AddSingleton` ist für zustandslosen oder threadsicher geteilten Zustand (Caches, Optionen, HTTP-Clients über `IHttpClientFactory`). Eine Instanz pro Prozess.
- `AddTransient` ist für günstige, zustandslose Objekte, von denen Sie jedes Mal eine neue Kopie wollen (`IValidator<T>`, Mapper). Neue Instanz pro Auflösung.

Falsch entschieden, und Sie tauschen die heutige Ausnahme gegen die morgige `InvalidOperationException: Cannot consume scoped service ... from singleton ...` ein, oder schlimmer, gegen einen stillen Thread-Sicherheits-Bug, bei dem zwei Anfragen sich einen `DbContext` teilen. Die offizielle Anleitung in der [Microsoft.Extensions.DependencyInjection-Dokumentation](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines) ist die Referenz; verwenden Sie im Zweifel `AddScoped`, wenn ein Request-Scope existiert.

## Lösung zwei: registrieren Sie den Service-Typ, den der Konstruktor tatsächlich anfordert

Wenn Sie eine Registrierung haben, aber trotzdem die Ausnahme bekommen, stimmen registrierter Typ und konsumierter Typ nicht überein. Vergleichen Sie den Konstruktor mit der Registrierung:

```csharp
// Wrong: only the concrete type is registered
builder.Services.AddScoped<UserRepository>();

// Right: register both the interface and the implementation,
// or just the interface mapped to the implementation
builder.Services.AddScoped<IUserRepository, UserRepository>();
```

Der Container führt keine Interface-Inferenz durch. Wenn `UserRepository` `IUserRepository` implementiert, registriert nur `UserRepository` zu registrieren nicht `IUserRepository`. Wenn der Konsument das Interface anfordert, registrieren Sie das Interface.

Wenn Sie tatsächlich beide brauchen ("injiziere `UserRepository` hier, aber `IUserRepository` dort"), registrieren Sie beide und leiten Sie das Interface auf den konkreten Typ weiter:

```csharp
// .NET 11 preview 4
builder.Services.AddScoped<UserRepository>();
builder.Services.AddScoped<IUserRepository>(sp => sp.GetRequiredService<UserRepository>());
```

Dieses Muster ist wichtig für Hosted Services und das Options-Pattern, bei dem Konsumenten manchmal den konkreten `MyOptions` und manchmal `IOptions<MyOptions>` anfordern.

## Lösung drei: registrieren Sie, bevor der Host gebaut wird

`builder.Build()` ist die Trennlinie. Alles, was Sie nach diesem Punkt zu `builder.Services` hinzufügen, wird für den laufenden Host stillschweigend verworfen:

```csharp
// .NET 11 preview 4
var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

// Too late. The container was snapshotted in builder.Build().
builder.Services.AddScoped<IUserRepository, UserRepository>();

app.MapControllers();
app.Run();
```

Ordnen Sie um, sodass jede Registrierung vor `Build` läuft. Dieses Muster beißt am häufigsten, wenn ein Refactoring einen `Add*`-Aufruf in eine Methode verschiebt und die Methode vom falschen Ort aufgerufen wird. Ein praktisches Muster ist, jeden `services.Add*`-Aufruf in eine Erweiterungsmethode auf `IServiceCollection` zu packen und sie von einem einzigen Ort nahe dem Anfang von `Program.cs` aufzurufen:

```csharp
// .NET 11 preview 4
public static class DependencyInjectionExtensions
{
    public static IServiceCollection AddDataServices(this IServiceCollection services)
    {
        services.AddScoped<IUserRepository, UserRepository>();
        services.AddScoped<IOrderRepository, OrderRepository>();
        return services;
    }
}

// Program.cs
builder.Services.AddDataServices();
var app = builder.Build();
```

In Integrationstests gegen `WebApplicationFactory<TEntryPoint>` lautet die entsprechende Regel, dass `ConfigureTestServices` läuft, bevor der Test-Host gebaut wird. Wenn Sie den Container aus dem Body einer Testmethode nach `factory.CreateClient()` mutieren, mutieren Sie eine verworfene Collection.

## Varianten, die wie derselbe Fehler aussehen

Mehrere ähnliche Meldungen werden anders gelöst und verschwenden Zeit, wenn Sie sie wie denselben Bug behandeln:

- **`Cannot consume scoped service '<X>' from singleton '<Y>'`**. Die Registrierung existiert, aber die Lebensdauer ist falsch. Die Lösung ist, `Y` scoped zu machen oder `IServiceScopeFactory` / `IServiceProvider` in `Y` zu nehmen und bei Bedarf einen Scope zu erstellen. Behandelt in [dem Singleton-zu-Scoped-Capture-Problem](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- **`No service for type 'IOptions<MyOptions>' has been registered`**. Gleiche Grundursache, andere Meldung: Sie haben `services.Configure<MyOptions>(...)` oder `services.AddOptions<MyOptions>().Bind(...)` ausgelassen. Das Hinzufügen von `Configure` registriert `IOptions<MyOptions>` kostenlos.
- **`Implementation type 'X' can't be converted to service type 'Y'`**. Sie haben `services.AddScoped(typeof(IFoo), typeof(Bar))` geschrieben, und `Bar` implementiert `IFoo` nicht. Der Compiler kann das nicht erkennen, weil beide Argumente `Type` sind. Korrigieren Sie den Typ oder verwenden Sie die generische Überladung.
- **`A suitable constructor for type 'X' could not be located`**. Der Typ ist registriert, aber DI kann ihn nicht konstruieren: Jeder öffentliche Konstruktorparameter muss auflösbar sein, und es muss genau einen Konstruktor geben (oder `[ActivatorUtilitiesConstructor]` auf dem gewählten). Das ist nicht der `Unable to resolve service`-Fehler.
- **Keyed Services**: In .NET 8 und neuer erfordert `AddKeyedScoped<IFoo, Foo>("primary")` `[FromKeyedServices("primary")] IFoo foo` am Konsumenten. Ein einfaches `IFoo` anzufordern wirft die Resolve-Service-Ausnahme, obwohl eine keyed Registrierung existiert. Die beiden Namespaces sind getrennt.

## Wie Sie bestätigen, dass die Registrierung korrekt verdrahtet ist

Drei schnelle Prüfungen schlagen jede Menge Raterei:

1. **`IServiceProvider.GetService<T>()` aus der Dev-Konsole.** Setzen Sie eine einzelne Zeile direkt nach `app.Build()` und vor `app.Run()`:

   ```csharp
   // .NET 11 preview 4 - remove before commit
   using (var scope = app.Services.CreateScope())
   {
       var repo = scope.ServiceProvider.GetService<IUserRepository>();
       Console.WriteLine(repo is null ? "NOT REGISTERED" : repo.GetType().FullName);
   }
   ```

   Wenn `GetService<T>()` `null` zurückgibt, fehlt die Registrierung oder ist auf einen anderen Container scoped. `GetRequiredService<T>()` würde dieselbe `InvalidOperationException` werfen, die Sie debuggen.

2. **Validieren Sie Scopes beim Start.** Geben Sie der Service-Provider-Factory `ValidateScopes = true` und `ValidateOnBuild = true` mit, und der Host weigert sich zu starten, wenn irgendeine Registrierung kaputt ist:

   ```csharp
   // .NET 11 preview 4
   builder.Host.UseDefaultServiceProvider(options =>
   {
       options.ValidateScopes = true;
       options.ValidateOnBuild = true;
   });
   ```

   `ValidateOnBuild` geht jede Registrierung einmal zur Build-Zeit durch und scheitert schnell, wenn ein Konstruktorparameter nicht erfüllt werden kann. In der Entwicklungsumgebung aktiviert ASP.NET Core das für Sie, weshalb die Ausnahme oft in dem Moment erscheint, in dem Sie die Anwendung starten, und nicht in dem Moment, in dem Sie einen Endpunkt treffen.

3. **Drucken Sie die Registrierungen.** Wenn die Registrierung korrekt aussieht, die Ausnahme aber trotzdem feuert, dumpen Sie die Collection selbst vor `Build`:

   ```csharp
   // .NET 11 preview 4
   foreach (var sd in builder.Services.Where(s => s.ServiceType.Name.Contains("UserRepository")))
   {
       Console.WriteLine($"{sd.Lifetime}: {sd.ServiceType.FullName} -> {sd.ImplementationType?.FullName ?? "factory"}");
   }
   ```

   Das fängt den Fall ab, in dem Sie `MyApp.OldNamespace.IUserRepository` registriert haben und der Controller `MyApp.NewNamespace.IUserRepository` importiert. Die Ausnahmemeldung zeigt den vollständigen Namespace, aber das Auge gleitet darüber hinweg.

## Sonderfälle, die erfahrene Entwickler erwischen

Einige Muster lösen diese Ausnahme in Code aus, der bei der Inspektion korrekt aussieht:

- **`IConfiguration` in einen `Configure<TOptions>`-Callback injiziert**. Der Callback läuft lazy. Wenn Sie innerhalb des Callbacks einen Service referenzieren, der später entfernt wird, feuert die Ausnahme beim ersten Mal, wenn die Optionen aufgelöst werden, nicht beim Start.
- **Background Services, die scoped Abhängigkeiten in ihrem Konstruktor auflösen**. Ein `BackgroundService` ist ein Singleton. Sein Konstruktor kann kein `IUserRepository` anfordern, wenn Letzteres scoped ist. Injizieren Sie `IServiceScopeFactory`, erstellen Sie innerhalb von `ExecuteAsync` einen Scope und lösen Sie aus dem Scope auf.
- **Generische Hosted Services**. `services.AddHostedService<MyHostedService<MyArg>>()` erfordert, dass der geschlossene Generic `MyHostedService<MyArg>` durch DI konstruierbar ist, was bedeutet, dass auch `MyArg` auflösbar sein muss. Offene Generics brauchen `services.AddTransient(typeof(IRepo<>), typeof(Repo<>))`.
- **Source-generierte DI-Container**. Strawberry Shake, Refit und gRPC-Source-Generatoren registrieren manchmal ihre eigenen Clients mit `IServiceCollection`. Wenn Sie ihre `Add*`-Erweiterung nach `Build` aufrufen, gilt dieselbe stille Verwerfungs-Regel.
- **Native AOT Builds**. Der trimming-freundliche Standard-Container in .NET 11 löst standardmäßig immer noch über Reflection auf. Wenn Sie mit `<PublishTrimmed>true</PublishTrimmed>` veröffentlichen und der Trimmer den Implementierungstyp entfernt, sehen Sie die Resolve-Service-Ausnahme zur Laufzeit, obwohl der Quellcode sauber kompiliert. Die Lösung ist `[DynamicDependency]` oder die Registrierung des Typs über eine typisierte Factory.

## Verwandt

- Logging und DI sauber zusammen verdrahten: [strukturierte Protokollierung mit Serilog und Seq in .NET 11](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).
- Die nächste Ausnahme, die Sie nach dieser treffen, wenn Sie die falsche Lebensdauer wählen: [Singleton, der einen scoped DbContext konsumiert](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- Eine verwandte EF-Core-Fehlanwendung, die auftaucht, wenn DI denselben `DbContext` an zwei Anfragen weitergibt: [a second operation was started on this context instance](/de/2026/05/fix-second-operation-was-started-on-this-context-instance/).
- DI-Tausche zur Testzeit, die diese Ausnahme umgehen, indem ein Fake registriert wird: [pooled DbContext-Factory in EF-Core-11-Tests](/de/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).
- Für den verwandten `IConfiguration`-Fehlermodus: [no connection string named 'DefaultConnection' could be found](/de/2026/05/fix-no-connection-string-named-defaultconnection/).

## Quellen

- Microsoft Learn, [Dependency injection in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection).
- Microsoft Learn, [Dependency injection guidelines](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines).
- Microsoft Learn, [Keyed services in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#keyed-services).
- Microsoft Learn, [Use scope validation](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-usage#scope-validation).
- ASP.NET-Core-Quellcode, [`ActivatorUtilities.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection.Abstractions/src/ActivatorUtilities.cs), wo die Ausnahme geworfen wird.
