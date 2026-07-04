---
title: "Fix: \"The required column 'X' was not present in the results of a 'FromSql' operation\" in EF Core 11"
description: "EF Core throws this when your raw SQL does not return every column the entity maps to, or the column names do not match. Return all mapped columns with matching names, or query a scalar/keyless type instead."
pubDate: 2026-07-04
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
---

EF Core throws `The required column 'X' was not present in the results of a 'FromSql' operation` when the raw SQL you passed to `FromSql`, `FromSqlRaw`, or `FromSqlInterpolated` does not return a column that the target entity type maps to. The materializer reads results by mapped column name, so every property's column has to be in the result set, spelled the way EF expects. Fix it by returning all mapped columns (`SELECT *` or an explicit list with matching aliases), or, if you only want a subset or an arbitrary shape, switch to `Database.SqlQuery<T>` or a keyless entity type instead of a full entity. This applies to `Microsoft.EntityFrameworkCore` 11.0 on .NET 11 with C# 14, and the rule has been the same since EF Core 3.0.

## The error in context

The full runtime exception looks like this:

```
System.InvalidOperationException: The required column 'Description' was not present in the results of a 'FromSql' operation.
   at Microsoft.EntityFrameworkCore.Query.Internal.RelationalCommandCache...
   at lambda_method(Closure, QueryContext, DbDataReader, ResultContext, ...)
```

The exception type is `System.InvalidOperationException`, and it is thrown while the results are being read, not when you build the query. That means the stack trace points into EF Core's materialization pipeline (a `lambda_method` and `RelationalCommandCache`), not at your SQL string. The one useful piece of information is the column name in quotes: `'Description'`. That is the mapped column EF looked for in the reader and could not find by name.

## Why this happens

When `FromSql` returns a mapped entity type, EF Core does not read columns by ordinal position. It reads them by name. For each property on the entity it asks the `DbDataReader` "give me the ordinal of the column named `Description`", and if the reader has no such column, that call fails and EF surfaces it as this error. The docs state the constraint directly: the SQL query must return data for all properties of the entity type, and the result set column names must match the column names that properties are mapped to.

Three things trigger it, in rough order of frequency:

- **The SELECT list is missing a column.** You wrote `SELECT Id, Title FROM Articles` but the `Article` entity also maps a `Description` property. EF wants `Description` and it is not there.
- **A column name does not match the mapped name.** The SQL returns `article_description` (or an unaliased expression, or `Col2` from a scaffolded stored procedure) but the property maps to the column `Description`. Same failure, and the quoted name in the message is the one EF wanted, not the one your SQL produced, which is why the message can feel misleading.
- **A shadow or owned-type column is missing.** Foreign keys with no CLR property, `[Timestamp]`/rowversion concurrency tokens, and columns for owned types are all mapped and all required. It is easy to forget them because they are invisible in the entity class.

This is a deliberate design choice, not a bug. EF6 ignored property-to-column mapping for raw SQL and matched by property name loosely; EF Core made it strict so that a raw entity query behaves exactly like a normal one and can be tracked, fixed up, and composed over safely.

## Minimal repro

Here is the smallest program that reproduces it. The entity maps three columns; the SQL returns two:

```csharp
// .NET 11, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new BlogContext();

// Throws: 'Description' is mapped but not in the SELECT list.
var articles = await db.Articles
    .FromSql($"SELECT Id, Title FROM Articles")
    .ToListAsync();

public class Article
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
}

public class BlogContext : DbContext
{
    public DbSet<Article> Articles => Set<Article>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Blog;Trusted_Connection=True;Encrypt=False");
}
```

EF Core maps `Article` to three columns: `Id`, `Title`, `Description`. The reader coming back from `SELECT Id, Title` has only two of them, so materialization fails the moment `ToListAsync` starts reading rows, with `'Description' was not present`.

## Fix, in detail

The fixes are ordered from best (return a real, complete entity) to the alternatives you reach for when you genuinely do not want the full entity.

### 1. Return every mapped column

If you want tracked `Article` entities back, the SQL has to produce every column the entity maps. The simplest correct form is `SELECT *` against the table (or a view/TVF whose columns line up):

```csharp
// .NET 11, EF Core 11 -- returns Id, Title, Description: all three mapped columns
var articles = await db.Articles
    .FromSql($"SELECT * FROM Articles")
    .ToListAsync();
```

`SELECT *` is fine here precisely because EF matches by name, so column order does not matter and extra columns are ignored. If you prefer an explicit list (safer against schema drift and clearer in code review), list every mapped column and make sure none is missing:

```csharp
// .NET 11, EF Core 11 -- explicit, complete column list
var articles = await db.Articles
    .FromSql($"SELECT Id, Title, Description FROM Articles WHERE Title LIKE {'%' + term + '%'}")
    .ToListAsync();
```

Remember that "every mapped column" includes columns with no obvious CLR property: shadow foreign keys, a `RowVersion` concurrency token, discriminator columns for TPH inheritance. If your entity has a `[Timestamp] public byte[] RowVersion` or an inheritance discriminator, that column must be in the result set too.

### 2. Alias the columns so the names match

When the SQL cannot use the mapped names directly, for example a stored procedure or a legacy table that returns `article_desc`, alias the output columns to the names EF expects. Matching is case-insensitive, but the name has to be present:

```csharp
// .NET 11, EF Core 11 -- alias legacy names onto mapped column names
var articles = await db.Articles
    .FromSqlRaw(@"SELECT article_id AS Id,
                         article_title AS Title,
                         article_desc AS Description
                  FROM legacy_articles")
    .ToListAsync();
```

If you would rather change the mapping than the SQL, map the property to the real column name with `[Column("article_desc")]` or `HasColumnName("article_desc")` in `OnModelCreating`, and then the raw SQL returning `article_desc` matches without an alias. Pick one side; do not fight yourself on both.

### 3. Query a scalar or projection with `SqlQuery<T>`

If you only want a couple of fields, do not force a full entity. `Database.SqlQuery<T>` (EF Core 7.0+, still the current API in 11.0) reads an arbitrary type without the "all mapped columns" rule. For a single scalar column:

```csharp
// .NET 11, EF Core 11 -- no entity involved, so no missing-column rule
var titles = await db.Database
    .SqlQuery<string>($"SELECT Title FROM Articles WHERE Id > {minId}")
    .ToListAsync();
```

For a multi-column shape, declare a plain record whose property names match the (possibly aliased) result columns and query it. This type is not part of your model, so EF makes no demands about completeness:

```csharp
// .NET 11, EF Core 11 -- lightweight read model, matched by name
public record ArticleSummary(int Id, string Title);

var summaries = await db.Database
    .SqlQuery<ArticleSummary>($"SELECT Id, Title FROM Articles")
    .ToListAsync();
```

`SqlQuery<T>` never tracks results, which is exactly what you want for a read-only summary. It is the right tool the moment you catch yourself wanting a partial entity.

### 4. Model the result as a keyless entity type

For a shape you reuse across the app, especially the output of a view or a reporting stored procedure, declare a keyless entity type. It participates in the model (so you can `Include` and compose over it in some cases) but has no key and is never tracked. Configure it with `HasNoKey`:

```csharp
// .NET 11, EF Core 11 -- keyless type mapped to a reporting shape
public class ArticleStat
{
    public string Title { get; set; } = "";
    public int ViewCount { get; set; }
}

// in OnModelCreating:
modelBuilder.Entity<ArticleStat>().HasNoKey().ToView(null);

// query:
var stats = await db.Set<ArticleStat>()
    .FromSql($"SELECT Title, COUNT(*) AS ViewCount FROM Views GROUP BY Title")
    .ToListAsync();
```

A keyless entity still requires its own mapped columns to be present, but you control that mapping, so you size it to exactly the columns your SQL returns instead of to a full table entity.

## Gotchas and variants

**The quoted column is not the one your SQL is missing.** Because EF matches by name, if your SQL returns `Desc` and the entity maps `Description`, the message says `'Description' was not present`, not `'Desc' was unexpected`. Compare the list of columns your query actually returns against the entity's mapped columns, and look for the mismatch rather than trusting that the named column is literally absent. This exact confusion is tracked in [dotnet/efcore issue #33748](https://github.com/dotnet/efcore/issues/33748).

**Scaffolded stored procedures produce `Col1`, `Col2`.** When a stored procedure returns a computed column with no name (`SELECT COUNT(*)` rather than `SELECT COUNT(*) AS Total`), reverse-engineering tools name it `Col0`, `Col1`, and so on, and then the generated result type expects those names. Give every column an explicit alias in the procedure and the problem disappears at the source.

**A stored procedure that projects a subset.** `EXECUTE dbo.GetArticleTitles` returning only `Id, Title` cannot materialize a full `Article`. Do not run it through `context.Articles.FromSql`; run it through `Database.SqlQuery<T>` or a keyless type sized to what the procedure returns. Remember too that you cannot compose LINQ over a stored procedure call, so add `AsEnumerable()` right after `FromSql` if you need further in-memory work.

**Owned types and table splitting.** If `Article` owns an `Address`-style value object stored in the same table, the owned type's columns are part of the entity and must be in the result set. Missing them raises the same error for a column you may not realize exists. Include them or split the read into a keyless projection.

**It worked before an upgrade from EF6.** EF6 matched raw SQL results by property name and was lenient about missing or misnamed columns. EF Core is strict. If you are moving a codebase across that boundary, this is one of several raw-SQL behaviours that changed, and it pairs with the broader set of [breaking changes that actually bite when migrating EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**A `NULL` in a non-nullable column is a different error.** If the column is present but the value is `NULL` and the property is a non-nullable value type, you get a `System.Data.SqlTypes.SqlNullValueException` or a materialization error about converting null, not this one. That is a data problem, not a shape problem; make the property nullable or coalesce in SQL with `ISNULL`/`COALESCE`.

The mental model that keeps you out of this error for good: `FromSql` on a `DbSet<T>` is a promise to return a complete, correctly named `T`. If you cannot or do not want to keep that promise, do not use an entity. Use `SqlQuery<T>` for scalars and ad-hoc records, or a keyless type for a shape you name and reuse. Reserve `context.Set<T>().FromSql` for the case where the SQL really does hydrate the whole entity.

## Related

- [Fix: "The LINQ expression could not be translated" in EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) is the sibling error you hit when you go the other way and stay in LINQ.
- [EF Core compiled queries vs raw SQL vs Dapper](/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) weighs when raw SQL is worth the sharp edges you just met.
- [How to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) covers another case where the shape of the result and the entity mapping have to line up.
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) matters once your raw entity query works and you want the read to be cheap.
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) is worth a pass when raw SQL is your response to a query EF generated badly.

## Sources

- [Raw SQL Queries, EF Core docs](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries) (see the "Limitations" section: all mapped columns must be returned, and names must match)
- [Keyless entity types, EF Core docs](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)
- [RelationalDatabaseFacadeExtensions.SqlQuery, API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.sqlquery)
- [dotnet/efcore issue #33748: misleading "missing column" text for a wrong column](https://github.com/dotnet/efcore/issues/33748)
