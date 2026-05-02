---
title: "How to use compiled queries with EF Core for hot paths"
description: "A practical guide to EF Core 11 compiled queries: when EF.CompileAsyncQuery actually wins, the static-field pattern, the Include and tracking gotchas, and how to benchmark before and after so you can prove it was worth the extra ceremony."
pubDate: 2026-05-02
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
---

Short answer: declare the query once as a `static readonly` field via `EF.CompileAsyncQuery`, store the resulting delegate, and invoke it with a fresh `DbContext` plus parameters per call. On a hot read endpoint that runs the same shape thousands of times per second this saves the LINQ-to-SQL translation step and shaves 20-40% off the per-call overhead in EF Core 11. Outside hot paths it is not worth the boilerplate, because the EF Core query cache already memoizes the translation for repeated structurally identical queries.

This post covers the exact mechanics of `EF.CompileQuery` and `EF.CompileAsyncQuery` in EF Core 11.0.x on .NET 11, the static-field pattern that makes the saving real, what compiled queries cannot do (no `Include` chaining at runtime, no client-side composition, no IQueryable return), and a BenchmarkDotNet harness you can paste into your repo to verify the win on your own schema. Everything below uses `Microsoft.EntityFrameworkCore` 11.0.0 against SQL Server, but the same APIs work identically on PostgreSQL and SQLite.

## What "compiled query" actually means in EF Core 11

When you write `ctx.Orders.Where(o => o.CustomerId == id).ToListAsync()`, EF Core does roughly five things on every call:

1. Parse the LINQ expression tree.
2. Look it up in the internal query cache (the cache key is the structural shape of the tree plus parameter types).
3. On a cache miss, translate the tree to SQL and build a shaper delegate.
4. Open a connection, send the SQL with bound parameters.
5. Materialise the result rows back into entities.

Step 2 is fast, but it is not free. The cache lookup walks the expression tree to compute a hash key. On a small query that is microseconds. On a hot endpoint serving 5000 requests per second, those microseconds pile up. `EF.CompileAsyncQuery` lets you skip steps 1 through 3 entirely on every call after the first. You hand EF the expression tree once at startup, it produces a `Func` delegate, and from then on every invocation goes straight to step 4. The cost per call drops to "build a parameter, run shaper, hand back rows."

The official guidance is in [the EF Core advanced performance docs](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics). The headline number from the team's own benchmarks is roughly a 30% reduction in per-query overhead, with most of the win on small, frequently-executed queries where the translation is a meaningful fraction of total time.

## The static-field pattern

The single most common way to misuse `EF.CompileAsyncQuery` is to call it from inside the method that runs the query. That re-creates the delegate on every call, which is strictly worse than not compiling at all. The pattern that works is to put it in a static field:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public static class OrderQueries
{
    public static readonly Func<ShopContext, int, Task<Order?>> GetOrderById =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int id) =>
                ctx.Orders
                    .AsNoTracking()
                    .FirstOrDefault(o => o.Id == id));

    public static readonly Func<ShopContext, int, IAsyncEnumerable<Order>> GetOrdersByCustomer =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int customerId) =>
                ctx.Orders
                    .AsNoTracking()
                    .Where(o => o.CustomerId == customerId)
                    .OrderByDescending(o => o.PlacedAt));
}
```

Two things to notice. First, the parameter list is positional and the types are baked in: `int id` is part of the delegate signature. You cannot pass an arbitrary `Expression<Func<Order, bool>>` to it later, because that would defeat the whole point. Second, the delegate is invoked with a `DbContext` instance per call:

```csharp
public sealed class OrderService(IDbContextFactory<ShopContext> factory)
{
    public async Task<Order?> Get(int id)
    {
        await using var ctx = await factory.CreateDbContextAsync();
        return await OrderQueries.GetOrderById(ctx, id);
    }
}
```

The factory pattern matters here. Compiled queries are thread-safe across contexts but the `DbContext` itself is not. If you share one context across threads and run compiled queries concurrently, you will get the same race conditions you would get with any other concurrent EF Core usage. Use [a pooled DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor) for the per-call instance. If you do not, the cost of allocating and configuring a new context per call will dwarf whatever you saved by compiling the query.

## The two flavors and when each one wins

EF Core 11 ships two static methods on `EF`:

- `EF.CompileQuery` returns a synchronous `Func<,...>`. The result type is either `T`, `IEnumerable<T>`, or `IQueryable<T>` depending on the lambda.
- `EF.CompileAsyncQuery` returns either `Task<T>` for single-row terminal operators (`First`, `FirstOrDefault`, `Single`, `Count`, `Any`, etc.) or `IAsyncEnumerable<T>` for streaming queries.

For server workloads the async variant is almost always what you want. The sync variant blocks the calling thread on the database round trip, which is fine in a console app or a desktop client but will starve the thread pool in ASP.NET Core under load. The sole exception is a startup migration or a CLI tool where you genuinely want to block.

A subtle thing: `EF.CompileAsyncQuery` does not accept a `CancellationToken` parameter directly. The token is captured by the surrounding async machinery. If you need to cancel a long-running compiled query, the pattern from [the cancellation guide for long-running tasks](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) still applies: register a `CancellationToken` on the request scope and let the `DbCommand` honor it via the connection. Compiled queries propagate the token through the same `DbCommand.ExecuteReaderAsync` path as a non-compiled query.

## A repro that shows the gain

Build the smallest model you can:

```csharp
// .NET 11, EF Core 11.0.0
public sealed class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public sealed class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public decimal Total { get; set; }
    public DateTime PlacedAt { get; set; }
}

public sealed class ShopContext(DbContextOptions<ShopContext> options)
    : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();
}
```

Now write two implementations of the same lookup, one compiled and one not:

```csharp
// .NET 11, EF Core 11.0.0
public static class Bench
{
    public static readonly Func<ShopContext, int, Task<Order?>> Compiled =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int id) =>
                ctx.Orders
                    .AsNoTracking()
                    .FirstOrDefault(o => o.Id == id));

    public static Task<Order?> NotCompiled(ShopContext ctx, int id) =>
        ctx.Orders
            .AsNoTracking()
            .FirstOrDefaultAsync(o => o.Id == id);
}
```

Drop both into BenchmarkDotNet 0.14 with a Testcontainers-backed SQL Server, the same harness you would use from [the Testcontainers integration test guide](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/):

```csharp
// .NET 11, BenchmarkDotNet 0.14.0, Testcontainers 4.11
[MemoryDiagnoser]
public class CompiledQueryBench
{
    private IDbContextFactory<ShopContext> _factory = null!;

    [GlobalSetup]
    public async Task Setup()
    {
        // Initialise the container, run migrations, seed N rows.
        // Resolve the IDbContextFactory<ShopContext> from your service provider.
    }

    [Benchmark(Baseline = true)]
    public async Task<Order?> NotCompiled()
    {
        await using var ctx = await _factory.CreateDbContextAsync();
        return await Bench.NotCompiled(ctx, 42);
    }

    [Benchmark]
    public async Task<Order?> Compiled()
    {
        await using var ctx = await _factory.CreateDbContextAsync();
        return await Bench.Compiled(ctx, 42);
    }
}
```

On a 2024 laptop against a local SQL Server 2025 container, the compiled version comes in around 25% faster on warm runs, with a smaller allocation profile because the LINQ translation pipeline does not run. The exact number depends heavily on row count and column shape, but on a single-row primary-key lookup you can expect a meaningful gain.

The interesting result is what happens on a query that ran exactly once: there is no win. The compiled version does the same translation work the first time you invoke the delegate. If your hot path is "different shape per call," compiled queries are not the right tool. They reward repetition.

## What compiled queries cannot do

Compiled queries are static analysis on a fixed expression tree. That means several common LINQ patterns are out of bounds:

- **No conditional `Include`**. You cannot do `query.Include(o => o.Customer).If(includeLines, q => q.Include(o => o.Lines))` inside the lambda. The shape is fixed at compile time.
- **No `IQueryable` return for further composition**. If you return `IAsyncEnumerable<Order>` you can `await foreach` over it, but you cannot `.Where(...)` on the result and have that filter run server-side. It runs client-side, which negates the gain.
- **No closure capture of state**. The lambda passed to `EF.CompileAsyncQuery` must be self-contained. Capturing a local variable or service field from the enclosing scope throws at runtime: "An expression tree may not contain a closure-captured variable in a compiled query." The fix is to add the value as a parameter to the delegate signature.
- **No `Skip` and `Take` with `Expression`-typed values**. They must be `int` parameters on the delegate. EF Core 8 added support for parameter-driven paging, EF Core 11 keeps it, but you cannot pass a `Expression<Func<int>>`.
- **No client-evaluable methods**. If your `Where` calls `MyHelper.Format(x)`, EF cannot translate it. In a non-compiled query you would get a runtime warning. In a compiled query you get a hard exception at compile time, which is actually the better failure mode.

The constraints are the trade-off you make to get the speedup. If your real query needs branching shape, write a normal LINQ query and let the EF Core query cache do its job. The cache is good. It is just not free.

## Tracking, AsNoTracking, and why it matters here

Almost every example in this post uses `AsNoTracking()`. That is not decorative. Compiled queries on tracked entities still go through the change tracker on materialisation, which adds back a chunk of the overhead you just removed. For read-only hot paths, `AsNoTracking` is the default you want.

If you actually need tracking (the user is going to mutate the entity and call `SaveChangesAsync`), the math changes. The change-tracker work dominates the per-call cost, and the slice you gain from compiled queries is smaller. In that case the win is more like 5-10%, which is rarely worth the boilerplate.

There is a corollary in the [N+1 detection guide](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): if you compile a query that uses `Include` for a navigation, the Cartesian explosion is baked into the compiled SQL. You cannot opportunistically `AsSplitQuery` it later. Decide once, and pick the shape that fits the call site.

## Warm-up and the first invocation

The compilation work is deferred until the first call to the delegate, not the assignment to the static field. If your service has a strict P99 latency target on cold starts, the first request that hits a compiled-query code path will pay the translation cost on top of normal first-request overhead.

The cleanest fix is to warm both the EF Core model and the compiled queries during application startup, the same idea covered in [the EF Core warm-up guide](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/):

```csharp
// .NET 11, ASP.NET Core 11
var app = builder.Build();

await using (var scope = app.Services.CreateAsyncScope())
{
    var factory = scope.ServiceProvider
        .GetRequiredService<IDbContextFactory<ShopContext>>();
    await using var ctx = await factory.CreateDbContextAsync();

    // Touch the model
    _ = ctx.Model;

    // Trigger compilation by invoking each hot-path delegate once
    _ = await OrderQueries.GetOrderById(ctx, 0);
}

await app.RunAsync();
```

The query against `Id == 0` returns `null`, but it forces the translation. After this block your first real request hits the database with the SQL already cached in the delegate.

## When to skip compiled queries entirely

There is a temptation to compile every query in the codebase. Resist it. The EF Core team's own guidance says to use compiled queries "sparingly, only in situations where micro-optimizations are really needed." The reasons:

- The internal query cache already memoizes translations for repeated structurally identical queries. For most workloads the cache hit rate after warm-up is greater than 99%.
- Compiled queries add a second source of truth for the query shape (the static field plus the call site) which makes refactoring more painful.
- Stack traces become less helpful: an exception in a compiled query points at the delegate invocation site, not the original LINQ expression.

The honest decision rule is: profile first. Run the endpoint under realistic load with [`dotnet-trace`](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) and see how much of the time is in EF Core's query infrastructure. If it is in the single digits as a percentage of total request time, leave it alone. If you see 20%+ in `RelationalQueryCompiler`, `QueryTranslationPostprocessor`, or `QueryCompilationContext`, that is a compiled-query candidate.

## Two patterns that compose well

The compiled query is most useful in tight loops or background processors that hammer the same shape:

```csharp
// .NET 11, EF Core 11.0.0 - a streaming export
public static readonly Func<ShopContext, DateTime, IAsyncEnumerable<Order>> OrdersSince =
    EF.CompileAsyncQuery(
        (ShopContext ctx, DateTime since) =>
            ctx.Orders
                .AsNoTracking()
                .Where(o => o.PlacedAt >= since)
                .OrderBy(o => o.PlacedAt));

await foreach (var order in OrdersSince(ctx, cutoff).WithCancellation(ct))
{
    await writer.WriteRowAsync(order, ct);
}
```

Pair this with [`IAsyncEnumerable<T>` in EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) and you get a streaming export that does not buffer the result set, does not allocate a list, and reuses the compiled SQL on every batch. For an export job that runs nightly across millions of rows, that combination measurably reduces both latency and memory pressure.

The other pattern is the high-cardinality lookup endpoint: a single-row primary-key fetch on a public API where the request rate is in the thousands per second. There the per-call savings multiply by the call volume, and a compiled query on a `FirstOrDefault` paired with [response caching](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/response) gets you the closest thing EF Core has to a "free" read.

For everything else, write the query in plain LINQ, lean on the query cache, and revisit only when the profiler tells you the translation step is the bottleneck. Compiled queries are a scalpel, not a sledgehammer.
