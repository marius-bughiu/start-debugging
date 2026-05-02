---
title: "How to detect N+1 queries in EF Core 11"
description: "A practical guide to spotting N+1 queries in EF Core 11: what the pattern looks like in real code, how to surface it via logging, diagnostic interceptors, OpenTelemetry, and a test that fails the build when a hot path regresses."
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

Short answer: turn on EF Core 11's `LogTo` with the `Microsoft.EntityFrameworkCore.Database.Command` category at `Information` level, then run the suspect endpoint once. If you see the same `SELECT` with a different parameter value fire 50 times in a row instead of one `JOIN`, you have an N+1. The durable fix is not just adding `Include`, it is wiring up a `DbCommandInterceptor` that counts commands per request and a unit test that asserts an upper bound on commands per logical operation, so the regression cannot come back silently.

This post covers how N+1 still appears in EF Core 11 (lazy loading, hidden navigation access in projections, and split queries gone wrong), three layers of detection (logs, interceptors, OpenTelemetry), and how to gate it in CI with a test that fails when an endpoint exceeds its query budget. All examples are on .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.x), and SQL Server, but everything except the provider event names applies identically to PostgreSQL and SQLite.

## What an N+1 actually looks like in EF Core 11

The textbook definition is "one query to load N parent rows, then one extra query per parent to load a related collection or reference, for a total of N+1 round trips." In a real EF Core 11 codebase the trigger is rarely an explicit `foreach` over `Include`. The four shapes I see most often are:

1. **Lazy loading still on**: someone added `UseLazyLoadingProxies()` years ago, the code base grew, and a Razor page now iterates 200 orders and touches `order.Customer.Name`. Each access fires a separate query.
2. **Projection that calls a method**: `Select(o => new OrderDto(o.Id, FormatCustomer(o.Customer)))` where `FormatCustomer` cannot be translated to SQL, so EF Core falls back to client evaluation and re-queries `Customer` per row.
3. **`AsSplitQuery` on the wrong shape**: a `.Include(o => o.Lines).Include(o => o.Customer).AsSplitQuery()` correctly splits one parent join into multiple round trips, but if you add `.AsSplitQuery()` inside a `foreach` that already iterates parents, you multiply the round trips.
4. **`IAsyncEnumerable` mixed with navigation access**: streaming an `IAsyncEnumerable<Order>` with [IAsyncEnumerable in EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) and then touching `order.Customer.Email` in the consumer. Each enumeration step opens a new round trip if the navigation is not already loaded.

The reason all four are hard to spot is that the `DbContext` API never throws or warns by default. The query plan is fine. The only signal is the wire chatter, which is invisible until you look.

## A concrete repro

Spin up a tiny model and exercise it:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public sealed class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!;
    public decimal Total { get; set; }
}

public sealed class ShopContext(DbContextOptions<ShopContext> options)
    : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();
}
```

Now write the worst possible loop:

```csharp
// Triggers N+1 if Customer is not eagerly loaded
var orders = await ctx.Orders.ToListAsync();
foreach (var order in orders)
{
    Console.WriteLine($"{order.Id}: {order.Customer?.Name}");
}
```

Without lazy loading, `order.Customer` is `null` and you only see one `SELECT` from `Orders`. That is a different bug, silent data loss, but it is not N+1. Turn on lazy loading and the same code becomes the classic anti-pattern:

```csharp
options.UseLazyLoadingProxies();
```

Now you get one `SELECT` from `Orders`, then one `SELECT * FROM Customers WHERE Id = @p0` per order. With 1000 orders that is 1001 round trips. The first thing you need is a way to see them.

## Layer 1: structured logs with LogTo and the right category

The fastest detection signal is EF Core's built-in command logger. EF Core 11 exposes `LogTo` on `DbContextOptionsBuilder` and routes events through `Microsoft.EntityFrameworkCore.Database.Command.CommandExecuting`:

```csharp
services.AddDbContext<ShopContext>(options =>
{
    options.UseSqlServer(connectionString);
    options.LogTo(
        Console.WriteLine,
        new[] { RelationalEventId.CommandExecuting },
        LogLevel.Information);
});
```

Run the loop once and the console fills with copies of the same parameterised statement. If you are looking at a real app, send it to your logger via `ILoggerFactory` instead:

```csharp
var loggerFactory = LoggerFactory.Create(b => b.AddConsole());
options.UseLoggerFactory(loggerFactory);
options.EnableSensitiveDataLogging(); // only in dev
```

The `EnableSensitiveDataLogging` toggle is what makes the parameter values visible. Without it, you see the SQL but not the values, which makes "100 of these are identical except for `@p0`" much harder to spot. Keep it off in production: it logs query parameters, which can include PII or secrets. The official guidance on this is in [the EF Core logging docs](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/).

Once you can see the firehose, the manual detection rule is simple: for any single logical user action, the number of distinct SQL statements should be bounded by a small constant. A list endpoint should not scale its query count with row count. If it does, you found one.

## Layer 2: a DbCommandInterceptor that counts queries per scope

The log-and-grep workflow is fine for one developer, terrible for a team. The next layer is an interceptor that maintains a per-request counter and lets you assert on it. EF Core 11 ships [`DbCommandInterceptor`](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors), which is invoked for every executed command:

```csharp
// .NET 11, EF Core 11.0.0
public sealed class CommandCounter
{
    private int _count;
    public int Count => _count;
    public void Increment() => Interlocked.Increment(ref _count);
    public void Reset() => Interlocked.Exchange(ref _count, 0);
}

public sealed class CountingInterceptor(CommandCounter counter) : DbCommandInterceptor
{
    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result)
    {
        counter.Increment();
        return base.ReaderExecuting(command, eventData, result);
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        counter.Increment();
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }
}
```

Wire it up scoped per request:

```csharp
services.AddScoped<CommandCounter>();
services.AddScoped<CountingInterceptor>();
services.AddDbContext<ShopContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
    options.AddInterceptors(sp.GetRequiredService<CountingInterceptor>());
});
```

Now any code path can ask "how many SQL commands did I just send?" in O(1). In ASP.NET Core 11 wrap that around the request:

```csharp
app.Use(async (ctx, next) =>
{
    var counter = ctx.RequestServices.GetRequiredService<CommandCounter>();
    await next();
    if (counter.Count > 50)
    {
        var logger = ctx.RequestServices.GetRequiredService<ILogger<Program>>();
        logger.LogWarning(
            "{Path} executed {Count} SQL commands",
            ctx.Request.Path,
            counter.Count);
    }
});
```

A noisy warning at "more than 50 commands per request" is enough to surface every offender during a load test or a production shadow run. It is also the foundation of the CI gate further down.

The reason this works better than logs for production is volume. The command logger at `Information` level will drown a real app. A counter is a single integer per request and a single conditional log line on the violators.

## Layer 3: OpenTelemetry, where the data already lives

If you already follow the setup in [the OpenTelemetry guide for .NET 11](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/), you do not need a separate counter at all. The [`OpenTelemetry.Instrumentation.EntityFrameworkCore`](https://www.nuget.org/packages/OpenTelemetry.Instrumentation.EntityFrameworkCore) package emits one span per executed command with the SQL as `db.statement`:

```csharp
services.AddOpenTelemetry()
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddEntityFrameworkCoreInstrumentation(o =>
        {
            o.SetDbStatementForText = true;
        })
        .AddOtlpExporter());
```

In any backend that groups child spans under their HTTP parent (Aspire dashboard, Jaeger, Honeycomb, Grafana Tempo), an N+1 endpoint shows up as a flame graph with a single HTTP root and a stack of identical-shape SQL spans. The visual signal is unmistakable: a square block of repeated child spans is N+1, every time. Once you have this, you do not really need the log layer for everyday triage.

Be careful with `SetDbStatementForText = true` in production: it sends the rendered SQL to your collector, which might include identifiable values from `WHERE` clauses. Most teams keep it on in non-prod and turn it off (or scrub) in prod.

## Layer 4: a test that fails the build

Detection in dev and prod is necessary, but the only thing that prevents a slow regression back to N+1 is a test. The pattern uses the same counter interceptor and a [Testcontainers-based integration test](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) hitting a real database:

```csharp
// .NET 11, xUnit 2.9, EF Core 11.0.0, Testcontainers 4.11
[Fact]
public async Task Get_orders_endpoint_executes_at_most_two_commands()
{
    await using var factory = new ShopFactory(); // WebApplicationFactory<Program>
    var counter = factory.Services.GetRequiredService<CommandCounter>();
    counter.Reset();

    var client = factory.CreateClient();
    var response = await client.GetAsync("/orders?take=100");

    response.EnsureSuccessStatusCode();
    Assert.InRange(counter.Count, 1, 2);
}
```

The budget of "1 to 2" reflects the realistic shape: one `SELECT` for `Orders`, optionally one for `Customers` if you `Include` it. If a future change turns the `Include` into a lazy load, the count jumps to 101 and the test fails. The test does not need to know SQL or care about exact text. It just enforces a per-endpoint contract.

A subtle gotcha: the counter is scoped, but `WebApplicationFactory` resolves it from the root provider in older EF Core versions. In EF Core 11 the safe pattern is to expose the counter via a per-request middleware that stashes it on `HttpContext.Items`, then read it from `factory.Services` only in tests where you control the lifetime. Otherwise you risk reading a counter that belongs to a different request.

## Why `ConfigureWarnings` is not the whole story

EF Core has had `ConfigureWarnings` since version 3, and many guides will tell you to throw on `RelationalEventId.MultipleCollectionIncludeWarning` or `CoreEventId.LazyLoadOnDisposedContextWarning`. Both are useful, but neither catches N+1 directly. They catch specific shapes:

- `MultipleCollectionIncludeWarning` fires when you `Include` two sibling collections in a single non-split query and warns about Cartesian explosion. That is a different problem (one big query that returns too many rows) and the fix is `AsSplitQuery`, which itself can become N+1 if used wrong.
- `LazyLoadOnDisposedContextWarning` only fires after the `DbContext` is gone. It does not catch the in-context lazy load that produces the classic N+1.

There is no single warning that says "you just made the same query 100 times." That is why the counter approach is load-bearing: it observes behavior, not configuration.

## Fix patterns once you have detected one

Detection is half the job. Once the counter test fails, the fix usually fits one of these shapes:

- **Add an `Include`**. The simplest fix when the navigation is always needed.
- **Switch to a projection**. `Select(o => new OrderListDto(o.Id, o.Customer.Name))` translates to a single SQL `JOIN` and avoids materialising the full graph.
- **Use `AsSplitQuery`** when the parent has multiple large collections. One round trip per collection still scales `O(1)` in parents.
- **Bulk preload**. If you have a list of foreign keys after the parent query, do a single `WHERE Id IN (...)` follow-up instead of a per-row lookup. EF Core 11's parameter list translation makes this concise.
- **Turn off lazy loading entirely**. `UseLazyLoadingProxies` is rarely worth the runtime surprise. Static analysis and explicit `Include` find more bugs at PR time than at 3am.

If you mock `DbContext` in unit tests, none of this surfaces. That is one more reason to lean on integration tests against a real database, the same argument made in [the post on mocking DbContext](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/): mocks make the change tracker behave, but they cannot reproduce the wire-level chatter that makes N+1 visible.

## Where to look next

The patterns above will catch more than 95% of N+1s, but two niche tools fill in the corners. The `database` profile of `dotnet-trace` records every ADO.NET command for offline review, which is useful when the regression only reproduces in a load test (see [the dotnet-trace guide](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) for the workflow). And [`MiniProfiler`](https://miniprofiler.com/) still works well as a per-request UI overlay if you want a developer-facing badge that says "this page ran 47 SQL queries."

The thing all of these share is the same idea: surface the wire activity early enough that the developer who introduced the regression sees it before merge. EF Core 11 makes that easier than any version before it, but only if you opt in. The default is silence.
