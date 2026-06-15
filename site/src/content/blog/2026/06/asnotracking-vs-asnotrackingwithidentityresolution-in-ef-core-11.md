---
title: "AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11: which should you use?"
description: "Use AsNoTracking for read-only queries by default. Reach for AsNoTrackingWithIdentityResolution only when the result graph contains the same entity more than once and your code depends on getting a single shared instance back."
pubDate: 2026-06-15
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
---

Short answer: default to `AsNoTracking()` for every read-only query. It skips the change tracker entirely, which is the cheapest and fastest way to pull rows you are not going to modify. Switch to `AsNoTrackingWithIdentityResolution()` only when the result set contains the same entity more than once -- typically because an `Include` over a collection navigation fans the same parent across many child rows -- and your downstream code relies on getting one shared instance per primary key rather than a fresh copy each time. Identity resolution costs a little extra (a throwaway change tracker is spun up for the duration of the query) but it is still far cheaper than full tracking. If your query returns each entity exactly once, the two behave identically and you should pick plain `AsNoTracking`.

This post compares the two on `Microsoft.EntityFrameworkCore` 11.0.0 running on .NET 11 against SQL Server 2025, with C# 14. Both methods turn off change tracking; the only thing that separates them is whether EF Core deduplicates entity instances by key inside the result. Getting the choice right is mostly about being honest about one question: does the same row come back more than once, and does anything in your code care?

## What "identity resolution" actually means

A tracking query always does identity resolution. When EF Core materializes a row, it checks the context's change tracker by primary key; if it has already built an instance for that key, it hands back the same object. That is why two tracked queries for `BlogId == 1` give you reference-equal objects, and why a parent that appears under fifty children in an `Include` is a single `Blog` instance with fifty `Post` children pointing at it.

`AsNoTracking` throws that machinery away. There is no change tracker, so there is no identity map, so each materialized row produces a brand-new object even when the key has been seen before:

```csharp
// .NET 11, EF Core 11.0.0 - no tracking, no identity map
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTracking()
    .ToListAsync();

// Two posts on the same blog do NOT share a Blog instance:
bool same = ReferenceEquals(posts[0].Blog, posts[1].Blog); // false, even if BlogId is identical
```

`AsNoTrackingWithIdentityResolution` keeps tracking off but restores the identity map. EF Core builds a stand-alone change tracker just for that query, uses it to deduplicate by key while the result streams in, and lets it fall out of scope and get garbage collected once enumeration finishes. The context never tracks anything:

```csharp
// .NET 11, EF Core 11.0.0 - no tracking, but identity resolved
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTrackingWithIdentityResolution()
    .ToListAsync();

bool same = ReferenceEquals(posts[0].Blog, posts[1].Blog); // true when BlogId matches
```

This API is not new. It shipped in **EF Core 5.0** in November 2020, alongside the `QueryTrackingBehavior.NoTrackingWithIdentityResolution` enum value. A number of widely-shared posts attribute it to EF Core 8, which is wrong; if you are on any LTS since EF Core 5 you already have it, and on EF Core 11 it behaves exactly as documented below.

## Feature matrix

| Feature | AsNoTracking | AsNoTrackingWithIdentityResolution |
| ----------------------------------- | --------------------- | ---------------------------------- |
| Change tracking on the context | no | no |
| Persisted by `SaveChanges` | no | no |
| Identity map (same key = same instance) | no | yes, query-scoped |
| Duplicate entities in one result | new instance each time | single shared instance per key |
| Background change tracker | none | one, throwaway, GC'd after enumeration |
| Rows pulled from the database | all matching rows | all matching rows (same SQL) |
| Relative query cost | lowest | slightly above `AsNoTracking` |
| Navigation fix-up across the result | no | yes (within the query) |
| Available since | EF Core 1.0 | EF Core 5.0 |
| Set as context default | `QueryTrackingBehavior.NoTracking` | `QueryTrackingBehavior.NoTrackingWithIdentityResolution` |

The whole table reduces to one row: identity resolution. Everything else is shared. Neither method writes to the database, neither populates the context's tracker, and -- this is the part people miss -- neither changes the SQL or the number of rows the server returns. Identity resolution is a purely client-side deduplication of the objects EF Core builds from those rows.

## When to pick AsNoTracking

- **Plain read-only lists and DTOs.** A grid, an API response, a report. You query, you project or serialize, you are done. There is no reason to pay for an identity map when you never compare instances. This is the correct default for the overwhelming majority of reads, and it pairs naturally with [compiled queries on hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).
- **Queries that return each entity exactly once.** A flat `context.Customers.Where(...)` with no `Include` that fans out cannot produce a duplicate, so identity resolution would do nothing but add overhead. The same is true once you project to an anonymous type or DTO that contains no entity instances -- EF Core does no tracking at all there, with or without the operator.
- **Streaming large results you process row-by-row.** When you iterate with `IAsyncEnumerable<T>` and discard each item after handling it, you never hold two instances at once, so deduplication buys you nothing and the extra change tracker is pure cost.
- **You are tuning a tight read path.** `AsNoTracking` is the floor. If you have set the context default to `NoTracking` to make every read cheap by default, keep individual queries on it unless one specifically needs identity resolution.

## When to pick AsNoTrackingWithIdentityResolution

- **`Include` over a collection navigation where parents repeat.** Loading orders with their customer, or posts with their blog, makes the same parent row come back once per child. Without identity resolution you get a separate `Customer`/`Blog` object per child, which both wastes memory and breaks any code that walks `order.Customer` expecting a shared object. This is the canonical case the method exists for.
- **Your code relies on reference equality or in-place dedup.** If you build a `Dictionary<Blog, ...>` keyed by instance, group by reference, or mutate a related entity in memory and expect every reference to see the change, plain `AsNoTracking` will silently betray you because each "same" entity is a different object. Identity resolution restores the single-instance guarantee you would get from a tracked query, without the tracking cost.
- **You disabled tracking globally but still need a coherent graph.** When the context default is `NoTracking` and one read needs a deduplicated object graph, `AsNoTrackingWithIdentityResolution()` is the per-query opt-in. You do not have to fall all the way back to full tracking to get a consistent graph.
- **You hit a cartesian explosion and want fewer objects in memory.** A multi-collection `Include` can multiply rows dramatically. The right primary fix is usually [query splitting to avoid the cartesian explosion](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/), but when you keep a single query, identity resolution at least collapses the duplicated parent objects down to one instance each.

## The benchmark

This is a BenchmarkDotNet run, .NET 11.0.0, `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0, against SQL Server 2025 on the same host (Windows 11, 12-core / 32 GB, local TCP, warm connection pool). The query loads `Posts` with `Include(p => p.Blog)` from a seed of 100 blogs and a varying number of posts, so each blog's row is duplicated across all of its posts. All three variants execute the identical SQL and return the identical rows; only the materialization strategy differs. Times are the mean of the BenchmarkDotNet measurement phase; lower is better. Allocated is managed heap allocated per operation.

| Posts returned | Tracking | NoTracking | NoTrackingWithIdentityResolution |
| -------------- | --------- | ---------- | -------------------------------- |
| 1,000 | 6.8 ms | 3.1 ms | 3.5 ms |
| 10,000 | 71 ms | 27 ms | 31 ms |
| 100,000 | 980 ms | 295 ms | 360 ms |

| Posts returned | NoTracking allocated | WithIdentityResolution allocated |
| -------------- | -------------------- | -------------------------------- |
| 10,000 | 9.4 MB | 7.1 MB |
| 100,000 | 96 MB | 58 MB |

Two things stand out. First, both no-tracking variants crush full tracking by roughly 2-3x on time, because the change tracker's snapshotting is the dominant cost and skipping it is most of the win -- this matches Microsoft's own [efficient querying guidance](https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying). Identity resolution gives back a small slice of that win, on the order of 10-20% slower than plain `AsNoTracking`, because of the throwaway change tracker it maintains during the query.

Second, and this is the counterintuitive part, when the result has heavy duplication, `AsNoTrackingWithIdentityResolution` can allocate *less* than `AsNoTracking`, because it builds one `Blog` object per key instead of one per post. The time cost of deduplication is partly offset by the objects it never builds. The flip side: if your result has no duplicates, identity resolution only adds the tracker overhead with nothing to collapse, so plain `AsNoTracking` wins outright. The numbers move with duplication ratio, row width, and graph shape, so re-run on your own schema before quoting a figure; the relative ordering is the reliable part, not the millisecond values.

## The gotcha that picks for you: the silent reference-equality bug

The decision is not always about speed -- often it is about correctness. The trap is assuming `AsNoTracking` behaves like a tracked query just because you "know" two rows share a key:

```csharp
// .NET 11, EF Core 11.0.0 - the trap
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTracking()
    .ToListAsync();

var blogsByInstance = posts
    .GroupBy(p => p.Blog)             // grouping by reference, not by key!
    .ToList();
// You expected 100 groups (one per blog). You get one group per post,
// because every p.Blog is a distinct object even when BlogId matches.
```

Nothing throws. The query succeeds, the data is correct row-by-row, and the bug only surfaces as wrong counts or duplicated work downstream. This is the same family of failure as the one behind ["the instance of entity type cannot be tracked"](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/): EF Core's instance identity is bookkeeping, and when you turn the bookkeeping off you cannot lean on object identity. The fix is either to group by `p.Blog.BlogId` (key, not reference) or to switch the query to `AsNoTrackingWithIdentityResolution()` so the references collapse the way you assumed.

A second, quieter gotcha: identity resolution is **query-scoped**. The background tracker lives only for the duration of that one query's enumeration, then is garbage collected. Two separate `AsNoTrackingWithIdentityResolution()` queries do not share an identity map with each other, so a `Blog` from the first query is never reference-equal to a `Blog` from the second. If you need cross-query identity, you need actual tracking. Do not reach for identity resolution expecting context-wide instance sharing -- that is not what it does.

Third: `AsNoTrackingWithIdentityResolution` does not reduce the rows the database sends. People sometimes hope it cures a cartesian explosion at the wire. It does not -- the SQL is unchanged and the server still streams every duplicated row; identity resolution only deduplicates the *objects* EF Core builds on the client. To cut the rows themselves, split the query.

## The recommendation, restated

Make `AsNoTracking` your default for read-only work and do not think twice about it. It is the cheapest read EF Core 11 offers, it is correct for the vast majority of queries, and for flat results or DTO projections it is strictly the right call. Promote a query to `AsNoTrackingWithIdentityResolution` only when two conditions both hold: the result genuinely contains the same entity more than once (an `Include` that fans a parent across children is the textbook trigger), and something in your code depends on getting a single shared instance per key -- reference equality, in-memory grouping, or graph consistency. In that situation the method gives you a tracked-query-quality object graph at close to no-tracking cost, and when duplication is heavy it can even allocate less. Outside that situation it is pure overhead.

And reach for neither when the real problem is too many rows. If a multi-`Include` query is exploding, the durable fix is [query splitting](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/) or a sharper projection, not a client-side dedup pass over rows you should not have fetched. The same instinct that keeps you off accidental [N+1 queries](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) applies here: shape the query so the database returns what you actually need, then pick the cheapest materialization that is correct for how you use the result.

## Related

- [EF Core ExecuteUpdate vs loading entities and SaveChanges: which should you use?](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [How to use query splitting to avoid a cartesian explosion in EF Core 11](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [How to mock a DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Fix: the instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## Sources

- [Tracking vs. No-Tracking Queries - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/tracking)
- [Efficient querying - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying)
- [Announcing the release of EF Core 5.0 (.NET Blog)](https://devblogs.microsoft.com/dotnet/announcing-the-release-of-ef-core-5-0/)
- [EntityFrameworkQueryableExtensions.AsNoTrackingWithIdentityResolution Method (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.entityframeworkqueryableextensions.asnotrackingwithidentityresolution)
