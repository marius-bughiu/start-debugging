---
title: "Fix: Invalid column name 'Value' when using SqlQueryRaw<T> for a scalar result in EF Core"
description: "EF Core wraps a scalar SqlQuery<T> in a subquery and selects a column named Value as soon as you add First, Where, Max or Single. Alias your SQL column AS Value, or materialize first."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "efcore"
  - "ef-core-11"
  - "dotnet"
---

`Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").First()` fails with `Invalid column name 'Value'` because any LINQ operator you chain onto a scalar `SqlQuery<T>` or `SqlQueryRaw<T>` makes EF Core wrap your SQL in a subquery and select a column literally named `Value` from it. Fix it by aliasing the single output column: `SELECT COUNT(*) AS Value FROM Blogs`, quoted as `AS "Value"` on PostgreSQL. If you cannot change the SQL, materialize first (`ToListAsync()`, then pick the row in memory). Everything below was measured on EF Core 10.0.12 and EF Core 11.0.0-rc.1, which behave identically here, and the rule has existed since `SqlQuery<T>` shipped in EF Core 7.0.

## The error in context

On SQL Server the exception is a `SqlException`, number 207:

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Invalid column name 'Value'.
```

The same bug looks different on every provider, which is why it is hard to search for. The SQLite and PostgreSQL messages are copied from the lab runs below; the SQL Server lines are the engine errors for the SQL that EF sends (no SQL Server instance was available for this post):

```text
SQLite:      SQLite Error 1: 'no such column: s.Value'.
PostgreSQL:  42703: column s.Value does not exist
SQL Server:  Invalid column name 'Value'.                       (error 207)
SQL Server:  No column name was specified for column 1 of 's'.  (error 8155, unaliased COUNT(*), MAX(...) etc.)
```

The SQL Server variant you get depends on your SQL. If your query returns a named column such as `SELECT Id FROM Blogs`, SQL Server complains that `Value` does not exist. If it returns an expression with no name at all, such as `COUNT(*)`, SQL Server fails earlier, because a derived table cannot contain an unnamed column. Both have the same fix.

## Why EF Core asks for a column called Value

`SqlQuery<T>` for a scalar `T` is translated in `RelationalQueryableMethodTranslatingExpressionVisitor`. In the EF Core 11 RC 1 source, the translator creates a `FromSqlExpression` for your SQL with the table alias `s` (generated from `"sql"`), and a projection column whose name comes from a hard-coded constant:

```csharp
// EF Core 11.0.0-rc.1, src/EFCore.Relational/Query/RelationalQueryableMethodTranslatingExpressionVisitor.cs
private const string SqlQuerySingleColumnAlias = "Value";
```

There is no API to change that name. As long as nothing is composed on top, EF sends your SQL unchanged and reads the first column by position, so the column name does not matter and `ToList()` works. The moment you add an operator that has to reference the column in SQL, EF generates an outer `SELECT [s].[Value] FROM (<your SQL>) AS [s]` and the database looks for a column that is not there.

The [EF Core raw SQL docs](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#querying-scalar-non-entity-types) state the rule in one sentence: when you compose LINQ over a scalar SQL query, "you must name the output column `Value`". The trap is that methods like `First()` and `Single()` do not look like composition, but they are.

## Minimal repro

The following console app reproduces it with SQLite in memory, so it needs no server. The SQL Server statements quoted later were captured from the SQL Server provider with an interceptor that suppresses the connection and records `DbCommand.CommandText`, so those are the exact statements EF sends; no SQL Server instance was involved.

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 (identical on .NET 10 + EF Core 10.0.12)
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

var conn = new SqliteConnection("Data Source=:memory:");
conn.Open();
var db = new Db(new DbContextOptionsBuilder<Db>().UseSqlite(conn).Options);
db.Database.EnsureCreated();
db.Blogs.AddRange(new Blog { Name = "a", Views = 5 }, new Blog { Name = "b", Views = 50 });
db.SaveChanges();

// Works: no composition, EF reads column 0 by position.
var all = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").ToList();

// Throws: SQLite Error 1: 'no such column: s.Value'.
var count = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").First();

class Blog { public int Id { get; set; } public string Name { get; set; } = ""; public int Views { get; set; } }
class Db(DbContextOptions<Db> o) : DbContext(o) { public DbSet<Blog> Blogs => Set<Blog>(); }
```

For the `First()` call, the SQL Server provider sends:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, captured CommandText
SELECT TOP(1) [s].[Value]
FROM (
    SELECT COUNT(*) FROM Blogs
) AS [s]
```

## Which operators trigger it

I ran each operator against an unaliased `SELECT Id FROM Blogs` on both EF versions. The table is the result on SQLite; the SQL column shows what the SQL Server provider generated for the same query.

| Call on `SqlQueryRaw<int>(...)` | Generated outer SQL (SQL Server) | Result without alias |
|---|---|---|
| `ToList()` / `ToListAsync()` | none, your SQL is sent as is | works |
| `AsEnumerable().First()` | none, `First` runs in memory | works |
| `First()` / `FirstOrDefault()` | `SELECT TOP(1) [s].[Value] FROM (...) AS [s]` | fails |
| `Single()` / `SingleOrDefault()` | `SELECT TOP(2) [s].[Value] FROM (...) AS [s]` | fails |
| `Where(x => x > 1)` | `SELECT [s].[Value] ... WHERE [s].[Value] > 1` | fails |
| `Max()` / `Min()` | `SELECT MAX([s].[Value]) FROM (...) AS [s]` | fails |
| `Count()` | `SELECT COUNT(*) FROM (...) AS [s]` | works |
| `Any()` | `SELECT CASE WHEN EXISTS (SELECT 1 FROM (...) AS [s]) ...` | works |

`Count()` and `Any()` wrap your SQL too, but they never reference the column, so they get away with it. That is how code survives review: the `Count()` path is tested, then someone changes it to `FirstOrDefault()` and production starts throwing.

## Fix 1: alias the output column AS Value

This is the fix the docs recommend, and it keeps the composition on the server:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var count = await db.Database
    .SqlQueryRaw<int>("SELECT COUNT(*) AS Value FROM Blogs")
    .FirstAsync();

var bigIds = await db.Database
    .SqlQuery<int>($"SELECT Id AS Value FROM Blogs")
    .Where(id => id > 1)
    .OrderBy(id => id)
    .ToListAsync();
```

Both now run, and the second one is filtered and sorted in the database:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider
SELECT [s].[Value]
FROM (
    SELECT Id AS Value FROM Blogs
) AS [s]
WHERE [s].[Value] > 1
ORDER BY [s].[Value]
```

A small difference between the versions showed up here: EF Core 10.0.12 emits `ORDER BY CAST([s].[Value] AS int)` for the same query, EF Core 11 RC 1 drops the redundant cast. It does not change the result, but it does change the plan text if you diff queries during an upgrade.

The alias works the same for every scalar type EF can map, including `string`, `DateTime`, `Guid` and nullable types like `int?`. For an aggregate that can return `NULL`, map to the nullable type. On an empty table, `SqlQueryRaw<int>("SELECT MAX(Views) AS Value FROM Blogs")` throws `Nullable object must have a value.`, with or without composition, while the `int?` version returns `null`:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
int? maxViews = await db.Database
    .SqlQueryRaw<int?>("SELECT MAX(Views) AS Value FROM Blogs")
    .FirstOrDefaultAsync();
```

## Fix 2: quote the alias on PostgreSQL

PostgreSQL folds unquoted identifiers to lower case, and Npgsql quotes the column it generates. So `AS Value` creates a column called `value`, EF asks for `s."Value"`, and you get the same error even though you followed the docs. This is measured on Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3 and 11.0.0-rc.1.1 against PostgreSQL 18:

```csharp
// .NET 11 RC 1, Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.1.1
// Throws: 42703: column s.Value does not exist
await db.Database.SqlQueryRaw<int>("SELECT count(*)::int AS Value FROM \"Blogs\"").FirstAsync();

// Works
await db.Database.SqlQueryRaw<int>("SELECT count(*)::int AS \"Value\" FROM \"Blogs\"").FirstAsync();
```

In a C# 11+ raw string literal the quoting stays readable:

```csharp
// .NET 11 RC 1, C# 14
var count = await db.Database.SqlQuery<int>($"""
    SELECT count(*)::int AS "Value" FROM "Blogs"
    """).FirstAsync();
```

SQLite matches column names case-insensitively, so `AS value` works there, and SQL Server follows the database collation, which is case-insensitive by default. Write `"Value"` with a capital V everywhere and the query stays portable.

## Fix 3: materialize first when you cannot touch the SQL

If the SQL comes from a stored procedure, a view you do not own, or a shared constant, take the rows to the client and finish there:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var count = (await db.Database
        .SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs")
        .ToListAsync())
    .Single();

// or, synchronously
var count2 = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").AsEnumerable().Single();
```

Neither generates a subquery, so the column name is irrelevant. Only do this for queries that return a handful of rows. `AsEnumerable().Where(...)` streams the entire result to the client before filtering, which is exactly what composing on the server was supposed to avoid.

This is also the only option for a stored procedure, because an `EXEC` cannot be used as a subquery at all. Composing over it throws a different error before anything reaches the server; I covered that case in the guide on [calling a stored procedure and mapping its results](/2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11/).

## Gotchas and lookalike errors

**`ORDER BY` inside your SQL plus `First()` on SQL Server.** Even with the alias, `SqlQueryRaw<int>("SELECT Views AS Value FROM Blogs ORDER BY Views DESC").First()` generates `SELECT TOP(1) [s].[Value] FROM (SELECT Views AS Value FROM Blogs ORDER BY Views DESC) AS [s]`. SQLite accepts that, but SQL Server rejects it with error 1033 ("The ORDER BY clause is invalid in views, inline functions, derived tables, subqueries, and common table expressions, unless TOP, OFFSET or FOR XML is also specified"). Even if SQL Server accepted it, an `ORDER BY` inside a derived table does not guarantee the order of the outer query. Move the ordering into LINQ instead: `SqlQueryRaw<int>("SELECT Views AS Value FROM Blogs").OrderByDescending(v => v).First()`.

**A DTO instead of a scalar.** For `SqlQuery<BlogStat>` (unmapped types, EF Core 8+), EF does not use `Value`; it references one column per property, by the property name. `SELECT Name AS BlogName, Views FROM Blogs` composed with `.Where(b => b.Views > 10)` fails with `no such column: b.Name` on SQLite (the alias is now `b`, from the type name), and the same query without composition fails with `The required column 'Name' was not present in the results of a 'FromSql' operation`. The fix is to alias each column to its property name. The second message is the subject of its own guide: [the required column was not present in the results of a FromSql operation](/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

**`FromSql` on a `DbSet`.** Entity queries never use `Value`. If you hit `Invalid column name` there, the name in the message is one of your mapped columns, and the cause is a column missing from your `SELECT` list.

**Your own column is literally called `Value`.** Then `SELECT Value FROM Settings` composes fine with no alias, which is why some examples online seem to work without it. Rename the table column and those examples break.

**Seeing the real SQL.** `ToQueryString()` on the uncomposed `SqlQueryRaw<int>(...)` only prints your own SQL, and you cannot call it after `First()`. Log the executed commands instead (`LogTo` with `RelationalEventId.CommandExecuted`, or an interceptor), as described in the post on [logging the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/). The outer `SELECT [s].[Value]` is obvious once you see it.

## When raw SQL is the wrong tool

Most scalar raw SQL I see in code reviews is a `COUNT`, `MAX` or `EXISTS` that LINQ expresses directly: `db.Blogs.CountAsync()`, `db.Blogs.MaxAsync(b => (int?)b.Views)`, `db.Blogs.AnyAsync(...)`. Those never hit this error and are translated by the provider with correct quoting for every database. Keep `SqlQuery<T>` for queries LINQ cannot express, and if you are deciding between raw SQL, compiled queries and Dapper for a hot path, the [EF Core compiled queries vs raw SQL vs Dapper comparison](/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) has the numbers. If you went to raw SQL because a LINQ query failed to translate, the guide to [fixing "The LINQ expression could not be translated"](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) usually gets you back to LINQ.

## Related

- [Fix: The required column 'X' was not present in the results of a 'FromSql' operation in EF Core 11](/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [How to call a stored procedure and map its results in EF Core 11](/2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11/)
- [How to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [EF Core compiled queries vs raw SQL vs Dapper](/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)
- [Fix: The LINQ expression could not be translated in EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)

## Sources

- [SQL Queries: querying scalar (non-entity) types](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#querying-scalar-non-entity-types), EF Core docs
- [SQL Queries: composing with LINQ](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#composing-with-linq), including the SQL Server `ORDER BY` restriction
- [`RelationalQueryableMethodTranslatingExpressionVisitor.cs` at v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Relational/Query/RelationalQueryableMethodTranslatingExpressionVisitor.cs), dotnet/efcore
- [`RelationalDatabaseFacadeExtensions.SqlQueryRaw<TResult>`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.sqlqueryraw), API reference
- [Database engine errors](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/database-engine-events-and-errors), SQL Server docs (207, 1033, 8155)
