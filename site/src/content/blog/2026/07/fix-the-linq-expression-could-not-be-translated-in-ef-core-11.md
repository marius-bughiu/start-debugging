---
title: "Fix: \"The LINQ expression could not be translated\" in EF Core 11"
description: "EF Core 11 throws this when a Where or OrderBy calls a method it cannot turn into SQL. Rewrite the predicate into translatable operators, or pull the data client-side with AsEnumerable first."
pubDate: 2026-07-04
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
---

EF Core 11 throws `The LINQ expression could not be translated` when a part of your query outside the final `Select` (usually a `Where`, `OrderBy`, `GroupBy`, or `Join`) calls a method or uses a construct the database provider cannot convert to SQL. Fix it by rewriting the predicate with operators EF can translate (`==`, `Contains`, `StartsWith`, `EF.Functions.*`), or, if you genuinely need in-memory logic, force client evaluation on purpose by calling `AsEnumerable()`, `AsAsyncEnumerable()`, `ToList()`, or `ToListAsync()` before the untranslatable step. This applies to `Microsoft.EntityFrameworkCore` 11.0 on .NET 11 with C# 14, and the behaviour is unchanged from EF Core 3.0 onward.

## The error in context

The full runtime exception looks like this. EF Core prints the exact expression tree it choked on, which is the single most useful clue on the whole screen:

```
System.InvalidOperationException: The LINQ expression 'DbSet<Order>()
    .Where(o => o.CustomerName.Equals(
        name,
        StringComparison.OrdinalIgnoreCase))' could not be translated. Either rewrite the query in a form that can be translated, or switch to client evaluation explicitly by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'. See https://go.microsoft.com/fwlink/?linkid=2101038 for more information.
```

The exception type is `System.InvalidOperationException`, and it is thrown when the query is executed (at `ToList`, `First`, `foreach`, or `await`), not when you compose it. That is why a stack trace often points at your repository or controller line rather than the `Where` that actually caused it. Read the quoted expression, not the stack trace.

## Why this happens

EF Core translates as much of your query as it can into a single SQL statement and runs it on the database server. Since version 3.0, it supports partial client evaluation in exactly one place: the top-level projection, meaning the last `Select` call. If any other part of the query, a `Where`, `OrderBy`, `Skip`, `GroupBy`, `Join`, or a nested subquery, contains an expression it cannot translate, it refuses to silently pull the whole table into memory and filter there. Instead it throws.

That deliberate refusal is a feature. Before EF Core 3.0, the framework would happily evaluate an untranslatable `Where` on the client, which meant a query that looked cheap could quietly download a million rows and filter them in your process. The current behaviour trades a loud exception at development time for a class of production performance disasters you never see. When you hit this error, EF Core is telling you that the predicate you wrote has no SQL equivalent.

The usual triggers are:

- Calling a C# method with no SQL mapping (a custom helper, `string.Equals` with a `StringComparison`, `Enum.HasFlag`, `decimal.Round` with a `MidpointRounding`).
- Formatting or parsing inside the query (`DateTime.ToString("yyyy-MM-dd")`, `int.Parse`, `Guid.Parse`).
- Navigating or calling into a type the provider cannot map (a computed property backed by C# logic, not a mapped column).
- Comparing against a construct the provider does not support for your database (some `TimeSpan` arithmetic, certain `Span`-based APIs).

## Minimal repro

Here is the smallest program that reproduces it. Case-insensitive matching with a `StringComparison` overload is the most common real-world cause, because it reads perfectly in C# and is completely untranslatable:

```csharp
// .NET 11, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();

string name = "acme";

// Throws at ToListAsync: StringComparison has no SQL translation.
var orders = await db.Orders
    .Where(o => o.CustomerName.Equals(name, StringComparison.OrdinalIgnoreCase))
    .ToListAsync();

public class Order
{
    public int Id { get; set; }
    public string CustomerName { get; set; } = "";
    public DateTime PlacedOn { get; set; }
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Shop;Trusted_Connection=True;Encrypt=False");
}
```

The `Equals(name, StringComparison.OrdinalIgnoreCase)` call is the problem. EF Core has no way to express "ordinal, case-insensitive" as SQL, because case sensitivity in SQL is governed by the column's collation, not by a method argument. So it throws.

## Fix, in detail

The fixes are ordered from best (keep the work on the server) to last resort (pull data into memory on purpose).

### 1. Rewrite the predicate with translatable operators

Ninety percent of the time the fix is to express the same intent using operators EF Core knows. For case-insensitive comparison, drop the `StringComparison` overload entirely. On SQL Server the default collation is already case-insensitive, so a plain `==` does what you want and translates to a clean `WHERE`:

```csharp
// .NET 11, EF Core 11 -- translates to WHERE [o].[CustomerName] = @name
var orders = await db.Orders
    .Where(o => o.CustomerName == name)
    .ToListAsync();
```

If you need case-insensitive matching regardless of the column collation, use `EF.Functions.Collate` to pin the comparison to a case-insensitive collation, which the provider translates to a `COLLATE` clause:

```csharp
// .NET 11, EF Core 11 -- explicit case-insensitive comparison in SQL
var orders = await db.Orders
    .Where(o => EF.Functions.Collate(o.CustomerName, "SQL_Latin1_General_CP1_CI_AS") == name)
    .ToListAsync();
```

The `EF.Functions` surface exists precisely for this: `Like`, `Collate`, `DateDiffDay`, `Contains` (full-text), `Random`, and provider-specific helpers all give you SQL constructs that raw C# cannot express. Reach for it before you give up on server evaluation. For substring matching, prefer `Contains`, `StartsWith`, and `EndsWith`, all of which translate to `LIKE`:

```csharp
// .NET 11, EF Core 11 -- translates to WHERE [o].[CustomerName] LIKE @p + '%'
var orders = await db.Orders
    .Where(o => o.CustomerName.StartsWith(name))
    .ToListAsync();
```

### 2. Compute the value before the query, not inside it

A huge share of these errors are self-inflicted: you call a method inside the query whose result does not actually depend on the row. Hoist it into a local variable and EF Core turns it into a parameter:

```csharp
// Throws: ToString() on a DateTime cannot be translated
var bad = await db.Orders
    .Where(o => o.PlacedOn.ToString("yyyy") == "2026")
    .ToListAsync();

// Fixed: compare the mapped column directly, no formatting in SQL
var year = 2026;
var good = await db.Orders
    .Where(o => o.PlacedOn.Year == year)
    .ToListAsync();
```

`DateTime.Year`, `Month`, `Day`, `Date`, and friends do translate (to `DATEPART` on SQL Server), while `ToString(format)` does not. The rule of thumb: extract the piece of data you need with a property EF can map, rather than formatting the whole value into a string and matching on that.

### 3. Move client-only logic into the top-level projection

Remember that EF Core allows client evaluation in the last `Select`. If your untranslatable method is really about shaping output, not filtering, move it there. This query filters and orders in SQL, then runs the C# helper on only the rows that came back:

```csharp
// .NET 11, EF Core 11 -- filter in SQL, format on the client in the projection
var rows = await db.Orders
    .Where(o => o.PlacedOn.Year == 2026)      // server
    .OrderByDescending(o => o.PlacedOn)        // server
    .Select(o => new
    {
        o.Id,
        Display = FormatCustomer(o.CustomerName) // client, allowed here
    })
    .ToListAsync();

static string FormatCustomer(string raw) => raw.Trim().ToUpperInvariant();
```

`FormatCustomer` would throw in a `Where`, but in the final `Select` it is legal and runs in memory on the filtered result set. This is the sanctioned way to combine SQL filtering with C# formatting.

### 4. Force client evaluation on purpose (last resort)

If the logic genuinely cannot run in SQL and must sit in a `Where`, opt into client evaluation explicitly by breaking the query with `AsEnumerable` or `AsAsyncEnumerable`. Everything before the break runs on the server; everything after runs in memory:

```csharp
// .NET 11, EF Core 11 -- narrow in SQL first, then filter in memory
var orders = db.Orders
    .Where(o => o.PlacedOn.Year == 2026)   // runs in SQL, cuts the row count down
    .AsAsyncEnumerable();                    // boundary: client evaluation from here

var matched = new List<Order>();
await foreach (var o in orders)
{
    if (o.CustomerName.Equals(name, StringComparison.OrdinalIgnoreCase))
        matched.Add(o);
}
```

The critical detail is to put as much filtering as possible before the `AsEnumerable` boundary so you transfer the fewest rows. Calling `AsEnumerable()` on a bare `DbSet` and filtering afterward downloads the entire table, which is exactly the disaster the exception was protecting you from. Prefer `AsAsyncEnumerable` over `ToList` here so you stream rather than buffer the intermediate result.

## Gotchas and variants

**It worked in EF Core 2.2 and broke on upgrade.** Client evaluation everywhere was removed in EF Core 3.0. A query that "worked" before was probably filtering in memory the whole time. The upgrade did not break your query, it exposed a latent performance problem. If you are moving between major versions, the [breaking changes that actually bite when migrating EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) are worth a read before you start.

**The in-memory provider does not throw, the real one does.** If your unit tests use the in-memory provider they evaluate everything client-side and never see this error, then production against SQL Server or PostgreSQL throws on the same query. Test against a provider that translates. Running your suite against a real database with something like Testcontainers catches these before they ship.

**A `GroupBy` that projects to something SQL cannot aggregate.** `GroupBy` followed by a `Select` that returns raw grouped entities (rather than aggregates like `Count`, `Sum`, `Max`) frequently cannot be translated. Reshape the projection into scalar aggregates, or group on the client after materializing.

**Navigation properties and unmapped computed members.** Filtering on a C# computed property (a getter with logic, not a mapped column) cannot translate, because there is no column behind it. Map a persisted/computed column, or filter on the underlying columns instead.

**`Contains` on a large local list.** `Where(o => ids.Contains(o.Id))` does translate (to `IN` or a table-valued parameter in EF Core 11), but a related "could not be translated" can appear when the element type is complex. Keep the `Contains` argument a simple list of scalars.

**A different error, same trigger.** If you see `The LINQ expression could not be translated` and just below it a note about `AsSplitQuery`, you are hitting a translation limit in a query with multiple collection includes, not a client-eval problem. That one is about cartesian explosion, and the fix is [query splitting to avoid a cartesian explosion in EF Core 11](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/), not rewriting a predicate.

The mental model that keeps you out of this error for good: everything except the final `Select` has to become SQL. Before you write a `Where`, ask whether the database could run it. If the answer involves a C# method the database has never heard of, either find the `EF.Functions` equivalent, precompute the value, or accept that you are pulling rows into memory and say so explicitly with `AsAsyncEnumerable`.

## Related

- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) covers the other silent query performance trap that survives client-eval blocking.
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) is worth reading once your read queries translate cleanly and you want them faster.
- [How to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) shows how to keep JSON predicates on the server instead of materializing and filtering.
- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) helps once your query is translatable and you are tuning throughput.
- [How to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) is the write-side equivalent of keeping work in the database instead of in memory.

## Sources

- [Client vs. Server Evaluation, EF Core docs](https://learn.microsoft.com/en-us/ef/core/querying/client-eval)
- [How Queries Work, EF Core docs](https://learn.microsoft.com/en-us/ef/core/querying/how-query-works)
- [Database functions and EF.Functions, EF Core docs](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions)
- [dotnet/efcore issue #24318: "could not be translated" with the in-memory provider](https://github.com/dotnet/efcore/issues/24318)
