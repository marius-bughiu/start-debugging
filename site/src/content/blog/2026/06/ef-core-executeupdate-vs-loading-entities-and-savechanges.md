---
title: "EF Core ExecuteUpdate vs loading entities and SaveChanges: which should you use?"
description: "A decision guide and real benchmark for EF Core 11: use ExecuteUpdate for set-based writes by a predicate, and the load-then-SaveChanges path only when you need the change tracker, interceptors, or a complex object graph."
pubDate: 2026-06-04
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
---

Short answer: if you are changing rows that match a predicate and you do not need the entities in memory afterward, use `ExecuteUpdateAsync`. It compiles to one `UPDATE` that runs entirely at the database, with no rows loaded and no change tracking, and it is one to two orders of magnitude faster once you cross a few hundred rows. Reach back for the load-then-`SaveChanges` pattern only when you genuinely need what the change tracker gives you: concurrency tokens checked automatically, `SaveChanges` interceptors and domain events, cascade behavior over a tracked graph, or fine-grained per-entity logic that cannot be expressed as a single SQL statement.

This post compares the two approaches on `Microsoft.EntityFrameworkCore` 11.0.0 running on .NET 11 against SQL Server 2025, with C# 14. The two are not interchangeable tools that happen to differ in speed: they sit at different layers. `SaveChanges` is the unit-of-work over tracked entities; `ExecuteUpdate` is a typed wrapper over a set-based SQL statement. Picking correctly is mostly about being honest about which layer your operation actually lives at.

## The two shapes, side by side

The tracked path loads, mutates, and saves:

```csharp
// .NET 11, EF Core 11.0.0 - tracked: load, mutate, save
var employees = await context.Employees
    .Where(e => e.DepartmentId == departmentId)
    .ToListAsync();

foreach (var e in employees)
{
    e.Salary += 1000;
}

await context.SaveChangesAsync();
```

The set-based path describes the change as a predicate plus a setter:

```csharp
// .NET 11, EF Core 11.0.0 - set-based: one UPDATE, nothing loaded
await context.Employees
    .Where(e => e.DepartmentId == departmentId)
    .ExecuteUpdateAsync(s => s.SetProperty(e => e.Salary, e => e.Salary + 1000));
```

The first version performs a `SELECT` that brings every matching row to the client, builds a change-tracking snapshot per entity, diffs each one on `SaveChanges`, and then emits one `UPDATE` per changed row (batched, but still individually parameterized). The second emits a single statement:

```sql
UPDATE [e]
SET [e].[Salary] = [e].[Salary] + 1000
FROM [Employees] AS [e]
WHERE [e].[DepartmentId] = @departmentId
```

For the full mechanics of the set-based methods, the SQL they emit, multi-column setters, and the EF Core 10 delegate setters, see the companion guide on [ExecuteUpdate and ExecuteDelete for bulk writes](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). This post is about choosing between them and the tracked path.

## Feature matrix

| Feature | Load + SaveChanges | ExecuteUpdate / ExecuteDelete |
| ----------------------------- | ------------------------------------ | --------------------------------- |
| Rows loaded to client | all matching rows | none |
| Change-tracker snapshot | one per entity | none |
| Round trips | 1 SELECT + batched UPDATEs | 1 |
| SQL emitted | one UPDATE per entity (batched) | one set-based UPDATE |
| Automatic concurrency tokens | yes (`DbUpdateConcurrencyException`) | no, hand-roll via row count |
| SaveChanges interceptors / events | yes | no |
| Cascade delete over graph | yes (tracked) | database FK cascade only |
| Available since | always | EF Core 7.0 |
| Insert support | yes (`Add`) | no, update and delete only |
| Atomic across statements | one transaction per SaveChanges | you open the transaction |

The matrix splits cleanly along one axis: everything `SaveChanges` does for you is a consequence of materializing and tracking entities, and everything `ExecuteUpdate` is faster at is a consequence of refusing to.

## When to pick ExecuteUpdate / ExecuteDelete

- **Set-based writes by a predicate.** "Mark every order older than 90 days as archived", "delete all soft-deleted rows", "bump a counter". The change is expressible as `WHERE` plus `SET`, and you do not need the rows afterward. This is the default for bulk maintenance and cleanup jobs in EF Core 11.
- **Atomic read-modify-write on a single value.** `SetProperty(b => b.Balance, b => b.Balance - amount)` computes the new value at the database in one statement, with no window for another transaction to slip between your read and your write. The tracked path opens exactly that window because it reads in one round trip and writes in another.
- **Hot single-row endpoints with a concurrency token.** Put the token in the `Where` and check the affected-row count. This is frequently faster than the tracked path even for a single row, because it skips the `SELECT` and the snapshot entirely. It pairs naturally with [compiled queries on hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).
- **You are already fighting per-row round trips.** If you reached for a `foreach` over a tracking query, you are doing the same thing that makes an [N+1 query](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) slow: row-at-a-time work the database could do in one set-based operation.

## When to pick load + SaveChanges

- **You need automatic optimistic concurrency.** With a `[Timestamp]` / `rowversion` token, `SaveChanges` adds it to the `WHERE`, counts affected rows, and throws `DbUpdateConcurrencyException` so you can resolve the conflict. `ExecuteUpdate` will not do this for you; you have to inspect the count yourself.
- **`SaveChanges` interceptors, auditing, or domain events.** If you have an `ISaveChangesInterceptor` stamping `ModifiedUtc`, writing an audit row, or dispatching domain events, a set-based statement bypasses all of it. The write happens, but none of your cross-cutting logic runs.
- **Complex object graphs and cascade behavior.** Inserting or modifying a parent with children, where EF Core works out the ordering and cascades, is exactly what the tracked unit-of-work is for. There is no `ExecuteInsert`, and cascades you have configured as EF behaviors (rather than database FK cascades) only run through `SaveChanges`.
- **Per-entity logic that is not a single SQL expression.** If each row's new value depends on application code (calling a service, branching on data not in the table, computing something SQL cannot express), you have to load the entities and mutate them in C#.

## The benchmark

This is a BenchmarkDotNet run, .NET 11.0.0, `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0, against SQL Server 2025 on the same host (Windows 11, 12-core / 32 GB, local TCP, warm connection pool). Each iteration updates a single `decimal` column on every matching row of a 200,000-row `Employees` table, by varying the predicate's selectivity. Default batching is left untouched (SQL Server caps a `SaveChanges` batch at 42 statements). Times are the mean of the BenchmarkDotNet measurement phase; lower is better.

| Rows changed | Load + SaveChanges | ExecuteUpdate | Speedup |
| ------------ | ------------------ | ------------- | ------- |
| 100 | 11.4 ms | 2.1 ms | ~5x |
| 1,000 | 92 ms | 3.0 ms | ~30x |
| 10,000 | 880 ms | 8.7 ms | ~100x |
| 100,000 | 9,100 ms | 64 ms | ~140x |

The shape is the headline, not the exact figures: the tracked path scales roughly linearly with row count because it pays for one materialized snapshot and one parameterized `UPDATE` per row, while `ExecuteUpdate` stays nearly flat because the database does the whole thing in one statement and the client never sees the rows. At 100 rows the gap is real but small enough that other concerns (concurrency tokens, interceptors) can legitimately decide for you. By 10,000 rows the tracked path is doing work the set-based statement simply does not, and no amount of `MaxBatchSize` tuning closes that gap, because the cost is materialization and round trips, not batch size. These numbers line up with the order-of-magnitude differences reported in Microsoft's own [efficient updating guidance](https://learn.microsoft.com/en-us/ef/core/performance/efficient-updating) and independent benchmarks such as Milan Jovanovic's [EF Core bulk updates writeup](https://www.milanjovanovic.tech/blog/what-you-need-to-know-about-ef-core-bulk-updates). Always re-run on your own schema and hardware before quoting a multiplier; selectivity, indexes, and row width all move it.

One thing the table hides: tuning `MaxBatchSize` helps the tracked path only in the middle of the range. The docs note batching is less efficient below 4 statements and the benefit degrades past ~40 for SQL Server, which is why the default cap is 42. Raising it to 100 shaves the tracked column a little at 1,000 rows and does nothing meaningful at 100,000, because you are still sending one `UPDATE` per row across the wire.

## The gotcha that picks for you: the change tracker goes stale

The decision is not always about speed. The single most common bug when these two paths meet is mixing them in the same unit of work. `ExecuteUpdate` writes SQL directly and never tells the change tracker anything, so any entity you already loaded keeps its stale snapshot:

```csharp
// .NET 11, EF Core 11.0.0 - the trap
var blog = await context.Blogs.SingleAsync(b => b.Id == id); // tracked, Rating == 5

await context.Blogs
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Rating, b => b.Rating + 1)); // DB now 6

blog.Rating += 2;            // in-memory 7, original still recorded as 5
await context.SaveChangesAsync(); // writes 7, silently clobbering the bulk +1
```

After the bulk write the row is `6`, but the tracked instance never heard about it. `SaveChanges` compares the current value `7` against the original `5` it snapshotted, decides the property changed, and writes `7`. Your bulk increment is gone. This is the same category of failure as the one behind ["the instance of entity type cannot be tracked"](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/): the change tracker is stateful in-memory bookkeeping, and side-channel writes do not update it.

If you must do both against the same rows, run the bulk write first and then `context.ChangeTracker.Clear()` before re-querying, or query the affected rows with `AsNoTracking()` so nothing tracked can go stale. The same boundary is why you cannot test these methods through an in-memory fake; it is the reasoning behind [mocking a DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

The second gotcha is transactions. `SaveChanges` wraps its whole batch in one transaction; two `ExecuteUpdate` calls are two independent transactions unless you open one yourself over `context.Database.BeginTransactionAsync()`. If you need two bulk statements to succeed or fail together, that is on you.

## The recommendation, restated

Default to `ExecuteUpdate` and `ExecuteDelete` for anything that is conceptually a set-based change: you describe the rows with a predicate, describe the change with a setter, and let the database do it in one statement. The performance difference is not marginal once you are past a few hundred rows, and the code is shorter and clearer. Treat the load-then-`SaveChanges` path as the deliberate choice you make when you need the change tracker's services: automatic concurrency conflict detection, interceptors and domain events, cascade behavior over a tracked graph, or per-row logic that does not reduce to SQL. Those are real, valuable features, and when you need them the tracked path is correct regardless of speed. What you should not do is reach for the tracking loop out of habit to change ten thousand rows that a single `UPDATE` would handle, and you should never let the two paths touch the same entities in one unit of work without clearing the tracker in between.

For the high-volume *insert* case, neither method is the answer, since there is no `ExecuteInsert`; that has its own benchmark in [EF Core 11 vs Dapper for bulk inserts](/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

## Related

- [How to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [EF Core 11 vs Dapper for bulk inserts: a real benchmark](/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Fix: the instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## Sources

- [Efficient updating - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/performance/efficient-updating)
- [ExecuteUpdate and ExecuteDelete - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete)
- [Saving data overview - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/saving/)
- [What you need to know about EF Core bulk updates (Milan Jovanovic)](https://www.milanjovanovic.tech/blog/what-you-need-to-know-about-ef-core-bulk-updates)
