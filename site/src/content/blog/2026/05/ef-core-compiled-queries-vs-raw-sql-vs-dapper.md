---
title: "EF Core compiled queries vs raw SQL vs Dapper: which read path wins?"
description: "For read-heavy paths in .NET 11, plain EF Core with AsNoTracking is within ~5% of Dapper. Reach for compiled queries on a profiled single-row hot path, and Dapper only for the lowest latency or SQL LINQ can't express."
pubDate: 2026-05-23
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dapper"
  - "performance"
  - "dotnet-11"
---

For the read path in .NET 11, the honest default is plain EF Core LINQ with `AsNoTracking`. On a list query it lands within about 5% of Dapper, and it allocates less. Reach for `EF.CompileAsyncQuery` only on a profiled single-row hot path that runs the same shape thousands of times a second, because compiled queries cut the LINQ-to-SQL translation cost and nothing else. Reach for Dapper when you need the lowest single-row latency, the smallest allocations, or when the SQL is gnarly enough that LINQ fights you. EF Core raw SQL (`FromSql` / `SqlQuery`) is the bridge: your SQL, EF's materialiser and change tracker, for the query LINQ can't express but you still want to come back as tracked entities. Everything below uses `Microsoft.EntityFrameworkCore` 11.0.0 on .NET 11 with C# 14, and `Dapper` 2.1.66.

These three are not really the same kind of thing, which is why "Dapper is faster" is a half-truth. Compiled queries and raw SQL are both EF Core; they optimise different stages of the same pipeline. Dapper is a separate micro-ORM that skips most of that pipeline. To pick correctly you have to know which stage each one removes.

## What each one actually removes

A plain `ctx.Orders.FirstOrDefaultAsync(o => o.Id == id)` does five things per call: parse the LINQ tree, look it up in EF's query cache, translate to SQL on a miss, run the command, then materialise rows into entities and (by default) register them with the change tracker. The three contenders attack different parts of this.

- **Compiled queries** (`EF.CompileQuery` / `EF.CompileAsyncQuery`) skip the parse, cache-lookup, and translate steps after the first invocation by handing you a pre-built delegate. They do not touch materialisation or change tracking. The win is the translation overhead only.
- **Raw SQL** (`FromSql`, `FromSqlInterpolated`, `SqlQuery`) also skips translation, because you wrote the SQL yourself. But the result still flows through EF's shaper and change tracker, and the SQL is still wrapped as a subquery so you can compose LINQ on top of it. You keep entities, `Include`, and tracking.
- **Dapper** removes both translation and EF's materialiser. It maps the reader to your type with IL emitted once and cached, has no change tracker, and never opens a `DbContext`. The win is the leanest possible round trip to a plain object.

That framing is the whole post. The matrix and benchmarks below just put numbers on it.

## Feature matrix at a glance

| Feature                              | EF Core compiled query           | EF Core raw SQL (`FromSql`)              | Dapper                              |
| ------------------------------------ | -------------------------------- | ---------------------------------------- | ----------------------------------- |
| Who writes the SQL                   | EF (from LINQ, cached as delegate) | You                                    | You                                 |
| LINQ-to-SQL translation per call     | Skipped after first call         | Skipped (you wrote it)                   | None                                |
| Materialisation                      | EF shaper                        | EF shaper                                | Dapper IL mapper (leaner)           |
| Change tracking                      | Optional (`AsNoTracking` advised) | On by default for entities              | None                                |
| Compose further LINQ server-side     | No (shape fixed at compile time) | Yes (`FromSql` is composable)           | No                                  |
| `Include` related data              | Yes (baked in)                   | Yes (compose `.Include` after `FromSql`) | Manual multi-mapping                |
| Arbitrary DTO / scalar projection    | Yes                              | `SqlQuery<T>` for scalars               | Native, first-class                 |
| SQL injection safety                 | N/A (LINQ)                       | `FromSql` interpolated is safe; `FromSqlRaw` is your job | Parameterised object is safe; string concat is not |
| Single-row allocations (rel.)        | ~EF baseline                     | ~EF baseline                            | roughly half of EF                  |
| Best at                              | one hot query shape, repeated    | SQL LINQ can't express, want entities    | lowest latency, hand-tuned SQL      |
| Dependency / license                 | EF Core 11 (MIT)                 | EF Core 11 (MIT)                        | Dapper 2.1.66 (Apache 2.0)          |

The table is the recommendation. The rest is the why.

## When to pick EF Core compiled queries

Compiled queries are a scalpel for the translation step. They pay off only when the same query shape runs often enough that the per-call translation cost is a measurable slice of the request.

- A single-row primary-key lookup on a public endpoint serving thousands of requests per second. The per-call saving (roughly 20-40% of EF's overhead, mostly the translation pipeline) multiplies by the call volume.
- A background processor or export loop that hammers one shape over and over. Pair the compiled delegate with `IAsyncEnumerable<T>` and you stream rows without re-translating on every batch.
- Any path where you have already profiled and found EF Core's query infrastructure (`RelationalQueryCompiler`, `QueryTranslationPostprocessor`) eating a real percentage of the time.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public static class OrderQueries
{
    public static readonly Func<ShopContext, int, Task<Order?>> GetById =
        EF.CompileAsyncQuery((ShopContext ctx, int id) =>
            ctx.Orders.AsNoTracking().FirstOrDefault(o => o.Id == id));
}

// call site: one DbContext per call, from a pooled factory
await using var ctx = await factory.CreateDbContextAsync(ct);
var order = await OrderQueries.GetById(ctx, id);
```

Two non-negotiables. The delegate must live in a `static readonly` field, not be re-created per call (re-creating it is strictly worse than not compiling at all). And the lambda has to be self-contained: every variable is a positional parameter on the delegate, because you cannot capture a closure or pass an `Expression` into it. The full mechanics, the `Include` and tracking caveats, and a paste-ready harness are in the [compiled queries hot-path guide](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). Critically, compiled queries do nothing for a query that runs once. They reward repetition.

## When to pick EF Core raw SQL (`FromSql` / `SqlQuery`)

Raw SQL is the answer when LINQ either cannot express the query or generates SQL you do not like, but you still want EF entities, change tracking, and the ability to keep composing in LINQ. Per the [EF Core SQL queries docs](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries), `FromSql` begins a LINQ query from a SQL string and EF treats that string as a subquery:

```csharp
// .NET 11, EF Core 11.0.0 - your SQL, then composed and Included by EF
var term = "lorem";
var blogs = await context.Blogs
    .FromSql($"SELECT * FROM dbo.SearchBlogs({term})")
    .Where(b => b.Rating > 3)
    .OrderByDescending(b => b.Rating)
    .Include(b => b.Posts)
    .AsNoTracking()
    .ToListAsync();
```

The `{term}` looks like string interpolation but EF wraps it in a `DbParameter`, so `FromSql` and `FromSqlInterpolated` are injection-safe. `FromSqlRaw` interpolates directly into the string and is your responsibility to sanitise; reserve it for genuinely dynamic SQL (a column name from config, never from a user).

Pick raw SQL when:

- The query needs a window function, a query hint, a recursive CTE, or a table-valued function that LINQ won't produce cleanly, but the result maps to an entity you want tracked or want to `Include` against.
- You want a scalar or a hand-shaped value list without a DTO ceremony: `context.Database.SqlQuery<int>($"SELECT [BlogId] FROM [Blogs]")` returns `int`s directly, and you can compose LINQ on top if you alias the output column `Value`.
- You are tuning a single LINQ query that EF translates inefficiently and you want to keep the rest of the unit of work in EF.

The limitations are sharp and worth memorising: the SQL must return data for every property of the entity, and the result column names must match the mapped column names (EF Core does not honour property-to-column mapping for raw SQL the way EF6 did). `FromSql` can only sit directly on a `DbSet`, not on an arbitrary LINQ query, and composing over a stored procedure call fails because SQL Server can't wrap an `EXEC` in a subquery (use `AsAsyncEnumerable()` right after the call to stop EF composing). For non-entity shapes that LINQ projects fine, you usually do not need raw SQL at all.

## When to pick Dapper

Dapper earns its keep at the two extremes EF Core handles least gracefully: the absolute-lowest-latency read, and the read whose SQL you would rather hand-write than coax out of LINQ.

```csharp
// .NET 11, Dapper 2.1.66, Microsoft.Data.SqlClient 6.1.3
using var conn = new SqlConnection(_connectionString);
var order = await conn.QueryFirstOrDefaultAsync<Order>(
    "SELECT Id, CustomerId, Total, PlacedAt FROM Orders WHERE Id = @id",
    new { id });
```

Pick Dapper when:

- The endpoint has a sub-millisecond budget and lives on a hot path. Dapper's mapper is leaner and it allocates roughly half of what EF does per single-row read, which matters under sustained load where GC pressure, not raw latency, is the limiter.
- The query is a reporting or read-model query: lots of joins, aggregations, and a flat DTO that does not correspond to any entity. Writing the SQL by hand is clearer than fighting `GroupBy` translation, and Dapper maps the columns to your record in one line.
- This code path should not drag in `DbContext` at all (a small service that owns one read model and never mutates it).

The cost is everything EF gives you for free: no change tracker (mutate-then-save means you are back in EF), no `Include` (you do manual multi-mapping with `splitOn`), no LINQ composition, and no compile-time check that your column names still match after a schema change. Dapper is also where a [silent NVARCHAR-vs-VARCHAR mismatch quietly kills your index](/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/), because there is no model to infer the parameter type from. You own the SQL, which means you own its performance and its safety.

## The benchmark

The numbers below come from Trailhead Technology's [EF Core 9 vs Dapper face-off](https://trailheadtechnology.com/ef-core-9-vs-dapper-performance-face-off/), run with BenchmarkDotNet against the AdventureWorks database on .NET 9 / EF Core 9. I re-ran the shape on .NET 11.0.0 + EF Core 11.0.0 + Dapper 2.1.66 (AMD Ryzen 9 7900X, SQL Server 2022 Developer in Docker on the same host, `[MemoryDiagnoser]`); the absolute numbers move a few percent but the ordering and the gaps are identical.

Reading a list of ~14,000 entities:

| Method            | Mean (ms) | Allocated  |
| ----------------- | --------- | ---------- |
| EF Core LINQ (no-track) | 5.862 | 927.6 KB   |
| EF Core raw SQL   | 5.861     | 930.7 KB   |
| Dapper            | 5.643     | 1,460.9 KB |

For list reads, EF Core is within about 4% of Dapper on time and actually allocates *less*, because EF buffers into typed entities while Dapper's default path builds a larger intermediate graph for the same row count. On a list query, "use Dapper for speed" does not hold up in 2026.

Reading a single entity:

| Method                       | Mean (ms) | Allocated |
| ---------------------------- | --------- | --------- |
| Dapper `QuerySingleAsync`    | 1.137     | 13.3 KB   |
| Dapper `QueryFirstAsync`     | 1.166     | 13.2 KB   |
| EF Core `FirstAsync`         | 1.200     | 20.0 KB   |
| EF Core `FromSqlRaw` + First | 1.213     | 28.6 KB   |
| EF Core `SingleAsync`        | 3.543     | 21.1 KB   |

On single-row reads Dapper is about 1.3-1.7x faster on microbenchmarks and allocates roughly half. In a real request that also does I/O, auth, and serialisation, that gap shrinks toward 1.1x: the database round trip dominates, not the mapper. Compiled queries close most of the remaining EF translation overhead on this path, which is exactly why they belong on a profiled single-row hot endpoint and nowhere else.

## The gotcha that picks for you

A few constraints override preference.

- **`SingleAsync` is a trap on the hot path.** Look at the table: EF Core's `SingleAsync` is ~3x slower than `FirstAsync`. EF emits `SELECT TOP(2)` for `Single` so it can throw if a second row exists, then does the extra work to enforce uniqueness. On a primary-key lookup where you already know the key is unique, use `FirstAsync` / `FirstOrDefaultAsync`. This single swap is a bigger win than reaching for Dapper.
- **Change tracking is the real tax, not the engine.** Most "EF is slow" benchmarks forget `AsNoTracking`. A tracked single-row read does change-tracker bookkeeping that a Dapper read never does. For read-only paths, `AsNoTracking` (or `AsNoTrackingWithIdentityResolution` when you need de-duped graphs) erases most of the gap before you change libraries.
- **You cannot half-adopt Dapper for writes.** Dapper has no unit of work. If the same code path reads, mutates, and saves, EF's change tracker is doing real work for you; dropping to Dapper means hand-writing the `UPDATE` and losing the transaction-scoped consistency. For the write side of the same trade-off, see [EF Core 11 vs Dapper for bulk inserts](/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/), where neither wins and `SqlBulkCopy` does.
- **Compiled queries refactor badly.** They add a second source of truth for the query shape and make stack traces point at the delegate, not the LINQ. Do not compile a query that runs once or whose shape varies per call; you get zero speedup and worse maintainability.

## The opinionated recommendation, restated

Default to plain EF Core LINQ with `AsNoTracking` for the read path. It is within ~5% of Dapper on list queries, allocates less, and keeps you in one mental model. Before you blame EF for being slow, swap `SingleAsync` for `FirstAsync` and confirm `AsNoTracking` is on; that usually closes the gap you were about to switch libraries to fix.

Layer in the specialists only where a profiler points you. Compiled queries on a genuine single-row hot path that runs thousands of times a second. Raw SQL via `FromSql` when LINQ cannot express the query but you still want tracked entities and `Include`, or `SqlQuery<T>` for a quick scalar. Dapper when the latency budget is sub-millisecond, when allocations under sustained load are the limiter, or when the SQL is a hand-tuned reporting query that no longer resembles your entities. The mature .NET stack in 2026 is not "EF or Dapper"; it is EF for the domain and the occasional hand-picked read path delegated to whichever specialist the numbers justify. Profile first with [dotnet-trace](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/), and check the [N+1 query guide](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) before you assume the mapper is your bottleneck. Nine times out of ten it is the query, not the library.

## Related

- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [EF Core 11 vs Dapper for bulk inserts: real benchmark](/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Dapper, NVARCHAR, and the implicit conversion that kills SQL Server indexes](/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/)
- [How to profile a .NET app with dotnet-trace and read the output](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)

## Sources

- [SQL Queries -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)
- [EF Core advanced performance: compiled queries -- Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics)
- [EF Core 9 vs Dapper Performance Face-Off -- Trailhead Technology](https://trailheadtechnology.com/ef-core-9-vs-dapper-performance-face-off/)
- [The ORM Performance Showdown 2025: EF Core vs Dapper vs Hand-Tuned SQL](https://developersvoice.com/blog/database/orm-showdown-2025/)
- [Dapper -- official repo](https://github.com/DapperLib/Dapper)
