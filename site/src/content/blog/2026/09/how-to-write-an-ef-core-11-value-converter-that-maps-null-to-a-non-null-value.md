---
title: "How to write an EF Core 11 value converter that maps a null in the database to a non-null value in code"
description: "EF Core never passes null to a value converter by default. Here is the internal convertsNulls constructor that changes that, the IsRequired(false) call it depends on, why it cannot work at all for enums and other value types, the WHERE col = NULL trap it creates, and the two patterns that do the job without an internal API."
pubDate: 2026-09-06
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "value-converters"
  - "nullability"
  - "dotnet-11"
  - "how-to"
---

Short answer: EF Core deliberately never hands `null` to a value converter, so `HasConversion(v => ..., v => v ?? "Unknown")` silently does nothing for a NULL column. The only way to change that is the four-argument `ValueConverter<TModel, TProvider>` constructor with `convertsNulls: true`, which is marked `[EntityFrameworkInternal]` and produces warning `EF1001`. It works, but only for properties whose CLR type is a reference type, only if you also call `.IsRequired(false)`, and at the cost of breaking every LINQ query that filters on the sentinel value. For an `enum`, `int`, `DateTime` or any other non-nullable value type, it cannot be made to work at all. For those, map a nullable property and expose a non-nullable facade.

This post covers what EF actually does with a NULL column, the exact configuration that makes `convertsNulls` work, the four query shapes it breaks (with the SQL EF emits for each), the hard wall you hit on value types, and the two supported patterns to use instead.

A note on versions. EF Core 11 is in preview as of September 2026 and ships with .NET 11 in November 2026, per the [EF Core releases and planning page](https://learn.microsoft.com/en-us/ef/core/what-is-new/). EF11 requires the .NET 11 runtime, and the only SDK on this machine is .NET 10.0.302, so everything below was measured against `Microsoft.EntityFrameworkCore.Sqlite` 10.0.10 on an in-memory SQLite database. Nothing in this area changed in EF11: the [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) page lists no changes to value conversions or to null handling, and `convertsNulls` has been internal since EF Core 6.0.

## Why your converter never runs for a NULL column

The [value conversions documentation](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) states the rule directly: a null value will never be passed to a value converter, and a null in a database column is always a null in the entity instance. This is not an oversight. It is what lets one converter be shared between a non-nullable primary key and the nullable foreign keys that point at it, without writing null handling twice.

The consequence is that the obvious code does nothing:

```csharp
// .NET 11, C# 14 - this ?? is dead code
modelBuilder.Entity<Order>()
    .Property(o => o.Notes)
    .HasConversion(v => v, v => v ?? "");
```

The `v ?? ""` branch is never reached, because EF short-circuits the conversion before calling into it.

What happens next depends on the CLR type. Take a legacy table where the column is nullable and NULL carries meaning:

```sql
CREATE TABLE Orders (
    Id     INTEGER PRIMARY KEY AUTOINCREMENT,
    Notes  TEXT NULL,   -- NULL means "no notes"
    Status TEXT NULL    -- NULL means "status unknown"
);
INSERT INTO Orders (Notes, Status) VALUES (NULL, NULL);
INSERT INTO Orders (Notes, Status) VALUES ('hi', 'Shipped');
```

mapped to an entity that promises non-null:

```csharp
// .NET 11, C# 14
public enum ShippingStatus { Unknown, Pending, Shipped }

public class Order
{
    public int Id { get; set; }
    public string Notes { get; set; } = "";      // never null, we hope
    public ShippingStatus Status { get; set; }   // Unknown, we hope
}
```

Read row 1 back and `Notes` is `null` despite the initializer and despite the non-nullable declaration, because EF assigns the column value straight onto the property. `Status` is worse: the provider's data reader throws before EF gets a chance to do anything, which on SQLite reads

```
System.InvalidOperationException: The data is NULL at ordinal 2. This method can't be
called on NULL values. Check using IsDBNull before calling.
```

That exception is the single most common way this problem gets discovered. The exact type varies by provider, but the cause is always the same: EF only emits an `IsDBNull` check for a column it believes is nullable, and it believes nothing of the sort here. This is a different failure from [the property could not be mapped, because it is not a supported primitive type](/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/), which fires at model-building time rather than at materialization.

## The converter that does convert nulls

`ValueConverter<TModel, TProvider>` has a second constructor, added in EF Core 6.0, that takes a `convertsNulls` flag:

```csharp
[Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkInternal]
public ValueConverter(
    Expression<Func<TModel, TProvider>> convertToProviderExpression,
    Expression<Func<TProvider, TModel>> convertFromProviderExpression,
    bool convertsNulls,
    ConverterMappingHints? mappingHints = default);
```

There is no `HasConversion` overload for it, so you have to subclass. The procedure is three steps:

1. Write a converter class whose provider type is explicitly nullable, and pass `convertsNulls: true` to the base constructor.
2. Suppress `EF1001` around the class, since the constructor is internal.
3. Call `.IsRequired(false)` on the property so EF treats the column as nullable and emits the `IsDBNull` check the read path needs.

```csharp
// .NET 11, C# 14, EF Core 11
#pragma warning disable EF1001
public class NullToEmptyString : ValueConverter<string, string?>
{
    public NullToEmptyString()
        : base(
            v => v.Length == 0 ? null : v,   // model -> provider
            v => v ?? "",                    // provider -> model
            convertsNulls: true)
    {
    }
}
#pragma warning restore EF1001

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.Notes)
        .HasConversion(new NullToEmptyString())
        .IsRequired(false);
}
```

Without the `#pragma`, the build emits:

```
warning EF1001: Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<string, string?>
is an internal API that supports the Entity Framework Core infrastructure and not subject to the same
compatibility standards as public APIs. It may be changed or removed without notice in any release.
```

That is a warning, not an error, but it becomes an error under `TreatWarningsAsErrors`, which is the usual reason people find this API at all.

With that configuration, both directions work. Row 1 materializes with `Notes` equal to `""` rather than `null`, and saving a new entity whose `Notes` is `""` writes a genuine `NULL` to the column, confirmed by reading the raw table afterwards.

Step 3 is not optional and is the step almost everyone skips. Drop the `.IsRequired(false)` and `Notes` stays non-nullable in the model (`IsNullable = False`), EF omits the null check, and the read throws the same `The data is NULL at ordinal 1` exception as before. The converter is configured correctly and never gets called. If you are not sure which state you are in, `context.Model.FindEntityType(typeof(Order))!.FindProperty("Notes")!.IsNullable` tells you in one line.

## The query trap: WHERE col = NULL

Here is the part the [EF Core documentation](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) warns about without showing, and it is the reason the API is internal. EF applies the model-to-provider half of your converter to constants in the query too. Your sentinel converts to `null`, and EF plants that `null` in the SQL as an ordinary comparison operand.

Four ways to ask "which orders have no notes", the SQL EF Core 10.0.10 emits for each, and the rows returned against a table holding one NULL row and one `'hi'` row:

| LINQ | Generated SQL predicate | Rows |
| --- | --- | --- |
| `o.Notes == ""` | `"o"."Notes" = NULL` | 0 |
| `o.Notes == null!` | `"o"."Notes" IS NULL` | 1 |
| `string.IsNullOrEmpty(o.Notes)` | `"o"."Notes" IS NULL OR "o"."Notes" = NULL` | 1 |
| `o.Notes.Length == 0` | `length("o"."Notes") = 0` | 0 |

The natural query, comparing against the sentinel you invented, returns nothing. `= NULL` is never true under SQL's three-valued logic, so the row is silently skipped. No exception, no warning, just a filter that quietly matches zero rows in production.

The query that works is `o.Notes == null`, which is a comparison the nullable-reference-type analyzer flags as always false, on a property that genuinely never holds null once materialized. You are writing code the compiler believes is dead in order to produce the SQL you need. `string.IsNullOrEmpty` happens to survive only because EF expands it into two predicates and the `IS NULL` half carries the result. `Length == 0` fails for the ordinary reason NULL propagates through `length()`.

This is not a bug to be fixed downstream. It is what [issue #26230](https://github.com/dotnet/efcore/issues/26230) means by "value conversion to null in the store generates bad queries", and it is why the EF team marked the constructor internal for 6.0 rather than shipping it publicly: the failure is invisible and not easy to detect. If you take this route, the mitigation is to verify the predicate rather than trust it, either with `ToQueryString()` in a test or by [logging the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## Why it cannot work for an enum, int, or DateTime

For a non-nullable value type, `convertsNulls` gets you halfway and then stops. Write the converter:

```csharp
// .NET 11, C# 14, EF Core 11
#pragma warning disable EF1001
public class NullToUnknown : ValueConverter<ShippingStatus, string?>
{
    public NullToUnknown()
        : base(
            v => v == ShippingStatus.Unknown ? null : v.ToString(),
            v => v == null ? ShippingStatus.Unknown : Enum.Parse<ShippingStatus>(v),
            convertsNulls: true)
    {
    }
}
#pragma warning restore EF1001
```

The write side works: saving `ShippingStatus.Unknown` writes `NULL`. The read side does not, and step 3 above is why. `.IsRequired(false)` throws at model-building time:

```
System.InvalidOperationException: The property 'Order.Status' cannot be marked as
nullable/optional because the type of the property is 'ShippingStatus' which is not a
nullable type. Any property can be marked as non-nullable/required, but only properties
of nullable types can be marked as nullable/optional.
```

EF's nullability check looks at the CLR type, not at the converter, so no combination of settings gets you there. Leave the call out and the model keeps `IsNullable = False`, EF skips the `IsDBNull` check, and every read of a NULL row throws. There is no third option. `convertsNulls` on a non-nullable value type is a write-only feature, which is worse than useless: it will happily persist NULLs that the same model cannot read back.

## The two patterns that actually work

### Map a nullable property, expose a non-nullable facade

The mapped property carries the database's nullability honestly. The domain property does the coalescing in plain C#, where no query translator is involved:

```csharp
// .NET 11, C# 14, EF Core 11
public class Order
{
    public int Id { get; set; }

    public ShippingStatus? StatusRaw { get; set; }

    [NotMapped]
    public ShippingStatus Status
    {
        get => StatusRaw ?? ShippingStatus.Unknown;
        set => StatusRaw = value == ShippingStatus.Unknown ? null : value;
    }
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.StatusRaw)
        .HasColumnName("Status")
        .HasConversion<string>()
        .HasMaxLength(20);
}
```

No internal API, no `EF1001`, and the queries are correct by construction: `Where(o => o.StatusRaw == null)` emits `WHERE "o"."Status" IS NULL` and matches the NULL row, while `Where(o => o.StatusRaw == ShippingStatus.Shipped)` emits `WHERE "o"."Status" = 'Shipped'`. The enum-to-string half is the ordinary built-in conversion covered in [storing an enum as a string with a value converter](/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/), including the `HasMaxLength` that keeps SQL Server from handing you an unindexable `nvarchar(max)`.

The cost is that LINQ has to name `StatusRaw`, not `Status`. Referencing `Status` in a `Where` gives you [the LINQ expression could not be translated](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), because `[NotMapped]` members have no SQL counterpart. That is a fair trade: the translator refuses at compile-and-run time instead of silently emitting `= NULL`.

### Map a private backing field

If you would rather not widen the public surface with a `StatusRaw`, map a field and keep one public property:

```csharp
// .NET 11, C# 14, EF Core 11
public class Order
{
    public int Id { get; set; }

    private string? _notes;

    public string Notes
    {
        get => _notes ?? "";
        set => _notes = value.Length == 0 ? null : value;
    }
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>(e =>
    {
        e.Ignore(o => o.Notes);
        e.Property<string?>("_notes")
            .HasColumnName("Notes")
            .UsePropertyAccessMode(PropertyAccessMode.Field);
    });
}
```

Reads and writes behave identically to the facade version, and `Where(o => EF.Property<string>(o, "_notes") == null)` translates to `WHERE "o"."Notes" IS NULL`. The downside is that every query touching the column goes through the stringly-typed `EF.Property<T>`, which no rename refactoring will follow. Prefer the facade unless the extra public property is genuinely unacceptable.

### Or change the data

Worth saying plainly, because it is often the correct answer: if NULL and your sentinel mean exactly the same thing, the schema is carrying a distinction the domain does not have. One `UPDATE Orders SET Status = 'Unknown' WHERE Status IS NULL`, an `ALTER COLUMN ... NOT NULL`, and a `HasDefaultValue("Unknown")` remove the problem instead of routing around it. That is a data migration rather than a mapping trick, and [renaming a table in a migration without losing data](/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/) covers the general shape of hand-editing a migration to carry data changes alongside schema changes.

## Where the feature stands

[Issue #13850](https://github.com/dotnet/efcore/issues/13850), "Allow HasConversion/ValueConverters to convert nulls", is still open and sitting in the Backlog milestone with no due date. A 2026 request for a public `HasConversion` overload taking `convertsNulls`, [issue #36365](https://github.com/dotnet/efcore/issues/36365), was closed as a duplicate of it. So the four-argument constructor is where this stays for EF Core 11, warning and all.

Use it when the model property is a reference type, the sentinel is never used as a filter, and you have a test asserting on `ToQueryString()` for every query that touches the column. Everywhere else, and always for value types, map the nullable property and coalesce in C#.

### Read next

- [How to store an enum as a string in EF Core 11 with a value converter](/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/)
- [Fix: "The LINQ expression could not be translated" in EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Fix: "The property could not be mapped, because it is not a supported primitive type or a valid entity type" in EF Core 11](/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/)
- [How to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Fix: CS8618 "Non-nullable property must contain a non-null value when exiting constructor" in C#](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/)

### Sources

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions), EF Core documentation
- [ValueConverter&lt;TModel,TProvider&gt; constructors](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.valueconverter-2.-ctor), .NET API reference
- [Issue #26230: Problems with value converters that convert nulls](https://github.com/dotnet/efcore/issues/26230), dotnet/efcore
- [Issue #13850: Allow HasConversion/ValueConverters to convert nulls](https://github.com/dotnet/efcore/issues/13850), dotnet/efcore
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), EF Core documentation
