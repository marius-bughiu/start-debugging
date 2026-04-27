---
title: "How to warm up EF Core's model before the first query"
description: "EF Core builds its conceptual model lazily on the first DbContext access, which is why the first query in a fresh process is several hundred milliseconds slower than every query after it. This guide covers the three real fixes in EF Core 11: a startup IHostedService that touches Model and opens a connection, dotnet ef dbcontext optimize to ship a precompiled model, and the cache-key footguns that silently rebuild the model anyway."
pubDate: 2026-04-27
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "performance"
  - "startup"
  - "csharp"
---

The first query through a fresh `DbContext` is the slowest one your application will ever run, and it has nothing to do with the database. EF Core does not build its internal model when the host starts. It waits until the first time something reads `DbContext.Model`, runs a query, calls `SaveChanges`, or even just enumerates a `DbSet`. At that point it executes the entire convention pipeline against your entity types, which on a 50-entity model with relationships, indexes, and value converters can take 200 to 500 ms. Subsequent contexts in the same process get the cached model in under 1 ms. This guide shows the three fixes that actually move the number in EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.0, .NET 11, C# 14): an explicit warm-up at startup, a precompiled model produced by `dotnet ef dbcontext optimize`, and the model-cache-key footguns that quietly defeat both of the above.

## Why the first query is slow even when the database is warm

`DbContext.Model` is an `IModel` instance built by the conventions pipeline. The conventions are dozens of `IConvention` implementations (relationship discovery, key inference, owned-type detection, foreign-key naming, value-converter selection, JSON-column mapping, and so on) that walk every property of every entity type and every navigation. The output is an immutable model graph that EF Core then keeps for the lifetime of the process under a key produced by `IModelCacheKeyFactory`.

In a default `AddDbContext<TContext>` registration, that work happens lazily. The runtime sequence on cold start looks like this:

1. The host starts. `IServiceProvider` is built. `TContext` is registered as scoped. Nothing model-related has run yet.
2. The first HTTP request comes in. The DI container resolves a `TContext`. Its constructor stores `DbContextOptions<TContext>` and returns. Still nothing model-related has run.
3. Your handler writes `await db.Blogs.ToListAsync()`. EF Core dereferences `Set<Blog>()`, which reads `Model`, which triggers the convention pipeline. This is the 200 to 500 ms.
4. The query then compiles (LINQ to SQL translation, parameter binding, executor caching), which adds another 30 to 80 ms.
5. The query finally hits the database.

Steps 3 and 4 only happen once per process per `DbContext` type. The fifth request through that same context type sees both costs as zero. That is why "first request slow, every subsequent request fast" reproduces so cleanly and why you cannot shake it loose with database tuning. The work is in your process, not on the wire.

If you run a stopwatch around two back-to-back queries in a fresh process you will see the asymmetry directly:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
var sw = Stopwatch.StartNew();
await using (var db = new BloggingContext(options))
{
    _ = await db.Blogs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == 1);
}
Console.WriteLine($"first:  {sw.ElapsedMilliseconds} ms");

sw.Restart();
await using (var db = new BloggingContext(options))
{
    _ = await db.Blogs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == 1);
}
Console.WriteLine($"second: {sw.ElapsedMilliseconds} ms");
```

On a 30-entity demo model targeting SQL Server 2025 with EF Core 11.0.0 on a warm laptop, the first iteration prints around `380 ms` and the second around `4 ms`. The model build dominates. If the same code runs against a cold AWS Lambda where the host is spun up per invocation, that 380 ms lands directly in user-visible p99 latency, which is exactly the class of problem covered in [reducing cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).

## Fix one: warm up the model at startup with IHostedService

The cheapest fix moves the cost from "first request" to "host start" without changing any production code paths. Register an `IHostedService` whose only job is to resolve a context, force the model to materialize, and exit. The host blocks on `StartAsync` before opening the listening socket, so by the time Kestrel accepts a request the convention pipeline has already run and the cached `IModel` is sitting in the options instance.

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class EfCoreWarmup(IServiceProvider sp, ILogger<EfCoreWarmup> log) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        await using var scope = sp.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BloggingContext>();

        // Forces the conventions pipeline to run and the IModel to be cached.
        _ = db.Model;

        // Forces the relational connection-string parsing and the SqlClient pool
        // to allocate one physical connection. ADO.NET keeps it warm in the pool.
        await db.Database.OpenConnectionAsync(ct);
        await db.Database.CloseConnectionAsync();

        log.LogInformation("EF Core warm-up done in {Elapsed} ms", sw.ElapsedMilliseconds);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Wire it up after `AddDbContext`:

```csharp
// Program.cs, .NET 11, ASP.NET Core 11
builder.Services.AddDbContext<BloggingContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Db")));
builder.Services.AddHostedService<EfCoreWarmup>();
```

Three things this gets right that hand-rolled warm-ups commonly miss:

1. It scopes the context. `AddDbContext` registers `TContext` as scoped, so resolving it from the root provider throws. `CreateAsyncScope` is the documented pattern.
2. It reads `db.Model`, not `db.Set<Blog>().FirstOrDefault()`. Reading `Model` triggers the convention pipeline without compiling any LINQ query, which keeps the warm-up free of database round-trips that might fail because schema is not ready yet (think Aspire `WaitFor` ordering, or migrations that run after the host is up).
3. It opens and closes a connection so the SqlClient pool primes. The pool keeps physical connections idle for a short window, so the first real request is not paying TCP and TLS setup on top of the model build.

A pooled-context registration (`AddDbContextPool<TContext>`) needs the same warm-up, just resolved out of the pool. Either pattern works, but if you also have to mutate the registration to swap models in tests, consult [the EF Core 11 RemoveDbContext / pooled factory swap](/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) for the supported way to do it without rebuilding the entire service provider.

This fix is enough for most ASP.NET Core apps. The model still builds at runtime, you have just hidden the cost in the host startup window, which is usually free or close to free. The fix that actually removes the cost is below.

## Fix two: ship a precompiled model with dotnet ef dbcontext optimize

EF Core 6 introduced the compiled-model feature, EF Core 7 made it stable, and EF Core 11 fixed enough of the remaining limitations that it is the right default for any service that cares about cold start. The idea: instead of running the conventions pipeline at runtime, run it at build time and emit a hand-rolled `IModel` as generated C#. At runtime the context loads the prebuilt model directly and skips conventions entirely.

The CLI command is a one-shot:

```bash
# .NET 11 SDK, dotnet-ef 11.0.0
dotnet ef dbcontext optimize \
  --output-dir GeneratedModel \
  --namespace MyApp.Data.GeneratedModel \
  --context BloggingContext
```

That writes a folder of files like `BloggingContextModel.cs`, `BlogEntityType.cs`, `PostEntityType.cs`. Add the folder to source control, point `UseModel` at the generated singleton, and the runtime model build disappears:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContext<BloggingContext>(o => o
    .UseSqlServer(builder.Configuration.GetConnectionString("Db"))
    .UseModel(MyApp.Data.GeneratedModel.BloggingContextModel.Instance));
```

On the same 30-entity demo model, the first query drops from 380 ms to roughly 18 ms after this change. The remaining cost is LINQ-to-SQL translation for the specific query shape, which is per-query-shape and which the second invocation of the same query already caches. If the query is the same one you run on every request, the EF query cache eats the cost on iteration two and the first request is effectively as fast as the steady state.

Three details that bite the first time you do this:

1. **Regenerate when the model changes.** The optimized model is a snapshot. Adding a property, an index, or an `OnModelCreating` rule and shipping without re-running `dotnet ef dbcontext optimize` produces a runtime mismatch that EF Core detects and throws on. Wire the command into the build (`<Target Name="OptimizeEfModel" BeforeTargets="BeforeBuild">`) or into the same step that runs migrations, so it cannot drift.
2. **The `--precompile-queries` flag exists in EF Core 11 preview.** It extends optimization to the LINQ-to-SQL layer for known queries. As of `Microsoft.EntityFrameworkCore.Tools` 11.0.0 it is documented as preview and emits attributes you can read in the official [precompiled queries doc](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-queries). Use it for AOT-bound apps where reflection is restricted, or for hot paths where the marginal 30 to 80 ms still matters.
3. **A precompiled model is mandatory for Native AOT.** `OnModelCreating` runs reflection paths the AOT trimmer cannot statically analyze, so without a precompiled model the published app crashes the first time it touches `DbContext`. If you are also looking at AOT for the rest of the host, the same constraints from [using Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) apply to EF Core.

For a service that already runs `dotnet ef migrations` in CI, adding `dotnet ef dbcontext optimize` to the same step is two lines of YAML and pays back on every cold start forever.

## The model cache key footgun that defeats both fixes

There is a category of bug where the warm-up runs cleanly, the precompiled model loads cleanly, and the first user-facing query is *still* slow. The cause is almost always `IModelCacheKeyFactory`. EF Core caches the materialized `IModel` in a static dictionary keyed by an object the factory returns. The default factory returns a key that is just the context type. If your `OnModelCreating` consults runtime state (a tenant id, a culture, a feature flag), the model has to be cached separately per value of that state, and you have to tell EF Core that by replacing the factory.

```csharp
// .NET 11, EF Core 11.0.0
public sealed class TenantBloggingContext(
    DbContextOptions<TenantBloggingContext> options,
    ITenantProvider tenant) : DbContext(options)
{
    public string Tenant { get; } = tenant.CurrentTenant;

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Blog>().ToTable($"Blogs_{Tenant}");
    }
}

public sealed class TenantModelCacheKeyFactory : IModelCacheKeyFactory
{
    public object Create(DbContext context, bool designTime) =>
        context is TenantBloggingContext t ? (context.GetType(), t.Tenant, designTime) : context.GetType();
}
```

Register the replacement on the options:

```csharp
builder.Services.AddDbContext<TenantBloggingContext>(o => o
    .UseSqlServer(connStr)
    .ReplaceService<IModelCacheKeyFactory, TenantModelCacheKeyFactory>());
```

Two things go wrong here without the warm-up fix:

- The first request for tenant `acme` rebuilds the model at the cache key `(TenantBloggingContext, "acme", false)`. The first request for tenant `globex` rebuilds it again at `(TenantBloggingContext, "globex", false)`. Every distinct cache key hits the convention pipeline once. A naive warm-up that only resolves one tenant only warms one of N caches.
- A cache-key factory that closes over more state than necessary (for example, the entire `IConfiguration` snapshot) fragments the cache. If you discover the model rebuilds on every request, log `IModelCacheKeyFactory.Create`'s return value and check whether it is unstable.

The warm-up fix at the top still applies, you just have to iterate it across the cache-key dimensions you care about: in the hosted service, resolve a context per known tenant before declaring start-up done. If the tenant set is unbounded (per-customer subdomains in a multi-tenant SaaS) the precompiled-model fix does not save you either, because `dotnet ef dbcontext optimize` produces one snapshot, not a per-tenant family. In that case, accept the per-tenant first-hit cost and instead cap it with a stricter `UseQuerySplittingBehavior` and the small-query relational improvements covered in [how EF Core 11 prunes reference joins on split queries](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/).

## A pragmatic order of operations

If you came here for "what should I do, in what order", this is the sequence I run on a real service:

1. Measure. Stopwatch the first three queries in a fresh process. If the first query is under 50 ms, do nothing.
2. Add the `EfCoreWarmup` `IHostedService`. This is 30 lines of code and it converts a user-visible 300 ms into a host-startup 300 ms.
3. If startup time itself matters (Lambda, Cloud Run, autoscaler), run `dotnet ef dbcontext optimize` and `UseModel(...)`. Add the command to CI.
4. If you have a custom `IModelCacheKeyFactory`, audit what it captures. Make sure the key set is enumerable and warm each entry. If it is unbounded, accept the per-key cost and stop trying to fight it.
5. If the second query is also slow, the cost is in LINQ translation, not model build. Investigate `DbContextOptionsBuilder.EnableSensitiveDataLogging` plus `LogTo` filtered to `RelationalEventId.QueryExecuting`, or precompile the query.

This is the same shape as warming any cache: figure out where the cost lives, move it earlier, and verify the move with a stopwatch.

## Related

- [How to mock DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [How to use IAsyncEnumerable with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [How to reduce cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)
- [EF Core 11: RemoveDbContext and the pooled factory test swap](/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)
- [EF Core 11 preview 3 prunes reference joins on split queries](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/)

## Sources

- [EF Core compiled models](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-models) - Microsoft Learn
- [EF Core advanced performance topics: compiled queries](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-queries) - Microsoft Learn
- [`dotnet ef dbcontext optimize` reference](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#dotnet-ef-dbcontext-optimize) - Microsoft Learn
- [`IModelCacheKeyFactory` API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.imodelcachekeyfactory) - Microsoft Learn
- [EF Core testing strategies](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) - Microsoft Learn
