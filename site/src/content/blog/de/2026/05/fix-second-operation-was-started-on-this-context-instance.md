---
title: "Fix: A second operation was started on this context instance before a previous operation completed"
description: "EF Core wirft diese Ausnahme, wenn zwei await parallel auf demselben DbContext laufen. Warten Sie jeden Aufruf sequenziell ab, oder holen Sie sich pro nebenläufiger Arbeitseinheit einen frischen DbContext über IDbContextFactory."
pubDate: 2026-05-07
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "async"
lang: "de"
translationOf: "2026/05/fix-second-operation-was-started-on-this-context-instance"
translatedBy: "claude"
translationDate: 2026-05-07
---

Die Behebung: Ein `DbContext` ist nicht thread-safe, und es darf immer nur eine Abfrage, ein Speichern oder ein Durchlauf des Change Trackers gleichzeitig auf ihm laufen. Die Ausnahme bedeutet, dass sich zwei Operationen auf derselben Instanz überlappt haben, fast immer weil eine `Task` ohne `await` gestartet wurde, weil ein `Parallel.ForEachAsync`-Body den Kontext geteilt hat, oder weil ein erfasstes Feld von zwei Anfragen gleichzeitig getroffen wurde. Warten Sie entweder den ersten Aufruf ab, bevor Sie den zweiten starten, oder geben Sie jeder nebenläufigen Arbeitseinheit ihren eigenen `DbContext` über `IDbContextFactory<T>`.

```text
System.InvalidOperationException: A second operation was started on this context instance before a previous operation completed. This is usually caused by different threads concurrently using the same instance of DbContext. For more information on how to avoid threading issues with DbContext, see https://go.microsoft.com/fwlink/?linkid=2097913.
   at Microsoft.EntityFrameworkCore.Internal.ConcurrencyDetector.EnterCriticalSection()
   at Microsoft.EntityFrameworkCore.Query.Internal.QueryCompiler.ExecuteAsync[TResult](Expression query, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Query.Internal.EntityQueryProvider.ExecuteAsync[TResult](Expression expression, CancellationToken cancellationToken)
   at System.Linq.AsyncEnumerable.ToListAsync[TSource](IAsyncEnumerable`1 source, CancellationToken cancellationToken)
```

Diese Anleitung wurde gegen .NET 11 preview 4 und `Microsoft.EntityFrameworkCore` 11.0.0-preview.4 geschrieben. Der Text und der zugrunde liegende `ConcurrencyDetector` sind seit EF Core 2.0 unverändert; nur die umliegenden Stack-Trace-Interna verschieben sich zwischen Releases. Die Ausnahme stammt aus `ConcurrencyDetector.EnterCriticalSection`, welcher jede öffentliche async-API auf `DbContext` schützt. Es gibt seitens EF Core keine Race Condition, der Detector hat recht: Er hat erkannt, dass Sie versuchen, zwei Operationen durch eine Identity Map und ein offenes Command zu treiben.

## Warum ein DbContext per Design single-threaded ist

`DbContext` führt eine private Zustandsmaschine: eine Identity Map der verfolgten Entitäten, eine ausstehende Liste von Änderungen, eine offene `DbConnection` und höchstens ein `DbCommand` in Bearbeitung. ADO.NET-Provider erlauben keine zwei Commands auf derselben Connection, es sei denn MARS ist aktiv, und selbst mit MARS würden sich Mutationen des Change Trackers über zwei Abfragen hinweg in beliebiger Weise gegenseitig ins Gehege kommen. Statt alles intern zu synchronisieren und die Kosten bei jedem Aufruf zu zahlen, sagt EF Core nein: eine Operation pro Instanz zur Zeit. Der `ConcurrencyDetector` ist eine debug-freundliche Durchsetzung dieses Vertrages, nicht die Ursache des Problems.

Dieser Vertrag gilt für jede `*Async`-Methode: `ToListAsync`, `FirstOrDefaultAsync`, `SaveChangesAsync`, `AnyAsync`, `CountAsync`, `Database.ExecuteSqlAsync`, plus die synchronen Geschwister, falls Sie `.Result` oder `.GetAwaiter().GetResult()` an derselben Aufrufstelle einmischen. Wenn sich zwei davon auf demselben `DbContext` überlappen, wirft die zweite.

## Eine minimale Reproduktion

Die kürzeste verlässliche Reproduktion ist `Task.WhenAll` über demselben Kontext:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class Report(AppDb db)
{
    public async Task<(int customers, int orders)> Counts()
    {
        var customersTask = db.Customers.CountAsync();
        var ordersTask = db.Orders.CountAsync();

        await Task.WhenAll(customersTask, ordersTask); // throws
        return (await customersTask, await ordersTask);
    }
}
```

Beide `CountAsync`-Aufrufe starten fast simultan; der zweite tritt in `ConcurrencyDetector.EnterCriticalSection` ein, während der erste noch darin ist, und der Detector wirft. Die Behebung besteht nicht darin, Locking einzuführen, sondern zu erkennen, dass Sie zwei unabhängige Arbeitseinheiten wollten und nur ein Werkzeug hatten.

Eine subtilere Reproduktion ist ein vergessenes `await`:

```csharp
// .NET 11, EF Core 11.0.0 -- still wrong
public async Task ProcessOrder(int id)
{
    var orderTask = db.Orders.FirstOrDefaultAsync(o => o.Id == id);
    var auditTask = db.AuditLog.AddAsync(new AuditEntry(id)); // no await
    await db.SaveChangesAsync(); // throws
}
```

`AddAsync` gibt einen `ValueTask` zurück. Ohne ihn abzuwarten haben Sie das Hinzufügen nicht wirklich abgeschlossen, aber der Aufruf hat den Change Tracker bereits berührt. Dann läuft `SaveChangesAsync` gegen einen Tracker mitten in der Mutation, und der Detector schlägt an. Gleiche Ursache: zwei Operationen überlappen sich auf derselben Instanz.

## Drei Behebungen, in Reihenfolge der Priorität

Wenden Sie diese in dieser Reihenfolge an. Die erste ist in 90% der Fälle die richtige Antwort; die dritte ist der Notausgang für tatsächlich nebenläufige Arbeit.

### 1. Sequentiell awaiten, wenn Sie nur eine Verbindung brauchen

Wenn Sie eigentlich nicht brauchen, dass die Abfragen parallel laufen, starten Sie sie nicht parallel. Die Wanduhr-Kosten von zwei sequentiellen `CountAsync`-Aufrufen rechtfertigen den Bug selten:

```csharp
// .NET 11, EF Core 11.0.0
public async Task<(int customers, int orders)> Counts()
{
    var customers = await db.Customers.CountAsync();
    var orders = await db.Orders.CountAsync();
    return (customers, orders);
}
```

Für einen Request-Handler, der mit einer einzigen Datenbank spricht, ist das fast immer korrekt. Die zweite Abfrage läuft auf derselben bereits geöffneten Verbindung, also gibt es jenseits der Abfrage selbst keine Kosten für einen zweiten Round-Trip. Greifen Sie nur dann zu Parallelismus, wenn Sie gemessen haben, dass zwei Abfragen gegen dasselbe Backend echte Zeit sparen, was selten ist, weil die Datenbank selbst Commands pro Connection ohnehin serialisiert.

### 2. Verwenden Sie IDbContextFactory für tatsächlich nebenläufige Arbeitseinheiten

Wenn Sie zwei Abfragen wirklich gleichzeitig brauchen (am häufigsten in einem `BackgroundService`, einem `Hangfire`-Job, einem CLI-Tool, das Batches verarbeitet, oder Fan-out-Szenarien), geben Sie jedem Task seinen eigenen `DbContext`:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

public class Report(IDbContextFactory<AppDb> factory)
{
    public async Task<(int customers, int orders)> Counts()
    {
        var customersTask = CountAsync(db => db.Customers);
        var ordersTask = CountAsync(db => db.Orders);

        await Task.WhenAll(customersTask, ordersTask);
        return (await customersTask, await ordersTask);
    }

    private async Task<int> CountAsync<T>(Func<AppDb, IQueryable<T>> set)
    {
        await using var db = await factory.CreateDbContextAsync();
        return await set(db).CountAsync();
    }
}
```

Jede nebenläufige Operation bekommt nun ihren eigenen Kontext, ihre eigene Verbindung aus dem Pool und ihren eigenen Change Tracker. Es gibt keinen geteilten veränderlichen Zustand, also hat der Detector nichts zu beanstanden. `AddDbContextFactory` ist die unterstützte Registrierung; versuchen Sie nicht, manuell ein `DbContext` zu `new`en, um dem Lebenszyklus zu entkommen, das umgeht die Optionsauflösung und das Pooling.

Wenn Sie zusätzlich gepoolte Instanzen für günstige Erstellung möchten, registrieren Sie stattdessen `AddPooledDbContextFactory`. Für die Trade-offs gepoolter Factories in Test-Setups beschreibt [das Muster für entfernbaren gepoolten Factory-Tausch](/de/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) die Falle des zwischen Mietvorgängen leckenden Zustands.

### 3. Lösen Sie pro Operation einen frischen Scope auf

Im framework-verwalteten Scoped-Lebenszyklus (Standard für ASP.NET Core) besteht die Behebung darin, für jeden parallelen Zweig einen Child-Scope zu erstellen:

```csharp
// .NET 11, EF Core 11.0.0
public class Report(IServiceScopeFactory scopes)
{
    public async Task ProcessAll(IEnumerable<int> ids)
    {
        await Parallel.ForEachAsync(ids, async (id, ct) =>
        {
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            var order = await db.Orders.FirstOrDefaultAsync(o => o.Id == id, ct);
            // ... process order ...
        });
    }
}
```

`CreateAsyncScope` baut einen frischen DI-Scope, sodass das Auflösen von `AppDb` daraus eine andere Instanz zurückgibt als der äußere Request-Scope und als jede andere Iteration. Das ist die richtige Form für `Parallel.ForEachAsync` gegen EF Core. Das Factory-Muster aus Behebung 2 ist vorzuziehen, wenn die Arbeit reiner Datenzugriff ist; das Scope-Muster ist besser, wenn der Schleifenkörper auch andere scoped Services braucht.

## Häufige Formen, die das auslösen

### Den Request-DbContext mit Task.Run teilen

Ein klassischer ASP.NET-Core-Fehler: Ein Request-Handler stößt einen Fire-and-Forget-Background-Task an, der den request-scoped `DbContext` erfasst:

```csharp
// .NET 11, EF Core 11.0.0 -- wrong
[HttpPost]
public IActionResult QueueWork()
{
    _ = Task.Run(async () =>
    {
        await db.AuditLog.AddAsync(new AuditEntry("queued"));
        await db.SaveChangesAsync();
    });
    return Accepted();
}
```

Hier überlappen sich zwei Fehlermodi. Erstens kehrt der Request zurück und der DI-Scope verwirft den `DbContext`, während der Background-Task noch läuft, sodass Sie auch `ObjectDisposedException` sehen. Zweitens, wenn irgendein anderer Code-Pfad auf dem Request den Kontext noch nutzt, streiten beide Threads um ihn und der Detector wirft. Die Behebung ist dieselbe wie bei #2: injizieren Sie `IDbContextFactory<AppDb>`, oder geben Sie die Arbeit an einen echten Background-Mechanismus (`IHostedService`, Channels, eine Job-Queue), der seinen eigenen Scope besitzt. [Die Channels-als-BlockingCollection-Ersatz-Anleitung](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) deckt das In-Process-Queue-Muster ab.

### Streaming eines IAsyncEnumerable über eine HTTP-Grenze

Wenn Sie aus einem Controller, der von einer EF-Core-Abfrage gestützt wird, `IAsyncEnumerable<T>` zurückgeben, enumeriert ASP.NET Core es, während es die Antwort serialisiert. Wenn irgendetwas anderes auf diesem Scope denselben `DbContext` trifft, während die Serialisierung läuft, wirft der Detector. Leicht zu treffen, wenn eine Middleware später eine Audit-Zeile in einem `OnStarting`-Callback hinzufügt, während der Body noch streamt.

Die Behebung besteht darin, das Enumerable zu materialisieren, oder sicherzustellen, dass der Streaming-Endpunkt für die Lebensdauer der Antwort den einzigen Zugriff auf diesen Kontext besitzt. [Die `IAsyncEnumerable`-mit-EF-Core-Anleitung](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) durchläuft das Streaming-Modell und die Lebenszyklen, die damit funktionieren.

### Erfasster DbContext in einem Event Handler oder statischen Feld

Ein als statisches Feld gespeicherter `DbContext` oder einer, der in einem beim Start angemeldeten Event Handler erfasst wird, wird bei jedem Event wiederverwendet. Zwei Events, die kurz hintereinander eintreffen, überlappen sich auf ihm. Gleiche Behebung: injizieren Sie die Factory, erfassen Sie nicht.

### Singleton-scoped DbContext

Ein als `Singleton` registrierter `DbContext` (versehentlich oder über `AddSingleton<MyService>`, wo `MyService` `AppDb` injiziert) endet zwischen Requests geteilt. Concurrency ist dann unter jeder echten Last garantiert. [Der Identity-Map-Kollisions-Leitfaden](/de/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/) durchläuft dieselbe Singleton/Scoped-Falle aus dem Blickwinkel des Duplikatschlüssels; beide Fehler entstammen derselben Ursache.

### Synchrones und asynchrones an derselben Aufrufstelle mischen

`db.SaveChanges()` gefolgt von einer früher gestarteten (und nicht abgewarteten) noch laufenden Async-Abfrage löst den Detector aus, sobald Sie die asynchrone schließlich `awaiten`. Das taucht meist in Legacy-Code-Pfaden auf, wo jemand ein `_ = SomethingAsync()` hinzugefügt hat, um die Compiler-Warnung zu unterdrücken. Die Warnung zu unterdrücken hat auch den Bug unterdrückt; die Behebung ist, es zu `awaiten`.

### Einen DbContext zwischen Polly-Retry-Versuchen wiederverwenden

Wenn Sie einen Aufruf in `Polly` einpacken und der Retry läuft, während die `Task` des vorherigen Versuchs noch lebt (die Cancellation propagierte nicht sauber), berühren beide Versuche denselben Kontext. Paaren Sie Retries mit `IDbContextFactory<T>`, sodass jeder Versuch einen frischen Kontext erhält, oder stellen Sie sicher, dass der vorherige Versuch vollständig gecancelt ist (`ct.ThrowIfCancellationRequested()`-Pfade durch den EF-Core-Aufruf), bevor erneut versucht wird. [Die Cancel-ohne-Deadlock-Anleitung](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) deckt die Cancellation-Disziplin ab, die das sicher macht.

## Varianten, die wie dieser Fehler aussehen, es aber nicht sind

### "There is already an open DataReader associated with this Connection which must be closed first"

Andere Ausnahme, gleiche Familie. Diese kommt aus ADO.NET, wenn MARS aus ist und Sie versucht haben, einen zweiten Reader auf derselben Connection zu starten. EF Core verbirgt das die meiste Zeit, aber rohe Arbeit mit `db.Database.GetDbConnection()` umgeht den Detector und zeigt stattdessen den darunterliegenden Fehler. Die Behebung hat dieselbe Form (eine Operation pro Mal, oder eine Verbindung pro Operation), aber das Einschalten von `MultipleActiveResultSets=True` in Ihrer SQL-Server-Connection-String erlaubt verschachtelte Reader, falls Sie wirklich müssen.

### "ObjectDisposedException: Cannot access a disposed context"

Bedeutet, dass der DI-Scope den `DbContext` bereits verworfen hat, während ein erfasster Task ihn nutzen wollte. Üblicherweise ein Fire-and-Forget-`Task.Run` aus einem HTTP-Handler oder ein `BackgroundService`, der einen scoped Kontext beim Start erfasst hat. Die Behebung ist, den Kontext innerhalb des Tasks aufzulösen, nicht außerhalb.

### "The instance of entity type cannot be tracked because another instance with the same key value is already being tracked"

Identity-Map-Konflikt, eine single-threaded Form. Zwei CLR-Objekte, derselbe Primärschlüssel, derselbe Kontext. Die Behebung wird im Detail in [der Entity-Tracking-Anleitung](/de/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/) durchgegangen.

### "InvalidOperationException: Synchronous operations are disallowed"

Kestrel weist `Stream.Read` statt `Stream.ReadAsync` auf dem Response-Body zurück. Anderer Stack, andere Behebung (`AllowSynchronousIO = true` oder Umstieg auf async-APIs). Kein `DbContext`-Problem.

## Verwandt

Für umfassendere EF-Core-Hygiene siehe [die N+1-Erkennungs-Anleitung](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) und [die Anleitung zu Compiled Queries auf Hot Paths](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) für das Abfrage-Design, sobald das Concurrency-Modell stimmt. Für Test-Fixtures, die Ihrem Code eine echte Datenbank übergeben, ohne einen Kontext über Threads hinweg zu teilen, ist [die Testcontainers-gegen-echten-SQL-Server-Anleitung](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) das sauberste Setup. [Der N+1-Erkennungs-Beitrag](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) deckt auch die Logger-Hooks von EF Core 11 ab, die Sie umnutzen können, um vergessene `await` in CI zu kennzeichnen.

## Quellen

- [Avoiding DbContext threading issues](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#avoiding-dbcontext-threading-issues), EF-Core-Dokumentation.
- [`IDbContextFactory<TContext>` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [`AddDbContextFactory` extension](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.adddbcontextfactory), Microsoft Learn.
- [`ConcurrencyDetector` source](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/ConcurrencyDetector.cs), dotnet/efcore auf GitHub.
- [`IServiceScopeFactory.CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope), Microsoft Learn.
