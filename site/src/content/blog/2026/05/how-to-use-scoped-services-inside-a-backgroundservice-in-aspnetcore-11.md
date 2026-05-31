---
title: "How to use scoped services inside a BackgroundService in ASP.NET Core 11"
description: "A BackgroundService is a singleton, so it cannot inject a scoped service like a DbContext directly. Take IServiceScopeFactory, open one scope per unit of work with CreateAsyncScope, resolve inside it, and dispose it when the work is done."
pubDate: 2026-05-31
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
  - "backgroundservice"
---

A `BackgroundService` is registered as a singleton, so injecting a scoped service like a `DbContext` straight into its constructor either throws `Cannot consume scoped service 'X' from singleton 'Y'` at startup or, worse, pins that scoped instance to the lifetime of your whole process. The fix is to inject `IServiceScopeFactory`, open a fresh scope with `CreateAsyncScope()` for each unit of work inside `ExecuteAsync`, resolve the scoped service from that scope's provider, and dispose the scope when the work finishes. This guide is written against .NET 11 (preview 4 at the time of writing, general availability targeted for November 2026), `Microsoft.Extensions.Hosting` 11.0.0, and EF Core 11. The `BackgroundService` and `IServiceScopeFactory` contracts have been stable since .NET Core 3.1, so every pattern here also applies to .NET 6, 8, and 10 unchanged.

## Why a BackgroundService cannot just inject a scoped service

Every hosted service you register with `AddHostedService<T>` is a singleton. That is not a default you can override: `AddHostedService<T>` and `AddSingleton<IHostedService, T>` resolve to the same registration, and the host pulls the instance from the **root** service provider during `StartAsync`. The root provider has no ambient scope.

A scoped service, by definition, lives once per scope. In a web request that scope is created and disposed per request. A `BackgroundService` runs for the entire lifetime of the host, completely outside any request. So there is no scope for the runtime to resolve a scoped dependency against. If you write a constructor like `OrderWorker(AppDbContext db)`, one of two things happens:

- In `Development`, `WebApplication.CreateBuilder` turns on `ValidateScopes`, the call-site validator walks the graph during build, sees a scoped service flowing into a singleton, and throws `Cannot consume scoped service ...`. If that is the exact exception you landed here with, the dedicated [cannot consume scoped service from singleton fix](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) walks through every shape of it.
- In `Production`, scope validation is off by default, so the same code builds and runs. The `DbContext` gets captured for the life of the process. Its change tracker accumulates every entity you ever load, its connection never returns to the pool cleanly, and sooner or later you hit `ObjectDisposedException` or stale reads.

Neither outcome is what you want. The correct model is: the singleton worker owns the loop and the cancellation, and each iteration borrows a short-lived scope to do the actual work.

## Set up scoped resolution in four steps

Microsoft's own [worker service guidance](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) recommends delegating the real work to a scoped service and keeping the `BackgroundService` itself thin. Here is the full shape in four steps.

1. **Register the scoped service** with `AddScoped`, exactly as you would for a request-bound consumer. Nothing special is needed because it is being used in a background context.
2. **Register the worker** with `AddHostedService<T>`. It stays a singleton; do not try to make it scoped.
3. **Inject `IServiceScopeFactory`** (not the scoped service, and not `IServiceProvider`) into the worker's constructor.
4. **Open one scope per unit of work** inside `ExecuteAsync` with `CreateAsyncScope()`, resolve the scoped service from `scope.ServiceProvider`, do the work, and let the `await using` dispose the scope.

### Step 1 and 2: registration

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

### Step 3 and 4: the worker

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

The scoped service that holds all the real logic and the scoped dependencies:

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

`OrderProcessor` injects `AppDbContext` directly because it is itself scoped and is only ever resolved from inside a scope. The singleton worker never sees the `DbContext`. That separation is the whole trick: the lifetime mismatch disappears the moment the scoped graph is resolved from a real scope rather than from the root.

## CreateAsyncScope versus CreateScope

Use `CreateAsyncScope()`, not `CreateScope()`, for almost all modern code. The difference is in disposal.

`CreateScope()` returns an `IServiceScope` that disposes its scoped services synchronously through `IDisposable.Dispose()`. `CreateAsyncScope()` returns an `AsyncServiceScope` that disposes through `IAsyncDisposable.DisposeAsync()` when the service implements it, and falls back to synchronous disposal when it does not.

This matters because EF Core's `DbContext` in .NET 11 implements `IAsyncDisposable`, and several configurations (pooled contexts, contexts holding an open `DbConnection`) will throw if disposed synchronously. If you write `using var scope = scopeFactory.CreateScope();` and the scope contains a context that requires async disposal, you get an exception at the end of the block that has nothing to do with your actual work.

```csharp
// .NET 11 - prefer this
await using var scope = scopeFactory.CreateAsyncScope();

// Only use the sync form when nothing in the scope needs async disposal
using var syncScope = scopeFactory.CreateScope();
```

The cost of `CreateAsyncScope()` over `CreateScope()` is effectively zero when nothing needs async disposal, so there is no reason to reach for the synchronous version by default.

## One scope per unit of work, not one per process

The single most common mistake after switching to `IServiceScopeFactory` is hoisting the scope out of the loop:

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

This compiles, passes scope validation, and reintroduces the exact bug you were trying to fix. The `DbContext` resolved once now lives for the life of the worker. Its change tracker grows without bound across every iteration, queries get slower as the tracked graph expands, and a single failed `SaveChanges` can leave the context in a state that poisons every subsequent iteration. You also reopen the door to [the second-operation-on-context-instance error](/2026/05/fix-second-operation-was-started-on-this-context-instance/) the moment two iterations overlap.

Create the scope **inside** the loop. A scope is cheap. The point of the pattern is that each unit of work gets a clean slate: a fresh context, a fresh change tracker, a connection drawn from the pool and returned at the end of the iteration.

## Scoped services in a queue-draining worker

The per-iteration scope generalizes naturally to a worker that drains a `Channel<T>`. Each item dequeued is its own unit of work, so each gets its own scope:

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

`ReadAllAsync` already respects the cancellation token, so the loop unwinds cleanly on shutdown. Each message is processed in isolation, and a poison message that throws inside one scope does not corrupt the context used for the next.

## EF Core: IServiceScopeFactory versus IDbContextFactory

When the only scoped dependency you need is a `DbContext`, EF Core gives you a more direct tool: `IDbContextFactory<T>`. Register it with `AddDbContextFactory`, which registers the factory as a singleton, and inject the factory straight into the worker:

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

The decision rule is simple. If your unit of work needs **only** a `DbContext`, use `IDbContextFactory<T>`: there is no scope ceremony, and the factory hands you a fresh, correctly disposed context each call. If your unit of work needs a graph of scoped services (a repository, a tenant resolver, an `IOptionsSnapshot<T>`, a domain service that itself depends on the context), use `IServiceScopeFactory` so the whole graph is resolved consistently within a single scope. You can register both `AddDbContext` for request-bound code and `AddDbContextFactory` for the worker in the same app.

## A scope is not thread-safe: parallelism needs one scope per task

If you process items in parallel, do not share one scope across the parallel tasks. A `DbContext` is not thread-safe, and neither is a scope's resolution. Give each parallel branch its own scope:

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

Each invocation of the body gets an independent scope, an independent `DbContext`, and an independent change tracker, which is exactly the isolation you need for concurrent work.

## Graceful shutdown and StopAsync

`stoppingToken` is signalled when the host begins shutting down. Passing it into every async call inside the scope (the query, the `SaveChanges`, the `Task.Delay`) is what lets the worker stop promptly instead of blocking shutdown for up to the host's shutdown timeout (30 seconds by default).

If you need to do cleanup when the host stops, override `StopAsync` and call the base implementation:

```csharp
// .NET 11, C# 14
public override async Task StopAsync(CancellationToken cancellationToken)
{
    logger.LogInformation("OrderWorker stopping, draining in-flight work.");
    await base.StopAsync(cancellationToken);
}
```

One subtlety: a long blocking call inside the loop that ignores `stoppingToken` will not be interrupted, and the host waits for the full shutdown timeout before tearing the process down. If your unit of work can run long, thread the token all the way through. For the related question of stopping work that does not cooperate with cancellation, see [cancelling a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking).

## Mistakes that survive scope validation

These all compile and pass `ValidateScopes`, which is why they are worth naming:

- **Injecting `IServiceProvider` instead of `IServiceScopeFactory`.** The provider injected into a singleton is the root provider. Resolving a scoped service from it throws or captures, depending on validation settings. Always inject `IServiceScopeFactory` and call `CreateAsyncScope()`.
- **Resolving from the captured root provider inside the scope.** Write `scope.ServiceProvider.GetRequiredService<T>()`, never `_rootProvider.GetRequiredService<T>()`. Resolving from the root inside a scope you opened defeats the scope entirely.
- **Storing a resolved scoped service in a field.** The instance must not outlive the scope. Pass it as a method parameter and let it go out of scope with the `await using`.
- **Forgetting `await using`.** A plain `var scope = scopeFactory.CreateAsyncScope();` with no disposal leaks the scope and every service in it for the life of the process.

For workers you intend to run in production, pair this pattern with proper observability so a stuck or silently failing loop surfaces; the approach in [monitoring background jobs without Hangfire](/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts) applies directly. And for a complete worked example of the same scope-factory pattern around a non-trivial dependency, see [running a Semantic Kernel plugin from a BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).

The mental model that keeps this correct: the singleton owns the loop and the cancellation; the scope owns the work and the per-unit state. Keep those two responsibilities apart and the lifetime errors never appear in the first place.

## Sources

- Microsoft Learn, [Use scoped services within a BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) (updated 2026-05-27), the canonical worker service tutorial.
- Microsoft Learn, [Dependency injection in .NET: service lifetimes](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#service-lifetimes).
- Microsoft Learn, [`AsyncServiceScope` and `CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope).
- Microsoft Learn, [Using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- .NET Blog, [.NET 11 Preview 1 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-1/).
