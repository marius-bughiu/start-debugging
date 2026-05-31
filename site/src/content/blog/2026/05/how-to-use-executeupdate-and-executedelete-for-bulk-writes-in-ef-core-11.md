---
title: "How to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11"
description: "A complete guide to ExecuteUpdate and ExecuteDelete in EF Core 11: the SQL they emit, the change-tracker gotcha that silently overwrites your bulk write, transactions, concurrency control with the affected-row count, and the EF Core 10 delegate setters that let you build conditional updates with plain if statements."
pubDate: 2026-05-31
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
---

Short answer: to update or delete many rows in one SQL statement, write a LINQ `Where` to pick the rows, then call `ExecuteUpdateAsync` or `ExecuteDeleteAsync` on the resulting query. EF Core 11 translates the whole thing into a single `UPDATE` or `DELETE` that runs at the database, with no entities loaded, no change tracker, and no `SaveChanges`. Both methods execute immediately and return the number of affected rows. The one gotcha that bites everyone: because these methods never touch the change tracker, any entity you already loaded keeps its stale value, and a later `SaveChanges` will happily overwrite your bulk write.

This post covers `ExecuteUpdate` and `ExecuteDelete` in `Microsoft.EntityFrameworkCore` 11.0.0 on .NET 11 against SQL Server 2025: the exact SQL they emit, multi-property updates, referencing the existing column value, the change-tracking trap and how to dodge it, transaction semantics, rolling your own optimistic concurrency with the affected-row count, the delegate-based conditional setters that landed in EF Core 10, and the limitations that send you back to `SaveChanges`. The relational APIs are identical on PostgreSQL and SQLite; only the emitted SQL dialect differs.

## Why the SaveChanges loop is the wrong tool for bulk writes

The naive way to soft-delete every low-rated blog looks reasonable until you watch the SQL:

```csharp
// .NET 11, EF Core 11.0.0 - the slow way
await foreach (var blog in context.Blogs.Where(b => b.Rating < 3).AsAsyncEnumerable())
{
    context.Blogs.Remove(blog);
}

await context.SaveChangesAsync();
```

This queries every matching row off the wire, materializes each one into a tracked entity, marks it `Deleted` in the change tracker, and then on `SaveChanges` emits one `DELETE` per row. If 50,000 blogs match, that is one big `SELECT`, 50,000 allocations, and 50,000 `DELETE` statements (batched, but still individually parameterized). The database does enormous work for an operation that is conceptually a single set-based statement.

`ExecuteDelete` collapses all of that into one round trip:

```csharp
// .NET 11, EF Core 11.0.0
int deleted = await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteDeleteAsync();
```

EF Core 11 translates the LINQ predicate to SQL exactly as it would for a query, but emits a `DELETE` instead of a `SELECT`:

```sql
DELETE FROM [b]
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

Nothing is loaded, nothing is tracked, and `deleted` holds the row count. You can put any translatable LINQ in the `Where`, including joins and subqueries, just as you would when selecting the rows out.

## Updating in place with ExecuteUpdate

`ExecuteUpdate` is the `UPDATE` sibling. Instead of deleting the low-rated blogs, hide them:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters => setters.SetProperty(b => b.IsVisible, false));
```

The `Where` selects the rows; the `SetProperty` call says which column changes and to what. EF Core 11 emits:

```sql
UPDATE [b]
SET [b].[IsVisible] = CAST(0 AS bit)
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

To change several columns at once, chain `SetProperty` calls. They all land in one statement:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters => setters
        .SetProperty(b => b.IsVisible, false)
        .SetProperty(b => b.Rating, 0));
```

```sql
UPDATE [b]
SET [b].[Rating] = 0,
    [b].[IsVisible] = CAST(0 AS bit)
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

### Computing the new value from the old one

The second argument to `SetProperty` does not have to be a constant. Pass a lambda and you get the current row, so you can compute the new value from existing columns. To bump every matching rating by one:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters =>
        setters.SetProperty(b => b.Rating, b => b.Rating + 1));
```

Inside that lambda `b.Rating` is the pre-update column value, and EF Core translates the whole expression to SQL so the arithmetic happens at the database, atomically, with no read-modify-write race:

```sql
UPDATE [b]
SET [b].[Rating] = [b].[Rating] + 1
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

This is the pattern you want for counters, balances, and version stamps. Doing it through `SaveChanges` means loading the row, mutating in memory, and saving, which opens a window where another transaction can change the same row between your read and your write. The set-based `UPDATE` has no such window.

## The change-tracker trap that silently eats your write

Here is the single most important thing to internalize about both methods: they take effect immediately and have no interaction with EF's change tracker whatsoever. That is the source of their speed, and also the source of the one bug everyone hits at least once.

Walk through this sequence carefully:

```csharp
// .NET 11, EF Core 11.0.0
// 1. Tracking query: this Blog is now tracked, Rating == 5 in memory.
var blog = await context.Blogs.SingleAsync(b => b.Name == "SomeBlog");

// 2. Bump every blog's rating by one in the database. Runs now.
await context.Blogs
    .ExecuteUpdateAsync(setters => setters.SetProperty(b => b.Rating, b => b.Rating + 1));

// 3. Mutate the tracked instance in memory.
blog.Rating += 2;

// 4. Persist tracked changes.
await context.SaveChangesAsync();
```

After step 2 the database row reads `6`. But the tracked instance still believes the original value is `5`, because `ExecuteUpdate` never told the change tracker anything. Step 3 sets the in-memory value to `7`. When `SaveChanges` runs in step 4, EF compares the current value `7` against the *original* it recorded back in step 1 (`5`), decides the property changed, and writes `7`. Your bulk `+1` is gone, overwritten by a `SaveChanges` that had no idea it ever happened.

The official guidance from the [EF Core ExecuteUpdate and ExecuteDelete docs](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete) is blunt: avoid mixing tracked `SaveChanges` modifications and untracked `ExecuteUpdate`/`ExecuteDelete` against the same entities in the same unit of work. In practice there are two clean ways to stay out of trouble:

1. Run the bulk write against a context whose query for those rows used `AsNoTracking()`, so nothing tracked can go stale.
2. If you must read entities, run the bulk write, then call `context.ChangeTracker.Clear()` before re-querying, so the next read repopulates from the database with fresh values.

```csharp
// .NET 11, EF Core 11.0.0 - re-read fresh after a bulk write
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.IsVisible, false));

context.ChangeTracker.Clear();

var hidden = await context.Blogs
    .AsNoTracking()
    .Where(b => !b.IsVisible)
    .ToListAsync();
```

The cleanest mental model: treat `ExecuteUpdate`/`ExecuteDelete` as if they belong to a different, lower-level data access layer that happens to share your `DbContext`. They speak SQL, not entities. This is the same boundary you respect when you [mock a DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/): the change tracker is a stateful in-memory thing, and side-channel writes do not update it.

## Transactions: nothing is implicit

Neither method opens a transaction for you. Each call is its own round trip and, unless you wrap it, its own implicit transaction. This sequence is four separate transactions:

```csharp
// .NET 11, EF Core 11.0.0 - four independent transactions, NOT atomic
await context.Blogs.ExecuteUpdateAsync(/* update A */);
await context.Blogs.ExecuteUpdateAsync(/* update B */);

var blog = await context.Blogs.SingleAsync(b => b.Name == "SomeBlog");
blog.Rating += 2;
await context.SaveChangesAsync();
```

If update B throws, update A is already committed. There is no rollback, because there was never a shared transaction. When two or more bulk writes must succeed or fail together, start an explicit transaction over the [DatabaseFacade](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.databasefacade):

```csharp
// .NET 11, EF Core 11.0.0 - one atomic unit
await using var tx = await context.Database.BeginTransactionAsync();

await context.Blogs
    .Where(b => b.Rating < 0)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Rating, 0));

await context.Posts
    .Where(p => p.IsOrphaned)
    .ExecuteDeleteAsync();

await tx.CommitAsync();
```

Now both statements share one transaction and roll back together on failure. If one of these runs against a slow table and you hit a [SqlException: Timeout expired](/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/), the explicit transaction is also where you would set a longer command timeout for the batch.

## Rolling your own concurrency control with the row count

`SaveChanges` gives you optimistic concurrency for free through concurrency tokens: it adds the token to the `WHERE` clause and throws `DbUpdateConcurrencyException` if zero rows match. `ExecuteUpdate` and `ExecuteDelete` do not touch the change tracker, so they cannot do this automatically. They give you the raw material instead: the affected-row count.

Put the concurrency token in your own `Where` and inspect the return value:

```csharp
// .NET 11, EF Core 11.0.0 - hand-rolled optimistic concurrency
int updated = await context.Blogs
    .Where(b => b.Id == id && b.Version == expectedVersion)
    .ExecuteUpdateAsync(setters => setters
        .SetProperty(b => b.Title, newTitle)
        .SetProperty(b => b.Version, b => b.Version + 1));

if (updated == 0)
{
    // Either the row is gone or someone else bumped Version first.
    throw new DbUpdateConcurrencyException("Blog was modified concurrently.");
}
```

Because the `Version` check is part of the SQL `WHERE`, the comparison and the write are one atomic statement. No row matches if another transaction already incremented `Version`, `updated` comes back `0`, and you react. This is frequently *faster* than the tracked path for single-row updates on hot endpoints, and it composes well with the read-side patterns in [compiled queries for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Conditional setters without expression trees (EF Core 10 and later)

Before EF Core 10 the setters argument was an expression tree, which made dynamic updates painful: you could not drop an `if` statement in the middle of a fluent chain, so conditional updates meant either branching the whole call or building expression trees by hand. Starting with EF Core 10, and carried into EF Core 11, there is an overload whose setters argument is an ordinary delegate with a statement body. You can use plain C# control flow:

```csharp
// .NET 11, EF Core 11.0.0 - conditional setters with normal control flow
await context.Blogs
    .Where(b => b.Id == id)
    .ExecuteUpdateAsync(setters =>
    {
        setters.SetProperty(b => b.Title, newTitle);

        if (rankChanged)
        {
            setters.SetProperty(b => b.Rating, newRating);
        }

        foreach (var (column, value) in extraFlags)
        {
            // build setters in a loop, one per flag that actually changed
            setters.SetProperty(column, value);
        }
    });
```

The delegate body runs once, in C#, to build up the list of columns to set; EF Core 11 then translates that into a single `UPDATE`. This is the idiomatic way to implement a PATCH endpoint where the client sends only the fields it wants to change. You build exactly the setters you need and emit one statement, instead of either updating every column or falling back to load-mutate-save. The older expression-based overload still exists and is fine for the static, always-the-same-columns case.

## Referencing related entities, and the limits

`ExecuteUpdate` cannot reference a navigation directly inside `SetProperty`. This does not translate:

```csharp
// .NET 11, EF Core 11.0.0 - does NOT work
await context.Blogs.ExecuteUpdateAsync(
    setters => setters.SetProperty(b => b.Rating, b => b.Posts.Average(p => p.Rating)));
```

The workaround is to `Select` into an anonymous projection that computes the value first, then call `ExecuteUpdate` over that projection:

```csharp
// .NET 11, EF Core 11.0.0 - set each Blog's rating to the average of its Posts
await context.Blogs
    .Select(b => new { Blog = b, NewRating = b.Posts.Average(p => p.Rating) })
    .ExecuteUpdateAsync(setters => setters.SetProperty(x => x.Blog.Rating, x => x.NewRating));
```

EF Core 11 turns the average into a correlated subquery in the `UPDATE`:

```sql
UPDATE [b]
SET [b].[Rating] = CAST((
    SELECT AVG(CAST([p].[Rating] AS float))
    FROM [Post] AS [p]
    WHERE [b].[Id] = [p].[BlogId]) AS int)
FROM [Blogs] AS [b]
```

Beyond navigations, keep these constraints in mind:

- **Update and delete only.** There is no `ExecuteInsert`. Inserts still go through `Add` plus `SaveChanges`.
- **No returning the old values.** SQL can return the rows it touched, but EF Core 11 does not surface that; you only get the count.
- **No batching across calls.** Two `ExecuteUpdate` calls are two round trips. There is no equivalent of accumulating changes and flushing once.
- **One table per statement.** Like raw SQL `UPDATE`/`DELETE`, a single call targets a single table. Updating across a TPT inheritance hierarchy that spans tables is not expressible in one call.
- **Relational providers only.** These are extension methods on the relational query provider; the in-memory provider does not have them.

The first one is worth dwelling on: if your hot path is high-volume *inserts*, neither method helps. That is a different problem with its own answer, benchmarked in [EF Core 11 vs Dapper for bulk inserts](/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

## When to reach for which

The decision is mostly about whether you need the entities. If you are deleting or updating rows by a predicate and you do not need the affected objects in memory afterward, `ExecuteDelete`/`ExecuteUpdate` is almost always the right call: one statement, no materialization, no tracking overhead. It is the same instinct that makes you hunt down and kill an [N+1 query in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), namely refusing to do per-row round trips when the database can do the whole job in one set-based operation.

Reach back for `SaveChanges` when you genuinely need the change tracker: complex object graphs, cascade behaviors that depend on tracked state, automatic concurrency tokens, or interceptors and domain events wired into `SaveChanges`. And whenever you do mix the two, remember the boundary. The bulk methods write SQL directly and leave your tracked entities frozen in the past. Clear the tracker or query `AsNoTracking()` after a bulk write, wrap multi-statement work in an explicit transaction, and check the returned row count when correctness depends on how many rows actually changed.
