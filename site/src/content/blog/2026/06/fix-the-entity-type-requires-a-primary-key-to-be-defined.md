---
title: "Fix: The entity type 'X' requires a primary key to be defined in EF Core 11"
description: "EF Core can't find a key for your type. Either name a property Id or {Type}Id, add [Key], call HasKey, or - if it is a view or raw SQL result - call HasNoKey."
pubDate: 2026-06-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
---

The fix: EF Core builds your model and finds a type it thinks is an entity but cannot find a primary key for it. You have three real options, in order: give the type a key (name a property `Id` or `{Type}Id`, add `[Key]`, or call `modelBuilder.Entity<T>().HasKey(...)`); tell EF Core the type is intentionally keyless with `HasNoKey()` (correct for views and raw SQL results); or stop EF Core from treating it as an entity at all by removing the stray `DbSet<T>` or calling `modelBuilder.Ignore<T>()`. Pick the one that matches what the type actually is.

```text
System.InvalidOperationException: The entity type 'OrderSummary' requires a primary key to be defined.
If you intended to use a keyless entity type, call 'HasNoKey' in 'OnModelCreating'.
For more information on keyless entity types, see https://go.microsoft.com/fwlink/?linkid=2141943.
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.ValidateNonNullPrimaryKeys(IModel model)
   at Microsoft.EntityFrameworkCore.Infrastructure.ModelValidator.Validate(IModel model, ...)
   at Microsoft.EntityFrameworkCore.Metadata.Conventions.Infrastructure.ModelRuntimeInitializer.Initialize(...)
```

This is a model-validation error, not a runtime query error. It fires the first time EF Core builds the model: the first query, the first `SaveChanges`, the first `dotnet ef` command, or a call to `context.Model`. The type name in quotes is the one EF Core could not key. This guide is written against .NET 11, C# 14, and `Microsoft.EntityFrameworkCore` 11.0.0. The behaviour and the message text are unchanged from EF Core 7, so everything here applies back to that release.

## What "requires a primary key" actually means

When EF Core builds your model it runs a set of conventions. One of them, `KeyDiscoveryConvention`, tries to pick a primary key for every entity type by looking for a property named, case-insensitively, `Id` or `{EntityTypeName}Id`. If it finds exactly one such property, that becomes the key. If it finds none, the entity stays keyless, and then `ModelValidator` runs and rejects keyless entities that were not explicitly marked as keyless. That rejection is the exception you are reading.

So the error always means one of two things:

1. EF Core thinks this type is an entity, but convention could not discover a key and you did not configure one.
2. EF Core should not be treating this type as an entity at all, but something pulled it into the model.

The whole fix is figuring out which of those is true. Two questions settle it: does this type correspond to a real table or view I read and write, and does it have a natural unique identifier? If yes to both, the type wants a key. If it is a projection, a report row, or a raw SQL result, it wants `HasNoKey` or to be left out of the model entirely.

## The smallest repro

A `DbSet` of a type whose key property is not named in a way convention recognises.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class AppDb : DbContext
{
    public DbSet<OrderSummary> OrderSummaries => Set<OrderSummary>();

    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}

public class OrderSummary
{
    public Guid Reference { get; set; }   // not "Id", not "OrderSummaryId"
    public decimal Total { get; set; }
}
```

`Reference` is a perfectly good identifier, but convention does not know that. It looked for `Id` or `OrderSummaryId`, found neither, left the type keyless, and validation threw. The exact same error appears if you map a SQL view to a class, return rows from `FromSql` into an unmapped type, or accidentally expose a DTO as a `DbSet`.

## Fix 1: give the type a key

Use this when the type is a real entity you query and persist. Three ways, in increasing order of explicitness.

Rename the property so convention finds it:

```csharp
// .NET 11, EF Core 11.0.0 -- convention discovers this automatically
public class OrderSummary
{
    public Guid Id { get; set; }          // discovered by KeyDiscoveryConvention
    public decimal Total { get; set; }
}
```

Or keep your own name and annotate it:

```csharp
// .NET 11, EF Core 11.0.0
public class OrderSummary
{
    [Key]
    public Guid Reference { get; set; }
    public decimal Total { get; set; }
}
```

Or configure it in `OnModelCreating`, which is the right place when you cannot or do not want to put attributes on the type (for example, the class lives in a domain project that must not reference EF Core):

```csharp
// .NET 11, EF Core 11.0.0
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderSummary>().HasKey(o => o.Reference);
}
```

For a composite key, pass an anonymous object. There is no `[Key]`-attribute equivalent that defines column order reliably, so prefer the fluent form:

```csharp
// .NET 11, EF Core 11.0.0 -- composite key, order matters for the index
modelBuilder.Entity<OrderLine>().HasKey(l => new { l.OrderId, l.LineNumber });
```

One trap inside this fix: the key property must be a readable, mapped CLR property. A public **field**, a property marked `[NotMapped]`, or a property of a type EF Core cannot map will not be discovered, and you will keep getting the error even though "there is clearly an Id right there." Make it an auto-property of a mappable type (`int`, `long`, `Guid`, `string`, and so on).

## Fix 2: declare the type keyless with HasNoKey

Use this when the type genuinely has no primary key: a database view, the result shape of a stored procedure, or a read-only report row. Keyless entity types are read-only, are never tracked by the change tracker, and cannot take part in `SaveChanges`.

```csharp
// .NET 11, EF Core 11.0.0 -- a view with no natural key
modelBuilder.Entity<OrderSummary>()
    .HasNoKey()
    .ToView("vw_OrderSummary");
```

The attribute form is `[Keyless]` on the class, which is equivalent to calling `HasNoKey()`:

```csharp
// .NET 11, EF Core 11.0.0
[Keyless]
public class OrderSummary
{
    public Guid Reference { get; set; }
    public decimal Total { get; set; }
}
```

If the keyless type is fed by raw SQL rather than a view, map it to the query instead of a table:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Entity<OrderSummary>()
    .HasNoKey()
    .ToSqlQuery("SELECT Reference, SUM(Total) AS Total FROM Orders GROUP BY Reference");
```

Do not reach for `HasNoKey` just to make the error disappear on a type that does have an identity. A keyless entity cannot be updated or deleted through the context, and EF Core will not deduplicate rows that share the same values, so you can silently get duplicates in memory. `HasNoKey` is a statement about the data, not a workaround.

## Fix 3: stop EF Core from mapping the type at all

Often the type is not an entity and never should have been one. It got dragged into the model in one of three ways:

- You added a `DbSet<SomeDto>` for a projection or view-model. Remove it and project with `Select` into the DTO instead.
- A mapped entity has a navigation property pointing at the type, so EF Core mapped it transitively. If that navigation should not be a relationship, mark it `[NotMapped]`.
- You called `modelBuilder.Entity<SomeDto>()` somewhere (often to set a single property), which registers it as an entity.

To explicitly exclude a type, ignore it:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Ignore<OrderSummary>();
```

Or, on a property that is causing the transitive mapping:

```csharp
// .NET 11, EF Core 11.0.0
public class Order
{
    public int Id { get; set; }

    [NotMapped]
    public OrderSummary? Computed { get; set; }   // a view model, not a relationship
}
```

For one-off projections you rarely need a mapped type at all. Project straight into the shape you want and EF Core never tries to key it:

```csharp
// .NET 11, EF Core 11.0.0 -- no DbSet, no HasNoKey, nothing to key
var summaries = await db.Orders
    .GroupBy(o => o.CustomerId)
    .Select(g => new OrderSummary { Reference = g.Key, Total = g.Sum(o => o.Total) })
    .ToListAsync();
```

## Variants that land on this same error

### Mapping a record without an Id

A positional `record` works fine as an entity, but only if one of its parameters becomes a discoverable key. `public record OrderSummary(Guid Reference, decimal Total);` hits this error for the same reason the class did: `Reference` is not `Id`. Name the first parameter `Id`, add `[property: Key]` to the positional parameter, or configure `HasKey` in `OnModelCreating`. The mechanics of mapping records, including init-only properties and value equality, are covered in the guide on [using records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/).

### Database.SqlQuery<T> and FromSql result types

`db.Database.SqlQuery<OrderSummary>($"...")` maps `OrderSummary` as an implicit keyless type at query time, and that path does not need any configuration. But if you also call `modelBuilder.Entity<OrderSummary>()` for the same type elsewhere, you have now registered it as a regular entity, and convention demands a key. Either keep the type out of `OnModelCreating` entirely (let `SqlQuery` handle it), or register it explicitly with `HasNoKey()`. This is the root cause behind [dotnet/efcore#35575](https://github.com/dotnet/efcore/issues/35575), where a query type collided with a configured entity of the same name.

### The error names a type you did not write

If the type in quotes is a framework or library type, a navigation dragged it in. Find the entity that references it and decide: real relationship (configure the key on the referenced type) or not (mark the navigation `[NotMapped]` or `Ignore<T>()` the type). This often shows up with strongly-typed JSON columns and cross-schema foreign keys, as in [dotnet/efcore#36614](https://github.com/dotnet/efcore/issues/36614).

### It only fails under dotnet ef, not at runtime

`dotnet ef migrations add` and `dotnet ef database update` build the full model, so they surface model errors that a narrow runtime code path might not have triggered yet. The error is real; the tooling just found it first. If the design-time build cannot even construct your context, you will see a different message first; that one is covered in [why dotnet ef migrations add cannot create your DbContext](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

### A nullable or shadowed key

If your key property is nullable (`int?`), EF Core will discover it but `ModelValidator` rejects null primary keys with a closely related message. Make the key non-nullable. Likewise, if a base class and a derived class both declare `Id`, the shadowed member can confuse discovery; declare the key once on the type EF Core maps.

## Confirming the fix

After applying one of the three fixes, force a model build without running your app so the feedback loop is fast:

```bash
# .NET 11 SDK, EF Core tools 11.0.0
dotnet ef dbcontext info --startup-project ./Api
```

If the model is valid, this prints the provider and context details. If a type is still keyless and unmarked, it throws the same exception, and the message tells you exactly which type is still unresolved. Work through them one at a time; a model with several view or DTO types can throw once per type until each is handled.

The mental model worth keeping: this error is EF Core asking you to classify a type. Entity with identity, keyless read-only shape, or not-an-entity. Once you answer that, the fix is mechanical. When you are wiring these types into tests and want change tracking to behave, the patterns in [mocking DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) and [warming up the EF Core model before the first query](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) pair well with getting your keys right.

## Sources

- [Keyless entity types](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types), EF Core docs, on `HasNoKey`, `[Keyless]`, and the read-only constraints.
- [Keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys), EF Core docs, on convention discovery, `[Key]`, and composite keys.
- [Model validation and conventions](https://learn.microsoft.com/en-us/ef/core/modeling/), EF Core docs.
- [dotnet/efcore#29198](https://github.com/dotnet/efcore/issues/29198) and [dotnet/efcore#35575](https://github.com/dotnet/efcore/issues/35575), the canonical issues behind this message.
