---
title: "Fix: 23505: duplicate key value violates unique constraint on a concurrent EF Core insert"
description: "The check-then-insert in your handler is not atomic. Catch PostgresException with SqlState 23505, or collapse the whole thing into one INSERT ... ON CONFLICT statement. EnableRetryOnFailure will not help."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "postgresql"
  - "npgsql"
  - "concurrency"
  - "dotnet-11"
---

Your handler reads "does this email already exist?", sees nothing, and inserts. Under load two requests do that at the same time, both see nothing, and Postgres rejects the loser at the index with `23505`. The unique index is not the bug, it is the only thing that caught the bug. Fix it one of two ways: collapse the read and the write into a single `INSERT ... ON CONFLICT` statement so there is no window between them, or keep the naive insert and catch `DbUpdateException` whose inner exception is a `PostgresException` with `SqlState == PostgresErrorCodes.UniqueViolation`, then re-read the row the winner wrote. Do not reach for `EnableRetryOnFailure`: Npgsql's transient detector returns `false` for `23505`, so the resiliency layer will pass the exception straight through to you.

A note on verification. The only SDK on this machine is .NET 10.0.302, and there is no Postgres server on it, so everything below was checked against `Npgsql` 10.0.3, `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 and `Microsoft.EntityFrameworkCore` 10.0.4 offline (constant values, the transient-exception detector, generated SQL, change-tracker state), plus the PostgreSQL 18 documentation for the server-side behaviour. The Npgsql provider 11.0 is still in preview as of this writing and its [11.0 release notes](https://www.npgsql.org/efcore/release-notes/11.0.html) list no changes to error mapping, `SaveChanges` batching, or the retry detector, so all of it applies to EF Core 11 and provider 11.0 as well. Where a claim comes from the server documentation rather than a run on this machine, I say so.

## The error in context

```text
Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes. See the inner exception for details.
 ---> Npgsql.PostgresException (0x80004005): 23505: duplicate key value violates unique constraint "IX_Users_Email"

DETAIL: Key ("Email")=(ada@example.com) already exists.
   at Npgsql.Internal.NpgsqlConnector.ReadMessageLong(...)
   at Npgsql.NpgsqlDataReader.NextResult(...)
   at Microsoft.EntityFrameworkCore.Update.Internal.BatchExecutor.ExecuteAsync(...)
   at Microsoft.EntityFrameworkCore.Storage.RelationalDatabase.SaveChangesAsync(...)
```

Two things in that block are worth reading carefully.

The constraint name tells you which failure you have. `IX_Users_Email` is a unique index you declared, so this is an application-level race. If it says `PK_Users` instead, you almost certainly have a drifted identity sequence, which is a completely different problem and is covered below.

The `DETAIL:` line may be missing entirely. Npgsql's `Include Error Detail` connection-string parameter defaults to `false` (verified: `new NpgsqlConnectionStringBuilder("Host=h;Database=d").IncludeErrorDetail` returns `False` on Npgsql 10.0.3), because the detail text contains the offending key value and that is frequently personal data. Add `Include Error Detail=true` in development if you want the value, and leave it off in production unless you are comfortable with keys landing in your logs.

## Why this happens

The dominant cause, and the one that matches "it only happens under load", is that a check followed by an insert is two statements with a gap between them. Nothing in a `READ COMMITTED` transaction stops another session from inserting into that gap. The PostgreSQL documentation on [index uniqueness checks](https://www.postgresql.org/docs/current/index-unique-checks.html) describes what the server does when the other session has not committed yet: "If a conflicting row has been inserted by an as-yet-uncommitted transaction, the would-be inserter must wait to see if that transaction commits." If it rolls back there is no conflict and your insert proceeds; if it commits, you get `23505`. That is why the error is bursty and why it never reproduces on a developer laptop with one request in flight.

Two other causes produce the same SQLSTATE and are worth ruling out before you write any concurrency code:

- **A drifted sequence.** After a `pg_restore`, a `COPY`, or a data import that supplied explicit primary keys, the identity sequence still points at 1 while the table already holds rows up to 40,000. Every insert then collides on `PK_<Table>`. The fix is `SELECT setval(pg_get_serial_sequence('"Users"', 'Id'), (SELECT MAX("Id") FROM "Users"));`, not a retry loop.
- **Retrying `SaveChanges` on the same `DbContext`.** A failed `SaveChangesAsync` does not detach anything. I checked this directly: after the exception, `ChangeTracker.Entries()` still reports the offending entity in state `Added`, `DbUpdateException.Entries` has exactly one entry, and calling `SaveChangesAsync` again on that same context throws the identical exception. Any retry has to start from a fresh context.

## Minimal repro

```csharp
// .NET SDK 10.0.302, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class User
{
    public int Id { get; set; }
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
}

protected override void OnModelCreating(ModelBuilder mb)
    => mb.Entity<User>().HasIndex(u => u.Email).IsUnique();
```

That model produces exactly this DDL from the Npgsql provider (`db.Database.GenerateCreateScript()`, run offline):

```sql
CREATE TABLE "Users" (
    "Id" integer GENERATED BY DEFAULT AS IDENTITY,
    "Email" text NOT NULL,
    "Name" text NOT NULL,
    CONSTRAINT "PK_Users" PRIMARY KEY ("Id")
);

CREATE UNIQUE INDEX "IX_Users_Email" ON "Users" ("Email");
```

And here is the handler that loses the race:

```csharp
// Racy: the gap between AnyAsync and SaveChangesAsync is unguarded.
public async Task<User> RegisterAsync(string email, string name, CancellationToken ct)
{
    if (await db.Users.AnyAsync(u => u.Email == email, ct))
        throw new EmailTakenException(email);

    var user = new User { Email = email, Name = name };
    db.Users.Add(user);
    await db.SaveChangesAsync(ct);   // 23505 when a second request got here first
    return user;
}
```

Wrapping those three statements in a transaction does not help. A transaction gives you atomicity, not mutual exclusion, and `READ COMMITTED` is the default. Raising the isolation level does not help either: it changes the SQLSTATE you get in some scenarios but does not make the conflict disappear. PostgreSQL's [serialization failure handling](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html) page addresses this pattern head-on, noting that a unique-key failure after inspecting the currently stored keys "is effectively a serialization failure, but the server will not detect it as such because it cannot see the connection between the inserted value and the previous reads."

## Fix 1: one statement, with ON CONFLICT

This is the fix to reach for first. `INSERT ... ON CONFLICT` is a single statement, so there is no window for anyone to insert into, and the conflict resolution happens inside the server's index insertion path.

The subtlety is getting the row back. `ON CONFLICT DO NOTHING` returns nothing on conflict: the [INSERT documentation](https://www.postgresql.org/docs/current/sql-insert.html) states that only successfully inserted or updated rows are returned by `RETURNING`. So a get-or-create that must know the id uses `DO UPDATE` with a self-assignment, which touches the row and therefore makes it eligible for `RETURNING`:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3. Same code compiles unchanged on EF Core 11.
public async Task<int> GetOrCreateUserIdAsync(string email, string name, CancellationToken ct)
{
    var ids = await db.Database.SqlQuery<int>($"""
        INSERT INTO "Users" ("Email", "Name")
        VALUES ({email}, {name})
        ON CONFLICT ("Email") DO UPDATE SET "Email" = EXCLUDED."Email"
        RETURNING "Id" AS "Value"
        """).ToListAsync(ct);

    return ids.Single();
}
```

Four details in that snippet are load-bearing:

1. **`AS "Value"`.** `SqlQuery<T>` for a scalar type reads a column named `Value`. Without the alias you get a runtime failure about a missing column, not a compile error.
2. **The interpolated holes are parameters, not concatenation.** `ToQueryString()` on that query emits `VALUES (@p0, @p1)` with the values reported separately, so the usual injection concern does not apply here.
3. **`ToListAsync`, never `FirstOrDefaultAsync`.** EF Core inspects the raw SQL and refuses to compose over a statement that is not a `SELECT`. Adding any LINQ operator throws `InvalidOperationException: 'FromSql' or 'SqlQuery' was called with non-composable SQL and with a query composing over it.` I hit this exactly, on `NpgsqlQuerySqlGenerator`, while checking the generated SQL. Materialise the list first, then pick.
4. **`EXCLUDED` is the proposed row.** `SET "Email" = EXCLUDED."Email"` is a deliberate no-op write whose only purpose is to make the conflicting row eligible for `RETURNING`.

If you genuinely do not need the id back, prefer `ON CONFLICT ("Email") DO NOTHING` and skip the write amplification. The self-assignment version writes a new row version, bumps `xmax`, and fires any `BEFORE UPDATE` triggers on every duplicate attempt.

One more constraint the docs are explicit about: `ON CONFLICT DO UPDATE` will not touch the same existing row twice within one statement, and raises a cardinality violation (`21000`) if your `VALUES` list contains the same key twice. Deduplicate the batch in C# before you send it.

## Fix 2: insert optimistically, catch 23505, re-read

When the insert is buried in a larger unit of work and rewriting it as raw SQL is impractical, let the index be your lock and handle the loss:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3
public async Task<User> RegisterAsync(string email, string name, CancellationToken ct)
{
    var user = new User { Email = email, Name = name };
    db.Users.Add(user);

    try
    {
        await db.SaveChangesAsync(ct);
        return user;
    }
    catch (DbUpdateException ex)
        when (ex.InnerException is PostgresException
              {
                  SqlState: PostgresErrorCodes.UniqueViolation,
                  ConstraintName: "IX_Users_Email"
              })
    {
        // Someone else won. This context is poisoned: the entity is still Added.
        await using var fresh = await factory.CreateDbContextAsync(ct);
        return await fresh.Users.SingleAsync(u => u.Email == email, ct);
    }
}
```

`PostgresErrorCodes.UniqueViolation` is the string `"23505"` (verified against Npgsql 10.0.3), and using the constant beats a magic string. Filter on `ConstraintName` too. A bare `SqlState: "23505"` catch block will happily swallow a primary-key collision caused by a drifted sequence and turn a data-corruption signal into a silent, wrong answer.

The fresh context matters, and it is why this pattern pairs with `IDbContextFactory<T>` rather than a scoped `DbContext`. If you inject the scoped context and retry on it, you re-send the same `Added` entity and get the same exception, which is the behaviour I confirmed on the change tracker above. The same applies if you are [resolving a DbContext from a singleton service](/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/).

## Why EnableRetryOnFailure does nothing here

This trips up people who already added connection resiliency and assume it covers the case. It does not. I invoked the provider's own detector directly through reflection on `Npgsql.EntityFrameworkCore.PostgreSQL.Storage.Internal.NpgsqlTransientExceptionDetector` from provider 10.0.3:

```text
ShouldRetryOn(23505) = False     unique_violation
ShouldRetryOn(23503) = False     foreign_key_violation
ShouldRetryOn(40001) = True      serialization_failure
ShouldRetryOn(40P01) = True      deadlock_detected
ShouldRetryOn(53300) = True      too_many_connections
ShouldRetryOn(57P03) = True      cannot_connect_now
ShouldRetryOn(08006) = True      connection_failure
```

`PostgresException.IsTransient` agrees: `False` for `23505`, `True` for `40001` and `40P01`. That classification is correct. A blind retry of a genuine duplicate would just fail again, forever. It does mean the retry has to be yours, at the level where you can decide what a duplicate means for this operation. If you do add your own execution strategy around a manual transaction, be aware of the [execution strategy does not support user-initiated transactions](/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/) error you will meet on the way.

## Fix 3: an advisory lock, when the get-or-create spans several statements

Sometimes the operation genuinely cannot be one statement: you need to create a tenant, then a schema row, then a default settings row, and only one caller may do it. Serialize on a key rather than on the table:

```csharp
// EF Core 10.0.4 / Npgsql 10.0.3
await using var tx = await db.Database.BeginTransactionAsync(ct);

// Held until the transaction commits or rolls back. No explicit unlock.
await db.Database.ExecuteSqlAsync(
    $"SELECT pg_advisory_xact_lock(hashtext({email}))", ct);

var existing = await db.Users.SingleOrDefaultAsync(u => u.Email == email, ct);
if (existing is not null) { await tx.CommitAsync(ct); return existing; }

db.Users.Add(new User { Email = email, Name = name });
await db.SaveChangesAsync(ct);
await tx.CommitAsync(ct);
```

`pg_advisory_xact_lock` is released automatically at the end of the transaction, which is the property you want: no `finally` block can leak it. Two caveats. `hashtext` returns a 32-bit value, so distinct keys can collide and needlessly serialize with each other, which is a performance issue and never a correctness one. And this only works if every writer takes the lock. Keep the unique index in place regardless: it is the backstop for the code path that forgets.

## Variants that look the same but are not

**The insert succeeds alone and fails in a batch.** EF Core batches multiple pending inserts into one round trip inside one transaction, so a single duplicate anywhere in the batch rolls back every row you added. `DbUpdateException.Entries` tells you which entity the server rejected; the rest are untouched but also unsaved. If you are inserting thousands of rows, this is one of the reasons to reach for a different write path, which I measured in [EF Core 11 vs Dapper for bulk inserts](/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

**Ids keep skipping after every failure.** Expected, and not fixable. The [sequence functions documentation](https://www.postgresql.org/docs/current/functions-sequence.html) is unambiguous: "the value obtained by `nextval` is not reclaimed for re-use if the calling transaction later aborts." It also calls out `ON CONFLICT` specifically, because the tuple including its `nextval` call is computed before the conflict is detected. Every duplicate attempt burns an id. If your keys are user-visible and gaps are unacceptable, the answer is a different key strategy, not a gapless sequence; see [generating a primary key from a database sequence](/2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11/).

**Duplicates on a nullable column that you thought were impossible.** A standard unique index treats `NULL` values as distinct, so any number of rows can have `NULL` there. If you actually want at most one, PostgreSQL 15 and later supports `CREATE UNIQUE INDEX ... ON "Users" ("ExternalId") NULLS NOT DISTINCT`. Note that the Npgsql provider 11.0 raises its default minimum target to PostgreSQL 16, so this is available on any server the current provider targets by default.

**`ON CONFLICT` fails with "there is no unique or exclusion constraint matching the ON CONFLICT specification".** The conflict target is an index inference, not a column list. If your unique index is partial (`WHERE "DeletedAt" IS NULL`), you must repeat the predicate: `ON CONFLICT ("Email") WHERE "DeletedAt" IS NULL DO NOTHING`. Alternatively name the constraint directly with `ON CONFLICT ON CONSTRAINT "IX_Users_Email"`, which sidesteps inference entirely.

**This is a concurrent update, not a concurrent insert.** If two callers are modifying an existing row rather than creating one, `23505` is the wrong tool and you want a concurrency token instead. That is a different mechanism with a different exception, covered in [optimistic concurrency with a rowversion token](/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

## Proving it in a test

A race that only appears under production load is a race you cannot regression-test with a single-threaded in-memory provider. You need a real server and two connections. Spin up a Postgres container, resolve two contexts from `IDbContextFactory<T>`, and fire both inserts at the same `TaskCompletionSource` gate so they contend on the index at the same instant. If the handler is correct, both tasks return the same id and neither throws. The trade-offs of that setup versus a faked backing store are laid out in [WebApplicationFactory vs Testcontainers](/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/).

The habit worth forming is smaller than any of this code. When you catch a `DbUpdateException`, look at `SqlState` and `ConstraintName` before you decide what it means. `23505` on a unique index you designed is your data model doing its job and telling you a caller lost a race. `23505` on a primary key is usually the database telling you something is wrong with the table itself.

## Related

- [How to implement optimistic concurrency with a rowversion token in EF Core 11](/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [How to generate a primary key from a database sequence on insert in EF Core 11](/2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11/)
- [Fix: The configured execution strategy does not support user-initiated transactions](/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [How to use IDbContextFactory from a singleton service in Blazor](/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/)
- [EF Core 11 vs Dapper for bulk inserts: a real benchmark](/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)

## Sources

- [PostgreSQL 18: Index Uniqueness Checks](https://www.postgresql.org/docs/current/index-unique-checks.html)
- [PostgreSQL 18: Serialization Failure Handling](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html)
- [PostgreSQL 18: INSERT, including ON CONFLICT and unique index inference](https://www.postgresql.org/docs/current/sql-insert.html)
- [PostgreSQL 18: Sequence Manipulation Functions](https://www.postgresql.org/docs/current/functions-sequence.html)
- [PostgreSQL Error Codes: Class 23 Integrity Constraint Violation](https://www.postgresql.org/docs/current/errcodes-appendix.html)
- [Npgsql EF Core Provider 11.0 release notes](https://www.npgsql.org/efcore/release-notes/11.0.html)
- [EF Core: Connection resiliency](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency)
