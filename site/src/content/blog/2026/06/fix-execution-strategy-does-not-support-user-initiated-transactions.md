---
title: "Fix: The configured execution strategy 'SqlServerRetryingExecutionStrategy' does not support user-initiated transactions"
description: "EnableRetryOnFailure conflicts with BeginTransaction. Wrap the whole transaction in db.Database.CreateExecutionStrategy().ExecuteAsync(...) so it retries as one unit."
pubDate: 2026-06-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
---

The fix: you turned on connection resiliency with `EnableRetryOnFailure()` and then opened your own transaction with `BeginTransaction()` or `BeginTransactionAsync()`. A retrying execution strategy cannot replay a transaction it did not start, so it refuses up front. Get the strategy from `db.Database.CreateExecutionStrategy()` and run the entire transaction inside `strategy.ExecuteAsync(...)`. The whole delegate becomes one retriable unit.

```text
System.InvalidOperationException: The configured execution strategy 'SqlServerRetryingExecutionStrategy' does not support user-initiated transactions. Use the execution strategy returned by 'DbContext.Database.CreateExecutionStrategy()' to execute all the operations in the transaction as a retriable unit.
   at Microsoft.EntityFrameworkCore.Storage.ExecutionStrategy.ExecuteAsync[TState,TResult](TState state, Func`4 operation, Func`4 verifySucceeded, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerExecutionStrategy.Execute[TState,TResult](...)
   at Microsoft.EntityFrameworkCore.Storage.RelationalConnection.BeginTransaction()
```

This guide is written against .NET 11 and `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0, but the message and the underlying rule have been stable since EF Core 1.1 when connection resiliency shipped. If you are on EF Core 6, 8, or 9, everything below applies unchanged. The type name in the message depends on your provider: SQL Server raises `SqlServerRetryingExecutionStrategy`, Npgsql raises `NpgsqlRetryingExecutionStrategy`, Pomelo's MySQL provider raises its own. The fix is identical for all of them.

## Why a retrying strategy refuses your transaction

Connection resiliency works by wrapping each database operation in a retry loop. When you call `EnableRetryOnFailure()`, EF Core swaps in an execution strategy that knows which SQL Server error numbers are transient (deadlock victims, connection drops, Azure SQL throttling) and retries those operations with exponential backoff. The important word is *each*. Every query and every call to `SaveChangesAsync()` becomes its own retriable unit. If one fails transiently, the strategy replays that one operation.

A transaction breaks that model. When you call `BeginTransactionAsync()`, you are telling EF Core that several operations form a single atomic group. If the connection drops in the middle, retrying one statement is meaningless: the transaction has already been rolled back by the server, and replaying a single `INSERT` inside a transaction that no longer exists would either fail or, worse, commit partial work. The execution strategy cannot know what your transaction was supposed to contain, so it cannot replay it correctly.

Rather than retry incorrectly and risk data corruption, EF Core throws the moment you try to begin a user-initiated transaction while a retrying strategy is active. The official guidance is blunt about the stakes: a naive retry across a commit boundary "could lead to data corruption" if the operation depends on store state. The exception is a guardrail, not a bug.

## The smallest code that triggers it

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
builder.Services.AddDbContext<AppDb>(options =>
    options.UseSqlServer(
        connectionString,
        sql => sql.EnableRetryOnFailure())); // <-- resiliency on

// ...somewhere in a service:
public async Task TransferAsync(int fromId, int toId, decimal amount)
{
    await using var tx = await _db.Database.BeginTransactionAsync(); // <-- throws here

    var from = await _db.Accounts.FindAsync(fromId);
    var to = await _db.Accounts.FindAsync(toId);
    from!.Balance -= amount;
    to!.Balance += amount;

    await _db.SaveChangesAsync();
    await tx.CommitAsync();
}
```

The `BeginTransactionAsync()` line never returns a transaction. EF Core checks for an active retrying strategy first and throws the `InvalidOperationException`. Note that you do not need to call `BeginTransaction` explicitly to hit this: anything that opens a user transaction counts, including a `TransactionScope` you created yourself.

## Fix 1: wrap the transaction in the execution strategy

This is the canonical fix and the one Microsoft documents. Ask the context for its execution strategy, then hand it a delegate that contains the entire transaction, from `BeginTransactionAsync` to `CommitAsync`. If a transient failure occurs anywhere inside, the strategy re-runs the whole delegate, transaction and all.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
public async Task TransferAsync(int fromId, int toId, decimal amount)
{
    var strategy = _db.Database.CreateExecutionStrategy();

    await strategy.ExecuteAsync(async () =>
    {
        await using var tx = await _db.Database.BeginTransactionAsync();

        var from = await _db.Accounts.FindAsync(fromId);
        var to = await _db.Accounts.FindAsync(toId);
        from!.Balance -= amount;
        to!.Balance += amount;

        await _db.SaveChangesAsync();
        await tx.CommitAsync();
    });
}
```

`CreateExecutionStrategy()` returns the same retrying strategy that EF Core configured from your `EnableRetryOnFailure()` call. When resiliency is off, it returns a no-op strategy that runs the delegate exactly once, so this code is safe to write even in projects where retries are not enabled. That makes `strategy.ExecuteAsync` a reasonable default wrapper for any explicit transaction, not just ones in Azure-hosted apps.

There is one rule that catches people: the delegate must be idempotent enough to run from the start more than once. Do not read a value before the `strategy.ExecuteAsync` call, mutate it, and rely on the read inside the retry. Pull every read and write into the delegate so a replay starts from a clean slate.

## Fix 2: ExecuteInTransactionAsync when you need commit verification

`strategy.ExecuteAsync` handles the common case, but it has a blind spot. If the connection drops *while the commit is in flight*, the strategy does not know whether the server actually committed. By default it assumes a rollback and replays, which can insert a duplicate row if you use store-generated keys.

`ExecuteInTransactionAsync` closes that gap. It begins and commits the transaction for you and takes a `verifySucceeded` delegate that runs after a transient commit failure to check whether the work landed.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
var strategy = _db.Database.CreateExecutionStrategy();

var blog = new Blog { Url = "https://startdebugging.net" };
_db.Blogs.Add(blog);

await strategy.ExecuteInTransactionAsync(
    _db,
    operation: (ctx, ct) => ctx.SaveChangesAsync(acceptAllChangesOnSuccess: false, ct),
    verifySucceeded: (ctx, ct) =>
        ctx.Blogs.AsNoTracking().AnyAsync(b => b.BlogId == blog.BlogId, ct));

_db.ChangeTracker.AcceptAllChanges();
```

Two details matter here. `SaveChangesAsync` is called with `acceptAllChangesOnSuccess: false` so the tracked entities stay in the `Added` state until you know the commit stuck; that is what makes a clean replay possible. You then call `ChangeTracker.AcceptAllChanges()` once after the strategy returns. The `verifySucceeded` query uses `AsNoTracking()` so the verification read does not collide with the entities still pending in the change tracker.

If you genuinely do not care about the rare mid-commit failure, Microsoft's "do almost nothing" option is to avoid store-generated keys (use a client-side `Guid`) so a blind replay throws a primary-key violation instead of silently duplicating data. Fix 1 is then enough.

## Ambient transactions and TransactionScope

The same wrapper works for `TransactionScope`, including when you span two contexts. Open the scope and call `Complete()` inside the delegate.

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
var strategy = _db.Database.CreateExecutionStrategy();

await strategy.ExecuteAsync(async () =>
{
    using var scope = new TransactionScope(
        TransactionScopeAsyncFlowOption.Enabled); // required for await inside

    _db.Orders.Add(order);
    await _db.SaveChangesAsync();

    await _auditDb.SaveChangesAsync();

    scope.Complete();
});
```

Without `TransactionScopeAsyncFlowOption.Enabled`, the ambient transaction does not flow across the `await`, and you get a separate, hard-to-diagnose `TransactionAbortedException`. That is a different error, but it shows up in exactly the same code path, so set the flag whenever you mix `TransactionScope` with async EF Core calls.

## Gotchas and lookalikes

**It can fire on a plain query, not just a write.** GitHub issue [dotnet/efcore#29396](https://github.com/dotnet/efcore/issues/29396) tracks reports of the message appearing on a simple `SELECT`. The usual cause is an outer `TransactionScope` that you forgot about (often opened in a base repository, a test fixture, or a unit-of-work wrapper) so the "simple" query is actually running inside a user transaction. Search your call stack for any `BeginTransaction` or `new TransactionScope` above the failing line.

**Azure SQL can turn this on without you asking.** Starting around EF Core 8, the SQL Server provider began defaulting to a retrying strategy when it detects an Azure SQL connection string (see [dotnet/efcore#32165](https://github.com/dotnet/efcore/issues/32165)). Code that worked locally against LocalDB suddenly throws in Azure because resiliency is now active. If you see this only in your cloud environment, that is why. The fix is the same wrapper; you do not need to disable the default.

**Do not just delete `EnableRetryOnFailure` to make it go away.** That removes the error by removing the resiliency you presumably wanted. Wrap the transaction instead. If you truly need to bypass resiliency for one isolated operation, the cleaner escape hatch discussed in [dotnet/efcore#24922](https://github.com/dotnet/efcore/issues/24922) is to use a second, separately-configured context without retries, not to strip it from your main one.

**This is not the same as "A second operation was started on this context instance."** That error is about concurrent use of one `DbContext`, not about transactions and retries. If your message mentions concurrency rather than execution strategies, see the fix for [a second operation started on this context](/2026/05/fix-second-operation-was-started-on-this-context-instance/) instead.

## Related

- [Fix: SqlException: Timeout expired during EF Core migrations](/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) covers the transient-failure family from the migration side.
- [Fix: ObjectDisposedException: Cannot access a disposed context instance](/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) is the other EF Core lifetime trap that bites async code.
- [EF Core ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) shows when you can avoid an explicit transaction entirely.
- [How to use EF Core 11 interceptors for auditing](/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) for hooking into the save pipeline without manual transactions.
- [Migrate EF Core 6 to EF Core 11: breaking changes that actually bite](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) flags the Azure SQL retry default among other surprises.

## Sources

- [Connection Resiliency, EF Core](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency) - the canonical guidance on `CreateExecutionStrategy`, `ExecuteInTransactionAsync`, and the idempotency issue.
- [Implement resilient Entity Framework Core SQL connections](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/implement-resilient-applications/implement-resilient-entity-framework-core-sql-connections) - the .NET microservices architecture take on the same pattern.
- [dotnet/efcore#32165: Azure SQL retrying-strategy default](https://github.com/dotnet/efcore/issues/32165)
- [dotnet/efcore#29396: error on a simple SELECT](https://github.com/dotnet/efcore/issues/29396)
- [dotnet/efcore#24922: suspending the configured execution strategy](https://github.com/dotnet/efcore/issues/24922)
