---
title: "Native json column vs nvarchar(max) for storing JSON in SQL Server with EF Core 11"
description: "Use the native json type on SQL Server 2025 and Azure SQL: EF Core 11 gets JSON_CONTAINS, typed JSON_VALUE, in-place modify() and JSON indexes out of it. Stay on nvarchar(max) for SQL Server 2019/2022, legacy tooling, or a schema you must be able to roll back."
pubDate: 2026-09-12
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "json"
  - "dotnet-11"
---

Short answer: if your database is SQL Server 2025 or Azure SQL, store JSON in the native `json` type. With it, EF Core 11 emits typed `JSON_VALUE(... RETURNING int)`, translates `Contains` on a primitive collection to `JSON_CONTAINS`, runs `ExecuteUpdate` through the in-place `.modify()` method, and can create a `CREATE JSON INDEX`. None of that works on `nvarchar(max)`. Stay on `nvarchar(max)` if you run SQL Server 2019 or 2022, have tools that read the column raw (bcp native format, old ODBC clients), or need a schema change you can roll back: SQL Server refuses to `ALTER` a `json` column back to a string type.

Everything below was checked against `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 on the .NET 11 RC 1 SDK (11.0.100-rc.1.26425.128), with C# 14. The server-side behaviour comes from the SQL Server 2025 (17.x) documentation.

## The comparison at a glance

| | `json` (native) | `nvarchar(max)` |
| --- | --- | --- |
| Available on | SQL Server 2025, Azure SQL Database, Azure SQL MI, SQL database in Fabric | Every SQL Server version |
| EF Core 11 default when | `UseAzureSql`, or `UseCompatibilityLevel(170)` | `UseSqlServer` (default level 160) |
| Storage | Parsed binary, UTF-8 (`Latin1_General_100_BIN2_UTF8`), up to 2 GB | UTF-16 text |
| Validation on write | Always; top level must be an object or array | None unless you add `CHECK (ISJSON(...) = 1)` |
| Scalar filter SQL | `JSON_VALUE(col, '$.x' RETURNING int)` | `CAST(JSON_VALUE(col, '$.x') AS int)` |
| `tags.Contains("x")` | `JSON_CONTAINS(col, N'x') = 1` | `N'x' IN (SELECT ... FROM OPENJSON(col) ...)` |
| `ExecuteUpdate` on one property | `SET [col].modify('$.x', ...)` | `SET col = JSON_MODIFY(col, '$.x', ...)` |
| `CREATE JSON INDEX` | Yes (SQL Server 2025, preview) | No |
| Parameter type EF sends | `SqlDbType.Json` | `SqlDbType.NVarChar` |
| Convert back with `ALTER COLUMN` | Not allowed | N/A |
| What older clients see | `varchar(max)` or `nvarchar(max)` | `nvarchar(max)` |

## What changes when EF Core 11 picks the json type

EF does not decide based on the database it connects to. It decides based on the compatibility level you configure, and it does that at model-building time. I built a small probe that configures the same model four ways and prints the DDL and SQL, with an interceptor that suppresses the connection so no database is needed:

```csharp
// .NET 11 RC 1, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128
public class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
    public string[] Tags { get; set; } = [];          // primitive collection, always JSON
    public required Shipping Shipping { get; set; }   // complex type mapped with ToJson()
}

public class Shipping
{
    public string City { get; set; } = "";
    public int Priority { get; set; }
}

protected override void OnModelCreating(ModelBuilder mb)
    => mb.Entity<Order>().ComplexProperty(o => o.Shipping, s => s.ToJson());
```

With plain `UseSqlServer(connectionString)`, EF Core 11 runs at compatibility level 160. That default changed in EF Core 11: EF Core 10 used 150. Both JSON columns come out as `nvarchar(max)`:

```sql
-- UseSqlServer, default level 160
CREATE TABLE [Orders] (
    [Id] int NOT NULL,
    [Customer] nvarchar(max) NOT NULL,
    [Tags] nvarchar(max) NOT NULL,
    [Shipping] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

Switch to `UseSqlServer(cs, o => o.UseCompatibilityLevel(170))`, or to `UseAzureSql(cs)` (which defaults to 170), and the same model produces `[Tags] json NOT NULL` and `[Shipping] json NOT NULL`. Nothing else in your code changes. That is the first thing to internalize: **moving from `UseSqlServer` to `UseAzureSql` is a column type change**, whether you meant it or not.

The queries change too. Here are the three LINQ shapes that matter most, as generated at each level:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
ctx.Orders.Where(o => o.Shipping.Priority > 2);
ctx.Orders.Where(o => o.Tags.Contains("gift"));
await ctx.Orders.Where(o => o.Id == 1)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Shipping.Priority, o => o.Shipping.Priority + 1));
```

At level 160 (`nvarchar(max)`):

```sql
WHERE CAST(JSON_VALUE([o].[Shipping], '$.Priority') AS int) > 2

WHERE N'gift' IN (
    SELECT [t].[value]
    FROM OPENJSON([o].[Tags]) WITH ([value] nvarchar(max) '$') AS [t]
)

UPDATE [o]
SET [o].[Shipping] = JSON_MODIFY([o].[Shipping], '$.Priority', CAST(JSON_VALUE([o].[Shipping], '$.Priority') AS int) + 1)
FROM [Orders] AS [o]
WHERE [o].[Id] = 1
```

At level 170 (`json`):

```sql
WHERE JSON_VALUE([o].[Shipping], '$.Priority' RETURNING int) > 2

WHERE JSON_CONTAINS([o].[Tags], N'gift') = 1

UPDATE [o]
SET [Shipping].modify('$.Priority', JSON_VALUE([o].[Shipping], '$.Priority' RETURNING int) + 1)
FROM [Orders] AS [o]
WHERE [o].[Id] = 1
```

On the write path, `SaveChanges` still sends the whole document for a change to one property (`UPDATE [Orders] SET [Shipping] = @p0`), at both levels. The difference is the parameter: at 170, the `Microsoft.Data.SqlClient` 7.0.2 that EF Core 11 RC 1 pulls in sends it as `SqlDbType.Json` instead of `SqlDbType.NVarChar`. Only `ExecuteUpdate` gets the partial, in-place update. If you want to capture this SQL from your own app, [logging the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) covers the options.

## When to pick the native json type

- **You are on Azure SQL Database or Managed Instance.** The type is generally available there with the SQL Server 2025 or Always-up-to-date update policy, and `UseAzureSql` already selects it. Opting out costs you `JSON_CONTAINS` and the typed `RETURNING` clause and gains you nothing.
- **You are on SQL Server 2025 and filter inside documents.** `JSON_VALUE`, `JSON_PATH_EXISTS` and `JSON_CONTAINS` can use a JSON index, and EF Core 11 can now create one from the model (next section). On `nvarchar(max)` your only index option is a computed column per path.
- **You bulk-update fields inside documents.** `ExecuteUpdate` becomes `.modify()`, which Microsoft documents as updating in place when the new value fits: a string no longer than the old one, or a number of the same type or range. `JSON_MODIFY` on text rewrites the value.
- **You want the database to reject garbage.** A `json` column refuses anything that is not a well-formed object or array. With `nvarchar(max)` that check only exists if you add it yourself.

## When to stay on nvarchar(max)

- **Your production server is SQL Server 2019 or 2022.** The type does not exist there, and EF only uses it if you raise the compatibility level, so keep the default level 160 or set 150 explicitly.
- **Something outside EF reads the column.** SQL Server's `json` docs note that `sp_describe_first_result_set` does not report the `json` type. Clients on TDS 7.4 or later see `varchar(max)` with a UTF-8 collation, and older ones see `nvarchar(max)`. The bcp native format writes the document as text, so you need a format file to load it back. ETL packages that have hard-coded column metadata are the usual casualty.
- **You need a reversible migration.** You can `ALTER` `nvarchar(max)` to `json`, but SQL Server does not allow `ALTER TABLE` to turn a `json` column back into a string or binary type. The `Down()` method EF scaffolds for the conversion is a plain `ALTER COLUMN ... nvarchar(max)`, so rolling back means adding a new column, copying, and swapping by hand.
- **Your queries use shapes the type does not support yet.** The EF Core 10 breaking-change note calls out one: `DISTINCT` over JSON arrays is not supported on `json`, and such queries fail.

## Evidence: what I measured and what I did not

I did not run a storage or latency benchmark. There is no SQL Server 2025 instance in my test setup, and I am not going to put a speed-up number next to a type I did not time. What the probe above does show, for EF Core 11 RC 1:

1. The column type is decided only by `UseAzureSql` or compatibility level 170 or higher. `UseSqlServer` defaults to 160 (confirmed in `SqlServerOptionsExtension`, where `SqlServerDefaultCompatibilityLevel = 160` and `AzureSqlDefaultCompatibilityLevel = 170`).
2. Each translation difference in the table above is exact generated SQL, not paraphrased from release notes.
3. The migration EF generates to go from 160 to 170 is one `ALTER COLUMN` per JSON column (default constraint handling omitted):

```sql
-- EF Core 11.0.0-rc.1, model diff from level 160 to level 170
ALTER TABLE [Orders] ALTER COLUMN [Tags] json NOT NULL;
ALTER TABLE [Orders] ALTER COLUMN [Shipping] json NOT NULL;
```

The storage and read claims are Microsoft's. The [json data type reference](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type) says reads are more efficient because the document is already parsed, writes can update individual values, and the binary format is "optimized for compression". Measure with your own documents before promising anyone a number. Small, flat documents gain much less than large, nested ones that you filter on.

## The gotcha that picks for you: JSON indexes

EF Core 11 adds `HasIndex` over paths inside JSON complex types, which becomes SQL Server 2025's `CREATE JSON INDEX`. This is the strongest reason to move to `json`, and it has a trap. Here is what the probe printed when I added an index to the model above:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
mb.Entity<Order>().HasIndex("Shipping.City");
```

At level 170 you get what you want:

```sql
CREATE JSON INDEX [IX_Orders_Shipping_City] ON [Orders]([Shipping]) FOR (N'$.City');
```

At level 160, EF emits the **exact same statement**, even though the column it just created is `nvarchar(max)`. The migrations SQL generator does not check the store type before writing `CREATE JSON INDEX`. The [CREATE JSON INDEX reference](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) requires a `json` column, so that migration will fail when applied. That is also why Microsoft's own sample pins the type explicitly:

```csharp
// .NET 11, EF Core 11 - make the column type independent of the compatibility level
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.Contact, b => b.ToJson().HasColumnType("json"));

modelBuilder.Entity<Customer>()
    .HasIndex("Contact.Address.City");
```

Three more constraints come from the SQL side. JSON indexes are in preview and documented for SQL Server 2025 only, not Azure SQL. The table needs a clustered primary key. And an index can only be created offline, taking a schema modification lock for its whole duration. Plan the migration window accordingly; the [migrations bundle workflow for production](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) is the safe way to run it.

A related note for Azure SQL: the `json` type docs still list `.modify()` as a preview feature available only in SQL Server 2025, but EF emits it for every `json` column, including under `UseAzureSql`. I could not test that combination. Before you rely on `ExecuteUpdate` into JSON properties on Azure SQL, run it once against a real database. This mismatch has hit EF before: [the `AS JSON` error on Azure SQL](/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/) came from EF emitting `json` in an `OPENJSON` clause that only SQL Server 2025 accepts. It was fixed in EF Core 10.0.11.

## Opting out, per column or globally

If you are on Azure SQL but not ready to convert, you have two switches. The global one lowers the compatibility level EF assumes:

```csharp
// .NET 11, EF Core 11 - keep every JSON column on nvarchar(max) on Azure SQL
optionsBuilder.UseAzureSql(connectionString, o => o.UseCompatibilityLevel(160));
```

That also switches off every other level-170 translation, including `JSON_CONTAINS`. The targeted one pins individual columns and keeps the rest of the model on 170:

```csharp
// .NET 11, EF Core 11 - pin specific columns to text, verified to emit nvarchar(max) at level 170
modelBuilder.Entity<Order>()
    .ComplexProperty(o => o.Shipping, s => s.ToJson().HasColumnType("nvarchar(max)"));
modelBuilder.Entity<Order>()
    .PrimitiveCollection(o => o.Tags).HasColumnType("nvarchar(max)");
```

Going the other way on an existing database, raise the level, run `dotnet ef migrations add ConvertJsonColumns`, and read the generated migration before applying it. It touches every JSON column in the model at once, primitive collections included, which is easy to forget when you only mapped one complex type with `ToJson()`. For the modeling side of that decision, [complex types vs owned entities in EF Core 11](/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) explains why `ComplexProperty(...).ToJson()` is the mapping to be on before you convert. `ExecuteUpdate` into JSON only works with complex types.

## The recommendation, restated

Choose `json` on SQL Server 2025 and Azure SQL. That is where EF Core 11 is heading: `JSON_CONTAINS`, typed `JSON_VALUE`, `.modify()` and JSON indexes all depend on it, and `UseAzureSql` already assumes it. Set `HasColumnType("json")` explicitly on any JSON column you index, so a compatibility-level change can never produce a migration that fails. Stay on `nvarchar(max)` when the server is older than 2025, when non-EF tooling reads the raw column, or when you cannot accept a one-way schema change yet. In that last case, pin the type per column rather than lowering the compatibility level for the whole context. For the query side once you have converted, the walkthrough on [mapping and querying JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) picks up where this post stops.

## Sources

- [json data type (SQL Server 2025, Azure SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type): storage format, `modify`, conversion rules, limitations
- [CREATE JSON INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql)
- [What's New in EF Core 11: JSON indexes, JSON_CONTAINS, compatibility level 160 default](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: JSON type support](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [EF Core 10 breaking change: json data type used by default on Azure SQL and compatibility level 170](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/breaking-changes)
- [JSON data type support in SqlClient](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql/json-data-sql-server)
- [dotnet/efcore#29623: SQL Server, support JSON indexes](https://github.com/dotnet/efcore/issues/29623)
