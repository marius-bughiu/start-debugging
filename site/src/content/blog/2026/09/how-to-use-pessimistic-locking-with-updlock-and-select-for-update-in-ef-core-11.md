---
title: "How to use pessimistic locking with UPDLOCK and SELECT ... FOR UPDATE in EF Core 11"
description: "EF Core 11 still has no lock API. Here is how to take a real row lock with FromSql: WITH (UPDLOCK, ROWLOCK) on SQL Server, FOR UPDATE on PostgreSQL, the subquery trap that silently widens the lock, NOWAIT and SKIP LOCKED, deadlock retries, and what to do when the row does not exist yet."
pubDate: 2026-09-06
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "sql-server"
  - "postgresql"
  - "dotnet-11"
  - "how-to"
---

Short answer: EF Core 11 has no pessimistic locking API, so you take the lock yourself with `FromSql` inside an explicit transaction. On SQL Server that is `SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {id}`; on PostgreSQL it is `SELECT * FROM "Orders" WHERE "Id" = {id} FOR UPDATE`. Two rules make it work and are almost always what people get wrong: the query must run inside a transaction you opened yourself (otherwise the lock is released the instant the reader finishes), and the `WHERE` clause must live inside the `FromSql` string, not in a LINQ `.Where()` chained after it.

This post covers the exact SQL EF Core emits for each shape, why composing LINQ over a locking query quietly widens the lock to the whole table, how `NOWAIT` and `SKIP LOCKED` change the failure mode, how to retry a deadlock without fighting the connection resiliency strategy, and the case nobody writes about: locking a row that does not exist yet.

A note on versions. EF Core 11 is in preview as of September 2026 and ships with .NET 11 in November 2026, per the [EF Core releases and planning page](https://learn.microsoft.com/en-us/ef/core/what-is-new/). EF11 requires the .NET 11 runtime. Because the only SDK on this machine is .NET 10.0.302, every piece of generated SQL below was produced with `ToQueryString()` on `Microsoft.EntityFrameworkCore.SqlServer` 10.0.10 and `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3. Nothing in this area changed in EF11: the [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) page lists no changes to `FromSql`, transactions, or locking.

## EF Core still has no lock API, and that is deliberate

The request has been open since September 2021 as [dotnet/efcore#26042, "Support SELECT FOR UPDATE / UPDLOCK (pessimistic concurrency)"](https://github.com/dotnet/efcore/issues/26042). It is labelled `needs-design` and sits in the Backlog milestone with no target release. EF Core 11 does not close it.

The reason a generic API is hard is visible in the rest of this post: SQL Server expresses the lock as a table hint attached to a table reference, PostgreSQL expresses it as a statement-level clause with four different strengths, and the two disagree about what happens with joins, `LIMIT`, and rows that do not exist. There is no shape that maps cleanly onto both. So you write the SQL.

The alternative, which you should reach for first, is a `rowversion` concurrency token. Pessimistic locking is the right tool only when the conflicting work happens inside a single short transaction on the server. If a human sits in the middle of the read-modify-write, use [a rowversion concurrency token in EF Core 11](/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) instead: you cannot hold a database transaction open across a user's coffee break.

## The setup, in four steps

1. **Open an explicit transaction.** `await using var tx = await context.Database.BeginTransactionAsync();`. Every row lock lives and dies with a transaction. Without one, EF Core wraps the read in its own implicit transaction that commits as soon as the reader drains, and the lock is gone microseconds later.
2. **Read the row through `FromSql`, with the filter inside the SQL string.** The locking syntax has to sit on the table reference that actually gets scanned.
3. **Mutate the tracked entity and call `SaveChangesAsync`.** `FromSql` results are tracked by default, exactly like any other LINQ query, so the update is generated for you.
4. **Commit.** The lock is released at commit or rollback, and not before.

Here is the SQL Server version end to end:

```csharp
// EF Core 11 (verified on EF Core 10.0.10), .NET 11, C# 14
await using var tx = await context.Database.BeginTransactionAsync();

var order = await context.Orders
    .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {orderId}")
    .SingleAsync();

order.Status = "Confirmed";
await context.SaveChangesAsync();

await tx.CommitAsync();
```

And the PostgreSQL version, which is the same code with a different string:

```csharp
// Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
await using var tx = await context.Database.BeginTransactionAsync();

var order = await context.Orders
    .FromSql($"""SELECT * FROM "Orders" WHERE "Id" = {orderId} FOR UPDATE""")
    .SingleAsync();

order.Status = "Confirmed";
await context.SaveChangesAsync();

await tx.CommitAsync();
```

`FromSql` interpolation is not string concatenation. The `{orderId}` hole becomes a `DbParameter`, which is why this is safe against injection. `ToQueryString()` confirms it:

```sql
-- SQL Server, from ToQueryString()
DECLARE p0 int = 42;

SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = @p0
```

One constraint from the [EF Core SQL queries documentation](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries): the result set must contain a column for every mapped property of the entity, with the mapped column names. `SELECT *` satisfies that. A hand-listed column set that forgets a property throws at materialization, which is the subject of [the required column was not present in the results of a FromSql operation](/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

## What UPDLOCK actually buys you on SQL Server

`UPDLOCK` takes update (U) locks instead of shared (S) locks, and, per the [table hints reference](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table), holds them until the transaction completes. That second half is the whole point. A plain `SELECT` under `READ COMMITTED` takes shared locks and drops them as soon as the row has been read, so two transactions can both read, both decide to write, and then deadlock while each tries to convert its S lock to an X lock. U locks are not compatible with each other, so the second reader blocks at the read instead of deadlocking at the write. That conversion deadlock is the classic symptom that sends people looking for this feature in the first place.

Three details worth internalising:

- **`ROWLOCK` is a granularity request, not a guarantee.** It asks for row locks where SQL Server would ordinarily take page or table locks. Add it so a scan of a few rows does not escalate into a page lock over rows you never touched. If `UPDLOCK` ends up combined with `TABLOCK` for any reason, the docs say you get an exclusive table lock instead, which is rarely what you wanted.
- **`UPDLOCK` alone does not stop inserts.** It locks the rows that exist. If your logic is "sum the lines for this order, then insert one more", another transaction can insert a line that changes the sum. Add `HOLDLOCK`, which the docs describe as equivalent to `SERIALIZABLE`, to get key-range locks over the predicate for the duration of the transaction: `WITH (UPDLOCK, HOLDLOCK, ROWLOCK)`.
- **Locks may land on index keys, not data rows.** The Remarks section is explicit: if a covering nonclustered index answers the query, the lock is taken on the index key. Usually invisible, occasionally the reason two queries you thought were disjoint block each other.

Also note the deprecation: table hints without the `WITH` keyword still parse, but Microsoft has flagged that form for removal. Write `WITH (UPDLOCK, ROWLOCK)`, with commas between hints, not `(UPDLOCK ROWLOCK)`.

## PostgreSQL has four lock strengths, and FOR UPDATE is the strongest

The [SELECT locking clause documentation](https://www.postgresql.org/docs/current/sql-select.html) defines `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, and `FOR KEY SHARE`, in descending strength. `FOR UPDATE` blocks every other locker plus `UPDATE` and `DELETE`. `FOR NO KEY UPDATE` is what a plain `UPDATE` that does not touch a key column takes on its own, and it is the right choice when you are only changing non-key columns and do not want to block foreign-key checks from child tables, which take `FOR KEY SHARE`.

The pattern that catches people is `FOR UPDATE` combined with `Include`. PostgreSQL refuses to lock the nullable side of an outer join: "FOR UPDATE cannot be applied to the nullable side of an outer join". The fix is `FOR UPDATE OF "Orders"`, naming only the table you actually want locked. In EF Core this problem mostly solves itself, because `Include` composes over your `FromSql` as a subquery and the join lands outside it:

```sql
-- Npgsql, FromSql with FOR UPDATE plus .Include(o => o.Lines)
SELECT o."Id", o."Status", o."Total", o0."Id", o0."OrderId", o0."Quantity"
FROM (
    SELECT * FROM "Orders" WHERE "Id" = @p0 FOR UPDATE
) AS o
LEFT JOIN "OrderLines" AS o0 ON o."Id" = o0."OrderId"
ORDER BY o."Id"
```

The `Orders` row is locked, the `OrderLines` rows are not. If you need the lines locked too, lock them in a second `FromSql` against `OrderLines`, in a consistent order.

## The subquery trap that silently widens your lock

This is the failure mode I would bet money on seeing in production code. `FromSql` composes: any LINQ operator you chain after it turns your SQL into a derived table. Move the filter out of the string and into `.Where()`, and here is what EF Core generates:

```sql
-- Npgsql: .FromSql($"""SELECT * FROM "Orders" FOR UPDATE""").Where(o => o.Status == "Pending")
SELECT o."Id", o."Status", o."Total"
FROM (
    SELECT * FROM "Orders" FOR UPDATE
) AS o
WHERE o."Status" = 'Pending'
```

The `FOR UPDATE` is now attached to an unfiltered scan of `Orders`. PostgreSQL will not push the outer predicate down into a sub-select carrying a locking clause, because doing so would change which rows get locked. The documentation makes the same point in its `ORDER BY` workaround: `SELECT * FROM (SELECT * FROM mytable FOR UPDATE) ss ORDER BY column1` "locks all rows". So this query locks every row in the table and blocks every other writer, and it does it without an error, a warning, or anything in the query plan that looks obviously wrong.

SQL Server produces the same shape and a subtler problem:

```sql
-- SQL Server: .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK)").Where(o => o.Status == "Pending")
SELECT [o].[Id], [o].[Status], [o].[Total]
FROM (
    SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK)
) AS [o]
WHERE [o].[Status] = N'Pending'
```

A derived table is not an optimization fence in T-SQL, so the optimizer may or may not push the predicate into it. Which rows end up locked becomes a property of the chosen plan rather than of your code. That is not a bug you want to debug at 3am.

The rule: everything that narrows the row set goes inside the `FromSql` string. Chain LINQ after it only for things that cannot widen the lock, such as `Include` or a projection. And verify it once, either with `ToQueryString()` in a test or by [logging the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## NOWAIT and SKIP LOCKED: choosing your failure

By default a blocked lock request waits. Both databases give you two alternatives.

**Fail fast.** PostgreSQL's `FOR UPDATE NOWAIT` raises SQLSTATE `55P03` (`lock_not_available`) immediately rather than waiting. SQL Server's `NOWAIT` table hint is documented as equivalent to `SET LOCK_TIMEOUT 0` for that table, and surfaces as error 1222, "Lock request time out period exceeded". Either way you get an exception you can translate into a 409 instead of a request that sits on a thread for thirty seconds:

```csharp
// Npgsql: fail immediately rather than queue behind another worker
try
{
    var order = await context.Orders
        .FromSql($"""SELECT * FROM "Orders" WHERE "Id" = {orderId} FOR UPDATE NOWAIT""")
        .SingleAsync();
}
catch (PostgresException ex) when (ex.SqlState == "55P03")
{
    return Results.Conflict("Order is being modified by another request.");
}
```

**Skip the contended rows.** This is the job queue pattern, and it is the one case where pessimistic locking is unambiguously the right design. PostgreSQL spells it `SKIP LOCKED`; SQL Server spells it `READPAST`, which the docs describe as built precisely "to reduce locking contention when implementing a work queue that uses a SQL Server table".

```csharp
// SQL Server: claim up to 10 unclaimed jobs, skipping rows other workers hold
await using var tx = await context.Database.BeginTransactionAsync();

var jobs = await context.Jobs
    .FromSql($"""
        SELECT TOP (10) * FROM [Jobs] WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE [Status] = 'Queued' ORDER BY [Id]
        """)
    .ToListAsync();

foreach (var job in jobs)
{
    job.Status = "Running";
}

await context.SaveChangesAsync();
await tx.CommitAsync();
```

Two constraints on `READPAST`. It skips row-level locks but not page-level locks, which is another reason to pair it with `ROWLOCK`. And it cannot be used when `READ_COMMITTED_SNAPSHOT` is `ON` and the session isolation level is `READ COMMITTED`; in that configuration you have to add the `READCOMMITTEDLOCK` hint. On PostgreSQL, `SKIP LOCKED` gives you a deliberately inconsistent view, which is fine for a queue and wrong for anything you plan to aggregate.

## Deadlocks still happen, so retry

Pessimistic locking converts most write conflicts into waiting, but it does not eliminate deadlocks: two transactions that lock rows A then B and B then A will still deadlock (SQL Server error 1205, PostgreSQL SQLSTATE `40P01`). The cheap structural fix is to always acquire locks in a deterministic order, which usually means sorting by primary key before you start locking.

For the rest, retry. If you have enabled `EnableRetryOnFailure`, note that the retrying execution strategy refuses to wrap a transaction you opened yourself and throws `InvalidOperationException`. The whole unit of work has to go through the strategy, which is covered in detail in [the execution strategy does not support user-initiated transactions](/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/):

```csharp
var strategy = context.Database.CreateExecutionStrategy();

await strategy.ExecuteAsync(async () =>
{
    await using var tx = await context.Database.BeginTransactionAsync();

    var order = await context.Orders
        .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {orderId}")
        .SingleAsync();

    order.Status = "Confirmed";
    await context.SaveChangesAsync();
    await tx.CommitAsync();
});
```

One caveat: EF's default `SqlServerRetryingExecutionStrategy` retries a specific list of transient SQL Server error numbers. Verify that deadlocks are in the set you care about, or supply your own `errorNumbersToAdd`, rather than assuming 1205 is handled.

## You cannot lock a row that does not exist

The single biggest limitation. `SELECT ... FOR UPDATE` on a row that has not been inserted returns zero rows and locks nothing, so the classic "check whether this username is taken, then insert it" race is completely unprotected by row locks. Two transactions both see nothing, both insert, and one of them gets a unique-constraint violation, which is exactly the scenario in [fix 23505 duplicate key value violates unique constraint on a concurrent EF Core insert](/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/).

Three ways out, in increasing order of how much you should like them:

- **A unique index plus a caught exception.** The database enforces it, you translate the provider exception into a domain error. Boring, correct, and the default answer.
- **A predicate lock.** On SQL Server, `WITH (UPDLOCK, HOLDLOCK)` over the `WHERE` that would have matched takes a key-range lock and does block the competing insert. PostgreSQL has no direct equivalent short of `SERIALIZABLE` isolation.
- **An advisory lock keyed on the value.** PostgreSQL's `pg_advisory_xact_lock(key)` takes a lock on an arbitrary 64-bit number that is released automatically at the end of the transaction (unlike `pg_advisory_lock`, which is session-scoped and survives a rollback). SQL Server's equivalent is `sys.sp_getapplock` with `@LockOwner = 'Transaction'` and a string resource name, returning `0` or `1` on success and `-1` for timeout, `-3` for deadlock victim.

```csharp
// PostgreSQL: serialise on a logical key rather than a row
await using var tx = await context.Database.BeginTransactionAsync();
await context.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock({tenantId})");
// ... read, decide, insert ...
await tx.CommitAsync();
```

Advisory locks are the right tool when the thing you are serialising is a decision rather than a row: "only one worker may run the nightly rollup for this tenant".

## When to reach for something else entirely

If the entire operation is a single arithmetic update, do not lock at all. `UPDATE Accounts SET Balance = Balance - 10 WHERE Id = 1 AND Balance >= 10` is atomic, takes its own exclusive lock for the duration of the statement, and tells you via the affected-row count whether the precondition held. In EF Core that is `ExecuteUpdateAsync`, and the tradeoffs against loading the entity are covered in [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/). A pessimistic lock only earns its keep when there is real logic between the read and the write that SQL cannot express.

And keep the transaction short. Everything you do between `BeginTransactionAsync` and `CommitAsync` is time that other requests spend blocked. An HTTP call to a payment provider inside a lock-holding transaction is how a single slow dependency takes down a whole table.

### Read next

- [How to implement optimistic concurrency with a rowversion token in EF Core 11](/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Fix: the execution strategy does not support user-initiated transactions](/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Fix: the required column was not present in the results of a FromSql operation in EF Core 11](/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [How to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [ExecuteUpdate vs loading entities and SaveChanges in EF Core](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)

## Sources

- [Support SELECT FOR UPDATE / UPDLOCK (pessimistic concurrency), dotnet/efcore#26042](https://github.com/dotnet/efcore/issues/26042), open since 2021 and still in the Backlog milestone.
- [Table hints (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table) for `UPDLOCK`, `HOLDLOCK`, `ROWLOCK`, `READPAST`, `NOWAIT`, the `WITH` keyword deprecation, and index-key locking.
- [SELECT, The Locking Clause](https://www.postgresql.org/docs/current/sql-select.html) for the four lock strengths, `NOWAIT`, `SKIP LOCKED`, the `OF table` list, and the sub-select locking note.
- [Explicit locking, PostgreSQL documentation](https://www.postgresql.org/docs/current/explicit-locking.html) for the row-lock conflict matrix and transaction-scoped advisory locks.
- [SQL queries in EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries) for `FromSql` parameterization, composability, subquery wrapping, and change tracking.
- [sys.sp_getapplock (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-getapplock-transact-sql) for lock modes, transaction versus session ownership, and return codes.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), which confirms EF11 requires the .NET 11 runtime and lists no locking or `FromSql` changes.
