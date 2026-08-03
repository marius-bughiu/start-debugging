---
title: "How to implement optimistic concurrency with a rowversion token in EF Core 11"
description: "Add a rowversion concurrency token in EF Core 11: the [Timestamp] and IsRowVersion setup, the SQL EF actually emits, catching DbUpdateConcurrencyException, store-wins vs client-wins vs merge, disconnected APIs with ETags, and the five traps that silently disable the whole thing."
pubDate: 2026-08-03
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "rowversion"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
---

Short answer: put a `byte[]` property on the entity, mark it `[Timestamp]` (or call `.IsRowVersion()` in `OnModelCreating`), and EF Core 11 maps it to a SQL Server `rowversion` column and adds `AND [RowVersion] = @original` to every UPDATE and DELETE it generates for that entity. When the row was changed by someone else in the meantime, the statement affects zero rows and `SaveChangesAsync` throws `DbUpdateConcurrencyException`, which you catch and resolve. The whole feature is about six lines of configuration. The hard part is the five ways to accidentally turn it off without getting an error.

This post covers the setup, the exact SQL and exception text, the three resolution strategies, the disconnected web-API round trip that most tutorials skip, and the traps that leave you with a token that protects nothing.

A note on how the details below were verified. EF Core 11 requires the .NET 11 runtime, and the only SDK on this machine is .NET 10.0.201, so the runnable experiments were done on `Microsoft.EntityFrameworkCore` 10.0.10 against SQLite, plus the SQL Server provider's DDL generator (which runs offline, without a server). The concurrency-token API and its generated SQL shape are unchanged between EF Core 8 and 11: the [EF Core 11 release notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) list no changes to concurrency tokens, `SaveChanges` conflict detection, or `DbUpdateConcurrencyException`. Anything that is EF Core 11 specific is called out as such.

## What a rowversion column actually is

`rowversion` is a SQL Server data type, not an EF Core concept. Per the [rowversion documentation](https://learn.microsoft.com/en-us/sql/t-sql/data-types/rowversion-transact-sql), it is 8 bytes of automatically generated, unique binary data. Three properties matter for concurrency work:

- **It is a counter, not a clock.** It preserves no date or time. Every database has a single counter that increments on any insert or update to any table containing a `rowversion` column. Two rows in different tables can never share a value, but you cannot subtract two values and get an elapsed time.
- **A table can have exactly one.** Which is why a rowversion token guards the entire row, never a subset of columns.
- **Any UPDATE bumps it, including a no-op.** The docs are explicit: setting a column to the value it already holds counts as an update and increments the version. A "save" that changes nothing still invalidates every other reader's token.

`timestamp` is a deprecated synonym for the same type. Use `rowversion` in DDL. Confusingly, the EF Core attribute is still spelled `[Timestamp]`, because it predates the rename.

## The setup, in four steps

1. **Add a `byte[]` property to the entity.** The CLR type has to be `byte[]` for the SQL Server provider to map it to `rowversion`. Name it whatever you like; `RowVersion` and `Version` are the common choices.
2. **Mark it as a row version.** Either `[Timestamp]` as a data annotation, or `.Property(p => p.RowVersion).IsRowVersion()` in `OnModelCreating`. The two are equivalent.
3. **Add a migration and apply it.** EF emits `[RowVersion] rowversion NOT NULL`, and SQL Server backfills every existing row on the next update.
4. **Catch `DbUpdateConcurrencyException` at every call site that saves that entity.** Without this step you have replaced a silent lost update with a 500 response, which is better but not by much.

Here is the entity, both ways:

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
public class Product
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public decimal Price { get; set; }

    [Timestamp]
    public byte[] RowVersion { get; set; } = default!;
}
```

```csharp
// Fluent equivalent, no attribute needed on the entity
protected override void OnModelCreating(ModelBuilder modelBuilder)
    => modelBuilder.Entity<Product>()
        .Property(p => p.RowVersion)
        .IsRowVersion();
```

Running the SQL Server provider's create-script generator over that model produces:

```sql
CREATE TABLE [Products] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Price] decimal(18,2) NOT NULL,
    [RowVersion] rowversion NOT NULL,
    CONSTRAINT [PK_Products] PRIMARY KEY ([Id])
);
```

The interesting part is not the DDL, it is the model metadata EF derives from it. Dumping `IProperty` for that column gives `colType=rowversion`, `IsConcurrencyToken=True`, `ValueGenerated=OnAddOrUpdate`. That last flag is the one to remember: EF Core will never write a value into this column. It excludes it from INSERT and UPDATE, and reads the new value back afterwards. The database owns it entirely.

## The SQL EF Core emits, and the exception when it fails

Once the property is a concurrency token, every UPDATE that EF generates for the entity carries the original value in its `WHERE` clause alongside the key. On SQLite with an application-managed token, the shape is exactly this (captured with `LogTo` filtered to `RelationalEventId.CommandExecuted`):

```sql
UPDATE "Products" SET "Price" = @p0, "Version" = @p1
WHERE "Id" = @p2 AND "Version" = @p3
RETURNING 1;
```

On SQL Server the statement also has to read the regenerated `rowversion` back, since the column is `ValueGenerated.OnAddOrUpdate`. The form documented in the [Razor Pages concurrency tutorial](https://learn.microsoft.com/en-us/aspnet/core/data/ef-rp/concurrency) pairs the guarded UPDATE with a `@@ROWCOUNT`-conditioned SELECT:

```sql
SET NOCOUNT ON;
UPDATE [Products] SET [Price] = @p0
WHERE [Id] = @p1 AND [RowVersion] = @p2;
SELECT [RowVersion]
FROM [Products]
WHERE @@ROWCOUNT = 1 AND [Id] = @p1;
```

The exact statement shape has changed across EF Core versions and providers, and it will keep changing. What is stable, and what you should assert on in a test, is the semantics: the token appears in the `WHERE`, and a zero-row result is turned into an exception.

If somebody else modified the row after you loaded it, the predicate matches nothing, zero rows come back, and EF throws. The message is worth memorising because it is the thing you will grep your logs for:

```text
The database operation was expected to affect 1 row(s), but actually affected
0 row(s); data may have been modified or deleted since entities were loaded.
```

Two things people get wrong about when this fires. First, it is thrown for updates *and* deletes, but essentially never for inserts. A duplicate insert produces a provider-specific unique-constraint exception instead. Second, "affected 0 rows" does not distinguish "somebody changed it" from "somebody deleted it". You have to work that out during resolution.

If the SQL above does not look like what your app is sending, the fastest way to find out what it *is* sending is to [log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) and read the `WHERE` clause directly. A missing `AND [RowVersion] = ...` means the token is not configured on the path you think it is.

## Resolving the conflict: three strategies, one loop

`DbUpdateConcurrencyException` exposes `Entries`, the list of `EntityEntry` objects whose commands came back with the wrong row count. Each entry gives you three sets of values:

- `CurrentValues`: what you tried to write.
- `OriginalValues`: what you read, before your edits. This is where the stale token lives.
- `GetDatabaseValuesAsync()`: what is in the database right now, freshly queried.

Every resolution strategy is a rule for combining those three, followed by refreshing `OriginalValues` so the retry's `WHERE` clause uses the current token.

**Store wins** is the simplest and the right default for anything a human is looking at: discard the attempt, reload, tell the user. `entry.ReloadAsync()` does it in one call.

**Client wins** overwrites whatever landed in between. Correct only when your write is authoritative (an admin override, a replay of a canonical event), and a genuine mistake everywhere else:

```csharp
// .NET 11, C# 14, EF Core 11
catch (DbUpdateConcurrencyException ex)
{
    foreach (var entry in ex.Entries)
    {
        var databaseValues = await entry.GetDatabaseValuesAsync();
        if (databaseValues is null)
        {
            // The row is gone. There is nothing to overwrite.
            throw new InvalidOperationException("Product was deleted by another user.");
        }

        // Keep CurrentValues as-is, but adopt the database's token so the
        // retried UPDATE targets the row as it exists now.
        entry.OriginalValues.SetValues(databaseValues);
    }

    await context.SaveChangesAsync();
}
```

**Merge** is the version worth writing when the entity has independent fields. Take the database value for any property you did not touch, keep yours for the ones you did, and escalate only on a true overlap:

```csharp
// .NET 11, C# 14, EF Core 11
var saved = false;
while (!saved)
{
    try
    {
        await context.SaveChangesAsync();
        saved = true;
    }
    catch (DbUpdateConcurrencyException ex)
    {
        foreach (var entry in ex.Entries)
        {
            if (entry.Entity is not Product)
            {
                throw new NotSupportedException(
                    $"No conflict policy for {entry.Metadata.Name}.");
            }

            var proposed = entry.CurrentValues;
            var database = await entry.GetDatabaseValuesAsync()
                ?? throw new InvalidOperationException("Row was deleted.");
            var original = entry.OriginalValues;

            foreach (var property in proposed.Properties)
            {
                // Skip the token itself: it is byte[], so Equals compares
                // references, and it is refreshed wholesale below anyway.
                if (property.IsConcurrencyToken) continue;

                var mine = proposed[property];
                var theirs = database[property];
                var wasLoaded = original[property];

                // I did not touch this column: take theirs.
                if (Equals(mine, wasLoaded))
                {
                    proposed[property] = theirs;
                }
                // Both of us changed it to different values: real conflict.
                else if (!Equals(theirs, wasLoaded) && !Equals(mine, theirs))
                {
                    throw new InvalidOperationException(
                        $"Conflicting edits to {property.Name}.");
                }
            }

            entry.OriginalValues.SetValues(database);
        }
    }
}
```

That `while (!saved)` loop is the shape the [EF Core concurrency documentation](https://learn.microsoft.com/en-us/ef/core/saving/concurrency) recommends, and it is genuinely a loop: your retry can lose the race a second time. Put a bounded attempt count on it in production, because an unbounded retry against a hot row is a livelock.

One interaction to watch: if you have enabled `EnableRetryOnFailure`, the retry happens inside a `SqlServerRetryingExecutionStrategy`, and wrapping this loop in a manual `BeginTransaction` will fail with the error described in [the execution strategy does not support user-initiated transactions](/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/). Use `strategy.ExecuteAsync(...)` around the whole unit of work instead.

## The disconnected round trip, which is where this usually goes wrong

The single-context example above is not what your API does. Your API loads a product in one request, hands it to a browser, and receives an edit ten minutes later in a completely different `DbContext`. The token has to survive that trip.

`byte[]` serialises to base64 in `System.Text.Json`, so passing it through a DTO works with no special handling. The idiomatic HTTP shape is an ETag: return the base64 token as the `ETag` response header on GET, require it as `If-Match` on PUT, and answer `412 Precondition Failed` when it does not match.

On the write side, the crucial line is setting `OriginalValue` explicitly. EF has no idea what the row looked like when the client read it, so you have to tell it:

```csharp
// .NET 11, C# 14, EF Core 11
app.MapPut("/products/{id:int}", async (
    int id, ProductDto dto, [FromHeader(Name = "If-Match")] string? ifMatch,
    AppDbContext db) =>
{
    if (string.IsNullOrEmpty(ifMatch)) return Results.BadRequest("If-Match required.");

    var product = await db.Products.FindAsync(id);
    if (product is null) return Results.NotFound();

    product.Name = dto.Name;
    product.Price = dto.Price;

    // Overwrite the token EF loaded with the one the client actually saw.
    db.Entry(product).Property(p => p.RowVersion).OriginalValue =
        Convert.FromBase64String(ifMatch.Trim('"'));

    try
    {
        await db.SaveChangesAsync();
        return Results.Ok(new { eTag = Convert.ToBase64String(product.RowVersion) });
    }
    catch (DbUpdateConcurrencyException)
    {
        return Results.StatusCode(StatusCodes.Status412PreconditionFailed);
    }
});
```

Note that this deliberately queries the row first. You can skip the query with `Attach` plus `EntityState.Modified`, which is one fewer round trip, but then every column is written whether or not it changed. I verified both paths behave identically with respect to the token: in the SQLite repro, setting `OriginalValue` on an attached, never-queried entity produced the same token-guarded `WHERE` clause as the query-first path and saved cleanly.

## Five ways to silently disable your concurrency token

**Forgetting to carry the original token.** If a detached entity arrives with a default or empty token and you call `context.Update(entity)`, EF takes the value *on the object* as the original. The emitted SQL becomes `WHERE "Id" = @p3 AND "Version" = @p4` with an all-zero `@p4`, which matches nothing, and every single save throws `DbUpdateConcurrencyException`. I reproduced exactly this on EF Core 10.0.10. The failure mode is loud, which is lucky, because the opposite mistake is silent.

**Using a provider that has no rowversion.** This one has no error at all. On SQLite, `[Timestamp]` on a `byte[]` produces a `BLOB NULL` column marked `IsConcurrencyToken=True`, `ValueGenerated=OnAddOrUpdate`. EF therefore never writes it, SQLite never generates it, and the value stays `null` forever. The generated UPDATE degrades to:

```sql
UPDATE "Products" SET "Price" = @p0
WHERE "Id" = @p1 AND "RowVersion" IS NULL
RETURNING "RowVersion";
```

`IS NULL` matches every time. You get a token-shaped column, zero protection, and no warning. Verified on EF Core 10.0.10 with `Microsoft.EntityFrameworkCore.Sqlite`. If your integration tests run on SQLite while production runs on SQL Server, your concurrency tests are passing for the wrong reason.

The fix for providers without a native auto-updating column is an application-managed token: a `Guid` marked `[ConcurrencyCheck]` (or `.IsConcurrencyToken()`), which you assign yourself on every save. PostgreSQL is the exception that needs neither: Npgsql maps a `uint` property marked `[Timestamp]` or configured with `.IsRowVersion()` onto the system `xmin` column, which the engine updates automatically.

**Putting `[Timestamp]` on the wrong CLR type.** EF Core does not validate this at model-build time. I put `[Timestamp]` on a `long` and the SQL Server provider happily emitted `[RowVersion] bigint NOT NULL` with `IsConcurrencyToken=True` and `ValueGenerated=OnAddOrUpdate`. SQL Server does not maintain plain `bigint` columns, and EF has been told not to write them, so nothing ever moves the value. Only `byte[]` maps to the real `rowversion` type.

**Writing through `ExecuteUpdate` or `ExecuteDelete`.** These bypass change tracking entirely, and with it the concurrency check. The SQL they emit contains only your predicate:

```sql
UPDATE "Products" AS "p"
SET "Price" = ef_add("p"."Price", '1.0')
WHERE "p"."Name" = 'B'
```

No token, no exception, one row affected. If you want optimistic concurrency on a bulk path you have to hand-roll it: put the token in the `Where`, and compare the returned affected-row count against what you expected. That trade-off, and when each write path is the right one, is the subject of [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

**Comparing tokens with `==` in C#.** `byte[]` uses reference equality. Two arrays holding identical bytes are not equal. Use `SequenceEqual`, or compare the base64 strings, whenever you need to check a token in application code. EF itself compares in SQL, so this only bites in your own validation logic.

## When a row-level token is too coarse

A `rowversion` protects the whole row. Two users editing genuinely independent fields on the same record (one fixes a typo in the description, the other adjusts the stock count) collide, even though nothing is actually in conflict. On a hot record that is a stream of spurious 412s.

Two ways out. Use the merge strategy above so the false conflicts resolve automatically and only true overlaps surface. Or drop to an application-managed token that you regenerate only when properties you care about change, which you can centralise in a `SaveChanges` interceptor of the kind described in [EF Core 11 interceptors for auditing](/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/). The cost of the second option is that you now own the "did this change matter?" decision, forever, for every property you add.

The higher-level alternative is a transaction isolation level. Snapshot isolation on SQL Server, or repeatable read on PostgreSQL, will raise a serialization error when your transaction's write conflicts with a committed one, without any token in the model. It is simpler, and it is the wrong tool the moment a human is in the loop, because the transaction would have to stay open across the user's think time. Concurrency tokens exist precisely so the "transaction" can span an HTTP round trip and a coffee break.

## Related

- [ExecuteUpdate vs loading entities and SaveChanges in EF Core](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [How to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [How to use EF Core 11 interceptors for auditing](/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [Fix: the execution strategy does not support user-initiated transactions](/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Fix: the instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## Sources

- [Handling concurrency conflicts](https://learn.microsoft.com/en-us/ef/core/saving/concurrency) on Microsoft Learn, for the token semantics, the three value sets, and the retry loop.
- [rowversion (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/rowversion-transact-sql) for the 8-byte counter, the one-per-table rule, the no-op UPDATE behaviour, and the `timestamp` deprecation.
- [Disconnected entities](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities) for `Update` versus `Attach` and `CurrentValues.SetValues`.
- [What's new in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), which confirms EF11 requires the .NET 11 runtime and lists no concurrency-token changes.
- [Npgsql concurrency tokens](https://www.npgsql.org/efcore/modeling/concurrency.html) for the `xmin` mapping on PostgreSQL.
