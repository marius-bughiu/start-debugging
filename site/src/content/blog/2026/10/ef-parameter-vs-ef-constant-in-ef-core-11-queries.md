---
title: "EF.Parameter vs EF.Constant in EF Core 11 queries"
description: "EF.Constant inlines a captured value as a SQL literal, EF.Parameter turns a literal into a SQL parameter. Keep EF Core's defaults, use EF.Parameter to stop dynamically built expression trees from recompiling on every call, and use EF.Constant only for a value with a handful of distinct values whose data is skewed enough to need its own plan."
pubDate: 2026-10-02
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dotnet"
  - "sql-server"
  - "performance"
---

`EF.Constant(x)` tells EF Core to write a value into the SQL as a literal (`WHERE [Status] = N'Pending'`) even though it came from a variable, which EF would normally send as a parameter. `EF.Parameter(x)` does the opposite: it forces a value that EF would normally inline, such as a literal or an `Expression.Constant` in a hand-built tree, to go out as a parameter (`WHERE [Status] = @p`). The defaults are right for almost every query. Reach for `EF.Parameter` when you build expression trees dynamically, because raw constants in those trees force a full query compilation on every distinct value. Reach for `EF.Constant` only when a column has a few distinct values with very skewed data and the database needs a separate plan per value.

Everything below was run on EF Core 11.0.0-rc.1.26425.128 with SDK 11.0.100-rc.1.26425.128 on an Apple M4. Where noted I also checked EF Core 10.0.12 on SDK 10.0.302, and it behaved the same. `EF.Constant` shipped in EF Core 8.0.2, `EF.Parameter` in EF Core 9, and the collection-specific `EF.MultipleParameters` in EF Core 10.

## The comparison at a glance

| | `EF.Parameter(x)` | `EF.Constant(x)` |
| --- | --- | --- |
| Available since | EF Core 9 | EF Core 8.0.2 |
| Scalar result in SQL | `@p` parameter | literal, e.g. `N'Pending'` |
| Collection result in SQL (EF 10/11) | one JSON parameter + `OPENJSON` | `IN (1, 2, 3, ...)` literals |
| EF query cache entries for N distinct values | 1 | 1 (since EF 9) |
| Database plan cache entries for N distinct values | 1 | up to N |
| Plan tuned for the actual value | No (parameter sniffing applies) | Yes |
| Value appears in EF logs by default | No (`'?'`) | No, redacted as `?` since EF 10 |
| Works in `EF.CompileQuery` / query filters | No, throws | No, throws |
| Main use | dynamic expression trees, forcing a JSON collection parameter | skewed low-cardinality columns, forcing an inlined `IN` list |

## What EF Core does by default

EF's parameterization rule is simple: anything that comes from outside the expression tree (a captured local, a field, a method argument) becomes a parameter, and anything written as a literal inside the lambda becomes a constant. Here is what EF Core 11 RC 1 generates for SQL Server, straight from `ToQueryString()`:

```csharp
// EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.SqlServer, .NET 11 RC 1
var status = "Pending";

db.Orders.Where(o => o.Status == status);
// DECLARE @status nvarchar(4000) = N'Pending';
// WHERE [o].[Status] = @status

db.Orders.Where(o => o.Status == "Pending");
// WHERE [o].[Status] = N'Pending'
```

That split is deliberate. A literal in source code cannot change between executions, so inlining it costs nothing and gives the query optimizer the actual value to estimate with. A captured variable can change on every call, so inlining it would produce a different SQL string per value, and each distinct string gets its own entry in the database's plan cache. On a busy SQL Server that is plan cache bloat and a compile on every new value.

`EF.Constant` and `EF.Parameter` exist to override that rule in either direction.

## EF.Constant: force a literal

```csharp
// EF Core 11.0.0-rc.1
var status = "Pending";
db.Orders.Where(o => o.Status == EF.Constant(status));
// WHERE [o].[Status] = N'Pending'

var name = "O'Brien";
db.Orders.Where(o => o.Customer == EF.Constant(name));
// WHERE [o].[Customer] = N'O''Brien'
```

The second query matters if you are worried about injection: EF still generates the literal through the provider's type mapping, so the quote is escaped. `EF.Constant` is not string concatenation.

The reason to do this is parameter sniffing. SQL Server compiles a parameterized plan using the first value it sees and reuses that plan for every later value. If `Status = 'Archived'` matches 40 million rows and `Status = 'Pending'` matches 200, a plan compiled for one is wrong for the other. With a literal, each value gets its own plan with its own cardinality estimate. That trade only pays off when the column has a small, fixed set of values. If you wrap a user ID or an order number in `EF.Constant`, you have rebuilt the plan cache problem EF's defaults were designed to avoid.

### EF.Constant no longer costs an EF recompile

In EF Core 8 the implementation inserted the constant early in the pipeline, before EF's own query cache lookup, so every new value caused a full LINQ-to-SQL compilation. The [EF Core 9 breaking changes page](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) describes the rewrite: the method is now processed at a later stage, after the cache. I checked this by counting the `Compiling query expression` debug log event across 500 executions with 500 distinct values, after a 50-query warm-up, on SQLite in-memory:

```csharp
// EF Core 11.0.0-rc.1, Microsoft.EntityFrameworkCore.Sqlite
for (int i = 0; i < 500; i++)
{
    using var db = new Ctx(conn, log: s => { if (s.Contains("Compiling query expression")) compiles++; });
    var value = "S" + i;
    db.Orders.Where(o => o.Status == EF.Constant(value)).ToList();
}
```

The result was zero additional compilations: EF reuses its compiled query and only re-renders the SQL text. The cost of `EF.Constant` today lives entirely on the database side, one plan per distinct SQL string.

## EF.Parameter: force a parameter

```csharp
// EF Core 11.0.0-rc.1
db.Orders.Where(o => o.Status == EF.Parameter("Pending"));
// DECLARE @p nvarchar(4000) = N'Pending';
// WHERE [o].[Status] = @p
```

Wrapping a hard-coded literal is rarely useful by itself. Where `EF.Parameter` earns its place is dynamic query construction. When you build a predicate with `System.Linq.Expressions`, the natural thing to write is `Expression.Constant(value)`, and EF treats that exactly like a literal in source code:

```csharp
// EF Core 11.0.0-rc.1, .NET 11 RC 1
static Expression<Func<T, bool>> Eq<T>(string property, string value, bool wrap)
{
    var p = Expression.Parameter(typeof(T), "e");
    Expression v = Expression.Constant(value);
    if (wrap)
        v = Expression.Call(typeof(EF), nameof(EF.Parameter), [typeof(string)], v);
    return Expression.Lambda<Func<T, bool>>(
        Expression.Equal(Expression.Property(p, property), v), p);
}

db.Orders.Where(Eq<Order>("Status", "Shipped", wrap: false));
// WHERE [o].[Status] = N'Shipped'

db.Orders.Where(Eq<Order>("Status", "Shipped", wrap: true));
// DECLARE @p nvarchar(4000) = N'Shipped';
// WHERE [o].[Status] = @p
```

Unlike `EF.Constant`, a raw `Expression.Constant` is part of the tree EF uses as its cache key, so every distinct value is a cache miss and a full compilation. This is where the measurable cost shows up. Same harness as above, 500 distinct values, one process per variant, after warm-up:

| Variant (EF Core 11 RC 1, SQLite in-memory, M4) | EF compilations | Time for 500 queries |
| --- | --- | --- |
| Captured variable (default) | 0 | 186-292 ms |
| `EF.Constant(variable)` | 0 | 188-226 ms |
| Raw `Expression.Constant` in a built tree | 500 | 2201-2261 ms |
| `Expression.Constant` wrapped in `EF.Parameter` | 0 | 202-355 ms |

The ranges are two runs each. The table is empty, so this isolates EF's own overhead: roughly 4 ms of compilation per query, before the database has done anything. On SQL Server you would add a database plan compile per distinct string on top of that. One `Expression.Call` to `EF.Parameter` brings the dynamic tree back to the cost of a normal LINQ query.

The other way to get there is to capture the value in a closure object and use `Expression.Property(Expression.Constant(holder), "Value")`, which is what the C# compiler does for a lambda. It works, but `EF.Parameter` is shorter and makes the intent visible. I covered the closure trick in more depth in [writing reusable LINQ predicates EF Core can translate](/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/).

## Collections: three strategies, three markers

For a scalar, the choice is binary. For a collection used in `Contains`, EF Core 10 and 11 have three translations, and each marker method picks one per query:

```csharp
// EF Core 11.0.0-rc.1, SQL Server provider
int[] ids = [1, 2, 3, 4, 5, 6, 7, 8];

db.Orders.Where(o => ids.Contains(o.Id));
// DECLARE @ids1 int = 1; ... DECLARE @ids8 int = 8;
// DECLARE @ids9 int = 8; DECLARE @ids10 int = 8;
// WHERE [o].[Id] IN (@ids1, @ids2, ..., @ids10)

db.Orders.Where(o => EF.Constant(ids).Contains(o.Id));
// WHERE [o].[Id] IN (1, 2, 3, 4, 5, 6, 7, 8)

db.Orders.Where(o => EF.Parameter(ids).Contains(o.Id));
// DECLARE @ids nvarchar(4000) = N'[1,2,3,4,5,6,7,8]';
// WHERE [o].[Id] IN (
//     SELECT [i].[value]
//     FROM OPENJSON(@ids) WITH ([value] int '$') AS [i]
// )

db.Orders.Where(o => EF.MultipleParameters(ids).Contains(o.Id));
// same padded IN (@ids1, ..., @ids10) as the default
```

The default since EF Core 10 is one scalar parameter per element, padded so that 8 values produce 10 parameters (the last value is repeated). That keeps the number of distinct SQL strings small while still telling the optimizer roughly how many values there are. `EF.Parameter` on a collection gets you back the EF Core 8 and 9 behavior: a single JSON parameter unpacked with `OPENJSON`, one SQL string for any list length, but no cardinality information for the planner. `EF.Constant` inlines the values, which is the EF Core 7 behavior.

The global switch is `UseParameterizedCollectionMode`:

```csharp
// EF Core 11.0.0-rc.1
options.UseSqlServer(connectionString,
    o => o.UseParameterizedCollectionMode(ParameterTranslationMode.Constant));
```

With that set, a plain `ids.Contains(...)` produces `IN (1, 2, ...)`, `EF.MultipleParameters(ids)` opts a single query back into padded parameters, and `EF.Parameter(ids)` opts it into `OPENJSON`. The mode only affects collections: a scalar captured variable stays `@status` in every mode. The EF Core 9 methods `TranslateParameterizedCollectionsToConstants()` and `TranslateParameterizedCollectionsToParameters()` were marked `[Obsolete]` in EF Core 10 and are gone from the EF Core 11 RC 1 source, so a project upgrading from EF 9 has to move to `UseParameterizedCollectionMode`. The [EF Core 6 to 11 breaking changes walkthrough](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) has the rest of that upgrade path.

## Gotchas I hit while testing

### The marker has to be inside the lambda

`EF.Constant` and `EF.Parameter` are markers, not functions. Their real bodies throw. They only work when they sit inside an expression tree that EF translates. This compiles but fails at run time:

```csharp
// EF Core 11.0.0-rc.1
db.Orders.OrderBy(o => o.Id).Take(EF.Constant(10));
// InvalidOperationException: The 'EF.Constant<T>' method may only be used
// within Entity Framework LINQ queries.
```

`Take(int)` takes a plain `int`, not an `Expression`, so C# evaluates `EF.Constant(10)` immediately, outside any query. The same applies to any operator argument that is not a lambda.

### Not in compiled queries, not in query filters

Since EF Core 9, both methods throw inside `EF.CompileQuery` and `EF.CompileAsyncQuery`. On EF Core 11 RC 1 the message is clearer than the `InvalidCastException` documented for EF 9:

```text
InvalidOperationException: 'EF.Constant<T>' is not supported when using compiled queries or query filters.
InvalidOperationException: 'EF.Parameter<T>' is not supported when using compiled queries or query filters.
```

If you need a constant in a hot path, write the literal into the compiled query's lambda. If you need per-value plans, a compiled query is the wrong tool anyway, because it pins one SQL string. The [compiled queries guide](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) covers when they pay off. The message also rules out global query filters, which matters if you were hoping to inline a tenant ID into a [named query filter](/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/).

### Inlined values are redacted in logs

Before EF Core 10, an inlined constant was visible in the logged SQL, unlike a parameter value. Since EF Core 10, EF redacts it. From the EF Core 11 RC 1 log, with sensitive data logging off:

```text
Executed DbCommand (20ms) [Parameters=[@secret='?' (Size = 17)], ...]
WHERE "o"."Customer" = @secret

Executed DbCommand (0ms) [Parameters=[], ...]
WHERE "o"."Customer" = ?
```

The database still receives the real literal. Only the log line is masked. That `?` can be confusing the first time you [log the SQL EF Core generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) and try to paste it into SSMS. Turn on `EnableSensitiveDataLogging()` in development to see the value.

### The collection mode is not part of the query cache key

This one surprised me. Two contexts of the same type, one configured with `ParameterTranslationMode.Constant` and one with the default, share one internal service provider and one compiled query cache. Whichever runs a given query shape first decides the SQL for both:

```csharp
// EF Core 11.0.0-rc.1 and 10.0.12, same process
using (var a = new Ctx(ParameterTranslationMode.Constant))
    a.Orders.Where(o => ids.Contains(o.Id)).ToQueryString();
// WHERE [o].[Id] IN (1, 2, 3)

using (var b = new Ctx(mode: null))   // default MultipleParameters
    b.Orders.Where(o => ids.Contains(o.Id)).ToQueryString();
// WHERE [o].[Id] IN (1, 2, 3)   <- cached translation from context a
```

The source explains it. `RelationalOptionsExtension` returns `0` from `GetServiceProviderHashCode()`, and `RelationalCompiledQueryCacheKey` includes `UseRelationalNulls` and `QuerySplittingBehavior`, but not the collection mode. In a normal app with one configuration this never matters. It does matter if you register the same `DbContext` twice with different modes, or flip the mode in a test fixture and expect the next test to see different SQL. Use the per-query markers in that case, since they are part of the expression tree and therefore part of the cache key.

## When to pick EF.Parameter

- You build predicates with `System.Linq.Expressions` (filter builders, grid search, OData-like endpoints). Wrap every `Expression.Constant` that carries user input in `EF.Parameter`, or you pay a full compilation per distinct value.
- You want the `OPENJSON` translation for one query whose list length varies wildly (1 to 2,000 ids), so the database has one plan instead of many padded variants.
- You have set the global collection mode to `Constant` and one query needs to opt back out.

## When to pick EF.Constant

- A column with a handful of values and heavily skewed data, such as a status or type discriminator, where measured plans differ per value. Confirm the regression with the actual execution plan first.
- A short, stable list of values in `Contains` (a fixed set of roles or regions) where the optimizer benefits from seeing the literals, and you know the set of combinations is small.
- Never for IDs, user input with unbounded variety, or anything inside a compiled query.

## The recommendation

Leave EF Core 11's defaults alone until you have a measurement. Most of the real-world benefit comes from `EF.Parameter`, because a dynamically built tree with raw constants is an easy mistake that costs about 4 ms of EF compilation per call before the database even sees it. `EF.Constant` is a targeted fix for parameter sniffing on skewed, low-cardinality columns. It no longer costs an EF recompile, but every distinct value still costs a database plan. If you are not sure which of the two you got, `ToQueryString()` shows it immediately. Look for `DECLARE @`. And if a query regressed after an upgrade, check [what the SQL Server compatibility level changes for EF Core 11](/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/) before reaching for either marker.

## Sources

- [What's new in EF Core 9: force or prevent query parameterization](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [What's new in EF Core 10: improved translation for parameterized collections, redacting inlined constants](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Breaking changes in EF Core 9: EF.Constant and EF.Parameter in compiled queries](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes)
- [`EF.cs`, `EFExtensions.cs` and `ParameterTranslationMode.cs` in dotnet/efcore](https://github.com/dotnet/efcore/tree/main/src/EFCore)
- [dotnet/efcore#13617, the original plan cache issue for inlined collections](https://github.com/dotnet/efcore/issues/13617)
