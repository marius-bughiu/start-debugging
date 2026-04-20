---
title: "EF Core 11 translates Contains to JSON_CONTAINS on SQL Server 2025"
description: "EF Core 11 auto-translates LINQ Contains over JSON collections to the new SQL Server 2025 JSON_CONTAINS function, and adds EF.Functions.JsonContains for path-scoped and mode-specific queries that can hit a JSON index."
pubDate: 2026-04-20
tags:
  - ".NET 11"
  - "EF Core 11"
  - "SQL Server"
  - "JSON"
  - "LINQ"
---

SQL Server 2025 added a native [`JSON_CONTAINS`](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-contains-transact-sql) function, and EF Core 11 is the release that plugs into it. Two things change for anyone storing collections as JSON columns: `Contains` over JSON collections now gets a direct translation instead of the old `OPENJSON` join, and there is a new `EF.Functions.JsonContains()` for cases where you need a JSON path or a specific search mode. The work is part of [EF Core 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md).

## Opting into the SQL Server 2025 compatibility level

The new translation only turns on when the provider knows it is talking to SQL Server 2025. You do that via `UseCompatibilityLevel(170)` on the provider options:

```csharp
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder.UseSqlServer(
        connectionString,
        o => o.UseCompatibilityLevel(170));
```

Compatibility level 170 is what SQL Server 2025 reports; lower levels will keep using the older translation so this is safe to leave off until you actually upgrade the database.

## What Contains looks like now

Take a classic "tags as JSON array" shape:

```csharp
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<string> Tags { get; set; } = new();
}

modelBuilder.Entity<Blog>()
    .Property(b => b.Tags)
    .HasColumnType("json"); // SQL Server 2025 native JSON type
```

On EF Core 10 or on an older SQL Server target, this query:

```csharp
var posts = await context.Blogs
    .Where(b => b.Tags.Contains("ef-core"))
    .ToListAsync();
```

gets you the `OPENJSON` translation, which reads as a correlated subquery:

```sql
WHERE N'ef-core' IN (
    SELECT [t].[value]
    FROM OPENJSON([b].[Tags]) WITH ([value] nvarchar(max) '$') AS [t]
)
```

EF Core 11 against compatibility level 170 emits this instead:

```sql
WHERE JSON_CONTAINS([b].[Tags], 'ef-core') = 1
```

The reason this matters is not just SQL prettiness. `JSON_CONTAINS` is the only predicate in SQL Server 2025 that can use a [JSON index](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql). If you have `CREATE JSON INDEX IX_Tags ON Blogs(Tags)`, the `OPENJSON` path will never touch it but the EF 11 translation will.

There is one trap called out in the release notes: `JSON_CONTAINS` does not handle NULL the way LINQ `Contains` does, so EF only picks the new translation when at least one side is provably non-nullable (a non-null constant, or a non-nullable column). If both sides can be null, EF falls back to `OPENJSON` so existing behavior is preserved.

## When you need a path or a search mode

`Contains` covers the "is this scalar in the array" case. For anything else, EF Core 11 exposes `EF.Functions.JsonContains(container, value, path?, mode?)`. The classic example is looking up a value at a specific path inside a structured JSON document:

```csharp
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string JsonData { get; set; } = "{}"; // { "Rating": 8, ... }
}

var ratedEights = await context.Blogs
    .Where(b => EF.Functions.JsonContains(b.JsonData, 8, "$.Rating") == 1)
    .ToListAsync();
```

Translates to:

```sql
WHERE JSON_CONTAINS([b].[JsonData], 8, N'$.Rating') = 1
```

You can use it with scalar string columns, with complex types mapped to JSON, and with owned types mapped via `OwnsOne(... b.ToJson())`. The comparison against `= 1` is load-bearing: `JSON_CONTAINS` returns a `bit`, and EF preserves that so composite predicates like `WHERE ... AND JSON_CONTAINS(...) = 1` stay SARGable against a JSON index.

Pair this with [`EF.Functions.JsonPathExists`](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) for "does the property exist at all" checks and you cover most of the JSON-column query surface without dropping down to raw SQL. The full list of EF Core 11 translator changes is in the [What's New](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) doc.
