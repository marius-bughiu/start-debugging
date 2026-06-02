---
title: "Lösung: ObjectDisposedException: Cannot access a disposed context instance"
description: "Ihre Fire-and-Forget-Task hat einen anfragebezogenen DbContext erfasst, den der DI-Scope bereits freigegeben hatte. Lösen Sie innerhalb der Task einen frischen Kontext mit IServiceScopeFactory oder IDbContextFactory auf."
pubDate: 2026-06-02
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "async"
lang: "de"
translationOf: "2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance"
translatedBy: "claude"
translationDate: 2026-06-02
---

Die Lösung: Eine Fire-and-Forget-`Task` hat einen `DbContext` (oder einen anderen Dienst mit Scope) erfasst, der in einem DI-Scope lebte, welcher freigegeben wurde, bevor die Task fertig war. Die Anfrage kehrte zurück, ASP.NET Core gab den Scope und seinen `DbContext` frei, und Ihre abgekoppelte Task griff danach auf die tote Instanz zu. Erfassen Sie den Kontext mit Scope nicht: Erstellen Sie innerhalb der Task Ihren eigenen Scope mit `IServiceScopeFactory.CreateAsyncScope` und lösen Sie daraus einen neuen `DbContext` auf, oder injizieren Sie `IDbContextFactory<T>` und rufen Sie `CreateDbContextAsync` auf.

```text
System.ObjectDisposedException: Cannot access a disposed context instance. A common cause of this error is disposing a context instance that was resolved from dependency injection and then later trying to use the same context instance elsewhere in your application. This may occur if you are calling Dispose() on the context instance, or wrapping it in a using statement. If you are using dependency injection, you should let the dependency injection container take care of disposing context instances.
Object name: 'AppDb'.
   at Microsoft.EntityFrameworkCore.DbContext.CheckDisposed()
   at Microsoft.EntityFrameworkCore.DbContext.get_DbContextDependencies()
   at Microsoft.EntityFrameworkCore.DbContext.Set[TEntity]()
   at Microsoft.EntityFrameworkCore.Internal.InternalDbSet`1.get_EntityQueryable()
```

Dieser Leitfaden wurde gegen .NET 11 preview 4 und `Microsoft.EntityFrameworkCore` 11.0.0-preview.4 geschrieben, aber der Meldungstext und die `CheckDisposed`-Prüfung sind seit EF Core 3.0 stabil. Die Exception wird aus `DbContext.CheckDisposed()` ausgelöst, das am Anfang jedes öffentlichen Members läuft: `Set<T>`, `SaveChangesAsync`, `Database`, der Change Tracker, alles. Wenn Sie sie sehen, ist das Objekt tatsächlich schon weg. EF Core befindet sich nicht in einer Race Condition und verhält sich nicht falsch; etwas hat den Kontext freigegeben, und dann hat der Code trotzdem danach gegriffen.

## Was "freigegeben" hier tatsächlich bedeutet

Ein `DbContext`, der aus Dependency Injection aufgelöst wurde, gehört dem Scope, aus dem er aufgelöst wurde. In ASP.NET Core erstellt das Framework einen DI-Scope pro HTTP-Anfrage und gibt ihn frei, wenn die Antwort abgeschlossen ist. Das Freigeben des Scopes gibt jedes `IDisposable` frei, das er erstellt hat, einschließlich Ihres `DbContext`. Danach wird der interne Service-Provider des Kontexts abgebaut, seine `DbConnection` kehrt in den Pool zurück, und `_disposed` wird auf `true` gesetzt. Jeder spätere Aufruf erreicht `CheckDisposed()` und löst die Exception aus.

Der Fehler hat fast nie damit zu tun, dass Sie selbst `using` schreiben oder `Dispose()` aufrufen (obwohl das die andere Art ist, ihn auszulösen). In der Praxis geht es um die Lebensdauer: Der Code hat den Scope überlebt, dem der Kontext gehörte. Die mit Abstand häufigste Form ist eine Fire-and-Forget-Task, die aus einer Anfrage gestartet wurde und den Kontext dieser Anfrage erfasst hat.

## Der minimale Repro

Ein Controller stößt Hintergrundarbeit an, ohne sie abzuwarten, und das Lambda schließt über den injizierten `DbContext`:

```csharp
// .NET 11, C# 14, EF Core 11.0.0 -- wrong
public class OrdersController(AppDb db) : ControllerBase
{
    [HttpPost("orders")]
    public IActionResult Create(OrderDto dto)
    {
        var order = new Order(dto);
        db.Orders.Add(order);

        // fire-and-forget: not awaited, escapes the request lifetime
        _ = Task.Run(async () =>
        {
            await Task.Delay(2000);            // simulate slow work
            db.AuditLog.Add(new Audit(order)); // db is disposed by now
            await db.SaveChangesAsync();        // throws ObjectDisposedException
        });

        return Accepted();
    }
}
```

Die Abfolge: `Create` gibt `Accepted()` fast sofort zurück, ASP.NET Core gibt den Anfrage-Scope frei (und `db` mit ihm), und zwei Sekunden später wacht die abgekoppelte Task auf und ruft einen Kontext auf, dessen `_disposed`-Flag bereits gesetzt ist. Das `Add` kann je nach Timing sogar erfolgreich erscheinen, aber `SaveChangesAsync` löst zuverlässig die Exception aus, weil es die freigegebenen Abhängigkeiten berührt.

Dasselbe passiert mit `ContinueWith`, mit einem `async void`-Ereignishandler, der den Kontext erfasst, mit einem `Timer`-Callback, der über ihn schließt, und mit einem `BackgroundService`, der einmal im Konstruktor einen Kontext mit Scope aufgelöst hat und ihn für immer wiederverwendet.

## Lösung 1: Erstellen Sie einen Scope innerhalb der Task und lösen Sie einen frischen Kontext auf

Das ist die richtige Antwort, wenn die Hintergrundarbeit Dienste mit Scope über den reinen Datenzugriff hinaus benötigt. Injizieren Sie `IServiceScopeFactory` (ein Singleton, immer sicher zu erfassen) und öffnen Sie einen Scope innerhalb des Task-Rumpfs:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class OrdersController(AppDb db, IServiceScopeFactory scopeFactory)
    : ControllerBase
{
    [HttpPost("orders")]
    public async Task<IActionResult> Create(OrderDto dto)
    {
        var order = new Order(dto);
        db.Orders.Add(order);
        await db.SaveChangesAsync();     // the request's own work, awaited

        var orderId = order.Id;          // capture a value, not the context

        _ = Task.Run(async () =>
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var bgDb = scope.ServiceProvider.GetRequiredService<AppDb>();
            bgDb.AuditLog.Add(new Audit(orderId));
            await bgDb.SaveChangesAsync();
        });

        return Accepted();
    }
}
```

Zwei Dinge haben sich geändert. Die Task erfasst `orderId` (ein `int`), nicht den `DbContext`. Und sie löst einen brandneuen `AppDb` aus einem Scope auf, der ihr gehört, sodass die Freigabe dieses Scopes an das Beenden der Task gebunden ist, nicht an die HTTP-Anfrage. `CreateAsyncScope` (statt des synchronen `CreateScope`) ist wichtig, weil `DbContext` `IAsyncDisposable` implementiert; die Verwendung des asynchronen Scopes gibt ihn über den asynchronen Pfad frei und vermeidet eine Sync-over-Async-Warnung unter den Analyzern.

Erfassen Sie auch niemals Entity-Instanzen über die Grenze hinweg. Das `order`-Objekt wird vom Kontext der Anfrage nachverfolgt; es an den Kontext des neuen Scopes weiterzugeben lädt zur Kollision "instance of entity type cannot be tracked" ein. Übergeben Sie den Schlüssel und laden Sie neu oder hängen Sie innerhalb der Task neu an.

## Lösung 2: Injizieren Sie IDbContextFactory, wenn die Arbeit reiner Datenzugriff ist

Wenn die abgekoppelte Arbeit nur einen `DbContext` und nichts weiter mit Scope benötigt, ist `IDbContextFactory<T>` sauberer, als einen ganzen DI-Scope hochzufahren. Registrieren Sie sie neben (oder anstelle von) dem Kontext mit Scope:

```csharp
// .NET 11, EF Core 11.0.0 -- Program.cs
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));
```

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class OrdersController(IDbContextFactory<AppDb> factory) : ControllerBase
{
    [HttpPost("orders")]
    public async Task<IActionResult> Create(OrderDto dto)
    {
        int orderId;
        await using (var db = await factory.CreateDbContextAsync())
        {
            var order = new Order(dto);
            db.Orders.Add(order);
            await db.SaveChangesAsync();
            orderId = order.Id;
        }

        _ = Task.Run(async () =>
        {
            await using var bgDb = await factory.CreateDbContextAsync();
            bgDb.AuditLog.Add(new Audit(orderId));
            await bgDb.SaveChangesAsync();
        });

        return Accepted();
    }
}
```

`IDbContextFactory<T>` wird als Singleton registriert, daher ist es sicher, sie im Closure zu erfassen. Jedes `CreateDbContextAsync` übergibt Ihnen einen Kontext, dessen Lebensdauer Sie mit `await using` steuern. Die Factory umgeht den Anfrage-Scope vollständig, was genau das ist, was eine abgekoppelte Task will. Wenn Sie auch `AddDbContextFactory` aufrufen, beachten Sie, dass in EF Core 11 dieselbe Registrierung sowohl die Injektion von `AppDb` mit Scope als auch die Injektion der Factory erfüllen kann, sodass Sie nicht global eine wählen müssen. Greifen Sie zu `AddPooledDbContextFactory`, wenn die Erstellungskosten in einem Profil auftauchen, aber setzen Sie jeglichen Zustand pro Kontext zwischen den Ausleihen zurück.

## Lösung 3: Hören Sie auf, abzufeuern und zu vergessen -- übergeben Sie die Arbeit an einen echten Hintergrundmechanismus

`Task.Run` aus einem Request-Handler ist das falsche Werkzeug, selbst wenn Sie die Lebensdauer des Kontexts korrigieren: Die Arbeit hat keine Wiederholung, keine Backpressure, keine Behandlung des kontrollierten Herunterfahrens, und der Thread, auf dem sie läuft, konkurriert mit der Anfrageverarbeitung. Die dauerhafte Lösung ist, eine Nachricht in eine Warteschlange zu stellen und einen Hosted Service sie in seinem eigenen Scope abarbeiten zu lassen. Ein `Channel<T>` ist die leichteste In-Process-Option:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public sealed record AuditWork(int OrderId);

public class AuditQueue
{
    private readonly Channel<AuditWork> _channel =
        Channel.CreateUnbounded<AuditWork>();

    public ValueTask Enqueue(AuditWork work) => _channel.Writer.WriteAsync(work);
    public IAsyncEnumerable<AuditWork> Reader(CancellationToken ct) =>
        _channel.Reader.ReadAllAsync(ct);
}

public class AuditWorker(AuditQueue queue, IServiceScopeFactory scopeFactory)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var work in queue.Reader(stoppingToken))
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            db.AuditLog.Add(new Audit(work.OrderId));
            await db.SaveChangesAsync(stoppingToken);
        }
    }
}
```

Registrieren Sie `AuditQueue` als Singleton und `AuditWorker` mit `AddHostedService`. Der Controller ruft jetzt nur noch `await queue.Enqueue(new AuditWork(orderId))` auf und kehrt zurück. Jede Arbeitseinheit erhält ihren eigenen Scope und ihren eigenen Kontext innerhalb des Workers, die Arbeit überlebt die Rückkehr der Anfrage, und das Herunterfahren wird sauber abgearbeitet, weil die Schleife `stoppingToken` beachtet. Das ist das Muster, das der [Leitfaden zu sicherem Fire-and-Forget mit BackgroundService](/de/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) vollständig behandelt, und der [Leitfaden zu Channels als BlockingCollection-Ersatz](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) erklärt die Warteschlangenseite ausführlich.

## Warum ein BackgroundService, der DbContext injiziert, beim Start fehlschlägt

Eine subtilere Variante: Sie injizieren `AppDb` direkt in den Konstruktor eines `BackgroundService` und erhalten zuerst einen anderen Fehler.

```csharp
// .NET 11, EF Core 11.0.0 -- wrong, fails to start
public class AuditWorker(AppDb db) : BackgroundService { /* ... */ }
```

Ein `BackgroundService` ist ein Singleton. Einen `AppDb` mit Scope in einen Singleton zu injizieren löst beim Start den DI-Scope-Validator mit "Cannot consume scoped service 'AppDb' from singleton" aus. Wenn Sie das irgendwie unterdrücken (sollten Sie nicht), würde der Singleton einen Kontext für die gesamte Lebensdauer des Prozesses halten, und Sie wären wieder bei `ObjectDisposedException` oder Thread-Fehlern beim ersten Mal, wenn sich zwei Iterationen überschneiden. Die Lösung ist dasselbe `CreateAsyncScope`-Muster aus Lösung 1. Der Beitrag über den [Fehler "Dienst mit Scope aus Singleton"](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) und der [Leitfaden zu Diensten mit Scope innerhalb eines BackgroundService](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) erklären beide, warum Singletons keinen Zustand mit Scope halten können.

## Freigabe, die Sie selbst verursacht haben

Zwei Formen, die kein Fire-and-Forget sind, erzeugen die identische Meldung:

Sie haben einen per DI aufgelösten Kontext in `using` eingewickelt. Wenn `AppDb` aus Konstruktor-Injektion kam, gehört er dem Container; ein `using`-Block gibt ihn zu früh frei, und der nächste Member-Aufruf in derselben Anfrage löst die Exception aus. Lassen Sie den Container ihn freigeben: Entfernen Sie das `using`. Geben Sie nur Kontexte frei, die Sie selbst mit `new` oder über eine Factory erstellt haben.

Sie haben ein `IEnumerable<T>` oder `IQueryable<T>` aus einer Methode zurückgegeben, und der Aufrufer durchläuft es, nachdem der Kontext bereits weg ist. Verzögertes LINQ wird erst bei der Aufzählung ausgeführt; wenn der Kontext der Methode an ein `using` oder an eine bereits beendete Anfrage gebunden war, erreicht die Aufzählung einen freigegebenen Kontext. Materialisieren Sie innerhalb der Methode mit `ToListAsync`, oder halten Sie den Kontext für die Aufzählung am Leben.

## Varianten, die so aussehen, es aber nicht sind

### "A second operation was started on this context instance before a previous operation completed"

Dieselbe Familie, andere Ursache: Zwei Operationen haben sich auf einem lebenden (nicht freigegebenen) Kontext überschnitten, normalerweise ein vergessenes `await` oder ein `Task.WhenAll` über einen Kontext. Die Lösung ist ebenfalls ein Kontext pro Operation, ausführlich im [Leitfaden zu second-operation-started](/de/2026/05/fix-second-operation-was-started-on-this-context-instance/).

### "Cannot access a disposed object. Object name: 'IServiceProvider'"

Der gesamte Scope oder der Root-Provider wurde freigegeben, nicht nur der Kontext. Dieselbe Grundursache (Lebensdauer), aber es bedeutet, dass Sie einen `IServiceProvider`/`IServiceScope` erfasst und nach dessen Freigabe verwendet haben. Lösen Sie alles auf, was Sie brauchen, bevor der Scope endet, oder halten Sie den Scope für die Arbeit am Leben.

### "The ConnectionString property has not been initialized"

Ein mit `new` erstellter Kontext ohne konfigurierten Provider, kein Freigabeproblem. Sie haben die DI umgangen und `OnConfiguring` oder die Optionen vergessen. Verwenden Sie die Factory oder die DI statt `new AppDb()`.

### "ObjectDisposedException" bei einer CancellationTokenSource

Eine `CancellationTokenSource`, die freigegeben wurde, während ein Token von ihr noch in Verwendung ist. Ohne Bezug zu EF Core, auch wenn der Exception-Typ übereinstimmt. Sehen Sie sich die Zeile `Object name:` an -- sie benennt das freigegebene Objekt, und das ist Ihr schnellstes Triage-Signal.

## Verwandtes

Für den breiteren Überblick zum Ausführen abgekoppelter Arbeit ohne Leck von Zustand mit Scope sind die Leitfäden zu [sicheren Fire-and-Forget-Mustern](/de/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) und [Diensten mit Scope innerhalb eines BackgroundService](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) die beiden, die als Nächstes zu lesen sind. Wenn Ihr Fire-and-Forget als `async void` begann, erklärt die [Aufschlüsselung von async void vs async Task](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/), warum das die Exception vollständig verschluckt. Und wenn die abgekoppelte Task beim Herunterfahren sauber stoppen muss, behandelt der [Leitfaden zum Abbrechen ohne Deadlock](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) die Token-Disziplin.

## Quellen

- [DbContext lifetime, configuration, and initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), EF Core-Dokumentation.
- [`IDbContextFactory<TContext>` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [`DbContext.CheckDisposed` source](https://github.com/dotnet/efcore/blob/main/src/EFCore/DbContext.cs), dotnet/efcore auf GitHub.
- [Consuming a scoped service in a background task](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service), .NET-Dokumentation.
- [`ServiceProviderServiceExtensions.CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope), Microsoft Learn.
