---
title: "Fix: AS JSON option can be specified only for column of nvarchar(max) type in WITH clause"
description: "EF Core emits [col] json '$.path' AS JSON inside OPENJSON WITH, which Azure SQL rejects with Msg 13618. Upgrade to EF Core 10.0.11+, or drop the provider compatibility level to 160."
pubDate: 2026-09-09
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "azure"
  - "json"
  - "dotnet-10"
---

Upgrade `Microsoft.EntityFrameworkCore.SqlServer` to 10.0.11 or later. Before that version, EF Core generated `[col] json '$.path' AS JSON` inside an `OPENJSON ... WITH` clause whenever a JSON-mapped complex type contained a nested collection and the provider was running at compatibility level 170. SQL Server 2025 accepts the native `json` type in that position; Azure SQL does not, and rejects it with Msg 13618. If you cannot upgrade, pass `o => o.UseCompatibilityLevel(160)`. One catch: the fix only kicks in when EF knows it is talking to Azure SQL, which means you must be calling `UseAzureSql`, not `UseSqlServer` against an Azure connection string.

## The error in context

The exception surfaces as a plain `SqlException` on the first query that reaches into a nested JSON collection:

```
Microsoft.Data.SqlClient.SqlException (0x80131904): AS JSON option can be specified only for column of nvarchar(max) type in WITH clause.
   at Microsoft.EntityFrameworkCore.Storage.RelationalCommand.ExecuteReaderAsync(RelationalCommandParameterObject parameterObject, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Query.Internal.SingleQueryingEnumerable`1.AsyncEnumerator.InitializeReaderAsync(AsyncEnumerator enumerator, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Storage.ExecutionStrategy.ExecuteAsync[TState,TResult](TState state, ...)
   at Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.ToListAsync[TSource](IQueryable`1 source, CancellationToken cancellationToken)
```

The server-side error number is 13618. The SQL that produced it looks like this:

```sql
SELECT [p].[value]
FROM [Cars] AS [c]
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] json '$.partNumbers' AS JSON
) AS [o]
CROSS APPLY OPENJSON([o].[partNumbers]) WITH ([value] varchar(32) '$') AS [p]
WHERE [c].[Vin] = '1FA6P8TH8J5123456' AND [c].[DealerId] = 'DEALER-001' AND [o].[packageId] = N'PKG-SPORT'
```

The offending line is `[partNumbers] json '$.partNumbers' AS JSON`. Everything else in the statement is fine.

The tell that you are on this page rather than a lookalike: the failure is environment-dependent. The same binary, the same model and the same query run against a local SQL Server 2025 instance and fail against Azure SQL, even when both databases report compatibility level 170.

## Why this happens

Three independent facts collide.

**`AS JSON` has always required `nvarchar(max)`.** The [OPENJSON reference](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql) is explicit: "If you specify the `AS JSON` option, the type of the column must be **nvarchar(MAX)**." That rule predates the native `json` type by nine years.

**SQL Server 2025 relaxed the rule, Azure SQL has not.** The native `json` data type is generally available on Azure SQL Database and Azure SQL Managed Instance, and in preview on SQL Server 2025. But the [json data type limitations](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type#limitations) carve out `OPENJSON` specifically: "Currently, the `OPENJSON()` function doesn't accept the **json** data type in some platforms. Currently, it's an implicit conversion. Explicitly convert to **nvarchar(max)** first. In SQL Server 2025 (17.x), the `OPENJSON()` function does support **json**." So the `json` type in a `WITH` clause is a SQL Server 2025 on-premises capability, not an Azure SQL one.

**`UseAzureSql` turns on compatibility level 170 by default, and 170 is what makes EF choose the `json` type.** In `SqlServerOptionsExtension`, `SqlServerDefaultCompatibilityLevel` is 160 while `AzureSqlDefaultCompatibilityLevel` is 170. `SqlServerSingletonOptions.SupportsJsonType` returns true at 170 and above. The practical consequence is that you do not have to opt into anything: switching from `UseSqlServer` to `UseAzureSql` is enough to move your JSON columns onto the native `json` type and to start emitting `json ... AS JSON` in generated queries.

Before EF Core 10.0.11, `SqlServerQuerySqlGenerator.GenerateColumnInfo` wrote out `columnInfo.TypeMapping.StoreType` verbatim for every column in the `WITH` clause. When the store type was `json` and the column carried `AS JSON`, that produced SQL only SQL Server 2025 could parse.

Note that the query shape matters. A JSON column you only read whole never hits this, and neither does a `Where` over a scalar inside the document. `AS JSON` shows up when the query pushes into a collection nested inside the JSON document, because EF has to hand that nested array to a second `OPENJSON` call. If you are new to how EF turns nested documents into `OPENJSON` trees, the mechanics are covered in [mapping and querying JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/).

## Minimal repro

The model needs a complex type mapped to JSON, containing a collection of complex types, containing a primitive collection. That is the shape reported in [dotnet/efcore#38615](https://github.com/dotnet/efcore/issues/38615):

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
public class Car
{
    public int CarId { get; set; }
    public string Vin { get; set; } = null!;
    public string DealerId { get; set; } = null!;
    public CarConfiguration CarConfiguration { get; set; } = null!;
}

public class CarConfiguration
{
    public string? CurrentTrim { get; set; }
    public List<OptionPackage>? OptionPackages { get; set; }
}

public class OptionPackage
{
    public required string PackageId { get; set; }
    public required ICollection<string> PartNumbers { get; set; }
}
```

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Car>(builder =>
    {
        builder.ToTable("Cars");
        builder.HasKey(e => e.CarId);
        builder.Property(e => e.Vin).IsUnicode(false).HasMaxLength(32);
        builder.Property(e => e.DealerId).IsUnicode(false).HasMaxLength(32);

        builder.ComplexProperty(e => e.CarConfiguration, pp =>
        {
            pp.ToJson("CarConfiguration");
            pp.IsRequired();
            pp.Property(p => p.CurrentTrim).HasJsonPropertyName("currentTrim");

            pp.ComplexCollection(p => p.OptionPackages, op =>
            {
                op.HasJsonPropertyName("optionPackages");
                op.Property(o => o.PackageId).HasJsonPropertyName("packageId");
                op.PrimitiveCollection(o => o.PartNumbers)
                    .ElementType(e => e.IsUnicode(false).HasMaxLength(32))
                    .HasJsonPropertyName("partNumbers");
            });
        });
    });
}
```

There is deliberately no `HasColumnType("json")` in that configuration. You do not need one: at compatibility level 170 the provider picks the native type on its own.

The query that fails is any projection that walks two levels down:

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
var options = new DbContextOptionsBuilder<CarContext>()
    .UseAzureSql(connectionString)   // defaults to compatibility level 170
    .Options;

await using var ctx = new CarContext(options);

var partNumbers = await ctx.Cars
    .Where(c => c.Vin == "1FA6P8TH8J5123456" && c.DealerId == "DEALER-001")
    .SelectMany(c => c.CarConfiguration.OptionPackages!)
    .Where(op => op.PackageId == "PKG-SPORT")
    .SelectMany(op => op.PartNumbers)
    .ToListAsync();                  // Msg 13618 on Azure SQL
```

You do not need an Azure subscription to see the bad SQL. `ToQueryString()` generates without opening a connection, so a throwaway console app with a fake connection string is enough to confirm which shape your build produces. Running that harness against 10.0.10 prints the `[partNumbers] json '$.partNumbers' AS JSON` line shown earlier.

## Fix, in detail

### 1. Upgrade to EF Core 10.0.11 or later

This is the real fix and it needs no model or query changes. [dotnet/efcore#38665](https://github.com/dotnet/efcore/pull/38665) landed on the `release/10.0` branch on 2026-07-20 and shipped in 10.0.11 (2026-08-11). The current patch, 10.0.12, has it too.

```xml
<!-- .NET 10 -->
<PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="10.0.12" />
```

Same repro, same query, `Microsoft.EntityFrameworkCore.SqlServer` 10.0.12 and `UseAzureSql`:

```sql
SELECT [p].[value]
FROM [Cars] AS [c]
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] nvarchar(max) '$.partNumbers' AS JSON
) AS [o]
CROSS APPLY OPENJSON([o].[partNumbers]) WITH ([value] varchar(32) '$') AS [p]
WHERE [c].[Vin] = '1FA6P8TH8J5123456' AND [c].[DealerId] = 'DEALER-001' AND [o].[packageId] = N'PKG-SPORT'
```

The generator now substitutes the type only in that one position:

```csharp
// dotnet/efcore, SqlServerQuerySqlGenerator.GenerateColumnInfo, release/10.0
if (columnInfo.AsJson
    && columnInfo.TypeMapping.StoreType == "json"
    && (_sqlServerSingletonOptions.EngineType != SqlServerEngineType.SqlServer
        || _sqlServerSingletonOptions.SqlServerCompatibilityLevel < 170))
{
    Sql.Append("nvarchar(max)");
}
else
{
    Sql.Append(columnInfo.TypeMapping.StoreType);
}
```

Nothing about your table changes. The column stays `json` on disk; only the `WITH` clause declaration is rewritten, and `OPENJSON` still accepts the `json` column as its first argument through implicit conversion.

### 2. If you cannot upgrade, drop the compatibility level to 160

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.SqlServer 10.0.9 or 10.0.10
optionsBuilder.UseAzureSql(connectionString, o => o.UseCompatibilityLevel(160));
```

At 160, `SupportsJsonType` is false, the JSON column maps to `nvarchar(max)`, and the `WITH` clause reverts to `[partNumbers] nvarchar(max) '$.partNumbers' AS JSON`. Confirmed against 10.0.10.

The cost is not limited to that one clause. Compatibility level 160 also turns off `JSON_CONTAINS` translation, the `json` type's `.modify()` support for `ExecuteUpdate`, and the other 170-only translations described in [EF Core 11's JSON_CONTAINS translation](/2026/04/efcore-11-json-contains-sql-server-2025/). More importantly, it changes the modelled column type, which the migrations pipeline will notice. Reading the store type straight off the relational model on 10.0.12 makes that concrete:

```
UseAzureSql (default compat 170)            Cars.CarConfiguration -> json
UseSqlServer + UseCompatibilityLevel(170)   Cars.CarConfiguration -> json
UseSqlServer + UseCompatibilityLevel(160)   Cars.CarConfiguration -> nvarchar(max)
```

If your table is already `json` and you lower the compatibility level, the next `dotnet ef migrations add` will generate an `ALTER COLUMN` back to `nvarchar(max)`. SQL Server will not let you convert a `json` column to a string type with `ALTER TABLE` anyway, so that migration fails at deployment rather than silently rewriting your data. Treat 160 as a runtime stopgap and keep it out of the model you scaffold migrations from, or accept that you are on `nvarchar(max)` storage for good.

### 3. Check that you are actually calling `UseAzureSql`

This is the part that trips people who upgrade and still see the error. Look again at the generator condition: it substitutes `nvarchar(max)` when the engine type is not `SqlServer`, or when it is `SqlServer` at a compatibility level below 170. Point `UseSqlServer` at an Azure SQL connection string, ask for level 170, and EF concludes it is talking to an on-premises SQL Server 2025 box that supports `json` in `OPENJSON`. On 10.0.12 that combination still emits the failing line:

```sql
-- UseSqlServer + UseCompatibilityLevel(170), EF Core 10.0.12
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] json '$.partNumbers' AS JSON
) AS [o]
```

That is correct behaviour, not a second bug: EF cannot tell where a connection string points without asking the server. The fix is to declare the engine you are on. `UseAzureSql` exists since EF Core 9.0 and also configures Azure-appropriate connection resiliency for free.

```csharp
// .NET 10, EF Core 9.0 and later
builder.Services.AddDbContext<CarContext>(options =>
    options.UseAzureSql(builder.Configuration.GetConnectionString("CarContext")));
```

Azure SQL Managed Instance uses the same call. Azure Synapse has `UseAzureSynapse`, which reports `SupportsJsonType` as false unconditionally, so it never reaches this code path.

### 4. What does not work: overriding the container column type

The obvious-looking workaround is to force the JSON column back to a string type:

```csharp
// Does NOT fix the WITH clause
pp.ToJson("CarConfiguration");
pp.HasColumnType("nvarchar(max)");
```

On 10.0.10 with `UseSqlServer` at level 170, that still emits `[partNumbers] json '$.partNumbers' AS JSON`. The reason is that `HasColumnType` sets the store type of the container column, while the `WITH` clause entry for a nested collection gets its type from the provider's JSON type mapping, which is chosen from the compatibility level. Changing the outer column does not reach the inner declaration. Reach for the version bump or the compatibility level instead.

## Gotchas and lookalike errors

**"The store type 'nvarchar(2000)' specified for JSON column ... is not supported by the current provider."** Different error, different cause. This one is an `InvalidOperationException` thrown by model validation before any SQL is generated, and it fires on every configuration, Azure or not:

```
InvalidOperationException: The store type 'nvarchar(2000)' specified for JSON column 'CarConfiguration' in table 'Cars' is not supported by the current provider. JSON columns require a provider-specific JSON store type.
```

It means you pinned a JSON column to a non-MAX `nvarchar(x)`, which worked in EF Core 9 and became a validation error in EF Core 10 ([dotnet/efcore#37424](https://github.com/dotnet/efcore/issues/37424)). Use `nvarchar(max)` or `json`, or drop the `HasColumnType` call and let the provider choose.

**Handwritten SQL and `FromSql`.** Msg 13618 is a T-SQL rule, not an EF rule. If the failing statement is your own `OPENJSON ... WITH (Payload nvarchar(100) '$.payload' AS JSON)`, no EF version fixes it: widen the column declaration to `nvarchar(max)`. The [common JSON issues](https://learn.microsoft.com/en-us/sql/relational-databases/json/solve-common-issues-with-json-in-sql-server) page in the SQL docs covers the same rule from the T-SQL side. Because raw SQL bypasses the query pipeline, `ToQueryString()` will not help you here; the SQL you wrote is the SQL that runs.

**On-premises SQL Server 2025 is not affected.** If your database is SQL Server 2025 (17.x) and EF is configured with `UseSqlServer` plus level 170, `json ... AS JSON` is valid and the pre-10.0.11 SQL runs fine. That asymmetry is exactly why this bug survived until a customer ran the same build against Azure.

**EF's compatibility level is not the database's.** `UseCompatibilityLevel(170)` only tells EF what SQL it may generate. It does not run `ALTER DATABASE ... SET COMPATIBILITY_LEVEL`. Setting EF to 170 against a database still at 150 produces a different family of syntax errors entirely.

**A `SELECT` that only reads the whole document is safe.** If the error appeared after a seemingly unrelated refactor, look for a new `SelectMany`, `Any` or `Contains` over a nested collection. That is what pulls in the second `OPENJSON` and the `AS JSON` column. Turning on SQL logging as described in [how to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) tells you within one request which query changed shape.

## Does EF Core 11 have the fix

The same generator code is present on the `release/11.0` branch, so `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128, published 2026-09-08, ships the fix. That package targets `net11.0` only, so verifying it needs a .NET 11 SDK; every SQL sample above was produced on .NET SDK 10.0.302 against EF Core 10.0.10, 10.0.11 and 10.0.12 using `ToQueryString()`.

If you are moving a JSON-heavy model onto EF Core 11 anyway, this is worth folding into the same pass as the mapping decisions in [complex types vs owned entities](/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) and the provider-level changes in [migrating EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/). The underlying lesson generalizes past this one error: "Azure SQL" and "SQL Server 2025" are not the same target, they diverge on JSON in particular, and EF only knows which one you are on because you told it.

## Related

- [How to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)
- [EF Core 11 translates Contains to JSON_CONTAINS on SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/)
- [Complex types vs owned entities in EF Core 11](/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)
- [How to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Migrate EF Core 6 to EF Core 11: breaking changes that actually bite](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)

## Sources

- [dotnet/efcore#38615, Exception when querying json that happens only on Azure SQL with compatibility level 170](https://github.com/dotnet/efcore/issues/38615)
- [dotnet/efcore#38665, Fix OPENJSON AS JSON failure on Azure SQL when column type is json at compat level 170](https://github.com/dotnet/efcore/pull/38665)
- [dotnet/efcore#37424, EF10 SQL Server: JSON types mapped to nvarchar(x) no longer work](https://github.com/dotnet/efcore/issues/37424)
- [OPENJSON (Transact-SQL), including the AS JSON column type rule](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql)
- [json data type limitations, on OPENJSON and the json type](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type#limitations)
- [Microsoft SQL Server database provider for EF Core, on UseAzureSql and compatibility levels](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/)
- [Solve common issues with JSON in SQL Server](https://learn.microsoft.com/en-us/sql/relational-databases/json/solve-common-issues-with-json-in-sql-server)
