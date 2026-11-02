---
title: "How to store an enum as a string in EF Core 11 with a value converter"
description: "Store C# enums as readable strings instead of ints in EF Core 11: HasConversion, bulk configuration for every enum, the nvarchar(max) trap, the ordering gotcha, and how to migrate an existing int column."
pubDate: 2026-08-03
updatedDate: 2026-11-02
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "value-converters"
  - "enums"
  - "dotnet-11"
  - "how-to"
---

Use `.HasConversion<string>()` to store enum names with EF Core. Choose a maximum length that fits the permitted names and inspect the provider’s generated DDL. Equality filters use converted values. String comparisons and ordering follow the database collation, which can differ from the workflow order represented by enum numbers.

**Correction, November 2, 2026.** The previous version said numeric strings could never be read by the built-in converter and described 900 bytes as a universal SQL Server index-key limit. Both claims were incorrect. The migration section now distinguishes materializing a value from matching it in a query.

The correction fixture used SDK 10.0.302 and EF Core 10.0.10. It exercised SQLite reads and predicates, and generated SQL Server DDL and query SQL without connecting to SQL Server. EF Core 11-specific optimizations are described in the [release notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew). A different problem, [mapping database nulls through a converter](/2026/09/how-to-write-an-ef-core-11-value-converter-that-maps-null-to-a-non-null-value/), has separate rules.

## Why the default int mapping is a liability

By default EF Core maps an enum to its underlying numeric type. With implicit enum values, inserting or reordering a member can change the number assigned to later members. Assign explicit stable numeric values if numbers form part of a persisted contract.

```csharp
// Implicit numeric values follow declaration order.
public enum OrderStatus { Pending, Paid, Shipped, Delivered, Cancelled }
```

Six months later somebody inserts `Refunded` between `Paid` and `Shipped` because it reads better. The enum still compiles, every test still passes, and every row in the database that said `Shipped` now means `Refunded`. There is no compiler error and no runtime error. It is a silent data corruption bug that only surfaces when a human reads a report.

Storing names avoids dependence on declaration order. Renaming a member still changes the stored contract and needs a migration or an explicit mapping. Choose strings for readability or a stable external code, and account for storage, indexing and ordering.

## The three ways to configure the conversion

The shortest form uses the generic overload of `HasConversion`. EF Core inspects the model type (an enum) and the requested provider type (`string`) and selects the built-in converter automatically:

```csharp
// EF Core 11, OnModelCreating
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.Status)
        .HasConversion<string>()
        .HasMaxLength(20);
}
```

The second form spells out the two lambdas. You almost never need this for a plain enum, but it is what the [value conversions documentation](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) shows first, so it is worth recognising:

```csharp
// Explicit converter: Enum.Parse here is case-sensitive.
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion(
        v => v.ToString(),
        v => (OrderStatus)Enum.Parse(typeof(OrderStatus), v));
```

These two are *not* identical, and the difference matters. The built-in `EnumToStringConverter<TEnum>` parses case-insensitively; the hand-written `Enum.Parse` above is case-sensitive and throws on a row that stores `"pending"` instead of `"Pending"`. Prefer the generic overload.

The third form skips the fluent API entirely and just declares the column type. EF Core sees a string column under an enum property and infers the conversion:

```csharp
// EF Core 11 - conversion inferred from the store type
public class Order
{
    public int Id { get; set; }

    [Column(TypeName = "varchar(20)")]
    public OrderStatus Status { get; set; }
}
```

### Configuring every enum in the model at once

Repeating `HasConversion<string>()` for forty properties is how you end up with one that was forgotten. Pre-convention model configuration matches on the CLR type, and the docs note that the type "can be a base type" -- which means `System.Enum` matches every enum in the model:

```csharp
// EF Core 11 - applies to every enum property in the model
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
{
    configurationBuilder
        .Properties<Enum>()
        .HaveConversion<string>()
        .HaveMaxLength(32);
}
```

I verified this on EF Core 10.0.10. Dumping the model afterwards shows the conversion applied to both a non-nullable and a nullable enum property, including the max length:

```text
Id:         clr=Int32       provider=(none)  maxlen=
Perms:      clr=Perms       provider=String  maxlen=32
PrevStatus: clr=Nullable`1  provider=String  maxlen=32
Status:     clr=OrderStatus provider=String  maxlen=32
```

Note that `IProperty.GetValueConverter()` returns `null` here even though the conversion is active. When the conversion comes from the provider type rather than an explicit converter instance, it lives on the type mapping. If you are inspecting a model in the debugger, look at `property.GetTypeMapping().Converter`, which reports an `EnumToStringConverter<TEnum>` instance.

Pre-convention configuration overrides conventions *and* data annotations, so if you need one enum stored as an int, configure that one explicitly in `OnModelCreating` afterwards.

## The nvarchar(max) trap

Specify an appropriate length and inspect the generated migration. SQL Server distinguishes ordinary string columns, index key columns and included columns.

Configure the conversion without a length and the SQL Server provider has no idea how long the strings are, so it picks the widest thing it has. Here is the DDL EF Core generated for a model with three converted enum properties, only two of which set a length:

```sql
CREATE TABLE [Orders] (
    [Id] int NOT NULL IDENTITY,
    [Status] nvarchar(max) NOT NULL,
    [PrevStatus] varchar(20) NULL,
    [Perms] nvarchar(64) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

In this example the unconstrained `Status` column is `nvarchar(max)`. It cannot be an ordinary index key, although `max` columns can be non-key included columns in a nonclustered index. `PrevStatus` uses `.HasMaxLength(20).IsUnicode(false)` and becomes `varchar(20)`.

There is one saving grace worth knowing: if you declare an index on the property, EF Core's SQL Server provider falls back to its key-column default rather than `max`:

```csharp
// EF Core 11
modelBuilder.Entity<Order>().Property(o => o.Status).HasConversion<string>();
modelBuilder.Entity<Order>().HasIndex(o => o.Status);
```

```sql
CREATE TABLE [Orders] (
    [Id] int NOT NULL IDENTITY,
    [Status] nvarchar(450) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
GO

CREATE INDEX [IX_Orders_Status] ON [Orders] ([Status]);
```

The SQL Server provider generated `nvarchar(450)` for the indexed property in the EF Core 10.0.10 fixture. That width allows up to 900 bytes of character data. On SQL Server 2016 and later, clustered index keys allow up to 900 bytes and nonclustered index keys up to 1,700. The declared maximum is not the actual storage cost of a short value. Choose a length that covers every valid name or code.

If you want the length attached to the converter rather than repeated per property, pass `ConverterMappingHints`:

```csharp
// EF Core 11 - the size travels with the converter
var converter = new ValueConverter<OrderStatus, string>(
    v => v.ToString(),
    v => Enum.Parse<OrderStatus>(v, ignoreCase: true),
    new ConverterMappingHints(size: 20, unicode: false));
```

Hints are overridden by any facet you set explicitly on the property.

## What your LINQ queries actually compile to

Equality translates exactly as you would hope. The enum is converted on the way into the parameter, not on the way out of the column, so the column stays sargable:

```csharp
var pending = await context.Orders
    .Where(o => o.Status == OrderStatus.Pending)
    .ToListAsync();
```

```sql
SELECT "o"."Id", "o"."Perms", "o"."PrevStatus", "o"."Status"
FROM "Orders" AS "o"
WHERE "o"."Status" = 'Pending'
```

`Contains` over an array of enum values becomes a parameterised `IN`, with each value converted:

```sql
-- Parameters: @wanted1='Pending', @wanted2='Paid'
WHERE "o"."Status" IN (@wanted1, @wanted2)
```

`ExecuteUpdate` handles converted enums too, sending the string as a parameter:

```csharp
await context.Orders
    .Where(o => o.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Paid));
```

That covers the ordinary cases. Now the ones that do not behave.

### Relational comparison and OrderBy switch to alphabetical

This is the real cost of string storage, and EF Core gives you no warning about it. A `>` comparison on an enum is perfectly legal C# and translates to a perfectly legal SQL string comparison, which is not the same thing:

```csharp
// Intent: "everything after Paid in the workflow"
var later = await context.Orders
    .Where(o => o.Status > OrderStatus.Paid)
    .ToListAsync();
```

```sql
WHERE "o"."Status" > 'Paid'
```

With three rows holding `Pending`, `Delivered` and `Cancelled`, in-memory LINQ returns the `Delivered` and `Cancelled` rows. The database returns the `Pending` row, because `'Pending' > 'Paid'` alphabetically and `'Cancelled'` and `'Delivered'` are not. `OrderBy(o => o.Status)` has the same problem: it comes back `Cancelled, Delivered, Pending` instead of declaration order.

The fix is not a converter setting. Either keep an int for anything you order or range-compare on, or add an explicit `int SortOrder` column, or replace the range query with an explicit set: `Where(o => finished.Contains(o.Status))`. If you already ship code that range-compares enums, grep for it before you flip the mapping.

### Inspect the SQL for ToString()

Projecting or filtering on `Status.ToString()` looks harmless once the column is already a string, but EF Core 10 still emits the cast implied by the CLR call:

```csharp
context.Orders.Where(o => o.Status.ToString()!.StartsWith("P"))
```

```sql
-- EF Core 10
WHERE CAST([o].[Status] AS nvarchar(max)) LIKE N'P%'
```

The EF Core 10.0.10 SQL Server provider generated the `CAST` above. Whether a query uses an index depends on the actual plan. EF Core 11 documents an optimization for redundant casts, but check `ToQueryString()` with the provider and version you deploy. For an exact status, compare enum values directly. `EF.Functions.Like` expects a string expression, so passing an enum property directly is not a drop-in fix. See [SQL logging in development](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## Reading values back: unknown names and casing

Value converters run on materialisation, and a string column accepts anything. A row containing a name your enum does not have fails at read time, not at query time:

```text
InvalidOperationException: Cannot convert string value 'Refunded' from the database
to any value in the mapped 'OrderStatus' enum.
```

The exception surfaces when the row is materialised, so a query that returns 10,000 rows dies on whichever row happens to be bad. Guard the column with a `CHECK` constraint if the database is shared with anything that writes to it directly.

Casing, on the other hand, is forgiving with the built-in converter: a row storing `"pending"` materialises as `OrderStatus.Pending`. That is `EnumToStringConverter<TEnum>` parsing case-insensitively. Swap in a hand-written `Enum.Parse(typeof(OrderStatus), v)` and the same row throws, because the BCL default is case-sensitive. If you write your own, write `Enum.Parse<OrderStatus>(v, ignoreCase: true)`.

### `[Flags]` enums round-trip but do not query

A `[Flags]` enum converts through `ToString()` like any other, which produces a comma-separated list:

```text
row 1 | Read
row 2 | Read, Write
row 3 | None
```

Round-tripping works. Querying does not: `Where(o => o.Perms.HasFlag(Perms.Write))` cannot be translated into a string predicate, and `LIKE '%Write%'` matches nothing usefully and scans everything. Keep `[Flags]` enums as ints, or model the permissions as rows.

### Pass the provider value in raw SQL

An interpolated raw SQL argument does not automatically use the converter configured on a model property. Supply the stored representation explicitly. With the built-in name mapping:

```csharp
var providerValue = OrderStatus.Pending.ToString();
var rows = await context.Orders
    .FromSql($"SELECT * FROM Orders WHERE Status = {providerValue}")
    .ToListAsync();
```

Interpolation supplies a parameter here. With a custom `PND` mapping, pass `PND` for `Pending` instead. Passing the underlying integer can return different rows or cause a database conversion error depending on the provider. An entity query also needs the columns required for materialization. This differs from [a LINQ translation failure](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

## Storing short codes instead of names

If you want `"PND"` rather than `"Pending"` -- fixed-width codes are common in schemas shared with a warehouse -- subclass `ValueConverter<TModel, TProvider>` so the mapping is explicit and reviewable:

```csharp
// EF Core 11
public class StatusCodeConverter : ValueConverter<OrderStatus, string>
{
    public StatusCodeConverter() : base(v => ToCode(v), v => FromCode(v)) { }

    private static string ToCode(OrderStatus s) => s switch
    {
        OrderStatus.Pending => "PND",
        OrderStatus.Paid => "PAI",
        OrderStatus.Shipped => "SHP",
        OrderStatus.Delivered => "DLV",
        OrderStatus.Cancelled => "CAN",
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, null)
    };

    private static OrderStatus FromCode(string c) => c switch
    {
        "PND" => OrderStatus.Pending,
        "PAI" => OrderStatus.Paid,
        "SHP" => OrderStatus.Shipped,
        "DLV" => OrderStatus.Delivered,
        "CAN" => OrderStatus.Cancelled,
        _ => throw new InvalidOperationException($"Unknown status code '{c}'.")
    };
}
```

```csharp
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion<StatusCodeConverter>()
    .HasMaxLength(3)
    .IsUnicode(false);
```

Predicates translate through the converter, so `Where(o => o.Status == OrderStatus.Pending)` becomes `WHERE "o"."Status" = 'PND'`. Because the switch arms are exhaustive over known codes, an unexpected value gives you *your* message instead of EF's, which is much easier to triage. Converters are stateless and can be shared across every property that uses them.

## Migrating a column that already holds ints

A plain column conversion can leave `2` stored as the text `"2"` instead of `"Shipped"`. EF Core 10.0.10’s built-in converter read both strings as `Shipped` in the SQLite fixture. A LINQ equality predicate for `Shipped` matched only the named row because its provider value was `"Shipped"`. Even `"99"` materialized as an unnamed enum value, while `"Bogus"` threw. Numeric text is therefore a data-contract problem even when reads succeed.

For a coordinated migration, backfill the intended names explicitly. Back up and test on a copy, and plan for writers that may still use the old column during deployment.

1. Add the converter to the model, then scaffold the migration with `dotnet ef migrations add StoreStatusAsString`.
2. Open the generated migration and replace the `AlterColumn` with an `AddColumn` for a temporary column, for example `StatusText nvarchar(20) NULL`.
3. Add a `migrationBuilder.Sql(...)` backfill between the add and the drop, mapping each int to its name explicitly: `UPDATE Orders SET StatusText = CASE Status WHEN 0 THEN 'Pending' WHEN 1 THEN 'Paid' ... END;`. Write the CASE by hand against the enum declaration as it exists at this commit, not against whatever it becomes later.
4. Drop the old column, rename `StatusText` to `Status`, and make it `NOT NULL`. Write the mirror-image logic in `Down` so the migration is reversible.

Before dropping anything, verify row counts, unmapped integers, nullability, and the mapping of every numeric value. Rebuild affected indexes or foreign keys deliberately and test both upgrade and rollback where supported. Inspect `dotnet ef migrations script` and rehearse the actual deployment, including a [migration bundle](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) if that is how production applies it.

A last piece of advice on the model itself: value converters are for a single column. The moment you find yourself serialising several fields into one string to get around that, you want a [complex type mapped to JSON](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) instead, which EF Core 11 can index into and update in place. And if EF Core refuses to map the property at all, that is a different problem with a different fix, covered in [the property could not be mapped error](/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/).

## Sources

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) on Microsoft Learn, including the built-in converter list and the documented limitations.
- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) for pre-convention configuration and base-type matching.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) for the no-op CAST stripping.
- [EnumToStringConverter&lt;TEnum&gt;](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.enumtostringconverter-1) API reference.
- [dotnet/efcore#10434](https://github.com/dotnet/efcore/issues/10434), the tracking issue for querying into value-converted properties.
- [SQL Server index key limits](https://learn.microsoft.com/en-us/sql/sql-server/maximum-capacity-specifications-for-sql-server?view=sql-server-ver17)
- [EF Core 10.0.10 enum converter source](https://github.com/dotnet/efcore/blob/v10.0.10/src/EFCore/Storage/ValueConversion/Internal/StringEnumConverter.cs)
