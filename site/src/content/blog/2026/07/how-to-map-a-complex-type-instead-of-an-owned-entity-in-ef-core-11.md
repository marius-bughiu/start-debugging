---
title: "How to map a complex type instead of an owned entity in EF Core 11"
description: "Owned entities carry a hidden key and reference identity that fights value objects. Here is how to map a value object as a complex type in EF Core 11, when to switch, and the gotchas."
pubDate: 2026-07-12
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "complex-types"
  - "owned-entities"
  - "dotnet-11"
  - "how-to"
---

Short answer: on EF Core 11 (with .NET 11 and C# 14), map a value object like `Address` or `Money` with `ComplexProperty` instead of `OwnsOne`. A complex type has no key and no identity, so EF Core treats it with value semantics: assigning it copies fields, comparing it compares contents, and `ExecuteUpdate` can touch its properties. An owned entity is still an entity type behind the scenes, with a shadow key and reference identity, and that is exactly the source of the surprises people hit (you cannot assign a shared reference, LINQ equality breaks, bulk update is blocked). Complex types were introduced in EF Core 8, gained optional (nullable) mapping and JSON columns in EF Core 10, and in EF Core 11 became usable on TPT/TPC inheritance hierarchies with a cleaner configuration API. The switch is a model-configuration change plus one migration.

This post covers what actually differs between the two mappings, the exact `ComplexProperty` configuration for table splitting and JSON, how to migrate an existing `OwnsOne` mapping without losing data, and the cases where you still have to reach for owned entities.

## Why owned entities were never the right shape for a value object

When EF Core added owned entity types, they were pitched as the way to model value objects: an `Address` that lives inside a `Customer`, mapped to the same table. That works, but it was always a compromise. An owned entity **is an entity type**. EF Core gives it a primary key (usually a shadow key it manages for you), tracks it in the change tracker as its own node, and reasons about it with reference identity. The [owned-entities documentation](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities) has warned for years about the sharp edges that follow from that.

Three of those edges bite constantly.

First, you cannot share an instance. This looks like it should work and does not:

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress;
await context.SaveChangesAsync(); // throws with owned entities
```

Because both properties are the same entity type, EF Core sees one entity referenced twice and refuses it. Second, LINQ equality compares by identity, not contents, so `context.Customers.Where(c => c.BillingAddress == c.ShippingAddress)` does not mean what you think. Third, `ExecuteUpdate` does not support owned entity properties at all.

A complex type is the mapping that was actually meant for this. It has no identity of its own. It is defined entirely by its data, which is the definition of a value object. Assigning it copies the fields. Comparing it compares the fields. And EF Core 11 supports it in `ExecuteUpdate`. The EF team's own guidance in the [EF Core 10 release notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types) is blunt: "users already using owned entity types for these are advised to switch to complex types."

## The minimal complex type mapping

Start with the value object and the entity that contains it. The value object needs no key, no `Id`, nothing that smells like identity:

```csharp
// .NET 11, C# 14, EF Core 11
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string PostalCode { get; set; }
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required Address ShippingAddress { get; set; }
    public Address? BillingAddress { get; set; }
}
```

There are two ways to tell EF Core this is a complex type. The fluent API in `OnModelCreating`:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Customer>(b =>
    {
        b.ComplexProperty(c => c.ShippingAddress);
        b.ComplexProperty(c => c.BillingAddress);
    });
}
```

Or the `[ComplexType]` attribute on the value object, which lets EF Core pick it up by convention wherever it is used:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string PostalCode { get; set; }
}
```

By default this maps to **table splitting**: the address columns live directly on the `Customers` table with a prefix.

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ShippingAddress_Street] nvarchar(max) NOT NULL,
    [ShippingAddress_City] nvarchar(max) NOT NULL,
    [ShippingAddress_PostalCode] nvarchar(max) NOT NULL,
    [BillingAddress_Street] nvarchar(max) NULL,
    [BillingAddress_City] nvarchar(max) NULL,
    [BillingAddress_PostalCode] nvarchar(max) NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
```

Notice there is no separate `Addresses` table and no foreign key. That is the point: the value object is part of its owner's row, with no join and no identity to manage.

## Optional (nullable) complex types need at least one required property

The `BillingAddress? BillingAddress` above works because EF Core 10 added support for **optional** complex types. The whole object can be null, and EF Core decides presence from the column values. There is one rule that trips people up: an optional complex type must have at least one required (non-nullable) property. EF Core uses that column to distinguish "the whole address is null" from "the address is present but its optional fields are null." If every property on `Address` were nullable, EF Core would have no signal to tell those two states apart, and model building throws.

In practice this is almost never a constraint, because a real address has at least one field that must be present. If you genuinely have a value object where every field is optional, add a discriminator or reconsider whether it should be nullable at all.

## Mapping a complex type to a single JSON column

Table splitting spreads the fields across columns. If you would rather keep the value object as one opaque JSON document, EF Core 10 added `ToJson()` on complex properties, and EF Core 11 keeps it stable:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>(b =>
{
    b.ComplexProperty(c => c.ShippingAddress, c => c.ToJson());
    b.ComplexProperty(c => c.BillingAddress, c => c.ToJson());
});
```

On SQL Server 2025 (or Azure SQL) this uses the native `json` column type:

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ShippingAddress] json NOT NULL,
    [BillingAddress] json NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
```

JSON mapping buys you one thing table splitting cannot do: **collections inside the mapped type**. A complex type mapped with table splitting has to be a single value, but a complex type mapped to JSON can contain a `List<string>` or a nested list of value objects. You can still query into the document. On SQL Server 2025, `context.Customers.Where(c => c.ShippingAddress.City == "Cluj")` translates to a `JSON_VALUE` lookup, and EF Core 11 adds `EF.Functions.JsonPathExists` and `EF.Functions.JsonContains`, both of which work against complex types mapped to JSON. For the broader picture on querying JSON-mapped data, see [how to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) and the [JSON_CONTAINS translation added on SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/).

## What value semantics actually gets you

Once the mapping is a complex type, the three owned-entity edges disappear.

Sharing an instance now works, because assignment copies fields rather than aliasing a tracked reference:

```csharp
// .NET 11, EF Core 11 - complex type mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress; // copies the values
await context.SaveChangesAsync(); // succeeds
```

LINQ equality compares contents, so this returns the customers whose two addresses are genuinely equal:

```csharp
// .NET 11, EF Core 11
var sameAddress = await context.Customers
    .Where(c => c.BillingAddress == c.ShippingAddress)
    .ToListAsync();
```

And bulk update reaches inside the complex type, which owned entities never allowed:

```csharp
// .NET 11, EF Core 11
await context.Customers
    .Where(c => c.ShippingAddress.City == "Bucuresti")
    .ExecuteUpdateAsync(s =>
        s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"));
```

If you are weighing the write paths against loading and mutating entities, the tradeoffs are the same ones covered in [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/); complex types simply make the value-object case eligible for the fast path.

Structs work too, which lines up neatly with the "no identity" idea:

```csharp
// .NET 11, C# 14, EF Core 11
public struct Money
{
    public required decimal Amount { get; set; }
    public required string Currency { get; set; }
}
```

Records are also a good fit, and the interplay between records, complex types, and change tracking is worth reading in full in [how to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/).

## Migrating an existing OwnsOne mapping to a complex type

If you already ship `OwnsOne`, the switch is mechanical, and with table splitting it is usually schema-neutral because the columns are named and typed the same way. Here is the procedure.

1. **Confirm the current storage shape.** If your `OwnsOne` maps to the owner's table (the default), the columns are already `Owner_Property`. If it uses `OwnsOne(...).ToTable("Addresses")` (a separate table) or `OwnsOne(...).ToJson()`, note that, because the target storage matters for whether the migration moves data.
2. **Remove identity leakage from the value object.** Delete any `Id` property, any explicit key configuration, and any navigation back to the owner. A complex type cannot have a key or a back-reference.
3. **Replace `OwnsOne` with `ComplexProperty`.** Change `b.OwnsOne(c => c.ShippingAddress)` to `b.ComplexProperty(c => c.ShippingAddress)`, and `b.OwnsOne(c => c.ShippingAddress, a => a.ToJson())` to `b.ComplexProperty(c => c.ShippingAddress, a => a.ToJson())`. Carry over per-property configuration such as `HasMaxLength` and `HasColumnName`.
4. **Make optional value objects nullable in the CLR type.** If the owned reference could be absent, declare the property as `Address?` and confirm the type has at least one required property so EF Core can detect null.
5. **Add and inspect the migration.** Run `dotnet ef migrations add SwitchAddressToComplexType`. For a table-split `OwnsOne` on the same table, the migration should be empty or near-empty because the columns do not move. If it wants to drop and recreate columns, your column names diverged; pin them with `HasColumnName` until the diff is clean, so you do not lose data.
6. **Verify data-preserving behavior on a copy first.** Apply the migration to a scratch database restored from production before you run it for real, especially if you are moving from a separate table or from `nvarchar` JSON to the native `json` type.

The one migration that genuinely moves data is going from `OwnsOne(...).ToTable("Addresses")` (a separate table) to a table-split complex type. There is no clean auto-generated path for that, because the rows have to move from the child table into the parent. Write that migration by hand: add the new columns, `UPDATE ... FROM` to copy the values across, then drop the old table. If you are already deep in an EF Core upgrade, the same care applies to the rest of your model; the [EF Core 6 to EF Core 11 migration guide](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) covers the breaking changes that tend to surface alongside this one.

## EF Core 11 removes the inheritance and configuration friction

Two things specifically improved in EF Core 11 make the switch easier.

Complex types (and JSON columns) now work on entities using **TPT (table-per-type) and TPC (table-per-concrete-type) inheritance**. Before EF Core 11, a complex property on a base type in a TPT/TPC hierarchy was not supported, which forced you back to owned entities for any inherited value object. Now this maps correctly:

```csharp
// .NET 11, C# 14, EF Core 11
public abstract class Animal
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required AnimalDetails Details { get; set; }
}

public class Dog : Animal { public string Breed { get; set; } = ""; }
public class Cat : Animal { public bool IsIndoor { get; set; } }

[ComplexType]
public class AnimalDetails
{
    public DateTime BirthDate { get; set; }
    public string? Veterinarian { get; set; }
}

// OnModelCreating
modelBuilder.Entity<Animal>().UseTptMappingStrategy();
```

EF Core 11 creates the `Details_BirthDate` and `Details_Veterinarian` columns on the `Animal` table as expected.

Configuration also got shorter. Before, drilling into a complex type's property meant grabbing the complex builder first:

```csharp
// Pre-EF Core 11
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.ShippingAddress)
    .Property(a => a.Street)
    .HasMaxLength(200);
```

EF Core 11 lets you chain member access straight through in `Property`:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>()
    .Property(c => c.ShippingAddress.Street)
    .HasMaxLength(200);
```

EF Core 11 also landed a batch of stabilization fixes for complex types, including correct comparison of nested complex types, correct `ExecuteUpdate` assignment into nested properties, and a fix for a `NullReferenceException` when two types shared a nullable complex property mapped to the same column. If you tried complex types in EF Core 9 and hit rough edges, EF Core 11 is the release where they are meant to be a full owned-entity replacement.

## When you still have to use an owned entity

Complex types do not cover every case. Reach for `OwnsOne` or `OwnsMany` when:

- **You need the value object in a separate table.** Complex types are always inline, either as split columns or a single JSON column. There is no `ComplexProperty(...).ToTable("Addresses")`. If your schema requires the data in its own table with a foreign key, that is an owned (or full) entity.
- **You need a collection mapped to separate rows.** A table-split complex type must be a single value; collections of structs are not supported at all. A JSON-mapped complex type can hold a collection inside the document, but if you want each element as its own row in a child table, `OwnsMany` remains the tool.
- **Something genuinely needs identity.** If two "value objects" with the same contents must be distinguishable, or you need to track and update them independently, they are not value objects. Model them as a real related entity.

The rule of thumb is the same one that separates a `class` from a `record`: if the thing is defined by its data, map it as a complex type; if it has an identity that outlives its data, it is an entity. For most `Address`, `Money`, `GeoPoint`, and `DateRange` types in a .NET 11 codebase, complex types are now the correct default, and owned entities are the exception you drop to only when the storage shape forces your hand.

## Related reading

- [How to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/) goes deeper on records as complex types versus entities and the change-tracking rules behind the split.
- [How to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) covers the querying side of JSON-mapped complex types.
- [EF Core 11 translates Contains to JSON_CONTAINS on SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) explains the JSON functions that now work against complex types.
- [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) frames the bulk-update path that complex types unlock for value objects.
- [Migrate EF Core 6 to EF Core 11: breaking changes that actually bite](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) is the companion if this switch is part of a larger upgrade.

## Sources

- [What's New in EF Core 10: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types)
- [What's New in EF Core 11: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [EF Core owned entity types](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities)
- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Allow mapping optional complex properties (efcore#31376)](https://github.com/dotnet/efcore/issues/31376)
