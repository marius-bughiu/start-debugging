---
title: "Fix: A second operation was started on this context instance before a previous operation completed"
description: "EF Core throws when two awaits run in parallel on the same DbContext. Await each call sequentially, or get a new DbContext per concurrent unit of work via IDbContextFactory."
pubDate: 2026-05-07
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "async"
---

The fix: a `DbContext` is not thread-safe and only one query, save, or change-tracker walk may be in flight on it at a time. The exception means two operations on the same instance overlapped, almost always because a `Task` was started without `await`, a `Parallel.ForEachAsync` body shared the context, or a captured field was hit from two requests at once. Either await the first call before starting the second, or hand each concurrent unit of work its own `DbContext` via `IDbContextFactory<T>`.

```text
System.InvalidOperationException: A second operation was started on this context instance before a previous operation completed. This is usually caused by different threads concurrently using the same instance of DbContext. For more information on how to avoid threading issues with DbContext, see https://go.microsoft.com/fwlink/?linkid=2097913.
   at Microsoft.EntityFrameworkCore.Internal.ConcurrencyDetector.EnterCriticalSection()
   at Microsoft.EntityFrameworkCore.Query.Internal.QueryCompiler.ExecuteAsync[TResult](Expression query, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Query.Internal.EntityQueryProvider.ExecuteAsync[TResult](Expression expression, CancellationToken cancellationToken)
   at System.Linq.AsyncEnumerable.ToListAsync[TSource](IAsyncEnumerable`1 source, CancellationToken cancellationToken)
```

This guide is written against .NET 11 preview 4 and `Microsoft.EntityFrameworkCore` 11.0.0-preview.4. The text and the underlying `ConcurrencyDetector` have been the same since EF Core 2.0; the surrounding stack-trace internals shift between releases. The exception is raised from `ConcurrencyDetector.EnterCriticalSection`, which guards every public async API on `DbContext`. There is no race involved on EF Core's side, the detector is correct: it caught you trying to drive two operations through one identity map and one open command.

## Why a DbContext is single-threaded by design

`DbContext` keeps a private state machine: an identity map of tracked entities, a pending list of changes, an open `DbConnection`, and at most one `DbCommand` in flight. ADO.NET providers do not allow two commands on the same connection unless MARS is on, and even with MARS, EF Core's change-tracker mutations across two queries would race against each other in arbitrary ways. Rather than synchronise everything internally and pay the cost on every call, EF Core says no: one operation at a time per instance. The `ConcurrencyDetector` is a debug-friendly enforcement of that contract, not the cause of the problem.

This contract holds across every `*Async` method: `ToListAsync`, `FirstOrDefaultAsync`, `SaveChangesAsync`, `AnyAsync`, `CountAsync`, `Database.ExecuteSqlAsync`, plus the synchronous siblings if you mix `.Result` or `.GetAwaiter().GetResult()` into the same call site. If two of these overlap on the same `DbContext`, the second one throws.

## A minimal repro

The shortest reliable repro is `Task.WhenAll` over the same context:

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

Both `CountAsync` calls start almost simultaneously; the second one enters `ConcurrencyDetector.EnterCriticalSection` while the first is still inside it, and the detector throws. The fix is not to introduce locking, it is to recognise that you wanted two independent units of work and you only had one tool.

A more subtle repro is forgetting an `await`:

```csharp
// .NET 11, EF Core 11.0.0 -- still wrong
public async Task ProcessOrder(int id)
{
    var orderTask = db.Orders.FirstOrDefaultAsync(o => o.Id == id);
    var auditTask = db.AuditLog.AddAsync(new AuditEntry(id)); // no await
    await db.SaveChangesAsync(); // throws
}
```

`AddAsync` returns a `ValueTask`. Without awaiting it you have not actually finished adding, but the call has touched the change tracker. Then `SaveChangesAsync` runs against a tracker mid-mutation and the detector raises. Same root cause: two operations overlap on the same instance.

## Three fixes, ranked

Run them in this order. The first is the right answer in 90% of cases; the third is the escape hatch for genuinely concurrent work.

### 1. Await sequentially when you only need one connection

If you do not actually need the queries to run in parallel, do not start them in parallel. The wall-clock cost of two sequential `CountAsync` calls is rarely worth the bug:

```csharp
// .NET 11, EF Core 11.0.0
public async Task<(int customers, int orders)> Counts()
{
    var customers = await db.Customers.CountAsync();
    var orders = await db.Orders.CountAsync();
    return (customers, orders);
}
```

For a single request handler talking to a single database, this is almost always correct. The second query runs on the same already-open connection, so there is no second round-trip cost beyond the query itself. Reach for parallelism only when you have measured that two queries against the same backend save real time, which is uncommon because the database itself serialises commands per connection regardless.

### 2. Use IDbContextFactory for genuinely concurrent units of work

When you need two queries running at the same time (most often in a `BackgroundService`, a `Hangfire` job, a CLI tool processing batches, or fan-out scenarios), give each task its own `DbContext`:

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

Every concurrent operation now gets its own context, its own connection from the pool, and its own change tracker. There is no shared mutable state, so the detector has nothing to complain about. `AddDbContextFactory` is the supported registration; do not try to manually `new` a `DbContext` to escape the lifetime, it bypasses options resolution and pooling.

If you also want pooled instances for cheap creation, register `AddPooledDbContextFactory` instead. For the trade-offs of pooled factories in test setups, the [removable pooled-factory swap pattern](/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) covers the gotcha around state leaking between rentals.

### 3. Resolve a fresh scope per operation

In the framework-managed scoped lifetime (the default for ASP.NET Core), the fix is to create a child scope for each parallel branch:

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

`CreateAsyncScope` builds a fresh DI scope, so resolving `AppDb` from it returns a different instance than the outer request scope and from every other iteration. This is the right shape for `Parallel.ForEachAsync` against EF Core. The factory pattern from fix 2 is preferable when the work is purely data access; the scope pattern is better when the loop body needs other scoped services too.

## Common shapes that trigger this

### Sharing the request DbContext with Task.Run

A classic ASP.NET Core mistake: a request handler kicks off a fire-and-forget background task that captures the request-scoped `DbContext`:

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

Two failure modes overlap here. First, the request returns and the DI scope disposes the `DbContext` while the background task is still running, so you also see `ObjectDisposedException`. Second, if any other code path on the request still uses the context, both threads contend for it and the detector throws. The fix is the same as #2: inject `IDbContextFactory<AppDb>`, or hand the work to a real background mechanism (`IHostedService`, channels, a job queue) that owns its own scope. The [Channels-as-BlockingCollection-replacement walkthrough](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) covers the in-process queue pattern.

### Streaming an IAsyncEnumerable across an HTTP boundary

If you return `IAsyncEnumerable<T>` from a controller backed by an EF Core query, ASP.NET Core enumerates it as it serialises the response. If anything else on that scope hits the same `DbContext` while serialisation is in progress, the detector throws. Easy to hit when middleware later adds an audit row in `OnStarting` callback while the body is still streaming.

The fix is to materialise the enumerable, or to ensure the streaming endpoint owns the only access to that context for the response lifetime. The [`IAsyncEnumerable` with EF Core walkthrough](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) goes through the streaming model and the lifetimes that work with it.

### Captured DbContext in an event handler or static field

A `DbContext` stored as a static field, or captured in an event handler subscribed at startup, will be reused on every event. Two events arriving close together will overlap on it. Same fix: inject the factory, do not capture.

### Singleton-scoped DbContext

A `DbContext` registered as `Singleton` (by mistake or by `AddSingleton<MyService>` where `MyService` injects `AppDb`) ends up shared across requests. Concurrency is then guaranteed under any real load. The [identity-map collision guide](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/) walks through the same Singleton/Scoped trap from the duplicate-key angle; both errors come from the same root cause.

### Mixing sync and async on the same call site

`db.SaveChanges()` followed by an in-flight async query started earlier (and not awaited) will trip the detector once you eventually `await` the async one. This usually appears in legacy code paths where someone added an `_ = SomethingAsync()` to suppress the compiler warning. Suppressing the warning suppressed the bug too; the fix is to `await` it.

### Reusing a DbContext between Polly retry attempts

If you wrap a call in `Polly` and the retry runs while a previous attempt's `Task` is still alive (cancellation did not propagate cleanly), both attempts touch the same context. Pair retries with `IDbContextFactory<T>` so each attempt gets a fresh context, or make sure the prior attempt is fully cancelled (`ct.ThrowIfCancellationRequested()` paths through the EF Core call) before retrying. The [cancel-without-deadlocking guide](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) covers the cancellation discipline that makes this safe.

## Variants that look like this error but are not

### "There is already an open DataReader associated with this Connection which must be closed first"

Different exception, same family. This one comes from ADO.NET when MARS is off and you tried to start a second reader on the same connection. EF Core hides this most of the time, but raw `db.Database.GetDbConnection()` work bypasses the detector and surfaces the underlying error instead. The fix is the same shape (one operation at a time, or one connection per operation), but turning on `MultipleActiveResultSets=True` in your SQL Server connection string lets you run nested readers if you really must.

### "ObjectDisposedException: Cannot access a disposed context"

Means the DI scope already disposed the `DbContext` while a captured task tried to use it. Usually a fire-and-forget `Task.Run` from an HTTP handler, or a `BackgroundService` that captured a scoped context at startup. The fix is to resolve the context inside the task, not outside.

### "The instance of entity type cannot be tracked because another instance with the same key value is already being tracked"

Identity-map conflict, a single-threaded shape. Two CLR objects, same primary key, same context. Walks through the fix in detail at [the entity-tracking guide](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/).

### "InvalidOperationException: Synchronous operations are disallowed"

Kestrel rejecting `Stream.Read` instead of `Stream.ReadAsync` on the response body. Different stack, different fix (`AllowSynchronousIO = true` or move to async APIs). Not a `DbContext` problem.

## Related

For broader EF Core hygiene, see the [N+1 query detection walkthrough](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) and the [compiled-queries-on-hot-paths guide](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) for query design once the concurrency model is right. For test fixtures that hand a real database to your code without sharing a context across threads, the [Testcontainers-against-real-SQL-Server walkthrough](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) is the cleanest setup. The [N+1 detection post](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) also covers the EF Core 11 logger hooks you can repurpose to flag forgotten `await`s in CI.

## Sources

- [Avoiding DbContext threading issues](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#avoiding-dbcontext-threading-issues), EF Core docs.
- [`IDbContextFactory<TContext>` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [`AddDbContextFactory` extension](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.adddbcontextfactory), Microsoft Learn.
- [`ConcurrencyDetector` source](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/ConcurrencyDetector.cs), dotnet/efcore on GitHub.
- [`IServiceScopeFactory.CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope), Microsoft Learn.
