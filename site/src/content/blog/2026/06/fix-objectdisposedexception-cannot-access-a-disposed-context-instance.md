---
title: "Fix: ObjectDisposedException: Cannot access a disposed context instance"
description: "Your fire-and-forget task captured a request-scoped DbContext that the DI scope already disposed. Resolve a fresh context inside the task with IServiceScopeFactory or IDbContextFactory."
pubDate: 2026-06-02
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "async"
---

The fix: a fire-and-forget `Task` captured a `DbContext` (or another scoped service) that lived on a DI scope which was disposed before the task finished. The request returned, ASP.NET Core disposed the scope and its `DbContext`, and your detached task then touched the dead instance. Do not capture the scoped context: inside the task, create your own scope with `IServiceScopeFactory.CreateAsyncScope` and resolve a new `DbContext` from it, or inject `IDbContextFactory<T>` and call `CreateDbContextAsync`.

```text
System.ObjectDisposedException: Cannot access a disposed context instance. A common cause of this error is disposing a context instance that was resolved from dependency injection and then later trying to use the same context instance elsewhere in your application. This may occur if you are calling Dispose() on the context instance, or wrapping it in a using statement. If you are using dependency injection, you should let the dependency injection container take care of disposing context instances.
Object name: 'AppDb'.
   at Microsoft.EntityFrameworkCore.DbContext.CheckDisposed()
   at Microsoft.EntityFrameworkCore.DbContext.get_DbContextDependencies()
   at Microsoft.EntityFrameworkCore.DbContext.Set[TEntity]()
   at Microsoft.EntityFrameworkCore.Internal.InternalDbSet`1.get_EntityQueryable()
```

This guide is written against .NET 11 preview 4 and `Microsoft.EntityFrameworkCore` 11.0.0-preview.4, but the message text and the `CheckDisposed` guard have been stable since EF Core 3.0. The exception is raised from `DbContext.CheckDisposed()`, which runs at the top of every public member: `Set<T>`, `SaveChangesAsync`, `Database`, the change tracker, all of it. By the time you see it, the object is genuinely gone. EF Core is not racing or misbehaving; something disposed the context and then code reached for it anyway.

## What "disposed" actually means here

A `DbContext` resolved from dependency injection is owned by the scope it was resolved from. In ASP.NET Core, the framework creates one DI scope per HTTP request and disposes it when the response finishes. Disposing the scope disposes every `IDisposable` it created, including your `DbContext`. After that, the context's internal service provider is torn down, its `DbConnection` is returned to the pool, and `_disposed` is set to `true`. Any later call hits `CheckDisposed()` and throws.

The error is almost never about you writing `using` or calling `Dispose()` yourself (though that is the other way to trigger it). In practice it is about lifetime: code outlived the scope that owned the context. The single most common shape is a fire-and-forget task started from a request that captured the request's context.

## The minimal repro

A controller kicks off background work without awaiting it, and the lambda closes over the injected `DbContext`:

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

The sequence: `Create` returns `Accepted()` almost immediately, ASP.NET Core disposes the request scope (and `db` with it), and two seconds later the detached task wakes up and calls into a context whose `_disposed` flag is already set. The `Add` may even appear to succeed depending on timing, but `SaveChangesAsync` reliably throws because it touches the disposed dependencies.

The same thing happens with `ContinueWith`, with an `async void` event handler that captures the context, with a `Timer` callback closing over it, and with a `BackgroundService` that resolved a scoped context once in its constructor and reuses it forever.

## Fix 1: create a scope inside the task and resolve a fresh context

This is the right answer when the background work needs scoped services beyond just data access. Inject `IServiceScopeFactory` (a singleton, always safe to capture), and open a scope inside the task body:

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

Two things changed. The task captures `orderId` (an `int`), not the `DbContext`. And it resolves a brand-new `AppDb` from a scope it owns, so disposal of that scope is tied to the task finishing, not to the HTTP request. `CreateAsyncScope` (over the synchronous `CreateScope`) matters because `DbContext` implements `IAsyncDisposable`; using the async scope disposes it through the async path and avoids a sync-over-async warning under analyzers.

Never capture entity instances across the boundary either. The `order` object is tracked by the request's context; passing it into the new scope's context invites the "instance of entity type cannot be tracked" collision. Pass the key and re-load or re-attach inside the task.

## Fix 2: inject IDbContextFactory when the work is pure data access

If the detached work only needs a `DbContext` and nothing else scoped, `IDbContextFactory<T>` is cleaner than spinning up a whole DI scope. Register it alongside (or instead of) the scoped context:

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

`IDbContextFactory<T>` is registered as a singleton, so capturing it in the closure is safe. Each `CreateDbContextAsync` hands you a context whose lifetime you control with `await using`. The factory bypasses the request scope entirely, which is exactly what a detached task wants. If you also call `AddDbContextFactory`, note that in EF Core 11 the same registration can satisfy both scoped `AppDb` injection and factory injection, so you do not have to choose one globally. Reach for `AddPooledDbContextFactory` if creation cost shows up in a profile, but reset any per-context state between rentals.

## Fix 3: stop firing and forgetting -- hand work to a real background mechanism

`Task.Run` from a request handler is the wrong tool even when you fix the context lifetime: the work has no retry, no backpressure, no graceful-shutdown handling, and the thread it runs on competes with request processing. The durable fix is to enqueue a message and let a hosted service drain it on its own scope. A `Channel<T>` is the lightest in-process option:

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

Register `AuditQueue` as a singleton and `AuditWorker` with `AddHostedService`. The controller now just calls `await queue.Enqueue(new AuditWork(orderId))` and returns. Each unit of work gets its own scope and its own context inside the worker, the work survives the request returning, and shutdown drains cleanly because the loop honours `stoppingToken`. This is the pattern the [safe fire-and-forget with BackgroundService walkthrough](/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) covers in full, and the [Channels-as-BlockingCollection-replacement guide](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) explains the queue side in depth.

## Why a BackgroundService that injects DbContext fails at startup

A subtler version: you inject `AppDb` straight into a `BackgroundService` constructor and get a different error first.

```csharp
// .NET 11, EF Core 11.0.0 -- wrong, fails to start
public class AuditWorker(AppDb db) : BackgroundService { /* ... */ }
```

A `BackgroundService` is a singleton. Injecting a scoped `AppDb` into a singleton trips the DI scope validator at startup with "Cannot consume scoped service 'AppDb' from singleton". If you somehow suppress that (you should not), the singleton would hold one context for the whole process lifetime and you would be back to `ObjectDisposedException` or threading errors the first time two iterations overlap. The fix is the same `CreateAsyncScope` pattern from Fix 1. The [scoped-service-from-singleton error](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) post and the [scoped services inside a BackgroundService guide](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) both walk through why singletons cannot hold scoped state.

## Disposal you caused yourself

Two non-fire-and-forget shapes produce the identical message:

You wrapped a DI-resolved context in `using`. If `AppDb` came from constructor injection, the container owns it; a `using` block disposes it early, and the next member call in the same request throws. Let the container dispose it -- remove the `using`. Only dispose contexts you created yourself with `new` or via a factory.

You returned an `IEnumerable<T>` or `IQueryable<T>` from a method and the caller enumerates it after the context is gone. Deferred LINQ does not execute until enumeration; if the method's context was scoped to a `using` or to a request that has since ended, enumeration hits a disposed context. Materialise inside the method with `ToListAsync`, or keep the context alive for the enumeration.

## Variants that look like this but are not

### "A second operation was started on this context instance before a previous operation completed"

Same family, different cause: two operations overlapped on a live (not disposed) context, usually a forgotten `await` or a `Task.WhenAll` over one context. The fix is also one-context-per-operation, detailed in the [second-operation-started guide](/2026/05/fix-second-operation-was-started-on-this-context-instance/).

### "Cannot access a disposed object. Object name: 'IServiceProvider'"

The whole scope or root provider was disposed, not just the context. Same root cause (lifetime), but it means you captured an `IServiceProvider`/`IServiceScope` and used it after disposing it. Resolve everything you need before the scope ends, or keep the scope alive for the work.

### "The ConnectionString property has not been initialized"

A `new`-ed context with no configured provider, not a disposal problem. You bypassed DI and forgot `OnConfiguring` or the options. Use the factory or DI instead of `new AppDb()`.

### "ObjectDisposedException" on a CancellationTokenSource

A `CancellationTokenSource` disposed while a token from it is still in use. Unrelated to EF Core, even though the exception type matches. Look at the `Object name:` line -- it names the disposed object, and that is your fastest triage signal.

## Related

For the broader picture of running detached work without leaking scoped state, the [safe fire-and-forget patterns](/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) and [scoped services inside a BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) guides are the two to read next. If your fire-and-forget started life as an `async void`, the [async void vs async Task breakdown](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) explains why that swallows the exception entirely. And when the detached task needs to stop cleanly on shutdown, the [cancel-without-deadlocking guide](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) covers the token discipline.

## Sources

- [DbContext lifetime, configuration, and initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), EF Core docs.
- [`IDbContextFactory<TContext>` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [`DbContext.CheckDisposed` source](https://github.com/dotnet/efcore/blob/main/src/EFCore/DbContext.cs), dotnet/efcore on GitHub.
- [Consuming a scoped service in a background task](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service), .NET docs.
- [`ServiceProviderServiceExtensions.CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope), Microsoft Learn.
