---
title: "EF Core 11 Prunes Unnecessary Reference Joins in Split Queries"
description: "EF Core 11 Preview 3 removes redundant to-one joins from split queries and drops unneeded ORDER BY keys. One reported scenario got 29% faster, another 22%. Here is what the SQL now looks like."
pubDate: 2026-04-18
tags:
  - "ef-core"
  - "dotnet-11"
  - "sql-server"
  - "performance"
  - "csharp"
---

EF Core's split queries have always had a sharp edge: when you mixed `Include` of reference navigations with `Include` of collection navigations, every child query still re-joined the reference tables, even though nothing in those collection queries needed them. EF Core 11 Preview 3 fixes that, along with a related `ORDER BY` over-specification. The [release notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) clock the benchmark impact at 29% for one common split-query scenario and 22% for a single-query case. It is the kind of change that shows up in production without any LINQ edits on your side.

## The extra join that was never needed

Consider the canonical shape: a blog with a to-one `BlogType` and a to-many `Posts`, loaded with `AsSplitQuery()`:

```csharp
var blogs = context.Blogs
    .Include(b => b.BlogType)
    .Include(b => b.Posts)
    .AsSplitQuery()
    .ToList();
```

Split queries run one SQL per included collection, plus the root query. The root query legitimately needs to join `BlogType` to project its columns. The collection query for `Posts` does not, because it only projects post columns. EF Core 10 and earlier still emitted the join:

```sql
-- Before EF Core 11
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id], [b0].[Id]
FROM [Blogs] AS [b]
INNER JOIN [BlogType] AS [b0] ON [b].[BlogTypeId] = [b0].[Id]
INNER JOIN [Post] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id], [b0].[Id]
```

That extra `INNER JOIN [BlogType]` resolves for every row, then participates in the sort, for no payload reason. EF Core 11 prunes it:

```sql
-- EF Core 11
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Post] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id]
```

The more reference navigations you had bundled into `Include`, the more joins disappear. If your domain model leans on `Include` of small lookups (`Country`, `Status`, `Currency`) alongside a real collection, this is essentially free throughput.

## ORDER BY over-specification, also gone

The second optimization applies to single queries too. When you include a reference navigation, EF historically emitted its key in the `ORDER BY` clause, even though the parent's primary key already determines it through the foreign key:

```csharp
var blogs = context.Blogs
    .Include(b => b.Owner)
    .Include(b => b.Posts)
    .ToList();
```

Before EF Core 11:

```sql
ORDER BY [b].[BlogId], [p].[PersonId]
```

In EF Core 11:

```sql
ORDER BY [b].[BlogId]
```

`BlogId` is unique, and `PersonId` was fully determined by `BlogId` via the FK, so keeping it in the sort key was pure cost. Dropping it shortens the sort key, which matters once the table is large enough to spill to disk or once the planner picks a merge join over the result.

## When you will notice

You will see the biggest wins on queries with multiple small reference includes plus one or more collection includes, since those used to repeat the same unneeded joins across every child query. Customer-order, invoice-with-lines, and blog-with-posts shapes are the obvious candidates. Queries without `AsSplitQuery()`, and queries without any reference includes, get the `ORDER BY` simplification but not the join pruning.

There is no API change and nothing to turn on. Upgrade to EF Core 11.0.0-preview.3 (targeting .NET 11 Preview 3), run the same LINQ, and the generated SQL is tighter. Benchmark details live in the [EF Core tracking issue](https://github.com/dotnet/efcore/issues/29182).
