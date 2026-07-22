---
title: "Complex types vs owned entities in EF Core 11: which should you pick?"
description: "On EF Core 11, default to complex types for value objects and drop to owned entities only when you need a separate table or a collection mapped to its own rows."
pubDate: 2026-07-22
template: vs
tags:
  - "comparison"
  - "complex-types"
  - "owned-entities"
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
---

On EF Core 11 (with .NET 11 and C# 14), map a value object like `Address`, `Money`, or `DateRange` as a **complex type**, and reach for an **owned entity** only when the storage shape forces you to: the value needs its own table, or you need a collection stored as separate rows. That single axis decides almost every case. Complex types have value semantics and no identity, which is exactly what a value object is; owned entities are full entity types wearing a value-object costume, and the costume slips constantly. EF Core 11 is the release where the last reasons to prefer owned entities mostly disappeared, because complex types now work on TPT/TPC inheritance, support `ExecuteUpdate`, allow collections when mapped to JSON, and can carry keys and indexes.

This post is the decision, not the mechanics. If you want the step-by-step configuration, read [how to map a complex type instead of an owned entity in EF Core 11](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/). Here we compare the two mappings head to head, show where each one wins, and name the gotchas that pick for you.

## The one-screen feature matrix

The reason both mappings exist is that they answer different questions. An owned entity is EF Core's way of saying "this is a dependent entity that I store inside its owner." A complex type is EF Core's way of saying "this is a value, with no identity of its own." Everything below flows from that.

| Dimension                                  | Complex type                         | Owned entity                          |
| ------------------------------------------ | ------------------------------------ | ------------------------------------- |
| Underlying model kind                      | value, no key                        | entity, shadow primary key            |
| Identity semantics                         | by value (contents)                  | by reference (identity)               |
| `a == b` in LINQ compares                  | contents                             | identity                              |
| Assign copies fields (`x.A = x.B`)         | yes, copies                          | throws (shared reference)             |
| Same table as owner (table splitting)      | yes (default)                        | yes (default)                         |
| Separate table (`ToTable`)                 | no                                   | yes                                   |
| Single JSON column (`ToJson`)              | yes                                  | yes                                   |
| Collection as separate child rows          | no                                   | yes (`OwnsMany`)                      |
| Collection inside a JSON document          | yes (`ComplexCollection` + `ToJson`) | yes (`OwnsMany` + `ToJson`)           |
| `ExecuteUpdate` into a nested member       | yes (EF Core 11)                     | no                                    |
| CLR type can be a `struct` or `record`     | yes                                  | reference type only                   |
| Keys / indexes over nested scalar          | yes (EF Core 11)                     | yes                                   |
| TPT / TPC inheritance on the owner         | yes (EF Core 11)                     | yes                                   |
| Change tracker footprint                   | column-level, no separate node       | separate tracked node + shadow key    |

Read that table top to bottom and the pattern is obvious: complex types win every row that is about semantics, and owned entities win the two rows that are about storage shape (separate table, separate child rows). That is the whole comparison in miniature. Versions matter here because three of those "yes" cells for complex types only became true in EF Core 11; on EF Core 9 the calculus was different.

## When to pick a complex type

Reach for `ComplexProperty` (or the `[ComplexType]` attribute) in these cases, which cover the large majority of value objects in a real codebase:

- **The type is defined entirely by its data.** `Address`, `Money`, `GeoPoint`, `DateRange`, `PersonName`. If two instances with identical fields are interchangeable, it is a value, and a value wants value semantics. On EF Core 11 you write `b.ComplexProperty(c => c.ShippingAddress)` and the fields land inline on the owner's table.
- **You want to assign or compare the value naturally.** `customer.BillingAddress = customer.ShippingAddress` copies the fields and saves cleanly, and `Where(c => c.BillingAddress == c.ShippingAddress)` filters by contents. Both of these are broken with owned entities, as covered below.
- **You want bulk writes to reach inside the value.** EF Core 11 supports `ExecuteUpdate` into complex-type members: `ExecuteUpdateAsync(s => s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"))`. Owned entities have never allowed this. If you care about the fast write path, this alone is decisive; the tradeoffs are the same ones in [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).
- **The value is a `struct` or `record`.** Owned entities must be reference types EF Core can key and track. A complex type can be a `readonly struct Money` or a `record`, which lines up with the "no identity" idea. The record interplay is worth reading in full in [how to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/).

The Microsoft guidance is not subtle about this default. The EF Core 11 release notes state that the stabilization work on complex types was done specifically "to unblock using complex types as an alternative to the owned entity mapping approach," and the EF Core 10 notes told existing owned-entity users to switch. Treat complex types as the default and owned entities as the exception.

## When to pick an owned entity

There are exactly two structural reasons and one modeling reason to stay on `OwnsOne` / `OwnsMany`:

- **The value must live in its own table.** Complex types are always inline: either table-split columns on the owner, or one JSON column on the owner. There is no `ComplexProperty(...).ToTable("Addresses")`. If your schema requires the data in a separate table with a foreign key back to the owner (a reporting view keys off it, another table references it, a DBA mandates it), that is an owned entity mapped with `OwnsOne(...).ToTable(...)`.
- **You need a collection as separate rows.** A one-to-many of value objects that must each be its own row in a child table is `OwnsMany`. A table-split complex type must be a single value, and while EF Core 11 added `ComplexCollection` for collections, those are stored **inside a JSON document**, not as child rows. If you want to index, join, or query the elements as first-class rows, `OwnsMany` is still the tool.
- **It is not actually a value object.** If two instances with the same contents must remain distinguishable, or the thing has a lifecycle that outlives its current data, it has identity. That is a real related entity, not an owned type and not a complex type. Model it with a normal one-to-many and a key you control.

Notice that none of these reasons is about semantics or convenience. They are about the physical schema. If your answer to "does this need a separate table or separate rows?" is no, you do not have a reason to use an owned entity on EF Core 11.

## The three owned-entity edges that push people off it

The comparison gets concrete when you hit the sharp edges. All three come from the same root cause: an owned entity is an entity, so EF Core gives it a shadow key and reasons about it by reference identity.

First, you cannot share an instance. This looks like it should work and does not:

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress;
await context.SaveChangesAsync(); // throws: the same owned instance is referenced twice
```

Because both properties are the same entity type, EF Core sees one entity referenced from two places and refuses it. With a complex type, the assignment copies the fields and saves cleanly.

Second, LINQ equality compares identity, not contents:

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var same = await context.Customers
    .Where(c => c.BillingAddress == c.ShippingAddress) // not what you meant
    .ToListAsync();
```

With an owned entity this does not translate to a field-by-field comparison. With a complex type, EF Core 11 compares the contents (including nested complex types, after a specific EF Core 11 bug fix), so the query means "the two addresses are genuinely equal."

Third, `ExecuteUpdate` does not support owned-entity properties at all, while the complex-type version works:

```csharp
// .NET 11, EF Core 11 - complex type mapping
await context.Customers
    .Where(c => c.ShippingAddress.City == "Bucuresti")
    .ExecuteUpdateAsync(s =>
        s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"));
```

If your code hits any of these three, the owned-entity mapping is fighting you, and the fix is to switch the mapping, not to work around the symptom.

## Performance: it is about tracking nodes and joins, not a headline number

There is no dramatic throughput gap to put in a chart here, and you should be suspicious of anyone who shows you one. The real, structural performance difference is in two places.

The first is change tracking. An owned entity is tracked as its own node in the change tracker, with a shadow key EF Core manages. A complex type is not a separate node: its columns are tracked as part of the owner, at the column-diff level. In an object graph with many value objects per aggregate, that is fewer entries to snapshot, fix up, and diff on `SaveChanges`. The difference is usually small per entity but scales with how many value objects you load, and it is strictly in the complex type's favor because there is simply less bookkeeping.

The second is the join, and it only applies to the owned-entity case you would actually pick for storage reasons. An `OwnsOne(...).ToTable("Addresses")` mapping lives in a separate table, so reading the owner with its value object is a join. A table-split complex type has no separate table and therefore no join. If you moved a value object to an owned entity purely out of habit and it landed in the owner's table anyway (the default), the two are storage-equivalent and the tracking difference is the only one left. The moment you actually use the owned entity's headline feature (a separate table), you take on the join cost that complex types avoid by construction. For the broader tracking-cost picture, the same forces show up in [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/).

So the honest performance statement is: complex types are never slower than an equivalent same-table owned entity and are structurally leaner to track; owned entities take on a join precisely when you use them for the one thing complex types cannot do.

## The gotcha that picks for you: EF Core version and the nullable rule

Two things can make the decision for you regardless of preference.

The first is your EF Core version. Everything above assumes EF Core 11. On EF Core 9 and earlier, complex types could not be used on entities with TPT/TPC inheritance, `ExecuteUpdate` into nested members had bugs, comparison of nested complex types was wrong, and there was no `ComplexCollection`. If you are pinned to EF Core 9, owned entities may still be the pragmatic choice for an inherited value object or a collection, and you should plan the switch as part of your upgrade. The [EF Core 6 to EF Core 11 migration guide](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) covers the breaking changes that tend to surface alongside this one, and note that EF Core 11's `UseSqlServer` now defaults to compatibility level 160 (SQL Server 2022), which affects some JSON translations.

The second is the optional-value rule. An optional (nullable) complex type must have **at least one required, non-nullable property**, because EF Core uses that column to distinguish "the whole value is null" from "the value is present but its optional fields are null." If you have a value object where genuinely every field is nullable, an optional complex type will not build, and you either add a discriminator, reconsider the nullability, or fall back to an owned entity. In practice a real `Address` or `Money` always has a required field, so this rarely bites, but it is the one modeling constraint that can force your hand toward owned entities.

Query filters behave the same way for both: a global or named filter is defined on the owning entity, not on the value object, so soft delete and multi-tenancy work identically whichever mapping you choose. If that is your concern, see [named query filters vs a single global query filter in EF Core 11](/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/); it is not a differentiator between complex types and owned entities.

## The recommendation, stated plainly

On EF Core 11, default to complex types for value objects. Map `Address`, `Money`, `GeoPoint`, `DateRange`, and their kin with `ComplexProperty`, get value semantics for free, and enjoy `ExecuteUpdate`, struct/record support, and clean equality. Drop to an owned entity only when the physical schema demands it: the value must sit in its own table, or a collection of values must be stored as separate child rows. And if the thing has genuine identity that outlives its data, it was never a value object, so model it as a real related entity with a key you own.

The rule of thumb is the same one that separates a `record` from a `class`: if the thing is defined by its data, it is a value, and a value is a complex type. If it has an identity you need to track, it is an entity. EF Core 11 finally lets that mental model map one-to-one onto the framework, with owned entities reserved for the narrow storage cases they were always best at.

## Related reading

- [How to map a complex type instead of an owned entity in EF Core 11](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) is the full step-by-step, including the `OwnsOne`-to-`ComplexProperty` migration.
- [How to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/) goes deeper on records as complex types versus entities.
- [How to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) covers the JSON storage option both mappings share.
- [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) frames the bulk-update path complex types unlock for value objects.
- [How to configure table-per-hierarchy (TPH) inheritance mapping in EF Core 11](/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) is the companion when your owner sits in an inheritance hierarchy.

## Sources

- [What's New in EF Core 11: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types)
- [EF Core owned entity types](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities)
- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Allow mapping optional complex properties (efcore#31376)](https://github.com/dotnet/efcore/issues/31376)
