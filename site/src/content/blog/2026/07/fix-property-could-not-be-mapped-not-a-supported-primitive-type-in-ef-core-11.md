---
title: "Fix: \"The property could not be mapped, because it is not a supported primitive type or a valid entity type\" in EF Core 11"
description: "EF Core hit a property it does not know how to store. Map it as a complex type, convert it with HasConversion, give it a key, or ignore it with [NotMapped]."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
---

EF Core throws `The property 'X.Y' could not be mapped, because it is of type 'Z' which is not a supported primitive type or a valid entity type` when your model exposes a property EF Core cannot turn into a column and cannot treat as a relationship. Fix it one of four ways, in order of preference: map it as a complex type with `ComplexProperty` if it is a value object, convert it to a scalar with `HasConversion` (a value converter) if it is an enum list or a custom wrapper, give the type a key so EF Core maps it as a related entity, or exclude it entirely with `[NotMapped]` / `EntityTypeBuilder.Ignore` if it should never be persisted. This applies to `Microsoft.EntityFrameworkCore` 11.0 on .NET 11 with C# 14, and the message has been stable since EF Core 3.0.

## The error in context

The full runtime exception is an `InvalidOperationException` thrown while EF Core builds the model, which means it fires the first time you touch the `DbContext` (a query, a `SaveChanges`, or `dotnet ef migrations add`), not when you compile:

```
System.InvalidOperationException: The property 'Customer.Tags' could not be mapped, because it is of type 'HashSet<Tag>' which is not a supported primitive type or a valid entity type. Either explicitly map this property, or ignore it using the '[NotMapped]' attribute or by using 'EntityTypeBuilder.Ignore' in 'OnModelCreating'.
```

The two identifiers in the message are the only things you need to read: the property (`Customer.Tags`) and its type (`HashSet<Tag>`). EF Core is telling you it walked your entity, found this member, and had no rule for storing it. The last sentence lists the escape hatches but not the right one, which is why this error sends so many people straight to `[NotMapped]` even when the data was supposed to be saved.

## Why this happens

EF Core maps a property in exactly one of three ways. A scalar becomes a column (`int`, `string`, `decimal`, `DateTime`, `Guid`, `bool`, an `enum`, and since EF Core 8 also `DateOnly` and `TimeOnly` and primitive collections like `List<string>`). A type with a discoverable key becomes a related entity, wired up through a foreign key. And a value object with no key becomes a complex type or an owned entity, stored inline on the owner's table.

This error means the property fell through all three. The type is not a scalar EF Core knows, it has no key EF Core can find (so it cannot be a relationship), and you never told EF Core to treat it as a complex or owned type. Common triggers:

- A **custom class or struct** used as a value object (`Address`, `Money`, `GeoPoint`) that you never configured.
- A **collection of a custom type** (`List<OrderLine>`, `HashSet<Tag>`) where the element type has no key.
- An **enum collection** (`List<Status>`). A single enum maps fine, but before EF Core 8 a collection of them did not, and a collection of a custom type still does not without configuration.
- A **dictionary or arbitrary object** (`Dictionary<string, string>`, `IDictionary`, `object`, `dynamic`, `JsonElement`) that has no natural column representation.
- A **type from another library** (`NodaTime.Instant`, a domain primitive) with no built-in provider mapping.

The fix is never to guess. Decide what the data *is*, then pick the mapping that matches.

## Minimal repro

The smallest program that reproduces it uses a value object that looks harmless. `Address` has no `Id`, so EF Core cannot make it a related entity, and it is not a scalar, so EF Core throws:

```csharp
// .NET 11, C# 14, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();
await db.Database.EnsureCreatedAsync(); // throws here while building the model

public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required Address ShippingAddress { get; set; } // unmapped: not scalar, no key
}

public class ShopContext : DbContext
{
    public DbSet<Customer> Customers => Set<Customer>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Shop;Trusted_Connection=True;Encrypt=False");
}
```

EF Core reports `The property 'Customer.ShippingAddress' could not be mapped, because it is of type 'Address'...`. The property is real, the type is real, but nothing in the model tells EF Core how `Address` becomes storage.

## Fix, in detail

Work top to bottom. The first mapping that matches your intent is the right one.

### 1. It is a value object: map it as a complex type

If the property is a value object that belongs on the owner's row (an address, a money amount, a coordinate), map it with `ComplexProperty`. A complex type has no identity and gets stored inline, which is exactly what a value object wants:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Customer>()
        .ComplexProperty(c => c.ShippingAddress);
}
```

Or tag the type with `[ComplexType]` so EF Core picks it up by convention everywhere it appears:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
}
```

This maps to table splitting: `ShippingAddress_Street` and `ShippingAddress_City` columns on `Customers`, no join, no foreign key. Complex types are the modern replacement for owned entities for value objects, and they come with value semantics that owned entities never had. The full story, including when they still fall short, is in [how to map a complex type instead of an owned entity in EF Core 11](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/). If the type is a `record`, read [how to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/) first, because record equality interacts with change tracking in ways worth understanding before you ship.

### 2. It is really one scalar: convert it with HasConversion

If the property is conceptually a single value that EF Core does not have a built-in mapping for, a value converter turns it into a scalar on the way to the database and back on the way out. This covers `NodaTime` types, domain primitives, or an enum you want stored as its string name:

```csharp
// .NET 11, EF Core 11 - store the enum as its name, not its int
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion<string>();
```

For a custom wrapper type, supply both directions explicitly:

```csharp
// .NET 11, EF Core 11 - EmailAddress is a struct wrapping a string
modelBuilder.Entity<Customer>()
    .Property(c => c.Email)
    .HasConversion(
        email => email.Value,          // to the database column (nvarchar)
        value => new EmailAddress(value)); // back from the column
```

A value converter is the right tool when there is a clean, lossless mapping to one column. If the mapping is lossy or the type is genuinely composite (several fields), use a complex type instead. Do not reach for a converter just to serialize a whole object graph into one string; that path is next, and it has sharper edges.

### 3. It is a collection or a dictionary: primitive collections or a JSON column

EF Core 8 added native mapping for **primitive collections**, so on EF Core 11 a `List<string>`, `int[]`, or `List<DateOnly>` maps automatically to a JSON column with no configuration. If you still see the error for a primitive collection, you are on EF Core 7 or older; upgrading fixes it outright.

For a collection of a **custom type** or a **dictionary**, EF Core cannot infer the shape, so serialize the whole property to a JSON column. On EF Core 11 the cleanest route for a value-object collection is a JSON-mapped complex type:

```csharp
// .NET 11, EF Core 11 - store the whole collection as one json document
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.Tags, b => b.ToJson());
```

For a `Dictionary<string, string>` or other free-form bag, a value converter that runs `System.Text.Json` gives you the same single-column storage:

```csharp
// .NET 11, EF Core 11 - dictionary stored as a json string
modelBuilder.Entity<Customer>()
    .Property(c => c.Metadata)
    .HasConversion(
        dict => JsonSerializer.Serialize(dict, (JsonSerializerOptions?)null),
        json => JsonSerializer.Deserialize<Dictionary<string, string>>(json, (JsonSerializerOptions?)null)
                ?? new());
```

A JSON column is queryable on modern providers, so you are not giving up filtering to get single-column storage. The querying side, including the SQL functions that reach into a JSON document, is covered in [how to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/). If you need a custom serialization shape rather than the default, [how to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) shows how to control exactly what lands in the column.

### 4. It is actually a related entity: give it a key

If the property should be its own table with its own rows (an `Order` referencing real `OrderLine` records, not an inline value object), then it is an entity, and the error means EF Core could not find a key to establish the relationship. Add a key and EF Core wires up the foreign key automatically:

```csharp
// .NET 11, C# 14, EF Core 11
public class OrderLine
{
    public int Id { get; set; }     // now discoverable as a key
    public string Sku { get; set; } = "";
    public int Quantity { get; set; }
}

public class Order
{
    public int Id { get; set; }
    public List<OrderLine> Lines { get; set; } = []; // maps as a one-to-many
}
```

If the type has an identifier that is not named `Id` or `OrderLineId`, tell EF Core with `HasKey` in `OnModelCreating`. A keyless type that has no natural key but still needs its own rows should be mapped as an owned collection with `OwnsMany`. And if the error you are actually staring at is [the entity type 'X' requires a primary key to be defined](/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/), that is the closely related sibling: EF Core got far enough to treat the type as an entity but then found no key.

### 5. It should never be persisted: ignore it

If the property is a computed convenience, a cache, or a service reference that has no business in the database, exclude it. The attribute is the quickest:

```csharp
// .NET 11, C# 14, EF Core 11
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    [NotMapped]
    public string DisplayName => $"{Name} (#{Id})";
}
```

Or do it in the model configuration, which keeps persistence-ignorant POCOs free of EF Core attributes:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>()
    .Ignore(c => c.DisplayName);
```

`Ignore` is the correct fix only when the answer to "should this column exist?" is genuinely no. Reaching for it to silence the error on data you meant to save is the single most common way this error turns into a silent data-loss bug.

## Gotchas and variants

**A get-only computed property triggered it.** EF Core tries to map any readable property, including expression-bodied ones. If `DisplayName => ...` is derived from other columns, it does not need storage; ignore it. If it is expensive and you want it in the database, map a computed column with `HasComputedColumnSql` instead.

**It broke after you added `required` or changed a type.** Adding a property of an unmapped type, or swapping a `string` for a custom struct, introduces the unmapped member. The error names the exact property; check what changed on that type.

**A collection of enums.** `List<Status>` throws on EF Core 7 and earlier because enum collections were not primitive collections yet. On EF Core 8 and up it maps to a JSON column automatically. If you are mid-upgrade, the enum-collection behavior is one of several mapping changes in the [EF Core 6 to EF Core 11 migration guide](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**The type lives in another assembly and you cannot annotate it.** You cannot put `[ComplexType]` or `[NotMapped]` on a type you do not own, but every attribute has a fluent equivalent in `OnModelCreating` (`ComplexProperty`, `Property(...).HasConversion(...)`, `Ignore`). Configure it from your `DbContext` and you never touch the foreign type.

**A navigation to an abstract or interface type.** EF Core cannot map a property typed as an interface (`IAddress`) or an unmapped base without a discriminator. Map the concrete type, or configure inheritance explicitly.

**It is a `DbSet` filter, not a persisted property.** If the "property" is really a helper that queries other data, it does not belong on the entity at all. Move it to a repository or a service so EF Core never sees it during model building.

The decision that keeps you out of this error for good is a single question asked before you add the property: what is this, in storage terms? A value object goes inline as a complex type. A single convertible value gets a `HasConversion`. A bag of data becomes a JSON column. A thing with identity becomes a related entity with a key. And a purely in-memory helper gets ignored. EF Core throws precisely because it refuses to guess which of those you meant.

## Related

- [How to map a complex type instead of an owned entity in EF Core 11](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) is the deep dive on the value-object mapping this error most often points to.
- [How to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) covers storing and filtering a serialized collection or document.
- [Fix: The entity type 'X' requires a primary key to be defined](/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) is the sibling error when EF Core treats the type as an entity but finds no key.
- [How to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/) matters when your value object is a record and change tracking is in play.
- [How to write a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) shapes exactly what a value-converter-to-JSON property stores.

## Sources

- [Value conversions, EF Core docs](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions)
- [Complex types, EF Core 11 What's New](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Primitive collections, EF Core 8 What's New](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#primitive-collections)
- [Excluding types or properties from the model, EF Core docs](https://learn.microsoft.com/en-us/ef/core/modeling/#excluding-types-from-the-model)
- [dotnet/efcore issue #15987: property could not be mapped, not a supported primitive type](https://github.com/dotnet/efcore/issues/15987)
