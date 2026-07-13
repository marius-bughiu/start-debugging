---
title: "How to configure table-per-hierarchy (TPH) inheritance mapping in EF Core 11"
description: "TPH is EF Core's default inheritance strategy: one table, one discriminator column. Here is how to configure the discriminator, share columns, handle nullable derived properties, and the gotchas on EF Core 11."
pubDate: 2026-07-13
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "inheritance"
  - "tph"
  - "dotnet-11"
  - "how-to"
---

Short answer: on EF Core 11 (with .NET 11 and C# 14), you do not have to do anything to get table-per-hierarchy (TPH). It is the default. The moment you map a base type and at least one derived type, EF Core stores the whole hierarchy in one table and adds a string `Discriminator` column to tell the rows apart. Configuration is about tuning that default: renaming the discriminator column with `HasDiscriminator`, choosing the stored values with `HasValue`, mapping the discriminator to a real property, marking the hierarchy incomplete with `IsComplete(false)`, and sharing columns between sibling types. EF Core 11 also removes a long-standing limitation by letting complex types and JSON columns work on inheritance hierarchies, and fixes a TPH-specific nullability bug for JSON-mapped complex properties.

This post covers the exact configuration API, the schema EF Core generates, how querying against a TPH hierarchy actually works, the nullable-column gotcha that bites everyone at least once, and when TPH stops being the right call.

## Why TPH is the default and usually the right one

EF Core supports three relational inheritance strategies: table-per-hierarchy (TPH), table-per-type (TPT), and table-per-concrete-type (TPC). TPH is the default because it is the fastest for the common case. Everything lives in one table, so loading an entity is a single-row read with no joins, and querying the base type is a plain `SELECT` with no `UNION` and no fan-out across tables. The [EF Core inheritance documentation](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance) and the [performance guidance](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping) both land on the same rule: use TPH unless a benchmark or an external constraint forces you off it.

The cost you pay is a wider, sparser table. Every property from every derived type becomes a column on the shared table, and any column that only some rows use has to be nullable. For most hierarchies that trade is fine. When it stops being fine, you move to TPT or TPC, which is a separate decision covered at the end.

## The default mapping, with nothing configured

EF does not scan your assembly for derived types. You opt each type into the model, usually by exposing a `DbSet` or by referencing it in `OnModelCreating`. Here is a two-level hierarchy:

```csharp
// .NET 11, C# 14, EF Core 11
public class Payment
{
    public int Id { get; set; }
    public decimal Amount { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class CardPayment : Payment
{
    public string Last4 { get; set; } = "";
    public string Network { get; set; } = "";
}

public class BankTransferPayment : Payment
{
    public string Iban { get; set; } = "";
}
```

```csharp
// .NET 11, EF Core 11
public class PaymentsContext : DbContext
{
    public DbSet<Payment> Payments { get; set; } = null!;
    public DbSet<CardPayment> CardPayments { get; set; } = null!;
    public DbSet<BankTransferPayment> BankTransferPayments { get; set; } = null!;
}
```

With no inheritance configuration at all, EF Core 11 generates a single table with every property from every type, plus a `Discriminator` column it adds implicitly:

```sql
CREATE TABLE [Payments] (
    [Id] int NOT NULL IDENTITY,
    [Amount] decimal(18,2) NOT NULL,
    [CreatedAt] datetime2 NOT NULL,
    [Discriminator] nvarchar(max) NOT NULL,
    [Last4] nvarchar(max) NULL,
    [Network] nvarchar(max) NULL,
    [Iban] nvarchar(max) NULL,
    CONSTRAINT [PK_Payments] PRIMARY KEY ([Id])
);
```

Two things to notice. The discriminator is a string column that stores the CLR type name (`"CardPayment"`, `"BankTransferPayment"`, `"Payment"`) so EF knows which type to materialize for each row. And `Last4`, `Network`, and `Iban` are all nullable, because a `BankTransferPayment` row has no card fields and a `CardPayment` row has no IBAN. That nullability is automatic and, as we will see, not something you can override for a derived-type property.

## How a TPH query filters by type

When you query the base type, EF Core reads every row and uses the discriminator to build the right concrete object for each:

```csharp
// .NET 11, EF Core 11
var all = await context.Payments.ToListAsync();
// SELECT [p].[Id], [p].[Amount], [p].[CreatedAt], [p].[Discriminator],
//        [p].[Last4], [p].[Network], [p].[Iban]
// FROM [Payments] AS [p]
```

When you query a derived type, EF adds a discriminator predicate so you only get the matching rows:

```csharp
// .NET 11, EF Core 11
var cards = await context.CardPayments
    .Where(c => c.Network == "Visa")
    .ToListAsync();
// ... WHERE [p].[Discriminator] = N'CardPayment' AND [p].[Network] = N'Visa'
```

You can also filter by type inside a base-type query with `OfType<T>()` or a C# type pattern, and both translate to the same discriminator predicate:

```csharp
// .NET 11, EF Core 11
var cardsOnly = await context.Payments.OfType<CardPayment>().ToListAsync();
```

There is one materialization rule worth knowing: if the table contains a discriminator value that is not mapped to any type in your model, EF throws when it hits that row, because it does not know what to build. That only happens if something outside EF wrote rows with an unknown discriminator. If that is your situation, mark the mapping incomplete (below) so EF always adds the discriminator filter, even for base-type queries.

## Configuring the discriminator column and its values

The implicit `Discriminator` column and the CLR type names it stores are rarely what you want in a schema you have to live with. Rename the column, pin its type, and choose stable string values with `HasDiscriminator` and `HasValue`:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Payment>()
        .HasDiscriminator<string>("payment_type")
        .HasValue<Payment>("base")
        .HasValue<CardPayment>("card")
        .HasValue<BankTransferPayment>("bank_transfer");
}
```

Pinning explicit `HasValue` strings matters more than it looks. If you rely on the default (the CLR type name), then renaming a class in a later refactor silently changes the stored discriminator value, and every existing row in production now has a value your new model does not recognize. Explicit values decouple the database from your class names.

The discriminator does not have to be a string. An `int` or an `enum` is smaller and indexes better:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator<int>("payment_type")
    .HasValue<Payment>(0)
    .HasValue<CardPayment>(1)
    .HasValue<BankTransferPayment>(2);
```

Because EF adds the discriminator implicitly as a [shadow property](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties), you can also configure it like any other property, for example capping the string length so it is not `nvarchar(max)`:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .Property("payment_type")
    .HasMaxLength(20);
```

## Mapping the discriminator to a real .NET property

Sometimes you want the type tag readable on the entity itself, not hidden in a shadow property. Add a property to the base type and point `HasDiscriminator` at it:

```csharp
// .NET 11, C# 14, EF Core 11
public class Payment
{
    public int Id { get; set; }
    public decimal Amount { get; set; }
    public DateTime CreatedAt { get; set; }
    public string PaymentType { get; set; } = "";
}
```

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator(p => p.PaymentType)
    .HasValue<CardPayment>("card")
    .HasValue<BankTransferPayment>("bank_transfer");
```

Now `payment.PaymentType` is populated on every loaded entity. EF Core manages the value: it sets it on insert based on the concrete type, and it will not let you write a value that disagrees with the type. Treat it as read-only from your code. A mapped discriminator is handy for reporting queries and for API responses where the client needs the type name without you reflecting over it.

## Telling EF the hierarchy is incomplete

If another system writes rows to the same table with discriminator values you deliberately do not map, mark the discriminator incomplete so EF always filters, including on base-type queries:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator()
    .IsComplete(false);
```

With `IsComplete(false)`, `context.Payments.ToListAsync()` adds `WHERE [payment_type] IN (N'card', N'bank_transfer', ...)` and skips rows whose discriminator is unmapped, instead of throwing on them. This is exactly the escape hatch for a shared table where EF owns only some of the types.

## Sharing a column between sibling types

By default, two sibling types that both declare a property with the same name get two separate columns. If the properties are the same type and genuinely represent the same storage, map them to one column with `HasColumnName`:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<CardPayment>()
    .Property(c => c.Reference)
    .HasColumnName("Reference");

modelBuilder.Entity<BankTransferPayment>()
    .Property(b => b.Reference)
    .HasColumnName("Reference");
```

This keeps the table narrower, but there is a query trap the docs call out explicitly. Relational providers do not add the discriminator predicate when you read a shared column through a cast. A query like `(payment as CardPayment).Reference` returns the `Reference` value for sibling rows too, because the column is physically shared. To restrict it to one type you have to gate on the type yourself:

```csharp
// .NET 11, EF Core 11 - guard the cast so siblings return null
var refs = await context.Payments
    .Select(p => p is CardPayment ? ((CardPayment)p).Reference : null)
    .ToListAsync();
```

Share columns only when the values really are the same concept. When in doubt, let EF give each sibling its own nullable column.

## The nullable-column gotcha nobody expects

Here is the one that surprises people. A property that is required on a derived type cannot be a `NOT NULL` column under TPH. Since all types share one table, a column that belongs to `CardPayment` must be nullable so that `BankTransferPayment` rows can leave it empty. Even if `Last4` is `required` in C#, EF Core has to map it as a nullable column:

```sql
[Last4] nvarchar(max) NULL   -- required on CardPayment, still NULL in the DB
```

The database will not enforce "every card payment has Last4" for you. The application layer and EF Core's own validation enforce it on write, but a raw `INSERT` or a bad migration can produce a card row with a null `Last4` and the schema will not stop it. If database-enforced non-null on derived properties is a hard requirement, that is a genuine reason to choose TPT (each type gets its own table, so the column can be `NOT NULL` there) or to add a `CHECK` constraint by hand in a migration. This is the single most common reason a team moves a hierarchy off TPH, so weigh it before you commit.

## What EF Core 11 changed for inheritance

TPH itself has been stable for years; the EF Core 11 changes are about what you can put inside a hierarchy. Complex types and JSON columns now work on entity types that use TPT and TPC inheritance, which was previously unsupported and forced you back to owned entities for any inherited value object. TPH already supported complex types, and EF Core 11 fixed a TPH-specific bug where a [complex property stored as JSON was incorrectly marked non-nullable in a TPH class hierarchy](https://github.com/dotnet/efcore/issues/37404). So a value object mapped into a TPH table now nullably behaves the way it should:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class CardMetadata
{
    public required string Bin { get; set; }
    public string? IssuerCountry { get; set; }
}

public class CardPayment : Payment
{
    public string Last4 { get; set; } = "";
    public CardMetadata? Metadata { get; set; }
}
```

Configuration also got shorter across the board. EF Core 11 lets you chain member access straight through `Property`, so drilling into a complex type or a discriminator-adjacent property no longer needs an intermediate builder:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<CardPayment>()
    .Property(c => c.Metadata!.Bin)
    .HasMaxLength(8);
```

If you are pairing an inherited value object with a table-split or JSON mapping, the mechanics of that mapping are the same ones in [how to map a complex type instead of an owned entity in EF Core 11](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/), and the JSON querying side is covered in [how to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/).

## Bulk updates and query filters play nicely with TPH

Because a TPH hierarchy is one table, `ExecuteUpdate` and `ExecuteDelete` target a derived type cleanly, applying the discriminator predicate for you:

```csharp
// .NET 11, EF Core 11
await context.CardPayments
    .Where(c => c.Network == "Amex")
    .ExecuteUpdateAsync(s => s.SetProperty(c => c.Amount, c => c.Amount * 1.03m));
// UPDATE [p] SET [p].[Amount] = ... WHERE [p].[payment_type] = N'card' AND ...
```

The tradeoffs between that path and loading entities are the same ones in [how to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Query filters combine with the discriminator too, so a soft-delete or multi-tenant filter on the base type applies to the whole hierarchy, as described in [how to use named query filters for soft delete and multi-tenancy in EF Core 11](/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).

## When to leave TPH

Stay on TPH unless one of these is true:

- **You need database-enforced non-null on derived properties.** TPH cannot do it; the shared column has to be nullable. TPT gives each type its own table where the column can be `NOT NULL`.
- **The table is getting genuinely sparse and wide.** A hierarchy with many derived types, each adding several required-in-code columns, produces a table that is mostly nulls. If that hurts storage or your DBA vetoes it, TPT normalizes it at the cost of joins.
- **You mostly query one leaf type and benchmarks show TPC wins.** TPC keeps each concrete type in its own table with all columns inline, which can beat TPH for single-leaf-type queries. Measure before you switch; TPC brings its own key-generation and foreign-key constraints.

Note that changing an entity's type at runtime (turning a `CardPayment` into a `BankTransferPayment`) is not supported in any strategy. You delete and re-insert. That is a modeling reality, not a TPH limitation.

For the practical rule: TPH is the default because it is the right default. Configure the discriminator so your schema does not depend on class names, remember that derived-type columns are always nullable, and only reach for TPT or TPC when a concrete constraint or a real benchmark tells you to. If this decision is part of a larger version bump, the [EF Core 6 to EF Core 11 migration guide](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) covers the inheritance and mapping changes that tend to surface alongside it.

## Related reading

- [How to map a complex type instead of an owned entity in EF Core 11](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) explains value-object mapping, which now works inside inheritance hierarchies.
- [How to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) covers the JSON side of complex properties on a TPH table.
- [How to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) shows the bulk-write path that discriminator predicates make clean.
- [How to use named query filters for soft delete and multi-tenancy in EF Core 11](/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) pairs global filters with a TPH hierarchy.
- [Fix: The entity type requires a primary key to be defined in EF Core 11](/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined) is the companion when a base or derived type is missing its key.

## Sources

- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [What's New in EF Core 11: complex types and JSON on TPT/TPC](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Modeling for performance: inheritance mapping](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping)
- [EF Core shadow properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties)
- [Complex property stored as JSON marked non-nullable in TPH class hierarchy (efcore#37404)](https://github.com/dotnet/efcore/issues/37404)
