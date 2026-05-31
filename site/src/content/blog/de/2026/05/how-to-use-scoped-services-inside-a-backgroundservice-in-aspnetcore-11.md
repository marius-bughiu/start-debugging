---
title: "Scoped Services in einem BackgroundService unter ASP.NET Core 11 verwenden"
description: "Ein BackgroundService ist ein Singleton und kann daher einen Scoped Service wie einen DbContext nicht direkt injizieren. Nehmen Sie IServiceScopeFactory, öffnen Sie pro Arbeitseinheit einen Scope mit CreateAsyncScope, lösen Sie darin auf und verwerfen Sie ihn nach getaner Arbeit."
pubDate: 2026-05-31
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
  - "backgroundservice"
lang: "de"
translationOf: "2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-05-31
---

Ein `BackgroundService` wird als Singleton registriert. Injiziert man daher einen Scoped Service wie einen `DbContext` direkt in seinen Konstruktor, wird entweder beim Start `Cannot consume scoped service 'X' from singleton 'Y'` ausgelöst oder, schlimmer noch, diese scoped Instanz an die Laufzeit des gesamten Prozesses gebunden. Die Lösung besteht darin, `IServiceScopeFactory` zu injizieren, für jede Arbeitseinheit innerhalb von `ExecuteAsync` mit `CreateAsyncScope()` einen frischen Scope zu öffnen, den Scoped Service aus dem Provider dieses Scopes aufzulösen und den Scope nach Abschluss der Arbeit zu verwerfen. Dieser Leitfaden ist gegen .NET 11 geschrieben (zum Zeitpunkt der Erstellung Preview 4, allgemeine Verfügbarkeit für November 2026 geplant), `Microsoft.Extensions.Hosting` 11.0.0 und EF Core 11. Die Verträge von `BackgroundService` und `IServiceScopeFactory` sind seit .NET Core 3.1 stabil, sodass alle Muster hier auch unverändert für .NET 6, 8 und 10 gelten.

## Warum ein BackgroundService einen Scoped Service nicht einfach injizieren kann

Jeder gehostete Service, den Sie mit `AddHostedService<T>` registrieren, ist ein Singleton. Das ist kein Standardwert, den Sie überschreiben können: `AddHostedService<T>` und `AddSingleton<IHostedService, T>` werden zur selben Registrierung aufgelöst, und der Host bezieht die Instanz während `StartAsync` aus dem **Root**-Provider. Der Root-Provider hat keinen umgebenden Scope.

Ein Scoped Service lebt per Definition einmal pro Scope. In einer Webanfrage wird dieser Scope pro Anfrage erstellt und verworfen. Ein `BackgroundService` läuft über die gesamte Laufzeit des Hosts, vollständig außerhalb jeder Anfrage. Es gibt also keinen Scope, gegen den die Laufzeit eine scoped Abhängigkeit auflösen könnte. Schreiben Sie einen Konstruktor wie `OrderWorker(AppDbContext db)`, geschieht eines von zwei Dingen:

- In `Development` aktiviert `WebApplication.CreateBuilder` die Option `ValidateScopes`, der Call-Site-Validator durchläuft den Graphen während des Builds, sieht einen Scoped Service, der in einen Singleton fließt, und löst `Cannot consume scoped service ...` aus. Falls dies genau die Ausnahme ist, mit der Sie hier gelandet sind, geht der eigene Leitfaden [Scoped Service kann nicht aus Singleton verwendet werden](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) jede Ausprägung durch.
- In `Production` ist die Scope-Validierung standardmäßig deaktiviert, sodass derselbe Code kompiliert und läuft. Der `DbContext` wird für die Lebensdauer des Prozesses gefangen gehalten. Sein Change Tracker sammelt jede jemals geladene Entität, seine Verbindung kehrt nie sauber in den Pool zurück, und früher oder später stoßen Sie auf `ObjectDisposedException` oder veraltete Lesevorgänge.

Keines der beiden Ergebnisse ist erwünscht. Das korrekte Modell lautet: Der Singleton-Worker besitzt die Schleife und die Abbruchsteuerung, und jede Iteration leiht sich einen kurzlebigen Scope, um die eigentliche Arbeit zu erledigen.

## Scoped-Auflösung in vier Schritten einrichten

Microsofts eigener [Leitfaden zu Worker Services](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) empfiehlt, die eigentliche Arbeit an einen Scoped Service zu delegieren und den `BackgroundService` selbst schlank zu halten. Hier ist die vollständige Form in vier Schritten.

1. **Registrieren Sie den Scoped Service** mit `AddScoped`, genau wie für einen an eine Anfrage gebundenen Consumer. Es ist nichts Besonderes nötig, weil er in einem Hintergrundkontext verwendet wird.
2. **Registrieren Sie den Worker** mit `AddHostedService<T>`. Er bleibt ein Singleton; versuchen Sie nicht, ihn scoped zu machen.
3. **Injizieren Sie `IServiceScopeFactory`** (nicht den Scoped Service und nicht `IServiceProvider`) in den Konstruktor des Workers.
4. **Öffnen Sie pro Arbeitseinheit einen Scope** innerhalb von `ExecuteAsync` mit `CreateAsyncScope()`, lösen Sie den Scoped Service aus `scope.ServiceProvider` auf, erledigen Sie die Arbeit und lassen Sie das `await using` den Scope verwerfen.

### Schritte 1 und 2: Registrierung

```csharp
// .NET 11, C# 14 - Program.cs
using App.Workers;

var builder = WebApplication.CreateBuilder(args);

// The scoped unit of work. Registered exactly like any request-scoped service.
builder.Services.AddScoped<IOrderProcessor, OrderProcessor>();

// The worker stays a singleton. AddHostedService always registers a singleton.
builder.Services.AddHostedService<OrderWorker>();

var app = builder.Build();
app.Run();
```

### Schritte 3 und 4: der Worker

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace App.Workers;

public sealed class OrderWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<OrderWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("OrderWorker started.");

        while (!stoppingToken.IsCancellationRequested)
        {
            // One scope per iteration: a fresh DbContext, change tracker, and
            // connection scope every time, disposed at the end of the block.
            await using var scope = scopeFactory.CreateAsyncScope();

            var processor = scope.ServiceProvider
                .GetRequiredService<IOrderProcessor>();

            await processor.ProcessPendingAsync(stoppingToken);

            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }
    }
}
```

Der Scoped Service, der die gesamte eigentliche Logik und die scoped Abhängigkeiten enthält:

```csharp
// .NET 11, C# 14
namespace App.Workers;

public interface IOrderProcessor
{
    Task ProcessPendingAsync(CancellationToken cancellationToken);
}

public sealed class OrderProcessor(
    AppDbContext db,                 // scoped, injected normally now
    ILogger<OrderProcessor> logger) : IOrderProcessor
{
    public async Task ProcessPendingAsync(CancellationToken cancellationToken)
    {
        var pending = await db.Orders
            .Where(o => o.Status == OrderStatus.Pending)
            .ToListAsync(cancellationToken);

        foreach (var order in pending)
        {
            order.Status = OrderStatus.Processed;
        }

        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Processed {Count} orders.", pending.Count);
    }
}
```

`OrderProcessor` injiziert `AppDbContext` direkt, weil er selbst scoped ist und nur innerhalb eines Scopes aufgelöst wird. Der Singleton-Worker sieht den `DbContext` nie. Diese Trennung ist der ganze Trick: Die Diskrepanz der Laufzeiten verschwindet in dem Moment, in dem der scoped Graph aus einem echten Scope statt aus dem Root aufgelöst wird.

## CreateAsyncScope versus CreateScope

Verwenden Sie für nahezu jeden modernen Code `CreateAsyncScope()`, nicht `CreateScope()`. Der Unterschied liegt im Verwerfen.

`CreateScope()` gibt einen `IServiceScope` zurück, der seine Scoped Services synchron über `IDisposable.Dispose()` verwirft. `CreateAsyncScope()` gibt einen `AsyncServiceScope` zurück, der über `IAsyncDisposable.DisposeAsync()` verwirft, wenn der Service dies implementiert, und auf synchrones Verwerfen zurückfällt, wenn nicht.

Das ist wichtig, weil der `DbContext` von EF Core in .NET 11 `IAsyncDisposable` implementiert, und mehrere Konfigurationen (pooled Kontexte, Kontexte mit einer offenen `DbConnection`) eine Ausnahme auslösen, wenn sie synchron verworfen werden. Schreiben Sie `using var scope = scopeFactory.CreateScope();` und der Scope enthält einen Kontext, der asynchrones Verwerfen erfordert, erhalten Sie am Ende des Blocks eine Ausnahme, die nichts mit Ihrer eigentlichen Arbeit zu tun hat.

```csharp
// .NET 11 - prefer this
await using var scope = scopeFactory.CreateAsyncScope();

// Only use the sync form when nothing in the scope needs async disposal
using var syncScope = scopeFactory.CreateScope();
```

Die Kosten von `CreateAsyncScope()` gegenüber `CreateScope()` sind praktisch null, wenn nichts asynchrones Verwerfen benötigt, sodass es keinen Grund gibt, standardmäßig zur synchronen Variante zu greifen.

## Ein Scope pro Arbeitseinheit, nicht einer pro Prozess

Der häufigste Fehler nach dem Umstieg auf `IServiceScopeFactory` ist, den Scope aus der Schleife herauszuziehen:

```csharp
// .NET 11 - WRONG. The scope lives for the whole process.
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    await using var scope = scopeFactory.CreateAsyncScope();      // created once
    var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();

    while (!stoppingToken.IsCancellationRequested)
    {
        await processor.ProcessPendingAsync(stoppingToken);       // same DbContext forever
        await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
    }
}
```

Das kompiliert, besteht die Scope-Validierung und führt genau den Fehler wieder ein, den Sie beheben wollten. Der einmal aufgelöste `DbContext` lebt nun über die gesamte Lebensdauer des Workers. Sein Change Tracker wächst bei jeder Iteration unbegrenzt, Abfragen werden langsamer, je größer der nachverfolgte Graph wird, und ein einziges fehlgeschlagenes `SaveChanges` kann den Kontext in einen Zustand versetzen, der jede folgende Iteration vergiftet. Außerdem öffnen Sie damit erneut die Tür zu [dem Fehler "zweite Operation auf der Kontextinstanz"](/de/2026/05/fix-second-operation-was-started-on-this-context-instance/), sobald sich zwei Iterationen überschneiden.

Erstellen Sie den Scope **innerhalb** der Schleife. Ein Scope ist günstig. Der Sinn des Musters besteht darin, dass jede Arbeitseinheit eine saubere Ausgangslage erhält: einen frischen Kontext, einen frischen Change Tracker und eine Verbindung, die aus dem Pool entnommen und am Ende der Iteration zurückgegeben wird.

## Scoped Services in einem warteschlangenleerenden Worker

Der Scope pro Iteration verallgemeinert sich naturgemäß auf einen Worker, der einen `Channel<T>` leert. Jedes aus der Warteschlange entnommene Element ist seine eigene Arbeitseinheit, also erhält jedes seinen eigenen Scope:

```csharp
// .NET 11, C# 14
using System.Threading.Channels;

public sealed class OrderQueueWorker(
    Channel<int> queue,
    IServiceScopeFactory scopeFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var orderId in queue.Reader.ReadAllAsync(stoppingToken))
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var processor = scope.ServiceProvider
                .GetRequiredService<IOrderProcessor>();

            await processor.ProcessOneAsync(orderId, stoppingToken);
        }
    }
}
```

`ReadAllAsync` berücksichtigt das Abbruchtoken bereits, sodass sich die Schleife beim Herunterfahren sauber auflöst. Jede Nachricht wird isoliert verarbeitet, und eine vergiftete Nachricht, die innerhalb eines Scopes eine Ausnahme auslöst, beschädigt den im nächsten verwendeten Kontext nicht.

## EF Core: IServiceScopeFactory versus IDbContextFactory

Wenn die einzige scoped Abhängigkeit, die Sie benötigen, ein `DbContext` ist, gibt EF Core Ihnen ein direkteres Werkzeug: `IDbContextFactory<T>`. Registrieren Sie sie mit `AddDbContextFactory`, das die Factory als Singleton registriert, und injizieren Sie die Factory direkt in den Worker:

```csharp
// .NET 11, EF Core 11 - Program.cs
builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default")));
```

```csharp
// .NET 11, EF Core 11
public sealed class OrderWorker(
    IDbContextFactory<AppDbContext> dbFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);

            var pending = await db.Orders
                .Where(o => o.Status == OrderStatus.Pending)
                .ToListAsync(stoppingToken);

            // process...
            await db.SaveChangesAsync(stoppingToken);

            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }
    }
}
```

Die Entscheidungsregel ist einfach. Benötigt Ihre Arbeitseinheit **nur** einen `DbContext`, verwenden Sie `IDbContextFactory<T>`: Es gibt keine Scope-Zeremonie, und die Factory liefert Ihnen bei jedem Aufruf einen frischen, korrekt verworfenen Kontext. Benötigt Ihre Arbeitseinheit einen Graphen aus Scoped Services (ein Repository, einen Tenant-Resolver, ein `IOptionsSnapshot<T>`, einen Domänenservice, der seinerseits vom Kontext abhängt), verwenden Sie `IServiceScopeFactory`, damit der gesamte Graph konsistent innerhalb eines einzigen Scopes aufgelöst wird. Sie können `AddDbContext` für anfragegebundenen Code und `AddDbContextFactory` für den Worker in derselben Anwendung registrieren.

## Ein Scope ist nicht thread-safe: Parallelität braucht einen Scope pro Task

Wenn Sie Elemente parallel verarbeiten, teilen Sie keinen einzelnen Scope zwischen den parallelen Tasks. Ein `DbContext` ist nicht thread-safe, und die Auflösung eines Scopes ebenso wenig. Geben Sie jedem parallelen Zweig seinen eigenen Scope:

```csharp
// .NET 11, C# 14
await Parallel.ForEachAsync(
    orderIds,
    new ParallelOptions
    {
        MaxDegreeOfParallelism = 4,
        CancellationToken = stoppingToken
    },
    async (orderId, ct) =>
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var processor = scope.ServiceProvider
            .GetRequiredService<IOrderProcessor>();
        await processor.ProcessOneAsync(orderId, ct);
    });
```

Jeder Aufruf des Rumpfes erhält einen unabhängigen Scope, einen unabhängigen `DbContext` und einen unabhängigen Change Tracker, also genau die Isolation, die Sie für nebenläufige Arbeit benötigen.

## Geordnetes Herunterfahren und StopAsync

`stoppingToken` wird signalisiert, sobald der Host mit dem Herunterfahren beginnt. Es an jeden asynchronen Aufruf innerhalb des Scopes weiterzugeben (die Abfrage, das `SaveChanges`, das `Task.Delay`), ermöglicht es dem Worker, umgehend zu stoppen, statt das Herunterfahren bis zum Shutdown-Timeout des Hosts (standardmäßig 30 Sekunden) zu blockieren.

Müssen Sie beim Stoppen des Hosts aufräumen, überschreiben Sie `StopAsync` und rufen Sie die Basisimplementierung auf:

```csharp
// .NET 11, C# 14
public override async Task StopAsync(CancellationToken cancellationToken)
{
    logger.LogInformation("OrderWorker stopping, draining in-flight work.");
    await base.StopAsync(cancellationToken);
}
```

Eine Feinheit: Ein langer blockierender Aufruf innerhalb der Schleife, der `stoppingToken` ignoriert, wird nicht unterbrochen, und der Host wartet das volle Shutdown-Timeout ab, bevor er den Prozess abbaut. Kann Ihre Arbeitseinheit lange laufen, reichen Sie das Token vollständig durch. Zur verwandten Frage, wie man Arbeit stoppt, die nicht mit dem Abbruch kooperiert, siehe [eine lang laufende Task in C# ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking).

## Fehler, die die Scope-Validierung überleben

Diese kompilieren alle und bestehen `ValidateScopes`, weshalb es sich lohnt, sie zu benennen:

- **`IServiceProvider` statt `IServiceScopeFactory` injizieren.** Der in einen Singleton injizierte Provider ist der Root-Provider. Einen Scoped Service daraus aufzulösen, löst je nach Validierungseinstellung eine Ausnahme aus oder fängt ihn ein. Injizieren Sie stets `IServiceScopeFactory` und rufen Sie `CreateAsyncScope()` auf.
- **Aus dem gefangenen Root-Provider innerhalb des Scopes auflösen.** Schreiben Sie `scope.ServiceProvider.GetRequiredService<T>()`, niemals `_rootProvider.GetRequiredService<T>()`. Aus dem Root innerhalb eines selbst geöffneten Scopes aufzulösen, hebt den Scope vollständig auf.
- **Einen aufgelösten Scoped Service in einem Feld speichern.** Die Instanz darf den Scope nicht überleben. Übergeben Sie sie als Methodenparameter und lassen Sie sie mit dem `await using` aus dem Scope laufen.
- **Das `await using` vergessen.** Ein bloßes `var scope = scopeFactory.CreateAsyncScope();` ohne Verwerfen leakt den Scope und jeden darin enthaltenen Service für die gesamte Lebensdauer des Prozesses.

Für Worker, die Sie in der Produktion betreiben wollen, kombinieren Sie dieses Muster mit ordentlicher Observability, damit eine festhängende oder stillschweigend fehlschlagende Schleife auffällt; der Ansatz in [Hintergrundjobs ohne Hangfire überwachen](/de/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts) gilt direkt. Und für ein vollständiges Beispiel desselben Scope-Factory-Musters um eine nicht triviale Abhängigkeit siehe [ein Semantic-Kernel-Plugin aus einem BackgroundService ausführen](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).

Das mentale Modell, das dies korrekt hält: Der Singleton besitzt die Schleife und die Abbruchsteuerung; der Scope besitzt die Arbeit und den Zustand pro Einheit. Halten Sie diese beiden Verantwortlichkeiten getrennt, und die Laufzeitfehler treten gar nicht erst auf.

## Quellen

- Microsoft Learn, [Use scoped services within a BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) (aktualisiert am 2026-05-27), das kanonische Tutorial zu Worker Services.
- Microsoft Learn, [Dependency injection in .NET: service lifetimes](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#service-lifetimes).
- Microsoft Learn, [`AsyncServiceScope` and `CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope).
- Microsoft Learn, [Using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- .NET Blog, [.NET 11 Preview 1 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-1/).
