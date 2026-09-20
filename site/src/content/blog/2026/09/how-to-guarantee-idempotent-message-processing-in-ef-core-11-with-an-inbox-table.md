---
title: "How to guarantee idempotent message processing with EF Core 11 when two app instances consume the same message"
description: "The existence check in your handler is not the guard you think it is. Put a unique index on the inbox table, write the marker in the same SaveChanges as the business change, and let the database pick the winner. Plus the ExecuteUpdate trap that quietly undoes all of it."
pubDate: 2026-09-20
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "messaging"
  - "idempotency"
  - "sql-server"
  - "postgresql"
  - "dotnet-11"
  - "how-to"
---

Short answer: stop trusting `if (await db.Inbox.AnyAsync(...)) return;`. Two instances can both run that check before either one commits, and both will process the message. Instead, give the inbox table a unique index on the deduplication key, add the marker row to the change tracker alongside the business change, and let a single `SaveChangesAsync` commit both or neither. The instance that loses the race gets a `DbUpdateException` whose inner exception is a unique violation, which means "someone else already did this", so it acknowledges the message and returns. The database, not your `if`, is what makes the handler idempotent.

This post covers the race in detail, the four-step fix with the SQL EF Core 11 actually emits, how to tell a duplicate message apart from a genuine constraint violation, the two-phase variant for side effects that cannot join a database transaction, and the three mistakes that silently disable the whole thing.

A note on versions and verification. EF Core 11 requires the .NET 11 runtime and ships with .NET 11 in November 2026, per the [EF Core releases page](https://learn.microsoft.com/en-us/ef/core/what-is-new/). Everything below was run on `Microsoft.EntityFrameworkCore` 11.0.0-rc.1.26425.128 on the .NET 11 RC 1 SDK. There is no SQL Server or PostgreSQL on this machine, so the concurrency runs are against the SQLite provider with two connections to the same database file, and the SQL Server output was produced offline with `GenerateCreateScript()` and a connection-suppressing interceptor. Where a claim depends on server-side behaviour I could not execute, I say so and cite the vendor documentation instead.

## Why the existence check is not a guard

At-least-once is the delivery guarantee you get from Azure Service Bus, RabbitMQ, Kafka, and SQS. Microsoft's [Idempotent Consumer pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer) page lists three ways a duplicate reaches you: the producer retried a send whose acknowledgement was lost, the broker redelivered after your lock expired, or your process crashed between the database write and the acknowledgement.

None of those are exotic. A pod restart during a rolling deploy produces the last two on its own. And because you run more than one replica, the redelivery does not go back to the same instance; it goes to whichever consumer is free, which may be running the original copy at that very moment.

Here is the handler almost everyone writes first:

```csharp
// EF Core 11.0.0-rc.1, .NET 11. This is the version that does not work.
public async Task Handle(CreditRequested msg, CancellationToken ct)
{
    if (await db.Inbox.AnyAsync(m => m.MessageId == msg.MessageId && m.Consumer == "credit", ct))
        return;

    db.Credits.Add(new Credit { Amount = msg.Amount });
    db.Inbox.Add(new InboxMessage
    {
        MessageId = msg.MessageId,
        Consumer = "credit",
        ReceivedUtc = DateTime.UtcNow
    });

    await db.SaveChangesAsync(ct);
}
```

Two instances, one message id, a 50 ms gap between the check and the save, and the inbox table carrying a plain non-unique index:

```text
### 1. check-then-insert, no unique index, two concurrent consumers
  B: committed
  A: committed
  credits applied = 2, total = 200.0
  inbox rows = 2
```

Both readers saw an empty inbox, both wrote a marker, both credited the account. The marker table is now actively lying: it says the message was processed, twice.

## The fix, in four steps

1. Give the inbox table a unique index on the message id plus the consumer identity, so the database can reject the second writer.
2. Add the marker row and the business change to the same `DbContext` and commit them with a single `SaveChangesAsync`, so they land together or not at all.
3. Catch the `DbUpdateException` whose inner exception is a unique violation on that specific index, and treat it as "another instance already processed this message".
4. Acknowledge the message on both the commit path and the caught-duplicate path, and abandon it only on an unhandled exception.

### 1. Give the inbox table a unique index on the deduplication key

The key is the message identity plus the consumer identity. The consumer part matters when several independent handlers subscribe to the same channel: keyed on the message alone, the first handler to record a marker suppresses every other handler.

```csharp
// EF Core 11.0.0-rc.1
public class InboxMessage
{
    public long Id { get; set; }               // surrogate, keeps the clustered index sequential
    public Guid MessageId { get; set; }
    public string Consumer { get; set; }
    public DateTime ReceivedUtc { get; set; }
    public DateTime? ProcessedUtc { get; set; }
}

protected override void OnModelCreating(ModelBuilder b)
{
    var inbox = b.Entity<InboxMessage>();
    inbox.HasKey(m => m.Id);
    inbox.Property(m => m.Consumer).HasMaxLength(200).IsRequired();
    inbox.HasIndex(m => new { m.MessageId, m.Consumer }).IsUnique();
}
```

`GenerateCreateScript()` on the SQL Server provider gives this:

```sql
CREATE TABLE [Inbox] (
    [Id] bigint NOT NULL IDENTITY,
    [MessageId] uniqueidentifier NOT NULL,
    [Consumer] nvarchar(200) NOT NULL,
    [ReceivedUtc] datetime2 NOT NULL,
    [ProcessedUtc] datetime2 NULL,
    CONSTRAINT [PK_Inbox] PRIMARY KEY ([Id])
);
CREATE UNIQUE INDEX [IX_Inbox_MessageId_Consumer] ON [Inbox] ([MessageId], [Consumer]);
```

Resist the urge to make `MessageId` the primary key. On SQL Server the primary key is clustered by default, and a clustered index on a random `uniqueidentifier` fragments the table on every insert. A `bigint IDENTITY` key with the uniqueness enforced by a separate nonclustered index keeps inserts appending at the end of the clustered index instead of splitting pages all over it. This is exactly the shape [MassTransit](https://masstransit.massient.com/documentation/configuration/middleware/outbox) uses for its own `InboxState` entity: a `long Id` described in the source as the "Primary key for table, to have ordered clustered index", with the deduplication pair declared through `HasAlternateKey(p => new { p.MessageId, p.ConsumerId })`.

### 2. Write the marker in the same SaveChanges as the business change

Not before it, not after it. The [EF Core transactions documentation](https://learn.microsoft.com/en-us/ef/core/saving/transactions) is explicit that every change in one `SaveChanges` call goes into one transaction, and that a single failure rolls all of them back, so the call either succeeds completely or leaves the database untouched.

I checked that with a `DbTransactionInterceptor`. One `SaveChangesAsync` that updates an account and inserts the marker produces `BEGIN, COMMIT` around this pair of statements on SQLite:

```sql
UPDATE "Accounts" SET "Balance" = @p0
WHERE "Id" = @p1
RETURNING 1;

INSERT INTO "Inbox" ("Consumer", "MessageId", "ProcessedUtc", "ReceivedUtc")
VALUES (@p0, @p1, @p2, @p3)
RETURNING "Id";
```

On SQL Server the same save sends:

```sql
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
INSERT INTO [Inbox] ([Consumer], [MessageId], [ProcessedUtc], [ReceivedUtc])
OUTPUT INSERTED.[Id]
VALUES (@p0, @p1, @p2, @p3);
```

To prove the all-or-nothing part rather than assume it, I put a doomed insert in the same save. The marker never landed:

```text
### 3. marker + business write in one SaveChanges: all or nothing
  SaveChanges threw SqliteException
  inbox rows after failure = 0 (marker rolled back with the business write)
```

One caveat worth knowing: the default `AutoTransactionBehavior.WhenNeeded` means EF only opens an explicit transaction when a save needs more than one statement. That is the right default, but it means the atomicity you are relying on comes from EF deciding a transaction is needed. If you set `AutoTransactionBehavior.Never`, the documentation warns that a mid-save failure can leave earlier commands committed and the database in a partial state. Do not set it on a message handler.

### 3. Catch the unique violation and treat it as "already processed"

Keep the cheap existence check at the top. It is a fast path for the common case where the redelivery arrives minutes later, and it saves a rolled-back transaction. It is just not the correctness guarantee. The guarantee is the catch block:

```csharp
// EF Core 11.0.0-rc.1, SQL Server + PostgreSQL
try
{
    await db.SaveChangesAsync(ct);
}
catch (DbUpdateException ex) when (IsInboxDuplicate(ex))
{
    // another instance committed this message first; its transaction already
    // applied the business change, so there is nothing left to do
    return;
}

static bool IsInboxDuplicate(DbUpdateException ex) => ex.InnerException switch
{
    SqlException s => (s.Number == 2601 || s.Number == 2627)
                      && s.Message.Contains("IX_Inbox_MessageId_Consumer", StringComparison.Ordinal),
    PostgresException p => p.SqlState == PostgresErrorCodes.UniqueViolation
                           && p.ConstraintName == "IX_Inbox_MessageId_Consumer",
    _ => false
};
```

Running the corrected handler against the same two-instance race:

```text
### 2. same handler, unique index on (MessageId, Consumer)
  A: committed
  B: DbUpdateException / SqliteException code=19 ext=2067
         inner message: SQLite Error 19: 'UNIQUE constraint failed: Inbox.MessageId, Inbox.Consumer'.
  credits applied = 1, total = 100.0
  inbox rows = 1
```

One credit, one marker, and the loser found out cleanly.

### 4. Acknowledge the message on both paths

Both the commit and the caught duplicate are terminal outcomes: complete the message. Only an unhandled exception should abandon it so the broker redelivers. Getting this backwards, abandoning on the duplicate, produces a message that ping-pongs until it dead-letters.

## What the database does while both instances are inserting

The interesting case is not the one my SQLite run shows, where the loser fails immediately. It is the one where the two inserts overlap: instance A has inserted the marker but has not committed, and instance B tries to insert the same pair.

PostgreSQL's [unique index checks](https://www.postgresql.org/docs/18/index-unique-checks.html) documentation describes exactly what happens: when the conflicting row belongs to a transaction that has not committed yet, the second inserter has to wait and see how that transaction ends. A rollback means no conflict at all; a commit means a uniqueness violation.

That blocking is the feature, not a problem to tune away. B does not learn its fate until A's transaction resolves. If A commits, B gets `23505` and can safely skip, knowing the business change is durable. If A rolls back, because the handler threw or the pod died mid-transaction, B's insert succeeds and B processes the message, which is exactly what you want. SQL Server reaches the same outcome by a different route: A holds an exclusive lock on the index key it inserted, so B blocks on that lock until A commits or rolls back, and only then raises the duplicate-key error or proceeds. There is no PostgreSQL or SQL Server instance on this machine, so treat this whole section as documented behaviour rather than something I measured.

## Telling a duplicate message apart from a real bug

The `IsInboxDuplicate` check above matches on the index name, and that is deliberate. A message handler that writes business rows usually writes to tables that have their own unique constraints, an order number, an email address, an idempotency key on a payment. If your catch block swallows every unique violation, a genuine data bug in the business write gets reported to the broker as "already processed" and the message disappears.

How much help the provider gives you varies. I reflected over the exception types:

```text
### 10. does the provider exception name the constraint?
  SqliteException: SqliteErrorCode, SqliteExtendedErrorCode, SqlState
  SqlException: Errors, Number, SqlState
```

Npgsql is the generous one. `PostgresException` exposes `SqlState`, `TableName`, `ColumnName` and `ConstraintName` (verified on Npgsql 10.0.3), so you can match the constraint by name with no string parsing. `SqlException` gives you `Number` and nothing else structured, so you are matching on the index name inside the message text. `SqliteException` gives you `SqliteErrorCode` 19 and `SqliteExtendedErrorCode` 2067, with the column list only in the message.

On the two SQL Server error numbers: 2601 is "Cannot insert duplicate key row in object '%.\*ls' with unique index '%.\*ls'" and 2627 is "Violation of %ls constraint '%.\*ls'. Cannot insert duplicate key in object '%.\*ls'", per Microsoft's [replication error reference](https://learn.microsoft.com/en-us/previous-versions/SQL/SQL-server-2008/ms151779(v=sql.100)). Which one you get depends on how you declared the uniqueness. `HasIndex(...).IsUnique()` emits `CREATE UNIQUE INDEX`, while `HasAlternateKey(...)` emits a table constraint:

```sql
CONSTRAINT [AK_Inbox_MessageId_Consumer] UNIQUE ([MessageId], [Consumer])
```

Catch both numbers and match the name, and you do not have to care which one your model produced.

## Three ways to silently break this

**`ExecuteUpdate` and `ExecuteDelete` are not part of the save.** They issue their own statement immediately, outside whatever transaction `SaveChanges` will later open. A handler that credits an account with `ExecuteUpdateAsync` and then adds the inbox marker has no atomicity at all:

```text
### 9. ExecuteUpdate commits on its own, before SaveChanges runs
  marker rejected as duplicate
  balance = 100 (the credit stuck even though the marker was rejected)
```

The duplicate detection worked perfectly and the money still moved. If you want the bulk-update performance, open an explicit transaction with `BeginTransactionAsync`, run the `ExecuteUpdateAsync` and the `SaveChangesAsync` inside it, and commit once.

**Retrying on the same `DbContext` retries the same doomed insert.** After a failed save the change tracker keeps every entity in its pre-save state:

```text
### 4. change-tracker state after a duplicate-key failure
  InboxMessage  state = Added
  Account       state = Modified
  retry on same context: threw again (SqliteException)
```

Any retry has to start from a fresh scope and a fresh context. In practice that means the retry lives at the message-pump level, not inside the handler.

**A retrying execution strategy plus an explicit transaction throws.** The moment you reach for `BeginTransactionAsync` to solve the `ExecuteUpdate` problem above, `EnableRetryOnFailure` starts complaining. That failure has its own write-up: [the configured execution strategy does not support user-initiated transactions](/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/). The fix is `ExecuteAsync` on the strategy, wrapping the whole transaction so the retry replays all of it.

## Side effects that cannot join the transaction

Sending an email, charging a card, or writing to blob storage cannot roll back with your database transaction. The pattern that works is a two-phase claim: insert the marker and commit, then do the external work, then record the outcome.

```csharp
// EF Core 11.0.0-rc.1
db.Inbox.Add(new InboxMessage { MessageId = msg.MessageId, Consumer = "email", ReceivedUtc = DateTime.UtcNow });
try
{
    await db.SaveChangesAsync(ct);          // phase 1: claim the message
}
catch (DbUpdateException ex) when (IsInboxDuplicate(ex))
{
    return;                                  // someone else owns this one
}

await emailer.SendAsync(msg, ct);            // the side effect, outside any transaction

await db.Inbox
    .Where(m => m.MessageId == msg.MessageId && m.Consumer == "email")
    .ExecuteUpdateAsync(s => s.SetProperty(m => m.ProcessedUtc, DateTime.UtcNow), ct);
```

Two concurrent instances, one external call:

```text
### 7. two-phase claim: insert marker, commit, then call the API
  A: won the claim, called the API, marked processed (rows=1)
  B: lost the claim, skipping the API call
  external API calls = 1
```

Note what this buys and what it does not. It removes the duplicate call. It does not survive a crash between the commit and the send: you are left with a claimed row whose `ProcessedUtc` is null and no way to know whether the email went out. Microsoft's guidance is to read an in-progress record as a possibly half-finished attempt, and to reconcile stale ones or route them for human intervention rather than acknowledging blindly. The practical answer is to make the downstream call idempotent too, by sending the same `MessageId` as the provider's idempotency key, and then let a sweeper retry claims older than a threshold.

## Choosing the key, and cleaning up

The deduplication key has to be stable across redeliveries. Azure Service Bus `MessageId` and a CloudEvents `source` plus `id` pair both qualify. `CorrelationId` does not, because it identifies a conversation and several messages share it. Neither do delivery-attempt counters or receive timestamps. On Kafka, where there is no broker-assigned message id, the topic, partition and offset triple is stable for a given record; a producer-set header is better if you have one.

The inbox table grows forever unless you prune it, and pruning too early reopens the window. Keep a row for longer than the broker can still redeliver the original: that is the lock or visibility timeout times the maximum delivery count, plus the message time-to-live, plus a margin for messages an operator resubmits from the dead-letter queue weeks later. A nightly `ExecuteDeleteAsync` on `ReceivedUtc < cutoff` is enough, and it is one of the rare places where `ExecuteDelete` running outside a transaction is exactly what you want.

None of this is free to maintain, which is why the pattern is worth skipping when the operation is naturally idempotent. An upsert keyed on a business identifier, or a write that sets an absolute value instead of applying a delta, needs no inbox at all. If you are already on MassTransit, `AddInboxStateEntity()` and friends give you the same machinery with a configurable `DuplicateDetectionWindow` and a delivery service, on `MassTransit.EntityFrameworkCore` 9.2.2.

Hand-rolling it is a table, an index, one catch block and a cleanup job. The part that people get wrong is never the table. It is believing that the `if` at the top of the handler was doing the work.

### Read next

- [Fix: 23505: duplicate key value violates unique constraint on a concurrent EF Core insert](/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/)
- [How to implement optimistic concurrency with a rowversion token in EF Core 11](/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [How to use pessimistic locking with UPDLOCK and SELECT ... FOR UPDATE in EF Core 11](/2026/09/how-to-use-pessimistic-locking-with-updlock-and-select-for-update-in-ef-core-11/)
- [Fix: The configured execution strategy does not support user-initiated transactions](/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [BackgroundService vs IHostedService vs Hangfire for background jobs in .NET 11](/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/)

### Sources

- [Idempotent Consumer pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer), Azure Architecture Center
- [Transactions in EF Core](https://learn.microsoft.com/en-us/ef/core/saving/transactions), EF Core docs
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), EF Core docs
- [PostgreSQL 18: Unique Index Checks](https://www.postgresql.org/docs/18/index-unique-checks.html)
- [Errors 2601 and 2627 in the replication error reference](https://learn.microsoft.com/en-us/previous-versions/SQL/SQL-server-2008/ms151779(v=sql.100)), Microsoft Learn
- [Transactional Outbox configuration](https://masstransit.massient.com/documentation/configuration/middleware/outbox), MassTransit docs
- [`InboxState.cs`](https://github.com/MassTransit/MassTransit/blob/develop/src/Persistence/MassTransit.EntityFrameworkCoreIntegration/EntityFrameworkCoreIntegration/InboxState.cs), MassTransit
