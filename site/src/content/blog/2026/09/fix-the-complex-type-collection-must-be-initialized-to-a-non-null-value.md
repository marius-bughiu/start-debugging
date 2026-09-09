---
title: "Fix: The complex type collection must be initialized to a non-null value"
description: "On EF Core 10.0.x, nulling a complex property that holds a two-element collection inside a ToJson complex collection breaks DetectChanges. Fixed in 11.0.0-rc.1."
pubDate: 2026-09-09
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "complex-types"
  - "change-tracker"
  - "json"
  - "dotnet-10"
---

`The complex type collection '...' must be initialized to a non-null value before the elements can be accessed.` has two causes that share one message. If the path in the message names a property you simply never assigned, initialize it (`public List<Entry> Entries { get; set; } = new();`) and you are done. If the property is initialized and the exception falls out of `DetectChanges` or `SaveChanges`, you have hit [dotnet/efcore#38632](https://github.com/dotnet/efcore/issues/38632): on EF Core 10.0.0 through 10.0.12, setting a nullable complex property to `null` when that property's type holds a collection of two or more elements, inside a complex collection mapped with `ToJson()`, crashes change detection before any SQL is generated. The fix is merged and ships in `11.0.0-rc.1`; the 10.0.x backport is milestoned 10.0.13 and has not shipped.

## The error in context

The message comes from `CoreStrings.ComplexCollectionNotInitialized`, and it is worth reading character by character, because four other messages in this corner of the change tracker look almost the same:

```
System.InvalidOperationException: The complex type collection 'Root[]Group[]Item.Meta.Entries'
must be initialized to a non-null value before the elements can be accessed.
```

For the bug case, the frames that matter run, innermost first, `InternalComplexCollectionEntry.GetEntry` to `InternalComplexEntry.set_Ordinal` to `InternalComplexCollectionEntry.RemoveEntry` to `ChangeDetector.DetectComplexCollectionChanges`. If your stack has `RemoveEntry` and `set_Ordinal` in it, you are looking at the EF bug, not at your own null. If instead the top of the stack is your own call to `EntityEntry.ComplexCollection(...)`, you are looking at cause 1 below.

The property path is a flattened chain, not a C# expression. `[]` marks a hop through a complex collection and is followed by the element type, so `Root[]Group[]Item.Meta.Entries` reads as "the `Entries` collection on `Meta`, which hangs off an `Item` element, which lives inside a `Group` element, which lives in a collection on `Root`". That path is the fastest way to find the offending property in a deep model.

## Why the change tracker refuses to work with a null collection

Complex collections arrived in EF Core 10, and on relational providers they [must be mapped to a single JSON column with `ToJson()`](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types). They cannot go to a table of their own. That constraint is the whole reason this message exists: with no table and no key, EF cannot identify an element by its primary key the way it does for an owned entity. It identifies an element by its **position in the CLR list**.

`InternalComplexCollectionEntry` therefore keeps two parallel lists of entries, one for current values and one for original values, and every entry it hands out is derived from the CLR collection that is actually sitting on the object. `GetEntry` cannot invent a position in a list that does not exist:

```csharp
// EF Core 10 and 11, InternalEntryBase.InternalComplexCollectionEntry.GetEntry
if (original)
{
    if (_containingEntry.GetOriginalValue(_complexCollection) == null)
    {
        throw new InvalidOperationException(
            CoreStrings.ComplexCollectionEntryOriginalNull(
                _complexCollection.DeclaringType.ShortNameChain(), _complexCollection.Name));
    }
}
else
{
    if (_containingEntry[_complexCollection] == null)
    {
        throw new InvalidOperationException(
            CoreStrings.ComplexCollectionNotInitialized(
                _complexCollection.DeclaringType.ShortNameChain(), _complexCollection.Name));
    }
}
```

Two branches, two different messages. `ComplexCollectionNotInitialized` is the current-value branch. If you get `The original entries cannot be accessed for the complex type collection '...' as it was originally 'null'` instead, the collection was `null` when the row was loaded and you initialized it afterwards.

Note what `ChangeDetector` does, because it explains why a null collection does not always blow up. `DetectComplexCollectionChanges` reads both sides and treats a nullability difference as a change rather than an error:

```csharp
// EF Core 11, ChangeDetector.DetectComplexCollectionChanges
var currentCollection = (IList?)entry[complexProperty];
var originalCollection = (IList?)entry.GetOriginalValue(complexProperty);
var changesFound = currentCollection == null != (originalCollection == null);
```

Both element loops are guarded by `!= null`. So a plain null collection survives change detection; it only throws when something reaches for an *element*.

## Cause 1: the collection property really is null

This is the message doing its job. It fires the moment you index into the change tracker entry for a collection that was never assigned:

```csharp
// .NET 10, EF Core 10.0.12. Throws ComplexCollectionNotInitialized.
public class Distributor
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Address> ShippingCenters { get; set; } = null!;  // never assigned
}

var entry = db.Entry(distributor).ComplexCollection(d => d.ShippingCenters)[0];
```

Microsoft's guidance is blunt about this: initialize the collection inline so the property can never be null.

```csharp
// .NET 10, EF Core 10.0.12. The documented shape.
public List<Address> ShippingCenters { get; set; } = new();
```

Unlike a navigation collection, EF does not create the list for you, and there is no lazy-loading proxy to paper over it. Two variants of the same cause are worth checking before you go hunting for a bug:

- **A nullable collection property.** If you declared `List<Address>? ShippingCenters` and the JSON column holds SQL `NULL`, materialization gives you `null` back faithfully, and the first element access throws. Either make the property non-nullable and backfill the column with `'[]'`, or null-check before you touch the change tracker.
- **A nullable complex property in the path.** In `Root[]Group[]Item.Meta.Entries`, `Entries` may well be initialized on every `Meta` you construct, but if `Meta` itself is `null` there is no `Entries` to read. That is exactly the shape of the EF bug below, and it is also a shape you can produce yourself by indexing into the tracker on an item whose `Meta` you just cleared.

If you are new to this mapping style, [complex types vs owned entities in EF Core 11](/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) covers why complex types behave differently from the owned-entity graphs most people are migrating away from, and the [step-by-step mapping guide](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) covers the configuration itself.

## Cause 2: dotnet/efcore#38632, the reindex path

The interesting case is the one where every collection in your model is initialized and the exception still comes out of `SaveChangesAsync`. Four conditions have to line up, and they are common enough in a real model that people hit this while doing nothing unusual.

```csharp
// .NET 10, EF Core 10.0.12. Complex types are never discovered by convention,
// so every value type here carries [ComplexType].
public class Root
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Group> Groups { get; set; } = new();
}

[ComplexType]
public class Group
{
    public required string Title { get; set; }
    public List<Item> Items { get; set; } = new();
}

[ComplexType]
public class Item
{
    public required string Sku { get; set; }
    public Meta? Meta { get; set; }               // nullable complex property
}

[ComplexType]
public class Meta
{
    public required string Kind { get; set; }     // optional complex types need one required property
    public List<Entry> Entries { get; set; } = new();
}

[ComplexType]
public class Entry
{
    public required string Key { get; set; }
    public string? Value { get; set; }
}
```

```csharp
// .NET 10, EF Core 10.0.12. On relational providers a complex collection must be JSON.
modelBuilder.Entity<Root>()
    .ComplexCollection(r => r.Groups, g => g.ToJson());
```

And the mutation, which is about as ordinary as load-mutate-save gets:

```csharp
// .NET 10, EF Core 10.0.12. Throws inside DetectChanges, before any SQL is sent.
var root = await db.Roots.SingleAsync(r => r.Id == 1);

var item = root.Groups[0].Items[0];
// item.Meta.Entries came back from the JSON column with two elements.
item.Meta = null;

await db.SaveChangesAsync();
```

Nulling `Meta` removes the containing complex entry. Removal triggers a reindex of the entries that sat after it, and that reindex assigns `Ordinal` on each surviving entry, which routes back into `GetEntry` for `Meta.Entries`. By then `Meta` is `null`, so the current-value branch above throws. With one element or none in `Entries` there is nothing to reindex and the same code saves cleanly, which is why the bug looks so arbitrary from the outside.

The reporter hit it on 10.0.9 and 10.0.10, a commenter re-confirmed it on 10.0.11 on 2026-08-15, and the issue is still open against 10.0.12, the current stable patch. It is provider independent, confirmed on both Npgsql and SQLite, because the crash sits in the shared change tracker above the provider abstraction. A provider bump on its own will not help.

## Fix, in detail

### Move to EF Core 11 RC1

[PR #38667](https://github.com/dotnet/efcore/pull/38667) merged into `main` on 2026-07-20 with milestone 11.0-rc1, so the fix is in the `11.0.0-rc.1.26425.128` packages today. The change is a reordering, not new logic: tracked entries are now returned before the CLR collection is null-checked, so reindexing during cleanup works even when the parent complex value has already gone to `null`.

```csharp
// EF Core 11, InternalEntryBase.InternalComplexCollectionEntry.GetEntry
// Must check tracked entries first to allow reindexing during cleanup when the parent is null.
var existingEntries = original ? _originalEntries : _entries;
if (existingEntries != null
    && (uint)ordinal < (uint)existingEntries.Count
    && existingEntries[ordinal] is { } existingEntry)
{
    return existingEntry;
}
```

```xml
<!-- .NET 10 or .NET 11. Bump the provider package to a matching 11.0.0-rc.1 too. -->
<PackageReference Include="Microsoft.EntityFrameworkCore" Version="11.0.0-rc.1.26425.128" />
```

EF Core 11 goes stable alongside .NET 11 in November 2026, so this is a short prerelease window rather than an open-ended one. It is still a prerelease, so read the rest of the EF Core 11 release notes before you ship it.

### Track 10.0.13 if you need a servicing release

The issue was reopened after the `main` fix specifically to track the `release/10.0` backport, and it carries the 10.0.13 milestone. If you are on a supported servicing band and cannot take a prerelease, this is the version to watch. Until then, upgrading inside 10.0.x will not clear it.

### Split the mutation across two SaveChanges

The trigger needs two or more elements in the nested collection at the moment the parent goes null. Shrinking the collection in its own save, so that both the current and original snapshots are empty before you null the parent, sidesteps the reindex entirely:

```csharp
// .NET 10, EF Core 10.0.12. Two round trips, no reindex over a null parent.
var root = await db.Roots.SingleAsync(r => r.Id == 1);
var item = root.Groups[0].Items[0];

item.Meta!.Entries.Clear();
await db.SaveChangesAsync();   // original values are accepted here

item.Meta = null;
await db.SaveChangesAsync();
```

This is the reporter's minimised trigger list turned inside out, not a guarantee from the EF team, and it costs you an extra round trip and the atomicity of a single save. Wrap both calls in an explicit transaction if the intermediate state is not one you want another reader to see, and confirm it against your own model before you rely on it.

### Write the JSON column without the change tracker

The crash lives entirely in change tracking, and `ExecuteUpdateAsync` never goes near it. EF Core 10 can target a JSON-mapped complex collection directly:

```csharp
// .NET 10, EF Core 10.0.12. Untracked read, then a set-based write.
var groups = await db.Roots
    .AsNoTracking()
    .Where(r => r.Id == id)
    .Select(r => r.Groups)
    .SingleAsync();

groups[0].Items[0].Meta = null;

await db.Roots
    .Where(r => r.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(r => r.Groups, groups));
```

You give up the usual `SaveChanges` guarantees for this write: no optimistic concurrency check, no `SaveChanges` interceptors, and the whole JSON document is rewritten rather than the single changed path. If you are reaching for this pattern more broadly, the tradeoffs are worked through in [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

## Lookalike messages that land on this page

Four other strings in `CoreStrings` mention complex collections and null values, and they have nothing to do with #38632.

**`The original entries cannot be accessed for the complex type collection '...' as it was originally 'null'.`** That is `ComplexCollectionEntryOriginalNull`, the sibling branch of the same `if`. The collection was `null` when the row was materialized. Reading original values on a collection that never had any is not a bug, it is a question with no answer. Refresh the entity or stop reading original values on that path.

**`The value for the property '...' cannot be set, because it's on the complex type collection element '...[N]' that contains a 'null' value.`** That is `ComplexCollectionNullElementSetter`. The collection exists, but one of its *elements* is `null`. A JSON array of `[{...}, null]` will do it. Filter nulls out before you save, or stop writing them into the array.

**`Complex entry original ordinal '-1' is invalid for property '...' as it's outside of the collection of length 'N'.`** A different bug with a different fix, covered in [Complex entry original ordinal '-1' is invalid when saving a ToJson complex collection](/2026/09/fix-complex-entry-original-ordinal-is-invalid-when-saving-a-tojson-complex-collection/). Note the wording: *original ordinal*, and *for property*. That one was fixed in 10.0.10, so unlike this one, upgrading inside 10.0.x does clear it.

**`The complex type collection '...' cannot be configured because complex value type collections are not supported.`** That is `ComplexValueTypeCollection`, thrown at model-building time, not at save time. Complex collection elements must be reference types; a `List<Coordinate>` where `Coordinate` is a `readonly record struct` will not map. Track [dotnet/efcore#31411](https://github.com/dotnet/efcore/issues/31411) if you need it.

If your error mentions `AS JSON option can be specified only for column of nvarchar(max)` instead, that is a SQL Server column-type problem rather than a change-tracker problem, and it is covered separately in [the Azure SQL AS JSON fix](/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/). For the general mapping story, [how to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) is the place to start.

## Sources

- [dotnet/efcore#38632: ComplexCollection + ToJson(): DetectChanges throws "must be initialized to a non-null value"](https://github.com/dotnet/efcore/issues/38632)
- [dotnet/efcore#38667: the fix, merged 2026-07-20](https://github.com/dotnet/efcore/pull/38667)
- [Complex types, EF Core documentation](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types)
- [EF Core releases and planning](https://learn.microsoft.com/en-us/ef/core/what-is-new/)
- [InternalEntryBase.InternalComplexCollectionEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.InternalComplexCollectionEntry.cs)
- [ChangeDetector.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/ChangeDetector.cs)
- [CoreStrings.resx, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/Properties/CoreStrings.resx)
