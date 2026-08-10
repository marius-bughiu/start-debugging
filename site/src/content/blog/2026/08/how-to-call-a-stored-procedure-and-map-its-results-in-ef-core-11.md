---
title: "How to call a stored procedure and map its results in EF Core 11"
description: "Use FromSql on a DbSet when the procedure returns full entity rows, Database.SqlQuery<T> when it returns a projection, and ExecuteSql when it returns nothing. Never chain a LINQ operator onto an EXEC, and never read an output parameter before the reader is disposed."
pubDate: 2026-08-10
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
---

Short answer: EF Core 11 gives you three entry points for calling a stored procedure, and picking the wrong one is what causes most of the pain. Use `FromSql` on a `DbSet<T>` when the procedure returns every column of a mapped entity. Use `Database.SqlQuery<T>` when it returns a projection that is not an entity, which has worked for arbitrary DTOs since EF Core 8. Use `Database.ExecuteSql` when it returns no result set at all. Two rules apply to all three: you may not chain a LINQ operator onto an `EXEC`, and an output parameter's `Value` is null until the underlying reader has been disposed.

This post covers all three APIs, the exact exceptions you get when you misuse them, output and return parameters, multiple result sets, and the tracking behaviour that surprises people.

Everything below was measured against SQL Server 2022 (`mcr.microsoft.com/mssql/server:2022-latest`) using EF Core 10.0.10 on .NET SDK 10.0.201, since EF Core 11 requires the .NET 11 runtime, which is not installed on this machine. That matters less than usual here: EF Core 11 ships no changes to `FromSql`, `SqlQuery`, or `ExecuteSql`, and the [EF Core 11 release notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) contain no stored-procedure entries at all. Every exception message and behaviour quoted here is identical on EF Core 8, 9, 10 and 11. Where a claim is sourced from docs rather than measured, I say so.

The schema for every example:

```sql
-- SQL Server 2022
CREATE TABLE Blogs (
    Id         int NOT NULL IDENTITY PRIMARY KEY,
    Name       nvarchar(200) NOT NULL,
    Rating     int NOT NULL,
    OwnerEmail nvarchar(200) NULL
);

CREATE PROCEDURE dbo.GetTopBlogs @MinRating int AS
BEGIN
    SET NOCOUNT ON;
    SELECT Id, Name, Rating, OwnerEmail FROM Blogs
    WHERE Rating >= @MinRating ORDER BY Rating DESC;
END
```

Note the `SET NOCOUNT ON`. Without it SQL Server emits a rows-affected message ahead of the result set, which some drivers surface as a phantom empty result. It costs nothing and prevents a class of confusing bugs.

## When the procedure returns entity rows: FromSql

`FromSql` is an extension on `DbSet<T>`, and it is the right call when your procedure's result set matches a mapped entity column-for-column:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .ToListAsync();
```

That interpolated hole is not string concatenation. `FromSql` takes a `FormattableString` and turns every hole into a `DbParameter`, so this is safe against SQL injection. You can see exactly what gets sent by calling `ToQueryString()`:

```text
DECLARE p0 int = 3;

EXEC dbo.GetTopBlogs @MinRating = @p0
```

EF passed the SQL through verbatim. There is no wrapping subquery, which is the whole reason the next section exists.

Results come back tracked, exactly like a LINQ query. I measured three entities in the change tracker after a three-row procedure call. Add `AsNoTracking()` for read-only paths, and it composes fine here because it changes nothing about the SQL:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .AsNoTracking()
    .ToListAsync();
```

For named parameters, which matter when a procedure has optional parameters, wrap the value in a `SqlParameter` and reference it by name:

```csharp
// .NET 11, C# 14, EF Core 11
var minRating = new SqlParameter("min", 3);

var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {minRating}")
    .AsNoTracking()
    .ToListAsync();
```

Reusing a single `SqlParameter` instance across two consecutive executions works, contrary to a common belief carried over from raw ADO.NET, where a parameter may only belong to one command's collection. I ran the same instance through two `FromSqlRaw` calls back to back with no exception.

### The result set must contain every mapped column

This is the failure people hit first. Drop `OwnerEmail` from the procedure's `SELECT` and the query dies:

```text
InvalidOperationException: The required column 'OwnerEmail' was not present
in the results of a 'FromSql' operation.
```

EF materializes the full entity, so the reader has to supply every mapped property, including shadow properties and discriminators. Column names must match the mapped column names, not the property names, which is a genuine behaviour change from EF6. Ordering does not matter and matching is case-insensitive. If you cannot change the procedure to return the missing columns, you are not returning an entity, and you should be using `SqlQuery<T>` instead. I wrote up that specific exception in more depth in [the guide to the missing-column error in FromSql](/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

### You cannot compose LINQ over an EXEC

This is the second thing everyone hits. SQL Server cannot nest a procedure call inside a subquery, so the moment you add an operator that changes the SQL, EF gives up:

```csharp
// .NET 11, C# 14, EF Core 11 - throws
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .Where(b => b.Rating > 4)          // composition
    .ToListAsync();
```

```text
InvalidOperationException: 'FromSql' or 'SqlQuery' was called with non-composable
SQL and with a query composing over it. Consider calling 'AsEnumerable' after the
method to perform the composition on the client side.
```

The same exception fires for `Include`, `OrderBy`, `Skip`/`Take`, and for a bare `First()` or `Single()`, since those all append `TOP` or `ORDER BY`. I confirmed `Include` throws it too, so eager-loading a navigation off a procedure call is not available.

The fix is the one the message names. Insert `AsEnumerable()` (or `AsAsyncEnumerable()`) directly after `FromSql` to draw an explicit line between what the database does and what your process does:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .AsEnumerable()                    // everything after this runs in memory
    .Where(b => b.Rating > 4)
    .ToList();
```

Be honest with yourself about what that costs: every row the procedure returns crosses the network and is materialized before the `Where` runs. If the procedure returns 200,000 rows and you keep four, push the filter into the procedure as a parameter. `AsEnumerable` is a correctness fix, not a performance one.

Change tracking still applies after `AsEnumerable`, which trips people up. The client-side boundary only moves the query operators; materialization already happened on EF's side of the line. I measured three tracked entities after `FromSql(...).AsEnumerable().ToList()`. Add `AsNoTracking()` before `AsEnumerable()` if you do not want them.

By contrast, a composable `SELECT` gets wrapped and pushed down, which is what makes `FromSql` genuinely useful for non-procedure SQL:

```csharp
// .NET 11, C# 14, EF Core 11
var q = context.Blogs
    .FromSql($"SELECT * FROM Blogs WHERE Rating >= {3}")
    .Where(b => b.Name.StartsWith("S"));
```

```sql
SELECT [b].[Id], [b].[Name], [b].[OwnerEmail], [b].[Rating]
FROM (
    SELECT * FROM Blogs WHERE Rating >= @p0
) AS [b]
WHERE [b].[Name] LIKE N'S%'
```

That is the whole distinction. Composable SQL starts with `SELECT` and survives being made a subquery; `EXEC` does not.

## When the procedure returns a projection: SqlQuery&lt;T&gt;

Most real stored procedures do not return entity rows. They return a report shape: a join, a `GROUP BY`, some computed columns. For those, `Database.SqlQuery<T>` maps the result set onto a plain CLR type that is not in your model at all. This is the API most posts on this topic still describe as scalar-only; that stopped being true in EF Core 8, which extended it to [any mappable CLR type](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#raw-sql-queries-for-unmapped-types).

```sql
CREATE PROCEDURE dbo.GetBlogStats @MinViews int AS
BEGIN
    SET NOCOUNT ON;
    SELECT b.Name AS BlogName, COUNT(p.Id) AS PostCount, SUM(p.Views) AS TotalViews
    FROM Blogs b JOIN Posts p ON p.BlogId = b.Id
    WHERE p.Views >= @MinViews
    GROUP BY b.Name;
END
```

```csharp
// .NET 11, C# 14, EF Core 11
public class BlogStat
{
    public string BlogName { get; set; } = "";
    public int PostCount { get; set; }
    public int TotalViews { get; set; }
}

var stats = await context.Database
    .SqlQuery<BlogStat>($"EXEC dbo.GetBlogStats @MinViews = {10}")
    .ToListAsync();
```

`BlogStat` needs no `DbSet`, no `OnModelCreating` entry, and no attributes. Things I verified about how the mapping behaves:

- **Matching is by column name, not position.** I returned the three columns in scrambled order and every property still landed correctly.
- **Matching is case-insensitive.** `blogname` and `POSTCOUNT` both bound fine.
- **Extra columns in the result set are ignored.** Adding a fourth `Surprise` column did not throw, despite the docs saying the type "must have a property for every value in the result set". Do not lean on this; it is undocumented behaviour, not a contract.
- **A missing column is fatal.** Drop `TotalViews` from the `SELECT` and you get the same `The required column 'TotalViews' was not present in the results of a 'FromSql' operation.` message as the entity path.
- **Null into a non-nullable property throws** `SqlNullValueException: Data is Null. This method or property cannot be called on Null values.` Model the property as nullable, or `COALESCE` in SQL.

Use `[Column("...")]` when a result column name cannot match your property name:

```csharp
// .NET 11, C# 14, EF Core 11
public class BlogStat
{
    [Column("blog_name")]
    public string BlogName { get; set; } = "";
    public int PostCount { get; set; }
}
```

The non-composability rule applies here identically. `SqlQuery<T>(...).Where(...)` over an `EXEC` throws the exact same non-composable exception, and `AsEnumerable()` is the same fix.

For a single scalar, `SqlQuery<T>` with a primitive works directly:

```csharp
// .NET 11, C# 14, EF Core 11
var count = (await context.Database
    .SqlQuery<int>($"EXEC dbo.GetBlogCount")
    .ToListAsync()).Single();
```

The EF Core docs tell you to alias the output column `AS Value` for scalar `SqlQuery`. That requirement only applies when you compose LINQ over the query, because EF needs a name to reference from the outer `SELECT` it generates. Calling a procedure with no composition needs no alias; I confirmed an unaliased `SELECT COUNT(*)` binds fine.

### The keyless entity type alternative

Before EF Core 8 the only way to map a non-entity result shape was a keyless entity type, and it is still the better choice when the shape is part of your domain and you want it queryable as a `DbSet`:

```csharp
// .NET 11, C# 14, EF Core 11
protected override void OnModelCreating(ModelBuilder b)
{
    b.Entity<BlogStat>().HasNoKey().ToView(null);
}

var stats = await context.Set<BlogStat>()
    .FromSql($"EXEC dbo.GetBlogStats @MinViews = {10}")
    .ToListAsync();
```

`ToView(null)` tells EF the type has no backing table, so migrations will not try to create one. Keyless types are never change-tracked, which I confirmed: zero entries after materializing three rows. Reach for `SqlQuery<T>` for one-off reports and a keyless type when the shape is reused across the app or needs [an EF-generated query as well as a procedure](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types).

## When the procedure returns nothing: ExecuteSql

For a procedure that only writes, use `ExecuteSql`. It returns the number of rows affected, not anything the procedure computed:

```csharp
// .NET 11, C# 14, EF Core 11
var rowsAffected = await context.Database
    .ExecuteSqlAsync($"EXEC dbo.BumpRatings @By = {1}");
```

`ExecuteSql` parameterizes like `FromSql`; `ExecuteSqlRaw` is the escape hatch when you must build SQL dynamically. This is a different tool from [`ExecuteUpdate` and `ExecuteDelete` for bulk writes](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/), which generate SQL from LINQ rather than calling something you wrote.

One important caveat: `ExecuteSql` runs outside the change tracker. Rows it modifies in the database are not reflected in entities the context already loaded, so a subsequent `SaveChanges` can write stale values back over them. Call it before you load, or `Reload()` the affected entries afterwards.

## Output parameters, and the timing bug that bites everyone

A procedure that returns both a result set and an output parameter is a common pattern for paging:

```sql
CREATE PROCEDURE dbo.GetTopBlogsWithCount @MinRating int, @TotalCount int OUTPUT AS
BEGIN
    SET NOCOUNT ON;
    SELECT @TotalCount = COUNT(*) FROM Blogs;
    SELECT Id, Name, Rating, OwnerEmail FROM Blogs WHERE Rating >= @MinRating;
END
```

Output parameters need explicit `SqlParameter` instances and `FromSqlRaw`, because you have to set `Direction` yourself:

```csharp
// .NET 11, C# 14, EF Core 11
var minRating = new SqlParameter("MinRating", SqlDbType.Int) { Value = 3 };
var totalCount = new SqlParameter("TotalCount", SqlDbType.Int)
{
    Direction = ParameterDirection.Output
};

var blogs = await context.Blogs
    .FromSqlRaw("EXEC dbo.GetTopBlogsWithCount @MinRating, @TotalCount OUTPUT",
        minRating, totalCount)
    .ToListAsync();

var total = (int)totalCount.Value;   // only valid after ToListAsync
```

Note the `OUTPUT` keyword in the SQL text. Omit it and SQL Server treats the parameter as input-only and silently returns nothing.

Now the part that costs people an afternoon. `totalCount.Value` is `null` until the `DbDataReader` is closed, because that is when SQL Server sends output parameter values down the wire. Measured directly:

```text
before enumeration:  total.Value = null
mid-enumeration:     total.Value = null
after dispose:       total.Value = 5
```

Reading `totalCount.Value` on the line after you build the query gives you `null` and a `NullReferenceException` on the cast. It has to come after the enumeration completes. `ToListAsync()`, `First()` on an `AsEnumerable()`, and `await foreach` over `AsAsyncEnumerable()` all work, because each one disposes the reader.

The corollary is worse. If you take an enumerator and never dispose it, you get two failures at once:

```csharp
// .NET 11, C# 14, EF Core 11 - do not do this
var e = context.Blogs
    .FromSqlRaw("EXEC dbo.ManyRowsWithCount @Total OUTPUT", total)
    .AsEnumerable().GetEnumerator();
e.MoveNext();                        // reader is open and never closed
```

`total.Value` stays `null`, and the next query on that `DbContext` fails with `InvalidOperationException: There is already an open DataReader associated with this Connection which must be closed first.` I hit this accidentally while testing and it broke every subsequent query on the context. If you enumerate manually, wrap it in `using`.

## Getting the RETURN value, which is not the output parameter

A T-SQL `RETURN 42` is a third channel, separate from output parameters and result sets. The obvious approach does not work:

```csharp
// .NET 11, C# 14, EF Core 11 - throws
var ret = new SqlParameter("ret", SqlDbType.Int)
{
    Direction = ParameterDirection.ReturnValue
};
context.Database.ExecuteSqlRaw("EXEC @ret = dbo.BumpRatings @By", ret, by);
```

```text
SqlException: Must declare the scalar variable "@ret".
```

`ParameterDirection.ReturnValue` is only understood when the command is a real `CommandType.StoredProcedure`, and EF always sends `CommandType.Text`. Two things do work. The simpler one is to declare the parameter as `Output` and let the `EXEC @ret =` syntax bind it:

```csharp
// .NET 11, C# 14, EF Core 11
var ret = new SqlParameter("ret", SqlDbType.Int)
{
    Direction = ParameterDirection.Output
};
var by = new SqlParameter("By", SqlDbType.Int) { Value = 1 };

context.Database.ExecuteSqlRaw("EXEC @ret = dbo.BumpRatings @By", ret, by);
var returnValue = (int)ret.Value;   // 42
```

The other is to drop to a raw `DbCommand` on EF's connection, which also gets you `CommandType.StoredProcedure` and therefore real `ReturnValue` support:

```csharp
// .NET 11, C# 14, EF Core 11
var conn = context.Database.GetDbConnection();
if (conn.State != ConnectionState.Open) await conn.OpenAsync();

await using var cmd = conn.CreateCommand();
cmd.CommandText = "dbo.BumpRatings";
cmd.CommandType = CommandType.StoredProcedure;
cmd.Parameters.Add(new SqlParameter("@By", SqlDbType.Int) { Value = 1 });
var ret = new SqlParameter("@ret", SqlDbType.Int)
{
    Direction = ParameterDirection.ReturnValue
};
cmd.Parameters.Add(ret);

await cmd.ExecuteNonQueryAsync();
var returnValue = (int)ret.Value;   // 42
```

Both returned 42. Use the first unless you need `CommandType.StoredProcedure` for another reason. If you open the connection yourself, remember EF will not close it for you.

## Multiple result sets are still not supported

If your procedure returns two result sets, EF reads the first and silently discards the rest. No exception, no warning. I called a procedure returning both blogs and posts through `FromSql` and got three blogs back with the five posts dropped on the floor.

[FromSql: Support multiple resultsets](https://github.com/dotnet/efcore/issues/8127) has been open since April 2017 and sits in the Backlog milestone, so it is not coming in EF Core 11. The workaround is a raw `DbDataReader` and `NextResult()`:

```csharp
// .NET 11, C# 14, EF Core 11
var conn = context.Database.GetDbConnection();
if (conn.State != ConnectionState.Open) await conn.OpenAsync();

await using var cmd = conn.CreateCommand();
cmd.CommandText = "dbo.TwoResultSets";
cmd.CommandType = CommandType.StoredProcedure;

await using var reader = await cmd.ExecuteReaderAsync();

var blogs = new List<Blog>();
while (await reader.ReadAsync())
    blogs.Add(new Blog { Id = reader.GetInt32(0), Name = reader.GetString(1) });

await reader.NextResultAsync();

var posts = new List<Post>();
while (await reader.ReadAsync())
    posts.Add(new Post { Id = reader.GetInt32(0), Title = reader.GetString(2) });
```

That returned three blogs and five posts, correctly split. You lose EF's materialization and tracking; if you want tracking, attach the results manually. At this level of manual work, Dapper's `QueryMultiple` is a reasonable thing to reach for instead, and the tradeoffs are the ones I measured in [compiled queries vs raw SQL vs Dapper](/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/).

## Mapping inserts, updates and deletes to procedures

Everything above is about querying. The reverse direction, having `SaveChanges` call your procedures instead of generating `INSERT`/`UPDATE`/`DELETE`, is a separate feature added in EF Core 7 and unchanged in 11:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.Entity<Person>()
    .InsertUsingStoredProcedure(
        "People_Insert",
        spb =>
        {
            spb.HasParameter(p => p.Name);
            spb.HasResultColumn(p => p.Id);
        })
    .DeleteUsingStoredProcedure(
        "People_Delete",
        spb =>
        {
            spb.HasOriginalValueParameter(p => p.Id);
            spb.HasRowsAffectedResultColumn();
        });
```

Two things from the docs are worth knowing before you commit to this. Parameters must be declared in the same order they appear in the procedure definition, because EF always invokes positionally rather than by name. And original-value parameters are required for key values in update and delete procedures. I did not exercise this path against a database, so treat the sample as docs-sourced.

The EF team is blunt about the feature in their own release notes: support for stored procedure mapping does not imply that stored procedures are recommended.

## Picking the right API

If the procedure returns full entity rows, use `FromSql` on the `DbSet` and accept the tracking. If it returns a projection, use `Database.SqlQuery<T>` with a plain DTO, or a keyless entity type when the shape is reused. If it returns nothing, use `ExecuteSql`. If it returns multiple result sets or a `RETURN` value you need, drop to a `DbCommand`.

Whichever you pick, put `AsEnumerable()` after the call the moment you want to filter, and read output parameters only after the enumeration has finished. Those two rules cover most of the questions on this topic.

## Related

- [Fix: the required column was not present in the results of a FromSql operation](/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [EF Core compiled queries vs raw SQL vs Dapper](/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)
- [Fix: the LINQ expression could not be translated in EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [How to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [How to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)

## Sources

- [SQL Queries, EF Core documentation](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)
- [Raw SQL queries for unmapped types, What's New in EF Core 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#raw-sql-queries-for-unmapped-types)
- [Keyless entity types, EF Core documentation](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)
- [Stored procedure mapping, What's New in EF Core 7](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/whatsnew#stored-procedure-mapping)
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [dotnet/efcore#8127, FromSql: Support multiple resultsets](https://github.com/dotnet/efcore/issues/8127)
- [RelationalStrings.FromSqlNonComposable](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.relationalstrings.fromsqlnoncomposable)
