---
title: "AddDbContextPool vs AddDbContextFactory for running EF Core queries in parallel"
description: "AddDbContextPool hands out one scoped DbContext per DI scope, so it cannot run two queries at once. AddDbContextFactory and AddPooledDbContextFactory give you a context per call, which is what parallel queries need. Measured on EF Core 11 RC 1: the pooled factory creates a context in 342 ns and 40 B versus 17 us and 44 KB."
pubDate: 2026-10-08
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "dependency-injection"
---

If you want to run EF Core queries in parallel, `AddDbContextPool` is the wrong tool on its own: it registers your `DbContext` as a scoped service, so everything in one request (one DI scope) shares a single instance, and a single `DbContext` cannot run two operations at once. `AddDbContextFactory` registers a singleton `IDbContextFactory<T>` that gives you a fresh context per call, which is exactly the shape `Task.WhenAll` needs. If you want both, register `AddPooledDbContextFactory`: it is the same factory API backed by the same pool that `AddDbContextPool` uses, so every parallel branch rents its own recycled instance.

Everything below was measured on EF Core 11.0.0-rc.1.26425.128 with SDK 11.0.100-rc.1.26425.128 and `Microsoft.EntityFrameworkCore.Sqlite` on an Apple M4. I reran the same harness on EF Core 10.0.12 with .NET 10.0.10: the registrations, the reuse behavior and the pool size were identical, and the timings were within the same range (14.3 us and 43 KB per unpooled context, 357 ns and 40 B pooled).

## The comparison at a glance

| | `AddDbContextPool<T>` | `AddDbContextFactory<T>` | `AddPooledDbContextFactory<T>` |
| --- | --- | --- | --- |
| What you inject | `T` (scoped) | `IDbContextFactory<T>` (singleton) | `IDbContextFactory<T>` (singleton) |
| Also registers `T` as scoped | Yes, it is the main service | Yes | Yes |
| Contexts per DI scope | 1 | As many as you create | As many as you create |
| Safe for `Task.WhenAll` in one request | No | Yes | Yes |
| Instances reused after `Dispose` | Yes | No | Yes |
| Create + dispose cost (measured) | n/a via DI scope | 17,250 ns, 44,888 B | 342 ns, 40 B |
| Constructor can take scoped services | No | Yes | No |
| `OnConfiguring` runs | Once per pooled instance | Every instance | Once per pooled instance |
| Default pool size | 1024 | n/a | 1024 |

The "safe in parallel" row is the one this post is about, and it is decided by lifetime, not by pooling. Pooling only decides how expensive each context is.

## Why one DbContext cannot run two queries at once

A `DbContext` owns a change tracker, a connection and, during a query, an open data reader. None of those are thread-safe, and EF Core does not try to make them so. Instead, it has a concurrency detector that throws as soon as a second operation starts while the first is still running. I covered that exception in depth in [the post on "A second operation was started on this context instance"](/2026/05/fix-second-operation-was-started-on-this-context-instance/), but the short version matters here: parallelism in EF Core always means one context per concurrent operation.

That is where `AddDbContextPool` trips people up. It sounds like it should help with concurrency ("a pool of contexts"), but the pool is shared across scopes, not inside one. Here is what the container actually contains after each call, dumped from an EF Core 11 RC 1 `ServiceCollection`:

```text
--- AddDbContextPool
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextPool<AppDb>
  Scoped    IScopedDbContextLease<AppDb>
  Scoped    AppDb
--- AddDbContextFactory
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextFactorySource<AppDb>
  Singleton IDbContextFactory<AppDb>
  Scoped    AppDb
--- AddPooledDbContextFactory
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextPool<AppDb>
  Singleton IDbContextFactory<AppDb>
  Scoped    AppDb
```

With `AddDbContextPool`, `AppDb` is scoped and leased from the pool through `IScopedDbContextLease<AppDb>`. Resolve it twice in one scope and you get the same object. There is no `IDbContextFactory<AppDb>` in the container at all, so you cannot ask for a second one either.

## The parallel query that fails with AddDbContextPool

This is the minimal repro. A controller or minimal API endpoint gets the scoped context and tries to fan out:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddDbContextPool<AppDb>(o => o.UseSqlServer(cs));

app.MapGet("/dashboard", async (AppDb db) =>
{
    // Both queries use the same pooled instance: this throws.
    var ordersTask = db.Orders.CountAsync();
    var customersTask = db.Customers.CountAsync();
    await Task.WhenAll(ordersTask, customersTask);
    return new { Orders = ordersTask.Result, Customers = customersTask.Result };
});
```

Against SQL Server or PostgreSQL, where the async calls genuinely yield while waiting on the network, the second query starts before the first finishes and EF Core throws:

```text
InvalidOperationException: A second operation was started on this context instance
before a previous operation completed. This is usually caused by different threads
concurrently using the same instance of DbContext.
```

Two details from testing. First, SQLite's async methods complete synchronously, so the naive version above does not overlap on SQLite and "works", which makes a SQLite-backed test suite a poor detector for this bug. I had to wrap both queries in `Task.Run` to make them overlap. Second, if the race happens on the very first use of a fresh context, you get a different message, "An attempt was made to use the context instance while it is being configured", because both threads try to initialize the context at once. Same bug, same fix.

## Fan-out with AddDbContextFactory

The factory version gives every branch its own instance:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

app.MapGet("/dashboard", async (IDbContextFactory<AppDb> factory, CancellationToken ct) =>
{
    async Task<int> CountOrders()
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Orders.CountAsync(ct);
    }

    async Task<int> CountCustomers()
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Customers.CountAsync(ct);
    }

    var orders = CountOrders();
    var customers = CountCustomers();
    await Task.WhenAll(orders, customers);
    return new { Orders = orders.Result, Customers = customers.Result };
});
```

Each local function creates a context, runs one query, and disposes it. Nothing is shared, so there is nothing to race on. In my test harness the same shape with four branches (`Task.WhenAll` over four `CountAsync` calls, one per region) returned `250,250,250,250` every run.

Notice that `AddDbContextFactory` also registered `AppDb` as scoped. Existing code that injects `AppDb` directly keeps working, so you can switch the registration without touching every constructor in the app, and only the endpoints that fan out need to take the factory.

## AddPooledDbContextFactory: both at once

`AddDbContextFactory` creates a brand-new context on every `CreateDbContext` call. That cost is normally small next to a database round trip, but on a hot endpoint that fans out to five or ten queries it adds up. `AddPooledDbContextFactory` keeps the factory shape and rents instances from a pool instead:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddPooledDbContextFactory<AppDb>(o => o.UseSqlServer(cs));
```

The calling code is identical to the previous section, because you still inject `IDbContextFactory<AppDb>`. The implementation behind it is `PooledDbContextFactory<AppDb>` instead of `DbContextFactory<AppDb>`, and `Dispose` returns the instance to the pool instead of throwing it away. I checked that directly: create a context, dispose it, create another, and `ReferenceEquals` returns `true` with the pooled factory and `false` with the plain one.

Here is what that buys, measured with a simple loop (200,000 iterations for create/dispose, 20,000 for create/query/dispose, warmed up, single thread, `GC.GetAllocatedBytesForCurrentThread` for allocations):

| Operation | `AddDbContextFactory` | `AddPooledDbContextFactory` |
| --- | --- | --- |
| `CreateDbContext` + touch `Model` + `Dispose` | 17,250 ns, 44,888 B | 342 ns, 40 B |
| Create + `FirstOrDefault` by key (SQLite, no tracking) + `Dispose` | 49.7 us, 62,461 B | 20.0 us, 11,710 B |

These are numbers against a local SQLite file, so the database part is close to free and the context setup dominates. Against a real SQL Server across a network the query time will swamp the 17 us, which is why the official docs describe pooling as something for "high-performance scenarios". The allocation difference does not shrink with latency though: 44 KB of garbage per context, times ten parallel branches, times your request rate, is real GC pressure. The [EF Core advanced performance docs](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics) report the same shape against SQL Server: 50.38 KB allocated without pooling versus 4.63 KB with it.

The same docs also note that resolving a pooled context through DI "incurs a slight overhead" compared to calling the pooled factory directly, so the factory is the faster of the two pooled options even when you do not need parallelism.

## You can register both and share one pool

You do not have to pick. Calling `AddDbContextPool<AppDb>` and then `AddPooledDbContextFactory<AppDb>` with the same options works, and they share the same `IDbContextPool<AppDb>`. I verified it by renting a context from the factory, disposing it, then resolving `AppDb` from a new scope: it was the same instance. That lets most of the app inject `AppDb` as usual while the few fan-out endpoints inject the factory, without paying for two pools.

If you are on EF Core 11, there is also a parameterless `AddPooledDbContextFactory<T>()` overload that reads configuration from the context's own `OnConfiguring`, which I described in [the EF Core 11 Preview 3 post on RemoveDbContext and the pooled factory](/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).

## The pool does not limit parallelism, the connection pool does

The default `poolSize` is 1024 for both `AddDbContextPool` and `AddPooledDbContextFactory`. That number is the maximum number of instances the pool keeps, not the maximum you can have alive. When I set `poolSize: 2` and rented five contexts at once, I got five distinct instances. After disposing all five and renting five again, exactly two came back from the first batch. In other words, overflow falls back to creating fresh contexts and the extras are simply dropped on return. The pool never blocks.

The real ceiling for parallel queries is the ADO.NET connection pool underneath. EF Core opens a connection right before each query and closes it right after, and each concurrent query needs its own connection. `Microsoft.Data.SqlClient` defaults to `Max Pool Size=100`, and Npgsql also defaults to 100. Fan out 20 queries per request with 10 concurrent requests and you are already waiting on connections, which shows up as a timeout acquiring a connection from the pool rather than as an EF error. If you fan out over a list of IDs, bound the degree of parallelism with `Parallel.ForEachAsync` instead of throwing everything at `Task.WhenAll`; the trade-offs are in [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/).

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
await Parallel.ForEachAsync(regionIds,
    new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct },
    async (regionId, token) =>
    {
        await using var db = await factory.CreateDbContextAsync(token);
        totals[regionId] = await db.Orders
            .Where(o => o.RegionId == regionId)
            .SumAsync(o => o.Total, token);
    });
```

`totals` here should be a `ConcurrentDictionary<int, decimal>` or a pre-sized array, since the loop body runs concurrently.

## Gotchas that only bite the pooled variants

### Scoped constructor dependencies are resolved from the root provider

This one surprised me. A pooled context is created once and reused across scopes, so its constructor dependencies cannot come from the request scope. In EF Core 11 RC 1, a pooled context with a constructor such as `TenantDb(DbContextOptions<TenantDb> options, Tenant tenant)` where `Tenant` is scoped behaves like this:

- With scope validation on (the default in the `Development` environment), resolving it throws `InvalidOperationException: Cannot resolve scoped service 'Tenant' from root provider.`
- With scope validation off (the default in `Production`), it silently succeeds. The context gets a `Tenant` instance from the root provider, which does not match the `Tenant` the request scope resolves, and the same captured instance follows the pooled context into every later request.

So the bug you never see locally becomes a cross-tenant data leak in production. The plain `AddDbContextFactory` does not have this problem because it builds a new context each time. If you need per-request state with pooling, the documented pattern is a scoped wrapper factory that rents from the pooled factory and sets a property:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public sealed class TenantDbFactory(
    IDbContextFactory<TenantDb> pooled, ITenant tenant) : IDbContextFactory<TenantDb>
{
    public TenantDb CreateDbContext()
    {
        var db = pooled.CreateDbContext();
        db.TenantId = tenant.Id; // reset on every rent, never trust the previous value
        return db;
    }
}

builder.Services.AddPooledDbContextFactory<TenantDb>(o => o.UseSqlServer(cs));
builder.Services.AddScoped<TenantDbFactory>();
```

The same scoped-in-singleton trap shows up outside EF too; [the post on "Cannot consume scoped service from singleton"](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) explains why the container refuses it.

### Your own fields are not reset

EF Core resets its own state when a pooled context goes back: the change tracker is cleared (I added an entity, disposed, rented again, and `ChangeTracker.Entries()` was empty). Fields and properties you added to your `DbContext` subclass are not touched. A `public string? Note` that I set to `"dirty"` before disposing was still `"dirty"` on the next rent. Anything per-request must be assigned on every rent, as in the wrapper above. The same applies to a `DbConnection` you opened manually: close it before the context goes back.

### OnConfiguring runs once

Because the instance is reused, `OnConfiguring` only runs the first time a pooled instance is created. Do not read the current user, tenant or culture there.

### Dispose is what returns the instance

With the pooled factory, a context you forget to dispose is never returned. It is not a leak in the classic sense, since the GC still collects it, but you lose the pooling benefit and the pool quietly fills with fresh instances. Always use `await using`.

## When to pick which

- **Only sequential queries, ordinary app**: `AddDbContext` or `AddDbContextPool`. Inject `AppDb`, await each query in turn. Pooling is a cheap win if your context has no constructor dependencies and no per-request state.
- **Some endpoints fan out in parallel**: register `AddPooledDbContextFactory` (or `AddDbContextPool` plus `AddPooledDbContextFactory` with the same options). Inject `AppDb` where you work sequentially and `IDbContextFactory<AppDb>` where you fan out.
- **Context needs scoped services in its constructor**: `AddDbContextFactory`, unpooled. Or move that state into a property set by a scoped wrapper and keep pooling.
- **Singletons, hosted services, Blazor Server components**: the factory, for the reasons in [using IDbContextFactory from a singleton in Blazor](/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/). Pooled if the context allows it.

A last alternative if you already use `AddDbContextPool` and do not want a second registration: create a child scope per parallel branch with `IServiceScopeFactory.CreateAsyncScope()` and resolve `AppDb` from it. Each scope leases its own pooled instance, and my four-branch test returned the same `250,250,250,250`. It works, but it is more ceremony than injecting the factory, and every branch also resolves everything else in that scope.

The rule of thumb: parallelism needs a context per operation, and only the two factories give you that directly. Pooling is an independent decision about how cheap each of those contexts is, and in EF Core 11 the pooled factory makes it about 50 times cheaper to create one, as long as your context carries no per-request state in its constructor.

## Sources

- [Advanced Performance Topics: DbContext pooling (EF Core docs)](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics)
- [DbContext Lifetime, Configuration, and Initialization: using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/)
- [`EntityFrameworkServiceCollectionExtensions` API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions)
- [Sample: AspNetContextPoolingWithState (dotnet/EntityFramework.Docs)](https://github.com/dotnet/EntityFramework.Docs/tree/main/samples/core/Performance/AspNetContextPoolingWithState)
- [SQL Server connection pooling (ADO.NET)](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql-server-connection-pooling)
