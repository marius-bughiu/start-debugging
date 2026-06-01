---
title: "How to use query splitting to avoid a cartesian explosion in EF Core 11"
description: "When you Include two sibling collections, EF Core 11 returns the cross product and your row count explodes. Here is how AsSplitQuery fixes it, how to turn it on globally, and the consistency and ordering gotchas to watch for."
pubDate: 2026-06-01
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "sql-server"
  - "how-to"
---

Short answer: when a single LINQ query loads two or more collection navigations at the same level (`.Include(b => b.Posts).Include(b => b.Contributors)`), EF Core translates it into one SQL statement with sibling JOINs, and the database returns the cross product of both collections. A blog with 50 posts and 20 contributors comes back as 1000 rows. Call `.AsSplitQuery()` and EF Core 11 issues one query per collection instead, so you get 50 + 20 = 70 rows across separate round trips. The fix is one method call, but there are three things that bite people: data consistency across the split queries, the extra reference joins repeated in each query, and ordering correctness with `Skip`/`Take`.

This post is on .NET 11 and EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.x) against SQL Server, but the cartesian-explosion mechanics and the `AsSplitQuery` API are identical on PostgreSQL and SQLite. I will show the exploded SQL, the split SQL, how to set the behavior per query and globally, and how to decide between the two.

## What a cartesian explosion actually is

A relational JOIN between a parent and one child collection is fine. The trouble starts when you JOIN a parent to two child collections that hang off the same parent. Take the canonical blog model:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; set; } = [];
    public List<Contributor> Contributors { get; set; } = [];
}

public sealed class Post
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public string Title { get; set; } = "";
}

public sealed class Contributor
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public string FirstName { get; set; } = "";
}
```

Now load a blog with both collections in one query:

```csharp
var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .ToListAsync();
```

EF Core 11 produces a single statement with two `LEFT JOIN`s at the same level:

```sql
SELECT [b].[Id], [b].[Name],
       [p].[Id], [p].[BlogId], [p].[Title],
       [c].[Id], [c].[BlogId], [c].[FirstName]
FROM [Blogs] AS [b]
LEFT JOIN [Posts] AS [p] ON [b].[Id] = [p].[BlogId]
LEFT JOIN [Contributors] AS [c] ON [b].[Id] = [c].[BlogId]
ORDER BY [b].[Id], [p].[Id]
```

Because `Posts` and `Contributors` are both collections of `Blog`, the database has no choice but to return a cross product: every post row is paired with every contributor row for that blog. A blog with 50 posts and 20 contributors yields 50 * 20 = 1000 rows, and every one of those rows repeats the full `Blog` columns and the post columns and the contributor columns. EF Core de-duplicates the materialized objects on the client, so you still get one `Blog` with 50 posts and 20 contributors, but the wire paid for 1000 rows of redundant data.

The multiplier is the product of the collection sizes, not the sum. Add a third sibling collection with 10 rows and you are at 50 * 20 * 10 = 10,000 rows for a single parent. This is why a query that looks innocent in development, where every blog has two posts, can transfer hundreds of megabytes in production where blogs have hundreds of posts. The [official EF Core single vs. split queries guide](https://learn.microsoft.com/en-us/ef/core/querying/single-split-queries) documents a real case where the row count dropped from over 133,000 to just over 1,000 after splitting.

One important non-case: nested includes at different levels do not explode. `.Include(b => b.Posts).ThenInclude(p => p.Comments)` is `Comments` hanging off `Post`, not off `Blog`, so each comment maps to exactly one row and there is no cross product. Cartesian explosion is specifically about sibling collections at the same level.

## The warning EF Core already gives you

EF Core 11 does not silently let this happen without a hint. When it detects a query that loads multiple collections and you have not chosen a splitting behavior, it raises `MultipleCollectionIncludeWarning` through the logging pipeline. By default it is logged, not thrown, so it is easy to miss in a noisy log. You can promote it to an exception so it fails fast in development:

```csharp
// .NET 11, EF Core 11.0.0
services.AddDbContext<BloggingContext>(options =>
{
    options.UseSqlServer(connectionString);
    options.ConfigureWarnings(w =>
        w.Throw(RelationalEventId.MultipleCollectionIncludeWarning));
});
```

With this in place, any query that includes two sibling collections without an explicit `AsSingleQuery()` or `AsSplitQuery()` throws at execution time, forcing the author to make a deliberate choice. This is the same defensive posture I recommend for hunting performance regressions in [the guide to detecting N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): make the framework loud about the patterns that scale badly, rather than discovering them under load.

## The fix: AsSplitQuery

Add one operator to the query:

```csharp
var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

EF Core 11 now emits three separate SQL statements over the same connection: the root query for the blogs, one query for the posts, and one for the contributors.

```sql
-- Query 1: the roots
SELECT [b].[Id], [b].[Name]
FROM [Blogs] AS [b]
ORDER BY [b].[Id]

-- Query 2: posts, correlated back to the roots
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Posts] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id]

-- Query 3: contributors, correlated back to the roots
SELECT [c].[Id], [c].[BlogId], [c].[FirstName], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Contributors] AS [c] ON [b].[Id] = [c].[BlogId]
ORDER BY [b].[Id]
```

The same blog now costs 50 post rows plus 20 contributor rows plus 1 root row, 71 rows total instead of 1000. No data is duplicated, because the blog columns appear once in query 1 rather than being stamped onto every cross-product row. EF Core stitches the three result sets back together on the client using the correlating key, which is why each child query re-selects `[b].[Id]` and orders by it.

The returned object graph is byte-for-byte identical to the single-query version. `AsSplitQuery` changes only how the data travels, never what you get back. That makes it a safe drop-in for any read query where the parent has multiple large collections.

## Turning split queries on globally

If most of your queries fan out into multiple collections, flipping the default is cleaner than sprinkling `AsSplitQuery()` everywhere. Configure it on the provider options with `UseQuerySplittingBehavior`:

```csharp
// .NET 11, EF Core 11.0.0
services.AddDbContext<BloggingContext>(options =>
{
    options.UseSqlServer(connectionString,
        sql => sql.UseQuerySplittingBehavior(QuerySplittingBehavior.SplitQuery));
});
```

The `QuerySplittingBehavior` enum has two values: `SingleQuery` (the framework default, JOIN everything into one statement) and `SplitQuery` (one statement per collection). Once the global default is `SplitQuery`, you opt individual queries back into a single statement with `AsSingleQuery()`:

```csharp
var blog = await ctx.Blogs
    .Include(b => b.Posts)
    .AsSingleQuery()       // override the global SplitQuery default
    .FirstAsync(b => b.Id == id);
```

A reasonable rule of thumb: use `AsSingleQuery` for queries that load exactly one collection (no explosion is possible, and you save a round trip), and let the global `SplitQuery` default handle everything with two or more. Setting the global default also silences `MultipleCollectionIncludeWarning`, because you have now made an explicit choice for the whole context.

## When split queries are the wrong call

Splitting is not a free win, and treating it as one is how you trade a bandwidth problem for a latency or a correctness problem. Three drawbacks to weigh:

**Each split is a separate round trip.** Three collections means three round trips to the database. On a low-latency local network that is invisible, but against a cloud database with 15 ms of round-trip latency, three sequential queries add 45 ms of pure waiting before any work happens. If your collections are small (a handful of rows each), the cross product is tiny and a single JOIN query that pays one round trip is faster than three split queries that each pay their own. Split queries win when the collections are large enough that the cross-product row count dwarfs the round-trip cost.

**There is no transactional consistency across the splits by default.** A single SQL statement sees one consistent snapshot of the database. Split queries are multiple statements, and if another transaction commits between query 1 and query 2, the posts you load may not match the blog state you loaded. The fix, per the official docs, is to wrap the reads in a serializable or snapshot transaction:

```csharp
// .NET 11, EF Core 11.0.0
using var tx = await ctx.Database.BeginTransactionAsync(
    System.Data.IsolationLevel.Snapshot);

var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();

await tx.CommitAsync();
```

For most read paths the brief inconsistency window does not matter, but if you are computing a total across collections that must agree, reach for snapshot isolation.

**Reference navigations get joined into every split.** If you also `Include` a to-one navigation alongside your collections, each split query repeats the join to that reference table. In EF Core 10 and earlier this was pure waste. EF Core 11 fixed it: as covered in [the post on EF Core 11 pruning reference joins in split queries](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/), the runtime now drops reference joins from the child queries that do not project them, so a `BlogType` lookup is no longer re-joined in the posts query. Note that one-to-one and many-to-one references are always loaded via JOIN even in split mode, because a reference cannot multiply rows, so there is nothing to split.

## The ordering gotcha with Skip and Take

The subtle correctness trap is pagination. Split queries correlate their result sets by ordering on a shared key, and if your ordering is not fully unique, each split query can pick a different subset of rows when combined with `Skip`/`Take`. Suppose you order blogs by `CreatedDate` and two blogs share the same date:

```csharp
// Risky on older EF: non-unique ordering with paging
var page = await ctx.Blogs
    .OrderBy(b => b.CreatedDate)
    .Skip(20).Take(10)
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

Because relational databases apply no inherent ordering, the root query and the child queries could each resolve the tie differently, returning posts for a blog that is not in your page. EF Core 10 and 11 harden this by automatically appending the primary key to the generated `ORDER BY` so the correlation key is unique, but the safe habit is to make your own ordering deterministic regardless of EF version:

```csharp
// .NET 11, EF Core 11.0.0 -- fully unique ordering
var page = await ctx.Blogs
    .OrderBy(b => b.CreatedDate)
    .ThenBy(b => b.Id)            // tie-breaker makes the order total
    .Skip(20).Take(10)
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

Adding `ThenBy(b => b.Id)` makes the order total, so every split query agrees on which 10 blogs are in the page. This costs nothing and removes a class of bug that only shows up when two rows happen to tie.

## A quick decision checklist

When you hit a query that includes multiple collections, work through this:

1. **Does the query load two or more sibling collections?** If not, you cannot have a cartesian explosion. Leave it as a single query.
2. **Are the collections large in production?** If each parent has hundreds of rows per collection, the cross product is the dominant cost. Split it.
3. **Is the database latency high (cloud, cross-region)?** If yes and the collections are small, the extra round trips may cost more than the explosion. Measure before splitting.
4. **Does the read need a consistent snapshot?** If you compute cross-collection aggregates, wrap the split in a snapshot or serializable transaction.
5. **Is there pagination?** Make the `OrderBy` fully unique with a primary-key tie-breaker.

For hot paths where the query runs thousands of times a second, combine splitting with [compiled queries in EF Core](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) so the LINQ-to-SQL translation is cached. And when the read is genuinely on the critical path and EF Core's overhead matters, the comparison in [EF Core 11 vs Dapper for bulk operations](/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/) is worth a look, though for ordinary collection loading `AsSplitQuery` closes most of the gap. If you stream results instead of materializing a list, the same splitting rules apply to [IAsyncEnumerable queries in EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/).

Cartesian explosion is one of the few EF Core performance problems with a one-line fix and an identical result set. The hard part is not the `AsSplitQuery()` call, it is knowing it is happening at all. Turn `MultipleCollectionIncludeWarning` into an exception in development, and the framework will tell you exactly which queries need the treatment before they ever reach production.

Source: [Single vs. Split Queries, EF Core docs](https://learn.microsoft.com/en-us/ef/core/querying/single-split-queries), and the [EF Core 11 what's new notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
