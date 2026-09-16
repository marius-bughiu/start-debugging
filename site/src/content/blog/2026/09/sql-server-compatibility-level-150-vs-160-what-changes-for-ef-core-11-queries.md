---
title: "SQL Server compatibility level 150 vs 160: what changes for EF Core 11 queries"
description: "EF Core 11 now defaults UseSqlServer to compatibility level 160, which puts LEAST, GREATEST and two-argument LTRIM/RTRIM into your SQL, including every Take(n).FirstOrDefault(). Keep 160 on SQL Server 2022 and later; pin UseCompatibilityLevel(150) if any environment still runs SQL Server 2019."
pubDate: 2026-09-16
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-11"
---

Short answer: if every database your app talks to runs SQL Server 2022 or later, keep EF Core 11's new default of compatibility level 160. It turns `Math.Min`/`Math.Max`, `EF.Functions.Least`/`Greatest`, inline-array `Min`/`Max` and chained `Take` calls into `LEAST`/`GREATEST`, and `TrimStart(char)`/`TrimEnd(char)` into two-argument `LTRIM`/`RTRIM`. If any environment still runs SQL Server 2019, call `UseCompatibilityLevel(150)` before you upgrade. At 160, a query as ordinary as `.Take(pageSize).FirstOrDefaultAsync()` becomes `SELECT TOP(LEAST(@p, 1))`, and SQL Server 2019 does not have `LEAST`.

Everything below was checked against `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 on the .NET 11 RC 1 SDK (11.0.100-rc.1.26425.128) with C# 14, and against 10.0.12 on SDK 10.0.302 for the before picture. I compared the SQL both versions generate. I did not run it against a live SQL Server, so server-side behaviour is taken from the SQL Server documentation and linked below.

## 150 vs 160 at a glance

| LINQ shape (EF Core 11) | Level 150 (EF Core 10 default) | Level 160 (EF Core 11 default) |
| --- | --- | --- |
| `Math.Max(a, b)` in `Where` / `OrderBy` | Throws "could not be translated" | `GREATEST([a], [b])` |
| `Math.Min(a, b)` in the final `Select` | Evaluated on the client | `LEAST([a], [b])` on the server |
| `EF.Functions.Greatest(a, b, c)` in `Where` | Throws "could not be translated" | `GREATEST([a], [b], [c])` |
| `new[] { a, b }.Max()` | `(SELECT MAX(...) FROM (VALUES ...))` | `GREATEST([a], [b])` |
| `Take(n).FirstOrDefault()` | Nested `TOP(1)` over `TOP(@p)` subquery | `TOP(LEAST(@p, 1))` |
| `Skip(s).Take(n).First()` | `TOP(1)` over an `OFFSET`/`FETCH` subquery | `FETCH NEXT LEAST(@p1, 1) ROWS ONLY` |
| `TrimStart('0')` in `Where` | Throws "could not be translated" | `LTRIM([col], N'0')` |
| `ExecuteUpdate` setting a JSON property to a `DateTime` column | Throws | `JSON_MODIFY(..., JSON_VALUE(JSON_OBJECT('v': [col]), '$.v'))` |
| DDL / migrations | Identical | Identical |
| JSON columns | `nvarchar(max)` | `nvarchar(max)` (only 170 switches to `json`) |
| Minimum server | SQL Server 2019 | SQL Server 2022 (and database level 160 for `LTRIM`/`RTRIM` with characters) |

## EF's compatibility level is not your database's compatibility level

There are two separate settings, and both are called "compatibility level".

The **EF setting** is what you pass to `UseCompatibilityLevel`. EF never reads it from the server. It is fixed when the options are built, and it only decides which SQL features the query pipeline may use. In `SqlServerOptionsExtension` the defaults are `SqlServerDefaultCompatibilityLevel = 160` and `AzureSqlDefaultCompatibilityLevel = 170` in EF Core 11. In EF Core 10 the first one was 150. The change is [dotnet/efcore#38198](https://github.com/dotnet/efcore/issues/38198), shipped in PR #38199, and it is listed as a low-impact breaking change for EF Core 11.

The **database setting** is `sys.databases.compatibility_level`. It controls query-optimizer behaviour and a few syntax rules. At database level 160, SQL Server 2022 turns on parameter sensitive plan optimization and cardinality estimation feedback. A database you restore or attach onto a newer server keeps its old level. So a database moved from SQL Server 2019 to 2022 can still sit at 150.

The two settings only interact through the SQL EF sends. Microsoft's compatibility-level page says new T-SQL syntax "isn't gated by database compatibility level, except when they can break existing applications". `GREATEST` and `LEAST` are not in the list of exceptions, so they work on SQL Server 2022 at any database level. The optional *characters* argument of `LTRIM` and `RTRIM` is an exception: its docs require database compatibility level 160.

Note also that `UseAzureSql` and `UseSqlServer` are separate paths. `UseAzureSql` already defaulted to 170 in EF Core 10, so nothing in this post changes for Azure SQL users. If you point `UseSqlServer` at Azure SQL, you just moved from 150 to 160 like everyone else.

## How I measured the difference

The probe builds the same model three times (default, `UseCompatibilityLevel(150)`, `UseCompatibilityLevel(160)`). It prints `ToQueryString()` for queries. For `FirstOrDefaultAsync` and `ExecuteUpdateAsync`, an interceptor suppresses the connection and captures the command text, so no database is involved:

```csharp
// .NET 11 RC 1, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128
var configs = new (string Name, Action<DbContextOptionsBuilder> Configure)[]
{
    ("UseSqlServer (default)", o => o.UseSqlServer(Cs)),
    ("UseSqlServer + 150", o => o.UseSqlServer(Cs, s => s.UseCompatibilityLevel(150))),
    ("UseSqlServer + 160", o => o.UseSqlServer(Cs, s => s.UseCompatibilityLevel(160))),
};

foreach (var (name, configure) in configs)
{
    using var db = Shop.Create(configure); // adds the interceptor, EnableServiceProviderCaching(false)
    Q("Math.Max in Where", () => db.Products
        .Where(p => Math.Max(p.Stock, p.ReorderLevel) > 10).ToQueryString());
    Q("TrimStart('0') in Where", () => db.Products
        .Where(p => p.Sku.TrimStart('0') == "42").ToQueryString());
    // ...one line per shape in the table above
}

class NoDb : DbCommandInterceptor, IDbConnectionInterceptor
{
    public ValueTask<InterceptionResult> ConnectionOpeningAsync(DbConnection c, ConnectionEventData d,
        InterceptionResult r, CancellationToken t = default) => ValueTask.FromResult(InterceptionResult.Suppress());

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand cmd,
        CommandEventData d, InterceptionResult<DbDataReader> r, CancellationToken t = default)
    {
        Capture.Last = cmd.CommandText;
        throw new CapturedException(); // stop before anything needs a real reader
    }
    // ConnectionOpening (sync) and NonQueryExecutingAsync follow the same pattern
}
```

Running the same file against EF Core 10.0.12 gave a useful control. EF Core 10 with `UseCompatibilityLevel(160)` produced SQL identical to EF Core 11's default. None of these translations are new in EF Core 11. `Math.Min`/`Math.Max` via `LEAST`/`GREATEST` and the `char` overloads of `TrimStart`/`TrimEnd` both shipped in EF Core 9, gated on level 160. EF Core 11 only moved the default so they turn on without you asking.

## The change that bites: Take followed by First or Single

This is the one I did not expect, and it hits code that has nothing to do with `Math`. When a query already has a row limit and you add another, EF merges them. If both limits are constants it keeps the smaller one. Otherwise it calls `GenerateLeast`, which returns a `LEAST` expression only at level 160 or higher. Below 160 it returns null, and EF falls back to a nested query.

`FirstOrDefaultAsync` adds a limit of 1, and `SingleOrDefaultAsync` a limit of 2. EF parameterizes the value you pass to `Take`, even a literal like `Take(20)`. So a repository that returns a paged `IQueryable`, followed by a caller that asks for the first row, looks like this:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var first = await db.Products
    .OrderBy(p => p.Id)
    .Take(pageSize)
    .FirstOrDefaultAsync();
```

At level 160 (the EF Core 11 default):

```sql
SELECT TOP(LEAST(@p, 1)) [p].[Id], [p].[CreatedAt], [p].[ListPrice], [p].[Name], ...
FROM [Products] AS [p]
ORDER BY [p].[Id]
```

At level 150 (the EF Core 10 default):

```sql
SELECT TOP(1) [p0].[Id], [p0].[CreatedAt], [p0].[ListPrice], [p0].[Name], ...
FROM (
    SELECT TOP(@p) [p].[Id], [p].[CreatedAt], [p].[ListPrice], [p].[Name], ...
    FROM [Products] AS [p]
    ORDER BY [p].[Id]
) AS [p0]
ORDER BY [p0].[Id]
```

With `Skip`, the limit moves into `OFFSET @p ROWS FETCH NEXT LEAST(@p1, 1) ROWS ONLY`. `Take(n).Take(m)` with two parameters produces `TOP(LEAST(@p, @p1))`. `Take(n).AnyAsync()` and `Take(n).CountAsync()` are unaffected, because they wrap the limited query instead of stacking a second limit. `Take(n).Take(n)` with the same parameter is also unaffected, because EF sees two equal limits and keeps one.

On SQL Server 2022 the 160 form is simply shorter SQL. On SQL Server 2019 the server rejects `LEAST` as an unknown built-in function. This code compiled, passed tests against a newer server, and worked on EF Core 10. That is why a test suite that runs against a SQL Server 2022 container will not warn you.

## Math.Min, Math.Max and inline arrays

At 150, `Math.Max` and `EF.Functions.Greatest` cannot be translated at all. In a `Where` or `OrderBy` you get the usual `InvalidOperationException` asking you to rewrite the query or switch to client evaluation. In the final projection, EF quietly selects both columns and runs `Math.Min` on the client:

```sql
-- level 150: Select(p => new { p.Id, Effective = Math.Min(p.Price, p.ListPrice) })
SELECT [p].[Id], [p].[Price], [p].[ListPrice]
FROM [Products] AS [p]

-- level 160
SELECT [p].[Id], LEAST([p].[Price], [p].[ListPrice]) AS [Effective]
FROM [Products] AS [p]
```

That projection is the second silent change after upgrading: the same LINQ now depends on the server having `LEAST`.

Inline arrays had a working fallback at 150, a correlated `VALUES` subquery:

```sql
-- level 150: Where(p => new[] { p.Stock, p.ReorderLevel }.Max() > 10)
WHERE (
    SELECT MAX([v].[Value])
    FROM (VALUES ([p].[Stock]), ([p].[ReorderLevel])) AS [v]([Value])) > 10

-- level 160
WHERE GREATEST([p].[Stock], [p].[ReorderLevel]) > 10
```

The null semantics match. `GREATEST` and `LEAST` ignore `NULL` arguments unless all of them are `NULL`, just like `MAX` over the `VALUES` rows and like `Enumerable.Min` over a `decimal?[]`. EF also checks this: for a nullable result type it only picks `LEAST`/`GREATEST` when the function does not propagate nulls. So `new decimal?[] { p.SalePrice, p.Price }.Min()` becomes `LEAST([p].[SalePrice], [p].[Price])` without changing results.

## TrimStart and TrimEnd with characters

Trimming without arguments is `LTRIM(col)` at every level. Trimming specific characters needs the SQL Server 2022 two-argument form, and EF only uses it at 160:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var bySku = db.Products.Where(p => p.Sku.TrimStart('0') == "42");
var byName = db.Products.Where(p => p.Name.TrimEnd(' ', '.') == "Widget");
```

```sql
-- level 160
WHERE LTRIM([p].[Sku], N'0') = N'42'
WHERE RTRIM([p].[Name], N' .') = N'Widget'
```

At 150 both throw "could not be translated". In a final `Select` they run on the client, and at 160 they move to the server. This is the case that also depends on the database's own level. On SQL Server 2022 the `LTRIM` docs require database compatibility level 160 for the characters argument. A database that was restored from 2019 and never raised will reject it, even though `GREATEST` works fine on the same server.

## ExecuteUpdate into JSON columns

For JSON-mapped complex types, setting a property to an `int` or `string` column works at both levels. Setting it to a column of another type, such as `DateTime`, needs `JSON_OBJECT`, which is also SQL Server 2022:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
await db.Products.ExecuteUpdateAsync(s =>
    s.SetProperty(p => p.Details.LastPriceChange, p => p.CreatedAt));
```

At 160 that becomes `JSON_MODIFY([p].[Details], '$.LastPriceChange', JSON_VALUE(JSON_OBJECT('v': [p].[CreatedAt]), '$.v'))`. At 150 EF throws. EF Core 10.0.12 throws a message that tells you what to do: "'ExecuteUpdate' cannot set a property in a JSON column to an expression containing a column on SQL Server versions before 2022". EF Core 11 RC 1 wraps it in the generic "could not be translated, see inner exception" message.

## What does not change between 150 and 160

The schema. `GenerateCreateScript()` returned identical DDL at 150 and 160 for a model with a JSON complex type. `SupportsJsonType` only flips at 170, so JSON columns stay `nvarchar(max)` and changing between 150 and 160 creates no migration. The `OPENJSON`-based JSON querying that needs level 130 is untouched. Everything that needs 170 (the native `json` type, `JSON_CONTAINS`, `.modify()`) stays off at both levels.

## When to keep 160

- **Every environment is SQL Server 2022 or 2025, or Azure SQL / Managed Instance.** You get shorter SQL for paged queries, `Math.Min`/`Math.Max` on the server, and character trimming that translates instead of throwing.
- **You previously set `UseCompatibilityLevel(160)` by hand.** You can delete the call. The result is the same, as the EF Core 10 control run showed.
- **You relied on client evaluation of `Math.Min` or `TrimStart('0')` in projections.** Moving that work to the server is usually what you wanted anyway.

## When to pin 150

- **Any environment runs SQL Server 2019.** That includes staging, a customer's on-premises install, or a disaster-recovery replica. EF Core 11's provider docs still list SQL Server 2019 as supported, but only at level 150.
- **Your databases run on SQL Server 2022 at database level 150, and you do not control that.** For example, a vendor owns the database and will not raise the level because 160 changes query plans. `GREATEST`/`LEAST` would still work there, but `LTRIM`/`RTRIM` with characters would not. Pinning 150 is the only EF-side setting that covers both.
- **You ship one binary to many tenants on unknown SQL Server versions.** Pick the level your oldest supported server can run.

## Make the level explicit and check it at startup

Microsoft's own provider docs recommend configuring the level explicitly, and this default change is a good reason to follow that advice. Read it from configuration so each environment can declare what it runs:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1.26425.128
var level = builder.Configuration.GetValue("Database:CompatibilityLevel", 150);

builder.Services.AddDbContext<Shop>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Shop"),
        sql => sql.UseCompatibilityLevel(level)));
```

Then fail fast if the configured level asks for more than the server can give:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1.26425.128
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<Shop>();

    // EngineEdition 5 = Azure SQL Database, 8 = Azure SQL Managed Instance
    var engineEdition = await db.Database
        .SqlQuery<int>($"SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS [Value]")
        .SingleAsync();
    var serverMajor = await db.Database
        .SqlQuery<int>($"SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS [Value]")
        .SingleAsync();
    var databaseLevel = await db.Database
        .SqlQuery<int>($"SELECT CAST(compatibility_level AS int) AS [Value] FROM sys.databases WHERE name = DB_NAME()")
        .SingleAsync();

    // SQL Server 2019 = 15, 2022 = 16, 2025 = 17; the matching levels are 150, 160, 170
    var isAzure = engineEdition is 5 or 8;
    if ((!isAzure && level > serverMajor * 10) || level > databaseLevel)
        throw new InvalidOperationException(
            $"EF is configured for compatibility level {level}, but the server is version {serverMajor} " +
            $"and the database is at level {databaseLevel}.");
}
```

Azure SQL does not report a boxed SQL Server version you can compare this way, so the check relies only on the database level there. The database-level comparison is stricter than it needs to be for `LEAST`/`GREATEST`. I prefer it, because `LTRIM` with characters does depend on the database level and a check that only covers half the cases is worse than none. Run the same check in your integration tests against a container of the *oldest* server version you support, not the newest one.

## The recommendation, restated

Level 160 is the right default in 2026. SQL Server 2022 has been out for almost four years, and the SQL is better. But the default is a guess about your server, and for a SQL Server 2019 shop it is wrong in a way no compiler, analyzer or migration will point out. The first sign is a runtime SQL error on queries that worked in EF Core 10. So set `UseCompatibilityLevel` explicitly in every app you move to EF Core 11: 160 or higher if every server is 2022+, 150 if even one is not.

## Related

- The 170 step is a much bigger one, because it changes column types: [native json column vs nvarchar(max) in EF Core 11](/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/).
- If you are coming from an older release, [the EF Core 6 to 11 breaking changes that actually bite](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) covers the other version-dependent translations.
- The 150-level failures in this post are the classic [LINQ expression could not be translated error](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), and the rewrites there apply.
- To see which SQL your app actually sends after upgrading, [log the SQL EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).
- To catch the server-version mismatch in CI, [run integration tests against a real SQL Server with Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), pinned to your oldest production version.

## Sources

- [EF Core 11 breaking changes: SQL Server compatibility level now defaults to 160](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes#sqlserver-compatibility-level-160)
- [dotnet/efcore#38198: Bump default SQL Server compatibility level from 150 to 160](https://github.com/dotnet/efcore/issues/38198)
- [dotnet/efcore#38196: Math.Min/Max not translating on the old default level](https://github.com/dotnet/efcore/issues/38196)
- [EF Core SQL Server provider: compatibility level](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/#compatibility-level)
- [ALTER DATABASE compatibility level: supported levels and differences between 150 and 160](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-compatibility-level)
- [GREATEST (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/logical-functions-greatest-transact-sql)
- [LTRIM (Transact-SQL): the characters argument requires compatibility level 160](https://learn.microsoft.com/en-us/sql/t-sql/functions/ltrim-transact-sql)
- EF Core source at tag `v11.0.0-rc.1.26425.128`: `SqlServerSqlTranslatingExpressionVisitor.GenerateGreatest`/`GenerateLeast`, `RelationalQueryableMethodTranslatingExpressionVisitor.ApplyLimit`, `SqlServerStringMethodTranslator.TranslateTrimStartEnd`, `SqlServerSingletonOptions`
