---
title: "How to map and query JSON columns in EF Core 11"
description: "Map a nested type to a single JSON column with ComplexProperty(...).ToJson(), let EF Core 11 store it in the native SQL Server 2025 json type, then query into it with LINQ that translates to JSON_VALUE, JSON_CONTAINS, and JSON_PATH_EXISTS."
pubDate: 2026-06-23
template: how-to
tags:
  - "how-to"
  - "ef-core"
  - "ef-core-11"
  - "json"
  - "sql-server"
  - "dotnet-11"
---

Short answer: model the nested data as a complex type, call `ComplexProperty(b => b.Details, d => d.ToJson())` in `OnModelCreating`, and EF Core 11 maps the whole object graph to one column. On SQL Server 2025 (compatibility level 170) that column is the native `json` data type, not `nvarchar(max)`. Then you query into it with ordinary LINQ: `Where(b => b.Details.Viewers > 3)` translates to `JSON_VALUE(... RETURNING int)`, `b.Tags.Contains("ef-core")` translates to `JSON_CONTAINS`, and `EF.Functions.JsonPathExists(...)` checks for a path. Bulk updates into the document work too, via `ExecuteUpdateAsync` and the SQL Server `json` type's `.modify()` function.

This post uses `Microsoft.EntityFrameworkCore` 11.0.0 on .NET 11 with C# 14, against SQL Server 2025. The mapping APIs are provider-agnostic, but the exact SQL and the native `json` type are SQL Server specific; PostgreSQL and SQLite use their own JSON functions for the same LINQ.

## Two ways to map a column to JSON, and why one is now preferred

EF Core has been able to put a nested .NET object into a single JSON column for a while, but historically the only way was *owned entity types*: `OwnsOne(...).ToJson()`. That still works. The problem is that owned types are entity types underneath, so they carry identity and reference semantics, which leaks into your code in surprising ways.

Starting with EF Core 10 and stabilized further in 11, the recommended modeling tool is the *complex type*. A complex type has no key, no identity, and value semantics, which is exactly what a JSON document inside a row is. Mark the type with `[ComplexType]` (or configure it fluently) and call `ToJson()`:

```csharp
// .NET 11, EF Core 11.0.0
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    public string[] Tags { get; set; } = [];     // primitive collection
    public required BlogDetails Details { get; set; }
}

[ComplexType]
public class BlogDetails
{
    public string? Description { get; set; }
    public int Viewers { get; set; }
}
```

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .ComplexProperty(b => b.Details, d => d.ToJson());
}
```

Two things land in JSON here. `Details` becomes a JSON column because you asked for it with `ToJson()`. `Tags` becomes a JSON column automatically: EF maps primitive collections (`string[]`, `List<int>`, and so on) to a JSON array column with no configuration at all, a behavior that has been in place since EF Core 8.

## The native json data type, and when you get it

The column *type* depends on the database you point EF at. With EF Core 10 and 11, if you configure the provider with `UseAzureSql`, or with a SQL Server compatibility level of 170 or higher (which is what SQL Server 2025 reports), EF defaults the column to the native `json` data type rather than `nvarchar(max)`:

```csharp
// .NET 11, EF Core 11.0.0 - opt into the SQL Server 2025 json type
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder.UseSqlServer(
        connectionString,
        o => o.UseCompatibilityLevel(170));
```

The model above then produces this table:

```sql
CREATE TABLE [Blogs] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Tags] json NOT NULL,
    [Details] json NOT NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id])
);
```

The native `json` type validates its contents, stores them more compactly than text, and supports a JSON index. One migration gotcha is worth flagging up front: if your app already stores JSON in `nvarchar(max)` columns and you raise the compatibility level to 170, the next migration EF generates will *change those columns to `json`* automatically. If you are not ready for that, either pin the column type back to `nvarchar(max)` explicitly or keep the compatibility level below 170. Below 170, everything in this post still works; the data just lives in a text column and the SQL uses the older string-based JSON functions.

## Configuring the mapping, step by step

Here is the minimal, ordered path from a plain class to a queryable JSON column.

1. **Model the nested data as a `[ComplexType]`.** Give it the properties you want inside the document. Collections are allowed inside a complex type that maps to JSON, unlike table splitting.
2. **Call `ToJson()` in `OnModelCreating`.** Use `ComplexProperty(b => b.Details, d => d.ToJson())` for a single nested object. For a collection of nested objects, use `ComplexProperty` with a collection type, and the whole array maps to one column.
3. **Target SQL Server 2025 for the native type.** Set `UseCompatibilityLevel(170)` (or `UseAzureSql`) so the column is `json` rather than `nvarchar(max)`.
4. **Add a migration and apply it.** `dotnet ef migrations add AddBlogDetailsJson` then `dotnet ef database update`. Inspect the generated `CREATE TABLE` to confirm the column type is what you expect.
5. **Query and update with ordinary LINQ.** No raw SQL, no manual serialization. The sections below show what each LINQ shape translates to.

## Querying into the document with LINQ

This is the part that makes JSON columns worth using instead of a serialized blob you have to deserialize in memory. You filter, project, and order on properties *inside* the JSON, and EF translates it to server-side JSON functions.

Filtering on a nested scalar reads through to `JSON_VALUE` with a typed `RETURNING` clause:

```csharp
// .NET 11, EF Core 11.0.0
var popular = await context.Blogs
    .Where(b => b.Details.Viewers > 3)
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[Tags], [b].[Details]
FROM [Blogs] AS [b]
WHERE JSON_VALUE([b].[Details], '$.Viewers' RETURNING int) > 3
```

The `RETURNING int` clause is what lets the comparison happen as an integer on the server instead of a string compare, which is both correct and index-friendly.

### Searching a primitive collection: Contains becomes JSON_CONTAINS

Checking whether a JSON array contains a value is the single most common JSON query. On SQL Server 2025, EF Core 11 translates `Contains` over a JSON-backed primitive collection to the new `JSON_CONTAINS` function:

```csharp
var tagged = await context.Blogs
    .Where(b => b.Tags.Contains("ef-core"))
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[Tags], [b].[Details]
FROM [Blogs] AS [b]
WHERE JSON_CONTAINS([b].[Tags], 'ef-core') = 1
```

That replaces the older, slower `OPENJSON`-based translation, and `JSON_CONTAINS` can use a JSON index if one is defined. I covered this translation in depth in [the post on EF Core 11 and JSON_CONTAINS](/2026/04/efcore-11-json-contains-sql-server-2025/), including the compatibility-level switch that turns it on. One sharp edge: `JSON_CONTAINS` cannot search for null, so EF only emits it when it can prove one side is non-nullable (a non-null constant, or a non-nullable column or element). When it cannot, it falls back to the `OPENJSON` form so the query still returns the right answer.

### Path-scoped and mode-specific search: EF.Functions.JsonContains

When you need to search at a specific path inside the document, or specify a search mode, call `JSON_CONTAINS` directly through `EF.Functions.JsonContains()`:

```csharp
var rated = await context.Blogs
    .Where(b => EF.Functions.JsonContains(b.JsonData, 8, "$.Rating") == 1)
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[JsonData]
FROM [Blogs] AS [b]
WHERE JSON_CONTAINS([b].[JsonData], 8, N'$.Rating') = 1
```

It accepts the JSON value, the value to search for, and optionally a path and a search mode. It works against scalar string properties, complex types, and owned entity types mapped to JSON.

### Does this path exist at all: EF.Functions.JsonPathExists

New in EF Core 11, `EF.Functions.JsonPathExists()` checks whether a JSON path is present, translating to SQL Server's `JSON_PATH_EXISTS` (available since SQL Server 2022). This is the right tool for "rows where the document has an optional field set":

```csharp
var withOptional = await context.Blogs
    .Where(b => EF.Functions.JsonPathExists(b.JsonData, "$.OptionalInt"))
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[JsonData]
FROM [Blogs] AS [b]
WHERE JSON_PATH_EXISTS([b].[JsonData], N'$.OptionalInt') = 1
```

## Updating inside the document without loading it

Writing into a JSON column has two modes. The familiar one is change tracking: load the entity, mutate the nested property, call `SaveChanges`. EF serializes the updated document and writes the column. That is fine for one row.

The interesting one is bulk update straight in the database. EF Core 10 added `ExecuteUpdateAsync` support for JSON, and it carries into 11. Given the complex-type mapping above, you can increment a counter inside the JSON for an entire result set in a single round trip:

```csharp
await context.Blogs.ExecuteUpdateAsync(s =>
    s.SetProperty(b => b.Details.Viewers, b => b.Details.Viewers + 1));
```

On SQL Server 2025 this uses the `json` type's `.modify()` function, so the server rewrites just the one property in place rather than reading and re-serializing the whole document:

```sql
UPDATE [b]
SET [Details].modify('$.Viewers', JSON_VALUE([b].[Details], '$.Viewers' RETURNING int) + 1)
FROM [Blogs] AS [b]
```

One firm requirement: `ExecuteUpdate` into JSON only works when the type is mapped as a *complex type*. It does not work for owned entity types. This is the most concrete reason to prefer complex types for new code, and the broader trade-off between [`ExecuteUpdate` and loading entities then calling SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) applies here as well.

## JSON columns now work with TPT and TPC inheritance

Until EF Core 11, complex types and JSON columns could not be used on entity types that used table-per-type (TPT) or table-per-concrete-type (TPC) inheritance. That restriction is gone in 11. You can map a JSON property on a base type and use it across the hierarchy:

```csharp
public abstract class Animal
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required AnimalDetails Details { get; set; }
}

public class Dog : Animal { public string Breed { get; set; } = ""; }
public class Cat : Animal { public bool IsIndoor { get; set; } }

[ComplexType]
public class AnimalDetails
{
    public DateTime BirthDate { get; set; }
    public string? Veterinarian { get; set; }
}
```

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Animal>()
        .UseTptMappingStrategy()
        .ComplexProperty(a => a.Details, b => b.ToJson());
}
```

If you maintain a domain model with a real inheritance hierarchy, this is the change that lets you keep TPT/TPC and still document-model the shared, structured parts of each entity.

## Edge cases that bite

**Owned versus complex semantics.** With owned entity types, assigning one document to another (`blog.BillingDetails = blog.ShippingDetails`) throws, because the same entity instance cannot be tracked twice. Complex types are compared and assigned by value, so the assignment just copies fields. If you are still on owned types for JSON, migrating to complex types removes a whole category of these bugs; it pairs well with the discipline in [using records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/) for immutable value shapes.

**Struct complex types cannot be in collections yet.** EF Core 10 added `struct` and `record struct` support for complex types, which fits their value semantics nicely. But a *collection* of struct complex types is not currently supported. Use a class if the nested type lives in a list.

**Optional complex types need a required property.** An optional (nullable) complex type mapped to JSON requires at least one required property defined on the type, otherwise EF cannot tell an all-null document from an absent one.

**The nvarchar-to-json migration is automatic.** Raising the compatibility level to 170 rewrites existing `nvarchar(max)` JSON columns to the native `json` type on the next migration. Review that migration before applying it to production; it is a schema change on every JSON column at once.

**Indexing.** A JSON index is what makes `JSON_CONTAINS` and path lookups fast at scale. The native `json` type supports `CREATE JSON INDEX`; plain text columns do not. If your JSON queries are hot paths, the native type plus an index is the difference between a seek and a full scan, the same lesson that shows up in [the EF Core 6 to 11 migration breaking changes](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) around query plans.

The short version: reach for `[ComplexType]` plus `ToJson()`, target SQL Server 2025 so the column is real `json`, and then treat the document like any other part of your model in LINQ. EF Core 11 translates the filtering, the array `Contains`, the path checks, and even bulk updates down to server-side JSON functions, so the document never has to make a round trip into memory just to be queried.

## Sources

- [What's New in EF Core 11: complex types and JSON with TPT/TPC, JsonPathExists, JSON_CONTAINS](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: native json data type, complex types ToJson, ExecuteUpdate for JSON](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [SQL Server json data type and the modify() method](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type)
- [JSON_CONTAINS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-contains-transact-sql)
- [JSON_PATH_EXISTS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-path-exists-transact-sql)
</content>
