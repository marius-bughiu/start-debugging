---
title: "How to atomically append to a PostgreSQL jsonb array with EF Core and Npgsql"
description: "Loading an entity, calling List.Add, and saving rewrites the whole jsonb document and silently loses concurrent appends. Push the append into one UPDATE with the jsonb || operator, either through ExecuteSqlAsync or a mapped function inside ExecuteUpdateAsync, and make it idempotent with a @> guard."
pubDate: 2026-09-21
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "postgresql"
  - "npgsql"
  - "json"
  - "concurrency"
  - "how-to"
---

Short answer: do not load the row, `Add` to the list, and call `SaveChangesAsync`. EF Core sends the entire `jsonb` document back as a parameter, so two requests that append at the same time overwrite each other. Send one `UPDATE` that does the append inside PostgreSQL instead: `SET "Data" = jsonb_set("Data", '{Labels}', COALESCE("Data"->'Labels', '[]') || to_jsonb(@label::text))`. You can issue that through `Database.ExecuteSqlAsync`, or keep it in LINQ by mapping a small function with `HasDbFunction` and calling it inside `ExecuteUpdateAsync`, where EF Core 10 writes the `jsonb_set` for you. Add `.Where(t => !t.Data.Labels.Contains(label))`, which Npgsql translates to `@>`, and the append becomes idempotent too.

Everything below was run on .NET 10 (SDK 10.0.302) with `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 (which pulls in EF Core 10.0.4), against PostgreSQL 18.4. The JSON column is mapped the way EF Core 10 recommends: a complex type with `ToJson()`. All SQL and all counts quoted here come from real runs, not from reconstruction.

## Twenty concurrent appends, three survivors

Here is the model. A ticket has a `jsonb` column holding labels and an event history:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class Ticket
{
    public int Id { get; set; }
    public required string Title { get; set; }
    public required TicketData Data { get; set; }
}

public class TicketData
{
    public List<string> Labels { get; set; } = [];
    public List<TicketEvent> Events { get; set; } = [];
}

public class TicketEvent
{
    public required string Kind { get; set; }
    public DateTime At { get; set; }
}

public class AppDb : DbContext
{
    public DbSet<Ticket> Tickets => Set<Ticket>();

    protected override void OnModelCreating(ModelBuilder b)
        => b.Entity<Ticket>().ComplexProperty(t => t.Data, d => d.ToJson());
}
```

Npgsql creates `"Data" jsonb NOT NULL` for that. Now the code most people write first, run from 20 parallel tasks against the same row, each with its own `DbContext`:

```csharp
// .NET 10, EF Core 10.0.4 -- the lost-update version
await using var db = new AppDb();
var t = await db.Tickets.SingleAsync(x => x.Id == id);
t.Data.Labels.Add($"l{i}");
await db.SaveChangesAsync();
```

The row starts with one label, so the expected result is 21. I got **3**, on three runs out of three. The reason is visible in the SQL that `SaveChangesAsync` sends:

```sql
UPDATE "Tickets" SET "Data" = @p0
WHERE "Id" = @p1;
-- @p0='{"Labels":["hardware","urgent","via-savechanges"],"Events":[...]}'
```

EF Core does not send "append this element". It serializes the whole complex type in memory and replaces the column with it. Every task read the same starting document, added its own label, and wrote back a document that knew nothing about the other 19. The last writer wins, and the database has no idea anything went wrong, because from its point of view each `UPDATE` was a perfectly valid replacement.

That is not an Npgsql bug. It is the ordinary lost-update problem, and a JSON column makes it worse than usual: with scalar columns, two requests that change *different* columns do not collide, but here every change to any label or event rewrites the one column that holds all of them.

## Why an in-database append is atomic

PostgreSQL's `jsonb || jsonb` operator concatenates. When the left side is an array and the right side is a scalar or object, the right side is appended as one element:

```sql
SELECT '["a"]'::jsonb || to_jsonb('b'::text);     -- ["a", "b"]
SELECT '["a"]'::jsonb || '{"k": 1}'::jsonb;       -- ["a", {"k": 1}]
```

The important part is not the operator, it is where the old value comes from. In `SET "Data" = ... "Data" || ...`, the right-hand `"Data"` is the row's current value at the moment the `UPDATE` executes. Under the default `READ COMMITTED` isolation, when two transactions update the same row, the second one blocks on the row lock until the first commits, then re-reads the *new* row version and re-evaluates both its `WHERE` clause and its `SET` expressions against it. So every append builds on the previous one. No retry loop, no version column, no read round trip.

## Option 1: one UPDATE through ExecuteSqlAsync

The most direct fix is to write the statement yourself:

```csharp
// .NET 10, EF Core 10.0.4, PostgreSQL 18.4
var label = "urgent";
await db.Database.ExecuteSqlAsync($$"""
    UPDATE "Tickets"
    SET "Data" = jsonb_set("Data", '{Labels}', COALESCE("Data"->'Labels', '[]'::jsonb) || to_jsonb({{label}}::text))
    WHERE "Id" = {{id}}
    """);
```

`ExecuteSqlAsync` takes a `FormattableString`, so `{{label}}` and `{{id}}` become real parameters (`@p0`, `@p1`), not string concatenation. The `$$` raw string is deliberate: it lets the jsonb path literal `'{Labels}'` keep its single braces while `{{...}}` marks the holes. With the same 20 parallel tasks, this version ends with 21 labels every time.

Three pieces of that statement each exist for a reason:

- `jsonb_set(doc, '{Labels}', newArray)` replaces just the `Labels` key and keeps every other key in the document as it is *right now*, including an `Events` entry another request appended a millisecond ago.
- `COALESCE("Data"->'Labels', '[]'::jsonb)` covers rows written before `Labels` existed. `NULL || anything` is `NULL`, and `jsonb_set` with a `NULL` new value returns `NULL` for the whole document, which on a `NOT NULL` column is an error and on a nullable one is data loss.
- `::text` on the parameter gives `to_jsonb` a concrete type. Without it, a literal you inline yourself fails with `42804: could not determine polymorphic type because input has type unknown`.

Appending an object, such as a new history event, works the same way. Serialize it and cast it to `jsonb`:

```csharp
// .NET 10, EF Core 10.0.4, System.Text.Json
var ev = new TicketEvent { Kind = "escalated", At = DateTime.UtcNow };
var json = JsonSerializer.Serialize(ev);
await db.Database.ExecuteSqlAsync($$"""
    UPDATE "Tickets"
    SET "Data" = jsonb_set("Data", '{Events}', COALESCE("Data"->'Events', '[]'::jsonb) || jsonb_build_array({{json}}::jsonb))
    WHERE "Id" = {{id}}
    """);
```

The result was `{"Events": [{"At": "2026-09-21T08:00:00Z", "Kind": "escalated"}], ...}`, and reading the ticket back through EF materialized the event with `DateTimeKind.Utc`. Use EF's property names in the JSON (here `Kind` and `At`, the default when there is no `HasJsonPropertyName` in the model), because EF reads the document by those keys.

## Option 2: stay in LINQ with a mapped function and ExecuteUpdateAsync

Raw SQL works, but it hard-codes table and column names that EF otherwise owns. EF Core 10 added `ExecuteUpdateAsync` support for properties inside a `ToJson()` complex type, so the natural thing to try is:

```csharp
// Does NOT translate in EF Core 10.0.4 / Npgsql 10.0.3
await db.Tickets.Where(t => t.Id == id).ExecuteUpdateAsync(s =>
    s.SetProperty(t => t.Data.Labels, t => t.Data.Labels.Append("x").ToList()));
```

It fails with `The LINQ expression '...AsQueryable().Append("x")' could not be translated`, and the `Concat(new[] { "y" }).ToList()` variant fails with `does not represent a valid value`. Npgsql does not translate list-append operators on a JSON primitive collection in a setter.

What *does* work is a user-defined function whose return type is the collection type. EF lets that sit on the right side of `SetProperty`, and wraps it in the `jsonb_set` itself. Create the function in a migration:

```csharp
// EF Core 10 migration
migrationBuilder.Sql("""
    CREATE OR REPLACE FUNCTION jsonb_append_text(arr jsonb, elem text)
    RETURNS jsonb LANGUAGE sql IMMUTABLE
    AS $$ SELECT COALESCE(NULLIF(arr, 'null'::jsonb), '[]'::jsonb) || to_jsonb(elem) $$;
    """);
```

Then declare a C# stub and map it:

```csharp
// .NET 10, EF Core 10.0.4
public static class JsonbFn
{
    public static List<string> Append(List<string> array, string element)
        => throw new InvalidOperationException("Only usable in EF Core queries.");
}

// in OnModelCreating
b.HasDbFunction(typeof(JsonbFn).GetMethod(nameof(JsonbFn.Append))!)
    .HasName("jsonb_append_text");
```

The call site is now plain, typed EF:

```csharp
await db.Tickets.Where(t => t.Id == id).ExecuteUpdateAsync(s =>
    s.SetProperty(t => t.Data.Labels, t => JsonbFn.Append(t.Data.Labels, label)));
```

and the SQL EF generates is:

```sql
UPDATE "Tickets" AS t
SET "Data" = jsonb_set(t."Data", '{Labels}', COALESCE(to_jsonb(jsonb_append_text(t."Data" -> 'Labels', @label)), 'null'::jsonb))
WHERE t."Id" = @id
```

Twenty parallel callers, 21 labels, every run. The extra `to_jsonb(...)` around a value that is already `jsonb` is a no-op that EF adds for every JSON property it sets. The `NULLIF(arr, 'null'::jsonb)` in the function covers a document that holds `"Labels": null` rather than no key at all. Without it, `'null'::jsonb || '"x"'` quietly produces `[null, "x"]`.

### The same thing without a migration: HasTranslation

If you cannot add database objects, you can have EF emit built-in functions instead. `jsonb_insert(array, '{-1}', element, true)` inserts after the last element, which is an append:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore.Query.SqlExpressions;

b.HasDbFunction(typeof(JsonbFn).GetMethod(nameof(JsonbFn.Push))!)
    .HasTranslation(a =>
    {
        var jsonb = a[0].TypeMapping;
        var arr = new SqlFunctionExpression("COALESCE",
            [
                new SqlFunctionExpression("NULLIF", [a[0], new SqlFragmentExpression("'null'::jsonb")],
                    nullable: true, argumentsPropagateNullability: [false, false], typeof(string), jsonb),
                new SqlFragmentExpression("'[]'::jsonb"),
            ],
            nullable: false, argumentsPropagateNullability: [false, false], typeof(string), jsonb);
        var elem = new SqlFunctionExpression("to_jsonb",
            [new SqlUnaryExpression(ExpressionType.Convert, a[1], typeof(string), a[1].TypeMapping)],
            nullable: true, argumentsPropagateNullability: [true], typeof(string), jsonb);
        return new SqlFunctionExpression("jsonb_insert",
            [arr, new SqlFragmentExpression("'{-1}'"), elem, new SqlFragmentExpression("true")],
            nullable: true, argumentsPropagateNullability: [false, false, true, false],
            typeof(List<string>), jsonb);
    });
```

which produces:

```sql
SET "Data" = jsonb_set(t."Data", '{Labels}', jsonb_insert(COALESCE(NULLIF(t."Data" -> 'Labels', 'null'::jsonb), '[]'::jsonb), '{-1}', to_jsonb(@lbl::text), true))
```

Two details in that translation came from failures, not from style. My first version wrapped the array in `COALESCE(a[0], '[]')` directly, and EF's nullability processor removed the `COALESCE`, because the model says `Labels` is a required, non-nullable collection. Wrapping it in `NULLIF` first makes the expression nullable, so the `COALESCE` survives, and it handles JSON `null` for free. The `Convert` node is the `::text` cast. Without it, a call with a constant (`JsonbFn.Push(t.Data.Labels, "a")`) inlines `'a'` untyped and hits the same `42804` error as above. With a captured variable it worked either way, which is exactly the kind of bug that passes code review.

The function-in-a-migration route is less code and easier to read. Use `HasTranslation` only when adding a function to the database is not an option.

## Making the append idempotent

Retries, at-least-once message delivery, and double-clicked buttons all turn "append" into "append twice". Put the guard in the same statement:

```csharp
// .NET 10, EF Core 10.0.4
var n = await db.Tickets
    .Where(t => t.Id == id && !t.Data.Labels.Contains(label))
    .ExecuteUpdateAsync(s => s.SetProperty(t => t.Data.Labels, t => JsonbFn.Push(t.Data.Labels, label)));
// n == 1 when the label was added, 0 when it was already there
```

Npgsql translates `Contains` on a JSON primitive collection to the containment operator:

```sql
WHERE t."Id" = @id AND NOT ((t."Data" -> 'Labels') @> to_jsonb(@l))
```

Because PostgreSQL re-evaluates the `WHERE` clause after it waits on the row lock, this holds under concurrency, not just sequentially. Twenty parallel tasks all appending `"dup"` produced a total of exactly one affected row and `["hardware", "dup"]`, on every run. The affected-row count is also your answer to "did I add it", with no second query. If you need set semantics across *different* rows, for example "no two tickets share an external id", that belongs in a unique index, not in a JSON array.

## When you actually need read-modify-write

Sometimes the new element depends on the existing ones, for example "append unless the last event is already `closed`", and that logic does not fit neatly in SQL. Then keep `SaveChangesAsync`, but make lost updates detectable with an optimistic concurrency token. On PostgreSQL, the system column `xmin` changes on every update, and Npgsql maps it with a `uint` property marked `[Timestamp]`:

```csharp
// .NET 10, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
public class Ticket
{
    public int Id { get; set; }
    public required TicketData Data { get; set; }

    [Timestamp]
    public uint Version { get; set; }   // mapped to xmin, no migration column
}
```

Now a stale write throws `DbUpdateConcurrencyException` instead of silently winning, and you retry by reloading. With the same 20 parallel appenders and a reload-and-retry loop, all 21 labels landed, at the cost of **167** conflicts and retries. That number is why the in-database append is the default recommendation. Optimistic concurrency is correct, but under contention on a hot row it is a retry storm.

## Gotchas worth knowing before production

- **`ExecuteSqlRawAsync` and `SqlQueryRaw` treat braces as format holes, even with zero parameters.** `ExecuteSqlRawAsync("... jsonb_set(\"Data\", '{Labels}', ...)")` throws `FormatException: Input string was not in a correct format` before anything reaches PostgreSQL. Double the braces (`'{{Labels}}'`) or use the interpolated `ExecuteSqlAsync` with a `$$` raw string as shown above.
- **Appending an array appends its elements, not the array.** `'["a"]' || '["b"]'` is `["a", "b"]`. If the element you append can itself be an array, wrap it: `|| jsonb_build_array(@x::jsonb)`.
- **`to_jsonb` of a JSON string gives you a string.** `'["a"]' || to_jsonb('{"k":1}'::text)` appends the *text* `"{\"k\":1}"`. Serialized objects need `::jsonb`, not `to_jsonb`.
- **`jsonb_set` does not create missing parents.** `jsonb_set('{}', '{A,B}', '[1]')` returns `{}` unchanged. For a nested path, make sure the parent object exists, or build it with `jsonb_set` one level at a time.
- **Complex collections cannot be the return type of a mapped function.** Mapping `List<TicketEvent> PushEvent(List<TicketEvent>, string)` fails at model build with `The DbFunction 'JsonbFn.PushEvent(...)' has an invalid return type 'List<TicketEvent>'`. For arrays of objects, use Option 1.
- **Order is commit order, not call order.** Concurrent appends land in the order their transactions commit, so `l11` can come before `l10`. If order matters, append a timestamp or sequence number and sort on read.
- **Watch document size.** Each append rewrites the whole `jsonb` value on disk (PostgreSQL has no in-place JSON update, and large values are TOASTed). A history that grows without bound belongs in its own table.
- **Owned types do not get this.** EF Core's `ExecuteUpdate` support for JSON requires `ComplexProperty(...).ToJson()`. If you are still on `OwnsOne(...).ToJson()`, only Option 1 applies.

### Read next

- [How to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) covers the `ToJson()` mapping this post builds on.
- [Complex types vs owned entities in EF Core 11](/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) explains why `ExecuteUpdate` into JSON only works for complex types.
- [How to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) goes deeper on set-based updates, including their change-tracker blind spots.
- [EF Core ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) compares the two write paths in general.
- [How to implement optimistic concurrency with a rowversion token in EF Core 11](/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) is the SQL Server counterpart of the `xmin` approach above.

### Sources

- [JSON Functions and Operators](https://www.postgresql.org/docs/current/functions-json.html), PostgreSQL documentation (`||`, `@>`, `jsonb_set`, `jsonb_insert`)
- [Transaction Isolation: Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED), PostgreSQL documentation
- [JSON Mapping](https://www.npgsql.org/efcore/mapping/json.html), Npgsql EF Core provider documentation
- [Concurrency Tokens](https://www.npgsql.org/efcore/modeling/concurrency.html), Npgsql EF Core provider documentation (`xmin`)
- [What's New in EF Core 10: ExecuteUpdate support for relational JSON columns](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#executeupdate-support-for-relational-json-columns), Microsoft Learn
- [User-defined function mapping](https://learn.microsoft.com/en-us/ef/core/querying/user-defined-function-mapping), EF Core documentation
- [`NpgsqlQuerySqlGenerator.cs` at `v10.0.3`](https://github.com/npgsql/efcore.pg/blob/v10.0.3/src/EFCore.PG/Query/Internal/NpgsqlQuerySqlGenerator.cs), npgsql/efcore.pg
