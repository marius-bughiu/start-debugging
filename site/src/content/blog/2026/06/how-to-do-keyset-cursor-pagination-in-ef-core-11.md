---
title: "How to do keyset (cursor) pagination in EF Core 11"
description: "Replace Skip/Take with a WHERE clause that seeks past the last row you saw. Order by a fully unique key, carry the last row's values as a cursor, and EF Core 11 turns the next page into an index seek instead of an OFFSET scan."
pubDate: 2026-06-23
template: how-to
tags:
  - "how-to"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
---

Short answer: stop paging with `Skip(n).Take(pageSize)` and start paging with a `WHERE` clause. Keyset pagination (also called cursor or seek pagination) remembers the ordering values of the last row on the page you just showed, then asks the database for the rows that sort after it: `OrderBy(x => x.CreatedAt).ThenBy(x => x.Id).Where(x => x.CreatedAt > lastDate || (x.CreatedAt == lastDate && x.Id > lastId)).Take(pageSize)`. With an index on the ordering columns, every page is an index seek of constant cost, instead of an `OFFSET` that re-scans and discards every row before the page. The one hard requirement: order by something fully unique, which in practice means a real sort key plus the primary key as a tiebreaker.

This post uses `Microsoft.EntityFrameworkCore` 11.0.0 on .NET 11 with C# 14, against SQL Server 2025. Everything here works the same on PostgreSQL and SQLite; the only provider-specific note is at the end. If you have ever watched page 500 of a grid take ten times longer than page 1, this is the fix.

## Why Skip/Take gets slower the deeper you page

Offset pagination is the obvious first thing everyone writes. Page size 20, page 30, skip 580 rows:

```csharp
// .NET 11, EF Core 11.0.0 - offset pagination, the slow way
var page = 30;
var pageSize = 20;

var posts = await context.Posts
    .OrderBy(p => p.PostId)
    .Skip((page - 1) * pageSize)
    .Take(pageSize)
    .ToListAsync();
```

EF Core translates `Skip`/`Take` to SQL `OFFSET`/`FETCH` (or `LIMIT`/`OFFSET` on PostgreSQL and SQLite):

```sql
SELECT [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
ORDER BY [p].[PostId]
OFFSET 580 ROWS FETCH NEXT 20 ROWS ONLY;
```

The problem is what `OFFSET 580` actually does. The database does not jump to row 581. It produces all 600 rows in order, counts off the first 580, throws them away, and returns the last 20. The work scales with the offset, not the page size, so deep pages get progressively more expensive. On a hot table this is exactly backwards from what users expect: the further they scroll, the slower it gets.

There is a second, quieter bug. Offset pagination is not stable under concurrent writes. The official EF Core [pagination guidance](https://learn.microsoft.com/en-us/ef/core/querying/pagination) spells it out: if a row is inserted or deleted between two page requests, the whole result set shifts by one, and a user moving from page 2 to page 3 either sees a row twice or skips one entirely. For an admin grid nobody notices. For an infinite-scroll feed where rows are constantly being added at the top, it is a visible, reproducible defect.

## What a keyset query does instead

Keyset pagination throws away the idea of an offset. Instead of "skip 580 rows", you say "give me the rows that come after this specific row I already have". You remember the last row's sort values, and the next page is a `WHERE` that seeks straight past them:

```csharp
// .NET 11, EF Core 11.0.0 - keyset pagination, single unique key
var pageSize = 20;
int? lastPostId = 580; // the PostId of the last row on the previous page; null for page 1

var query = context.Posts.OrderBy(p => p.PostId).AsQueryable();

if (lastPostId is int cursor)
{
    query = query.Where(p => p.PostId > cursor);
}

var posts = await query.Take(pageSize).ToListAsync();
```

That translates to:

```sql
SELECT TOP(20) [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
WHERE [p].[PostId] > 580
ORDER BY [p].[PostId];
```

With an index on `PostId` (the clustered primary key already is one), the database seeks directly to the first row greater than 580 and reads 20 rows. There is no scan-and-discard. Page 1 and page 10,000 cost the same. And because the cursor is a value, not a position, an insert or delete elsewhere in the table cannot shift your window: you always continue from the exact row you last saw.

The catch is in the name: keyset pagination needs a *key*. The column (or columns) you order by must produce a strict, total order across rows. If two rows can tie on the sort key, the `>` comparison cannot tell the database which side of the boundary a tied row belongs on, and you will silently skip or repeat rows. `PostId` is unique, so it works alone. A `CreatedAt` timestamp is almost never unique, so it does not, and that is where most real queries live.

## Ordering by a non-unique column: add a tiebreaker

The realistic case is "newest first", ordering by a `CreatedAt` that can collide down to the millisecond. The fix the docs call out in a warning at the top of the [pagination page](https://learn.microsoft.com/en-us/ef/core/querying/pagination) is to make the ordering fully unique by appending a unique column, almost always the primary key:

```csharp
// .NET 11, EF Core 11.0.0 - keyset over (CreatedAt DESC, PostId DESC)
var pageSize = 20;

// Cursor carried from the last row of the previous page (null on page 1).
DateTime? lastCreatedAt = previousCursor?.CreatedAt;
int? lastPostId = previousCursor?.PostId;

var query = context.Posts
    .OrderByDescending(p => p.CreatedAt)
    .ThenByDescending(p => p.PostId)
    .AsQueryable();

if (lastCreatedAt is DateTime ca && lastPostId is int id)
{
    // Rows that sort strictly after the cursor in (CreatedAt DESC, PostId DESC).
    query = query.Where(p =>
        p.CreatedAt < ca || (p.CreatedAt == ca && p.PostId < id));
}

var posts = await query.Take(pageSize).ToListAsync();
```

The `WHERE` clause is the whole trick, so read it carefully. You are sorting descending, so "after the cursor" means smaller. A row belongs on the next page if its `CreatedAt` is strictly older than the cursor's (`p.CreatedAt < ca`), or its `CreatedAt` ties exactly and its `PostId` breaks the tie in the same direction (`p.CreatedAt == ca && p.PostId < id`). That `==` branch is the part people drop, and dropping it is exactly how rows that share a timestamp get skipped at page boundaries. The comparison direction in the `WHERE` must mirror the `OrderBy` direction precisely: ascending order uses `>`, descending uses `<`. Mix them up and your pages either overlap or leave gaps.

The generated SQL is a single seek:

```sql
SELECT TOP(20) [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
WHERE [p].[CreatedAt] < @ca OR ([p].[CreatedAt] = @ca AND [p].[PostId] < @id)
ORDER BY [p].[CreatedAt] DESC, [p].[PostId] DESC;
```

## Wiring it up end to end

Here is the full loop: encode the cursor, return it with the page, decode it on the next request. The steps are the same whether the cursor rides in a query string or an API response body.

1. **Pick a fully unique ordering.** A meaningful sort column plus the primary key as a final tiebreaker. The order of columns here is the order everything else must follow.
2. **Define an index that matches the ordering exactly.** A composite index over `(CreatedAt DESC, PostId DESC)` lets the seek read rows already in order. Without it the database sorts the whole table on every page and the win evaporates.
3. **Build the `WHERE` from the last row's values.** One `OR` branch per ordering column, with the comparison direction matching each column's sort direction.
4. **Take `pageSize` rows.** Optionally `pageSize + 1` so you can tell whether a next page exists without a second query.
5. **Emit a cursor from the last returned row** and hand it back to the caller to send with the next request.

A minimal endpoint that returns a page plus an opaque cursor:

```csharp
// .NET 11, EF Core 11.0.0, C# 14 - minimal API keyset endpoint
app.MapGet("/posts", async (string? cursor, AppDbContext db) =>
{
    const int pageSize = 20;

    var query = db.Posts
        .AsNoTracking()
        .OrderByDescending(p => p.CreatedAt)
        .ThenByDescending(p => p.PostId)
        .AsQueryable();

    if (Cursor.TryDecode(cursor, out var ca, out var id))
    {
        query = query.Where(p =>
            p.CreatedAt < ca || (p.CreatedAt == ca && p.PostId < id));
    }

    // Fetch one extra row to detect whether a further page exists.
    var rows = await query.Take(pageSize + 1).ToListAsync();

    var hasMore = rows.Count > pageSize;
    var page = rows.Take(pageSize).ToList();

    var next = hasMore && page.Count > 0
        ? Cursor.Encode(page[^1].CreatedAt, page[^1].PostId)
        : null;

    return Results.Ok(new { items = page, nextCursor = next });
});
```

The `Cursor` helper just packs the two values into a URL-safe token so callers treat it as opaque and cannot tamper with paging semantics:

```csharp
// .NET 11, C# 14 - opaque cursor encode/decode
static class Cursor
{
    public static string Encode(DateTime createdAt, int id) =>
        Convert.ToBase64String(
            Encoding.UTF8.GetBytes($"{createdAt.Ticks}:{id}"));

    public static bool TryDecode(string? token, out DateTime createdAt, out int id)
    {
        createdAt = default;
        id = default;
        if (string.IsNullOrEmpty(token)) return false;

        var parts = Encoding.UTF8
            .GetString(Convert.FromBase64String(token))
            .Split(':');
        if (parts.Length != 2) return false;

        createdAt = new DateTime(long.Parse(parts[0]), DateTimeKind.Utc);
        id = int.Parse(parts[1]);
        return true;
    }
}
```

Note the `AsNoTracking()` on the query. These are read-only list rows, so there is no reason to pay for the change tracker; if you are unsure when that matters, see [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/). For a hot list endpoint, this query is also a strong candidate for a [compiled query](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/), since the shape never changes between requests.

## The index is not optional

Keyset pagination is only fast if the database can seek. That requires an index whose key columns and directions match your `OrderBy` exactly:

```csharp
// .NET 11, EF Core 11.0.0 - composite index matching the page order
modelBuilder.Entity<Post>()
    .HasIndex(p => new { p.CreatedAt, p.PostId })
    .IsDescending(true, true);
```

The official guidance is blunt about this in the [indexes section](https://learn.microsoft.com/en-us/ef/core/querying/pagination): your index must correspond to your pagination ordering. If you order by `(CreatedAt DESC, PostId DESC)` but index `(CreatedAt ASC, PostId ASC)`, many databases can still scan the index backwards, but the moment you add a third column or a mismatched direction, the planner falls back to a sort over the full filtered set and your constant-cost page is gone. Index direction is part of the contract, not a detail. This is the same class of "the query plan is doing something you did not ask for" problem as an accidental [N+1 query](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): the LINQ looks fine, but the plan tells the real story, so check the actual execution plan once before you ship.

## Why not the tuple syntax you have seen in raw SQL

If you have written keyset pagination in hand-rolled SQL, you have probably used row-value comparison: `WHERE (CreatedAt, PostId) < (@ca, @id)`. It is the cleaner way to express the same boundary, most relational databases support it, and it tends to produce a better plan than the unrolled `OR` chain. The bad news for EF Core 11: you still cannot write it in LINQ. The docs note this explicitly, and it is tracked by [dotnet/efcore#26822](https://github.com/dotnet/efcore/issues/26822), which remains open as of EF Core 11.0.0. So the manual `OR` expansion above is not a workaround you will throw away next version; it is the current supported approach.

If you order by three or more columns, the `OR` chain grows fast and gets error-prone. The pattern generalizes mechanically: for ordering keys `a, b, c`, the predicate is `a > a0 || (a == a0 && b > b0) || (a == a0 && b == b0 && c > c0)`. Once you have more than two keys, reach for a maintained helper such as `MR.EntityFrameworkCore.KeysetPagination`, which builds this expression tree for you from the same `OrderBy` definition and keeps the `WHERE` in sync with the sort. Hand-writing four-deep `OR` chains is how the `==` branch gets dropped.

## Paging backwards and other edge cases

A few things bite people once the happy path works:

- **Previous page.** To page backwards, flip every comparison and every `OrderBy` direction, take a page, then reverse the list in memory before returning it. You cannot reuse the forward query with a "before" cursor and the same ordering; the rows would come back in the wrong order.
- **The user has no random access.** Keyset pagination supports next and previous, not "jump to page 47". That is inherent, not a bug. If you genuinely need page-number jumps, the docs suggest a hybrid: keyset for next/previous, offset only for the rare random jump. Most feeds and infinite scrolls never need the jump at all.
- **Total count.** Keyset gives you rows, not a count of remaining pages. If the UI needs "page 3 of 200", that count is a separate `COUNT(*)` query, and on a large table it is often the expensive part, so cache it or drop the requirement.
- **Nullable sort columns.** If your sort column is nullable, `NULL` comparisons will not behave like `>`/`<`, and rows with `NULL` can vanish from paging. Either sort on non-nullable columns or add an explicit `NULL`-ordering branch.
- **Cursor stability.** The cursor encodes values, so it stays valid even if rows are inserted or deleted around it, which is the whole point. It does break if the *row it points at* is deleted and you rely on reading that row back; since you only compare against its values, that is fine, but do not assume the cursor row still exists.

Offset pagination is not always wrong. For a small admin table, or any grid where users really do click page numbers, `Skip`/`Take` is simpler and the performance difference is invisible. The moment the table is large, append-heavy, or scrolled deeply, keyset is the version that stays fast and stays correct. Order by a unique key, build the `WHERE` to match it exactly, index those columns in the same direction, and your deepest page costs the same as your first.

## Related

- [How to use query splitting to avoid a cartesian explosion in EF Core 11](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [How to use IAsyncEnumerable with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)

## Sources

- [Pagination - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/pagination)
- [Indexes - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/modeling/indexes)
- [Support row value comparisons for keyset pagination - dotnet/efcore#26822](https://github.com/dotnet/efcore/issues/26822)
- [MR.EntityFrameworkCore.KeysetPagination (GitHub)](https://github.com/mrahhal/MR.EntityFrameworkCore.KeysetPagination)
