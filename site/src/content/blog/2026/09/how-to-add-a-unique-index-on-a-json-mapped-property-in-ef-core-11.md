---
title: "How to add a unique index on a JSON-mapped property in EF Core 11 (SQL Server and SQLite)"
description: "HasIndex(...).IsUnique() on a ToJson() member does not enforce uniqueness in EF Core 11 RC 1: SQL Server drops IsUnique and SQLite indexes the whole document. Expose the JSON value as a computed column and put the unique index on that instead."
pubDate: 2026-09-27
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "sqlite"
  - "json"
  - "dotnet-11"
---

Short answer: in EF Core 11 RC 1, do not put `IsUnique()` on an index over a member of a `ToJson()` complex property. It does not do what the model says. On SQL Server, EF emits `CREATE JSON INDEX`, which has no unique form, and silently drops `IsUnique()`. On SQLite, EF emits `CREATE UNIQUE INDEX ... ("Contact")`, so it indexes the entire JSON document, and two rows with the same email are accepted. The fix that works on both providers is to expose the JSON value as a shadow property mapped to a computed column (`JSON_VALUE` on SQL Server, `json_extract` on SQLite), put `HasIndex(...).IsUnique()` on that column, and query through `EF.Property` so the index is actually used.

I checked everything below against `Microsoft.EntityFrameworkCore.SqlServer` and `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128 on the .NET 11 RC 1 SDK (11.0.100-rc.1.26425.128), C# 14. I executed the SQLite results against a real in-memory database. I produced the SQL Server DDL with `GenerateCreateScript()` and the migrations SQL generator, and did not run it against a live SQL Server 2025. Where server behaviour matters, I cite the SQL Server documentation.

## The model that looks right but is not

EF Core 11 added indexes over properties inside complex types, including complex types mapped to a JSON column. The [What's New page](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) shows `HasIndex("Contact.Address.City")` producing a SQL Server JSON index. It is natural to add `.IsUnique()` to that and expect a constraint:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128, C# 14
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public Contact Contact { get; set; } = new();
}

public class Contact
{
    public string Email { get; set; } = "";
    public Address Address { get; set; } = new();
}

public class Address { public string City { get; set; } = ""; }

protected override void OnModelCreating(ModelBuilder mb)
{
    mb.Entity<Customer>().ComplexProperty(c => c.Contact, b => b.ToJson());
    mb.Entity<Customer>().HasIndex("Contact.Email").IsUnique(); // looks fine, is not
}
```

On SQL Server at compatibility level 170, `GenerateCreateScript()` prints:

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Contact] json NOT NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
CREATE JSON INDEX [IX_Customers_Contact_Email] ON [Customers]([Contact]) FOR (N'$.Email');
```

There is no `UNIQUE` anywhere. The [CREATE JSON INDEX syntax](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) has no unique option at all. A JSON index is a search structure for `JSON_VALUE`, `JSON_PATH_EXISTS` and `JSON_CONTAINS` predicates, not a constraint. At level 160 you get the same `CREATE JSON INDEX` over an `nvarchar(max)` column, which will fail when applied, a trap I covered in [native json vs nvarchar(max) in EF Core 11](/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/). With logging at `Warning`, EF logged nothing about the dropped `IsUnique()`.

SQLite is worse, because it looks like it worked:

```sql
CREATE TABLE "Customers" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Customers" PRIMARY KEY AUTOINCREMENT,
    "Name" TEXT NOT NULL,
    "Contact" TEXT NOT NULL
);
CREATE UNIQUE INDEX "IX_Customers_Contact_Email" ON "Customers" ("Contact");
```

The index is named after `Contact_Email`, but the key is the whole `"Contact"` column. I inserted two customers with the same email and different cities, and both `SaveChanges` calls succeeded. Then I inserted two customers whose entire `Contact` documents were identical, and the second one failed with `SQLite Error 19: 'UNIQUE constraint failed: Customers.Contact'`. So the constraint you get is "no two customers may have byte-identical contact documents", which is not a rule anyone wants.

Both behaviours are reported upstream: [dotnet/efcore#39065](https://github.com/dotnet/efcore/issues/39065) for SQL Server and [dotnet/efcore#39064](https://github.com/dotnet/efcore/issues/39064) for SQLite. Npgsql has the same whole-column problem for `jsonb` in [npgsql/efcore.pg#3918](https://github.com/npgsql/efcore.pg/issues/3918).

## Why a JSON path cannot be a unique key directly

A unique index needs a scalar key per row. A JSON document is one value in one column. The database only sees `$.Email` as a scalar if something extracts it:

- SQL Server does not allow an index key to be an expression. The documented pattern in [Index JSON data](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data) is a computed column over `JSON_VALUE` plus an ordinary B-tree index on it. `JSON_VALUE` is deterministic, and [CREATE INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) allows a `UNIQUE` index on a computed column that is deterministic and precise.
- SQLite does support indexes on expressions, and it also supports generated columns. EF Core has no API for an expression index, but it does have `HasComputedColumnSql`, which SQLite turns into a generated column.

A computed column is the one shape that both providers support and that EF Core can model, migrate and read back. That is the fix.

## The fix: a computed column with a unique index

1. Add a shadow property for the value you want to be unique, and map it to a computed column that extracts it from the JSON column.
2. Put `HasIndex(...).IsUnique()` on that shadow property, not on the JSON path.
3. On SQL Server, make sure EF does not add its default `IS NOT NULL` filter to the index (details below).
4. Add a migration, check it for existing duplicates before applying it, and query through `EF.Property` so lookups hit the index.

Here is the model configuration, written once for both providers:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128, C# 14
protected override void OnModelCreating(ModelBuilder mb)
{
    var customer = mb.Entity<Customer>();
    customer.ComplexProperty(c => c.Contact, b => b.ToJson());

    var emailSql = Database.IsSqlServer()
        ? "CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320))"
        : "json_extract(\"Contact\", '$.Email')";

    customer.Property<string>("ContactEmail")
        .HasMaxLength(320)
        .HasComputedColumnSql(emailSql, stored: false)
        .IsRequired();

    customer.HasIndex("ContactEmail").IsUnique();
}
```

SQL Server, level 170 (level 160 is identical except `[Contact]` is `nvarchar(max)`):

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ContactEmail] AS CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320)),
    [Contact] json NOT NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]);
```

SQLite:

```sql
CREATE TABLE "Customers" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Customers" PRIMARY KEY AUTOINCREMENT,
    "Name" TEXT NOT NULL,
    "ContactEmail" AS (json_extract("Contact", '$.Email')),
    "Contact" TEXT NOT NULL
);
CREATE UNIQUE INDEX "IX_Customers_ContactEmail" ON "Customers" ("ContactEmail");
```

With this model on SQLite, a second customer with `a@x.com` fails on `SaveChanges` with `DbUpdateException` wrapping `SQLite Error 19: 'UNIQUE constraint failed: Customers.ContactEmail'`. `ExecuteUpdate` is covered too: `SetProperty(x => x.Contact.Email, "a@x.com")` on a different row failed with the same error, because the generated column is recomputed from the updated document. After `SaveChanges`, EF also reads the computed value back into the shadow property (`Entry(e).Property("ContactEmail").CurrentValue` returned `a@x.com`), since computed columns are `ValueGenerated.OnAddOrUpdate`.

On SQL Server the duplicate surfaces as `SqlException` number 2601 ("Cannot insert duplicate key row"). Catch `DbUpdateException` and inspect the inner exception if you want to turn it into a validation error.

A few choices in that code matter:

- **The `CAST` to `nvarchar(320)`.** `JSON_VALUE` returns `nvarchar(4000)`, and the [Index JSON data page](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data) warns that index keys over 1700 bytes make inserts fail. 320 characters is the practical maximum for an email address and is 640 bytes as `nvarchar`. Cast to the narrowest type that fits your value. For numbers, cast to `int` or `bigint`.
- **`stored: false`.** Neither provider needs the value persisted for it to be indexed. On SQL Server a non-persisted computed column can be indexed as long as it is deterministic and precise. On SQLite a virtual generated column can be indexed, and only virtual ones can be added with `ALTER TABLE` later.
- **`IsRequired()`.** This is not about the column. It stops EF from adding a filter to the index, which is the next section.

## The SQL Server filter trap

If you leave the shadow property optional, EF's SQL Server provider does what it does for every unique index on a nullable column and adds a filter:

```sql
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]) WHERE [ContactEmail] IS NOT NULL;
```

That statement will not run. The [CREATE INDEX reference](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) states that the filter predicate "can't reference a computed column". EF generates it without complaint, so you find out when `dotnet ef database update` fails.

Two ways out, both verified to drop the `WHERE` clause from the generated SQL:

```csharp
// .NET 11 RC 1, EF Core 11 - either mark the value required...
customer.Property<string>("ContactEmail").IsRequired();

// ...or keep it optional and remove the filter explicitly
customer.HasIndex("ContactEmail").IsUnique().HasFilter(null);
```

Without the filter, SQL Server treats NULLs as equal in a unique index, so only one row may lack an email. If your JSON property really is optional, fold a per-row value into the expression so missing emails never collide. For example: `ISNULL(CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320)), N'#' + CAST([Id] AS nvarchar(11)))`. It is deterministic and precise, so it stays indexable. I did not run this one against a live server. SQLite does not have the problem: NULLs are always distinct in a SQLite unique index, and EF adds no filter there.

## Query through the column, or the index sits unused

The unique index enforces the rule no matter how you write queries. Using it for lookups is a separate question. A plain LINQ filter on the JSON path does not reference your computed column:

```csharp
// .NET 11 RC 1, EF Core 11
db.Customers.Where(c => c.Contact.Email == email);
// SQL Server 170: WHERE JSON_VALUE([c].[Contact], '$.Email' RETURNING nvarchar(max)) = N'a@x.com'
// SQLite:         WHERE "c"."Contact" ->> 'Email' = 'a@x.com'
```

SQL Server can match a query expression to an equivalent computed column, but only when the expressions are the same. `JSON_VALUE(... RETURNING nvarchar(max))` is not the same as `CAST(JSON_VALUE(...) AS nvarchar(320))`. SQLite does not match generated-column expressions at all. With the sqlite3 3.50.6 CLI, `EXPLAIN QUERY PLAN` returned `SCAN c` for both `Contact ->> 'Email'` and a hand-written `json_extract(Contact, '$.Email')`, and only the column reference produced `SEARCH c USING INDEX IX_Customers_ContactEmail (ContactEmail=?)`.

So filter on the shadow property:

```csharp
// .NET 11 RC 1, EF Core 11 - produces WHERE [c].[ContactEmail] = @email on both providers
var existing = await db.Customers
    .Where(c => EF.Property<string>(c, "ContactEmail") == email)
    .FirstOrDefaultAsync();
```

If `EF.Property` strings bother you, map a real read-only property instead (`public string ContactEmail { get; private set; } = "";`) with the same `HasComputedColumnSql`. EF populates it after every save, and your queries get a normal lambda.

## Adding it to a table that already has data

The migration EF scaffolds is two statements on each provider:

```sql
-- SQL Server
ALTER TABLE [Customers] ADD [ContactEmail] AS CAST(JSON_VALUE([Contact], '$.Email') AS nvarchar(320));
CREATE UNIQUE INDEX [IX_Customers_ContactEmail] ON [Customers] ([ContactEmail]);

-- SQLite
ALTER TABLE "Customers" ADD "ContactEmail" AS (json_extract("Contact", '$.Email'));
CREATE UNIQUE INDEX "IX_Customers_ContactEmail" ON "Customers" ("ContactEmail");
```

The `ALTER TABLE` succeeds even when duplicates exist. The `CREATE UNIQUE INDEX` does not. On SQLite with two existing `a@x.com` rows, it failed with `UNIQUE constraint failed: Customers.ContactEmail (19)`. Find the offenders first. EF translates the grouping on the JSON path without the new column:

```csharp
// .NET 11 RC 1, EF Core 11 - run before applying the migration
var duplicates = await db.Customers
    .GroupBy(c => c.Contact.Email)
    .Where(g => g.Count() > 1)
    .Select(g => new { Email = g.Key, Count = g.Count() })
    .ToListAsync();
```

Clean those rows up, then apply the migration. For production rollouts, generate the SQL and review it rather than letting the app migrate itself; the [migrations bundle workflow](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) covers that. If your team enforces index naming, the computed column gets named like any other property, so the rules from [custom naming conventions for keys and indexes in EF Core 11](/2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11/) apply to `IX_Customers_ContactEmail` without special-casing.

## Gotchas worth knowing before you ship

**Case sensitivity differs between providers.** On SQLite I inserted `a@x.com` and `A@X.com` and both were accepted, because SQLite compares with `BINARY` collation by default. On SQL Server, uniqueness follows the collation of the source column, and for most databases that is case-insensitive, so the same pair would collide. If the rule is "one account per email", normalize: store lower-case emails, or use `lower(json_extract("Contact", '$.Email'))` on SQLite so the two providers agree. Mixing providers between tests and production is where this bites, one of the reasons [WebApplicationFactory vs Testcontainers](/2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests/) matters for data-rule tests.

**The JSON property name is part of the SQL.** `$.Email` must match what EF writes into the document. If you rename the CLR property, or configure `HasJsonPropertyName("email")`, update the computed column SQL in the same migration. EF will not do it for you, because the path is an opaque string. A mismatch does not fail: every row yields NULL, and your "unique" rule stops enforcing anything.

**Complex collections are out of scope.** A unique index needs one value per row. For "SKU must be unique across `Items[]`" you need a child table, not a JSON column. EF Core 11 can index `Items[].Sku` for lookups on SQL Server, but that is a JSON index, not a constraint.

**Do not rely on a future `IsUnique()`.** The SQL Server fix, [dotnet/efcore#39090](https://github.com/dotnet/efcore/pull/39090), was merged into `release/11.0` on 2026-09-26, after RC 1 shipped. It does not make JSON indexes unique. It makes the model fail validation with `JSON index '{index}' on entity type '{entityType}' was configured with the '{option}' option, which is not supported on JSON indexes.` That is an improvement, since the silent drop becomes a loud error, but the answer stays a computed column. The SQLite issue was still open when I wrote this.

**The computed column needs the usual SQL Server SET options.** Indexes on computed columns require settings like `QUOTED_IDENTIFIER ON` and `ANSI_NULLS ON` for sessions that modify the table. SqlClient's defaults satisfy them, but a legacy script or tool that turns them off will get errors when writing to `Customers`.

If you have not settled on a JSON mapping yet, [how to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) covers `ComplexProperty(...).ToJson()` end to end. Everything here assumes that mapping.

## Sources

- [What's New in EF Core 11: keys and indexes on complex type properties, JSON indexes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [CREATE JSON INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql)
- [Index JSON data (computed columns over JSON_VALUE)](https://learn.microsoft.com/en-us/sql/relational-databases/json/index-json-data)
- [CREATE INDEX (Transact-SQL): filtered index and computed column rules](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql)
- [SQLite generated columns](https://www.sqlite.org/gencol.html)
- [dotnet/efcore#39065: IsUnique() on an index over a JSON-mapped member is silently dropped](https://github.com/dotnet/efcore/issues/39065)
- [dotnet/efcore#39064: SQLite index on a JSON-mapped member indexes the whole column](https://github.com/dotnet/efcore/issues/39064)
- [dotnet/efcore#39090: Validate unsupported SQL Server JSON index options](https://github.com/dotnet/efcore/pull/39090)
- [npgsql/efcore.pg#3918: index on a JSON-mapped member indexes the whole jsonb column](https://github.com/npgsql/efcore.pg/issues/3918)
