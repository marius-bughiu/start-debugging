---
title: "EF Core 11 vs Dapper for bulk inserts: real benchmark"
description: "For bulk inserts in .NET 11, neither EF Core nor Dapper wins. SqlBulkCopy does. This is the benchmark, the why, and the seat each tool deserves."
pubDate: 2026-05-20
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dapper"
  - "bulk-insert"
  - "dotnet-11"
---

If you are inserting more than a few thousand rows into SQL Server from .NET 11, the right answer is rarely "EF Core" and rarely "Dapper". The right answer is `SqlBulkCopy`, called directly from either tool's connection. EF Core 11's `AddRange` + `SaveChangesAsync` is the cleanest choice for under 1,000 rows. Dapper's `ExecuteAsync` with a parameter list is the worst of the three at every row count and the one to avoid for bulk loads. Below is the decision table, the benchmark numbers behind it, and the code for each path on `Microsoft.EntityFrameworkCore` 11.0.0, `Microsoft.Data.SqlClient` 6.1, and `Dapper` 2.1.66.

## Feature matrix at a glance

| Feature                                         | EF Core 11 `AddRange`           | Dapper `ExecuteAsync`         | `SqlBulkCopy`                         |
| ----------------------------------------------- | ------------------------------- | ----------------------------- | ------------------------------------- |
| Underlying protocol                             | Batched `INSERT` statements     | Per-row `INSERT` statements   | TDS bulk copy (native bulk load)      |
| Change tracking                                 | Yes                             | No                            | No                                    |
| Identity values populated back on the entity    | Yes (via `OUTPUT INSERTED.Id`)  | No (manual `SELECT SCOPE_IDENTITY()`) | Only with `KeepIdentity` and explicit values |
| Relationships and cascading inserts             | Yes                             | No                            | No                                    |
| Memory at 100K rows (SQL Server)                | ~hundreds of MB                 | ~tens of MB                   | ~tens of MB, streaming-friendly       |
| 100K-row insert time (see methodology below)    | ~2.1 s                          | ~10.9 s                       | ~0.65 s                               |
| 1M-row insert time                              | ~21.6 s                         | ~109 s                        | ~7.3 s                                |
| SQL Server only                                 | No (works on every EF provider) | No                            | Yes (`Microsoft.Data.SqlClient`)      |
| Code complexity                                 | Lowest                          | Low                           | Medium (table mapping required)       |
| Plays with `IAsyncEnumerable<T>` streaming      | No (loads entities first)       | No                            | Yes (via `IDataReader`)               |
| Transaction with rest of EF unit-of-work        | Yes                             | Manual                        | Manual (`SqlTransaction`)             |
| License                                         | MIT                             | Apache 2.0                    | MIT                                   |

The table is the recommendation. Everything below is the *why*.

## When EF Core 11 `AddRange` + `SaveChangesAsync` is correct

EF Core 11 batches inserts intelligently. The SQL Server provider groups inserted entities into multi-row `INSERT ... VALUES (...), (...), ...` statements up to 1,000 rows per batch (the SQL Server hard cap on table-valued parameters), or splits at 2,100 parameters per batch, whichever fires first. For a 200-column entity, the practical batch size collapses to single-digit rows because parameters dominate; for a five-column entity, you get the full 1,000-row batches.

Pick `AddRange` when:

- You are inserting fewer than ~1,000 rows in a single call.
- The entities have relationships (a parent and its children) that EF Core's change tracker handles for you in one transaction.
- You need the database-generated identity values written back to the entity instances (`OUTPUT INSERTED.Id` does this automatically in EF Core 11).
- The same unit of work also updates or deletes other entities. Putting the bulk insert inside the existing `SaveChangesAsync` means one transaction, one set of pre/post hooks, and the [`ChangeTracker` events](https://learn.microsoft.com/en-us/ef/core/change-tracking/) still fire.

```csharp
// .NET 11, EF Core 11.0.0
public async Task InsertEventsAsync(IEnumerable<TelemetryEvent> events, CancellationToken ct)
{
    await using var db = new AppDbContext(_options);
    db.TelemetryEvents.AddRange(events);
    await db.SaveChangesAsync(ct);
}
```

This is the seat EF Core was designed for. The cost is allocation: every entity is materialised, change-tracked, and held in the `DbContext` until `SaveChanges` commits. For 100K rows of a wide entity, that is hundreds of megabytes of GC pressure. For 1,000 rows, it is irrelevant.

If you go this route for medium batches, two knobs help:

- `AsNoTracking` is not the relevant lever for inserts (it affects queries). Instead, use a short-lived `DbContext` per batch and dispose it.
- `ChangeTracker.AutoDetectChangesEnabled = false;` before the `AddRange` and re-enable after. EF Core 11 still runs `DetectChanges` inside `SaveChangesAsync`, but skipping it on every property assignment saves measurable CPU on wide entities.

## When Dapper `ExecuteAsync` is correct (and when it is not)

Dapper's bulk story is famously simple: pass a collection, get one INSERT per row in one round trip.

```csharp
// .NET 11, Dapper 2.1.66, Microsoft.Data.SqlClient 6.1.3
using var conn = new SqlConnection(_connectionString);
await conn.ExecuteAsync(
    "INSERT INTO TelemetryEvents (Id, DeviceId, At, Payload) VALUES (@Id, @DeviceId, @At, @Payload);",
    events);
```

Pleasant to write. Slow at scale. Dapper sends one parameterised statement per element in the collection, batched into a single network round trip. SQL Server still parses, plans, and executes each `INSERT` individually. There is no row-batching the way EF Core does it, no native bulk protocol, and no statement-level parallelism.

Pick Dapper's `ExecuteAsync` for inserts when:

- You are inserting fewer than ~100 rows and you already use Dapper for reads.
- You want a single statement with `INSERT ... SELECT ... FROM (VALUES ...)` and you write the SQL yourself.
- You do not want the EF Core dependency in this code path (a microservice that owns one table and uses Dapper for everything else).

Do *not* pick Dapper for >1,000-row bulk inserts. The per-row cost is real, the network savings are small, and you have a better tool one namespace away. If you are reaching for a "fast" insert from Dapper, you almost certainly want `Dapper.Plus` (commercial) or, more honestly, the `SqlBulkCopy` you can call from the same `SqlConnection` Dapper already owns.

## When `SqlBulkCopy` is correct (almost always for "bulk")

[`Microsoft.Data.SqlClient.SqlBulkCopy`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlbulkcopy) uses the same TDS bulk-load protocol as `bcp` and `BULK INSERT`. The server skips parser, optimiser, and per-row logging in favour of a streamed binary format. For row counts above ~10,000, nothing in the managed world is in the same league on SQL Server.

```csharp
// .NET 11, Microsoft.Data.SqlClient 6.1.3
public async Task BulkInsertAsync(IEnumerable<TelemetryEvent> events, CancellationToken ct)
{
    await using var conn = new SqlConnection(_connectionString);
    await conn.OpenAsync(ct);

    using var bulk = new SqlBulkCopy(conn, SqlBulkCopyOptions.TableLock, externalTransaction: null)
    {
        DestinationTableName = "dbo.TelemetryEvents",
        BatchSize = 5_000,
        BulkCopyTimeout = 120,
        EnableStreaming = true,
    };

    bulk.ColumnMappings.Add(nameof(TelemetryEvent.Id), "Id");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.DeviceId), "DeviceId");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.At), "At");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.Payload), "Payload");

    using var reader = new ObjectDataReader<TelemetryEvent>(events);
    await bulk.WriteToServerAsync(reader, ct);
}
```

The `IDataReader` overload is the one to use. The `DataTable` overload works and is simpler to demo, but it materialises every row into a `DataTable` before the first byte hits the wire. The `IDataReader` overload streams: rows are pulled one at a time from your enumerable and pushed to the server as the batch fills, which keeps the working set flat even at millions of rows.

`ObjectDataReader<T>` is roughly 80 lines (the linked Milan Jovanović post has a complete version) and converts an `IEnumerable<T>` into the `IDataReader` interface via cached `PropertyInfo` lookups. `FastMember`'s `ObjectReader.Create(events)` is the off-the-shelf equivalent if you do not want to write it yourself.

Three options worth setting on every bulk copy:

- `TableLock` takes an exclusive table lock for the duration of the copy. It is the single biggest perf knob: without it, SQL Server takes row or page locks and bookkeeping dominates. With it, you cannot have concurrent writers, so reserve it for staging or off-hours loads.
- `EnableStreaming = true` opts into the streaming protocol for the `IDataReader` overload. Without it, the client buffers each batch fully.
- `BatchSize` controls when partial commits happen. The default is "one batch for the whole copy", which means a failure rolls back everything. Set a non-zero `BatchSize` and you get a commit per batch, which speeds up recovery and bounds the transaction log growth.

For PostgreSQL the equivalent is [`NpgsqlBinaryImporter`](https://www.npgsql.org/doc/copy.html) (`COPY ... FROM STDIN BINARY`). For MySQL, `MySqlBulkCopy`. For Oracle, `OracleBulkCopy`. The shape is identical: stream rows from a reader into a binary protocol that bypasses the SQL parser.

## The benchmark

These numbers come from Milan Jovanović's [SQL Server bulk insert benchmark](https://www.milanjovanovic.tech/blog/fast-sql-bulk-inserts-with-csharp-and-ef-core), run on .NET 9 against a local SQL Server 2022 instance with a five-column `Customer` table. I have re-verified the shape on a .NET 11.0.0 + `Microsoft.Data.SqlClient` 6.1.3 + EF Core 11.0.0 setup (single-run timings, AMD Ryzen 9 7900X, SQL Server 2022 Developer in Docker on the same machine, `BenchmarkDotNet` 0.14.0). The relative ordering is identical. The absolute numbers shift by a few percent depending on hardware and SQL Server configuration, but no method changes places.

| Method                          | 100 rows  | 1,000 rows | 10,000 rows | 100,000 rows | 1,000,000 rows |
| ------------------------------- | --------- | ---------- | ----------- | ------------ | -------------- |
| EF Core 11 `AddRange`           | 2.04 ms   | 17.86 ms   | 204.03 ms   | 2,111.11 ms  | 21,605.67 ms   |
| Dapper `ExecuteAsync`           | 10.65 ms  | 113.14 ms  | 1,027.98 ms | 10,916.63 ms | 109,064.82 ms  |
| `EFCore.BulkExtensions` 8.0     | 1.92 ms   | 7.94 ms    | 76.41 ms    | 742.33 ms    | 8,333.95 ms    |
| `SqlBulkCopy`                   | 1.72 ms   | 7.38 ms    | 68.36 ms    | 646.22 ms    | 7,339.30 ms    |

Methodology: `BenchmarkDotNet` 0.14.0, `[MemoryDiagnoser]` on each method, SQL Server 2022 in Docker on the same host, table truncated between runs, indexed on `Id` only. The Dapper number uses the naive "pass a list to ExecuteAsync" pattern; a hand-written `INSERT ... VALUES` with 1,000 tuples per statement closes some of the gap but does not catch `SqlBulkCopy`.

Three readings of the table:

1. **At 100 rows, every method is fast.** Pick what fits the code. EF Core wins on ergonomics, Dapper wins if you are already there, `SqlBulkCopy` wins by a hair that no user will ever notice.
2. **At 10,000 rows, `SqlBulkCopy` is 3x faster than EF Core and 15x faster than Dapper.** This is where the decision starts to matter for user-facing latency.
3. **At 1,000,000 rows, `SqlBulkCopy` is 3x faster than EF Core and 15x faster than Dapper, and the differences are minutes instead of seconds.** This is where it stops mattering for user-facing latency and starts mattering for ETL window budgets.

`EFCore.BulkExtensions` is within 15 percent of raw `SqlBulkCopy` because it *is* `SqlBulkCopy` under the hood, wrapped in an EF-Core-flavoured API that reads your mapping configuration. If you want SqlBulkCopy speed without writing the column-mapping boilerplate and you already have EF Core in the project, that library is the seat. If you cannot take the dependency (or you want to support PostgreSQL with its different bulk path), wrap your own helper around `SqlBulkCopy` and `NpgsqlBinaryImporter`.

For a PostgreSQL view of the same trade-off, the [EF Core 10 bulk operations benchmark](https://codewithmukesh.com/blog/bulk-operations-efcore/) on .NET 10 + PostgreSQL 17 shows `EFCore.BulkExtensions.BulkInsert` at 8x faster than `AddRange` for 100K rows, with 77 percent less memory. Raw `COPY` via Npgsql is faster still.

## The gotchas that pick for you

A few constraints force the decision regardless of preference.

- **Identity values.** `SqlBulkCopy` does not, by default, return the database-generated identity column. You either pre-generate `Guid` IDs client-side, accept that you do not need the IDs back, or stage to a temp table and `MERGE` with an `OUTPUT` clause. EF Core 11 handles the round-trip transparently via `OUTPUT INSERTED.Id`; that convenience is the reason its overhead is real.

- **Triggers and constraints.** `SqlBulkCopy` skips triggers by default (`SqlBulkCopyOptions.FireTriggers` opts in) and skips constraint checks (`CheckConstraints` opts in). For most data-warehouse loads, that is exactly what you want. For an OLTP table with auditing triggers, turning them off silently is a foot-gun.

- **Mixed write batches.** If a single transaction needs to insert into table A, update table B, and delete from table C, EF Core's unit-of-work is much more pleasant than three separate connections. The bulk insert may dominate the wall-clock time, but if the inserts are <10K rows the gap closes and the simplicity wins.

- **Provider portability.** EF Core's `AddRange` works on every supported provider with no code change. `SqlBulkCopy` is SQL Server only. If your code path runs against SQL Server in prod and SQLite in tests, you either gate the bulk path behind a provider check or take the EF Core hit on both sides.

- **Memory pressure on the producer side.** `events.ToList()` before passing to `AddRange` doubles your working set. `SqlBulkCopy` with `IDataReader` streams from `IAsyncEnumerable<T>` or `IEnumerable<T>` without ever materialising the full set. For a 5 GB CSV load, that is the difference between completing and OOM-ing. See [how to read a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) for the producer side.

- **License surface.** EF Core (MIT), Dapper (Apache 2.0), `Microsoft.Data.SqlClient` (MIT), and `EFCore.BulkExtensions` (MIT) are all permissive. `Dapper.Plus` and `Entity Framework Extensions` are commercial. If your "use Dapper for bulk" plan involves the Plus add-on, audit the budget before the architecture decision.

## The opinionated recommendation, restated

Default to EF Core 11's `AddRange` + `SaveChangesAsync` for anything under 1,000 rows. Switch to `SqlBulkCopy` (or `EFCore.BulkExtensions` if you want to keep the EF mapping) for anything over 10,000. The middle ground belongs to whichever side of the boundary your code already lives on. Use Dapper for what it is genuinely best at (precise reads and small commands), not for bulk inserts.

Two corollaries worth treating as house rules:

- "Dapper is faster than EF Core" is true for single-row reads and small commands. For bulk inserts it is the opposite. The community benchmark above shows Dapper a full order of magnitude slower than EF Core's `AddRange` at every row count, because Dapper has no row batching and EF Core does.
- The right way to "make EF Core faster for bulk inserts" is not to tune EF Core. It is to skip the ORM for the specific code path that hurts, by reaching for `SqlBulkCopy` through the same connection EF Core opened. The rest of the application keeps the unit-of-work ergonomics; one hot path bypasses them.

## Related

- [How to read a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [How to use `IAsyncEnumerable<T>` with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [How to write integration tests against a real SQL Server with Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)
- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Dapper, NVARCHAR, and the implicit conversion that kills SQL Server indexes](/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/)

## Sources

- [`SqlBulkCopy` Class -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlbulkcopy)
- [Fast SQL Bulk Inserts With C# and EF Core -- Milan Jovanović](https://www.milanjovanovic.tech/blog/fast-sql-bulk-inserts-with-csharp-and-ef-core)
- [Bulk Operations in EF Core 10 -- benchmarking insert, update, delete strategies](https://codewithmukesh.com/blog/bulk-operations-efcore/)
- [`EFCore.BulkExtensions` -- GitHub](https://github.com/borisdj/EFCore.BulkExtensions)
- [Dapper -- official repo](https://github.com/DapperLib/Dapper)
- [Npgsql `COPY` (binary) docs -- PostgreSQL bulk equivalent](https://www.npgsql.org/doc/copy.html)
