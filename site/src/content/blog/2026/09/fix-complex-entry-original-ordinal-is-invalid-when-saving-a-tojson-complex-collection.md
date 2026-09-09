---
title: "Fix: Complex entry original ordinal '-1' is invalid when saving a ToJson complex collection"
description: "Upgrade Microsoft.EntityFrameworkCore to 10.0.10 or later. Before that, growing a nested collection under a second ToJson complex property crashed SaveChanges."
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

Upgrade `Microsoft.EntityFrameworkCore` to 10.0.10 or later. Between 10.0.0 and 10.0.9, if an entity mapped two or more complex properties with `ToJson()` and a collection nested inside one of them gained an element between load and save, the change tracker forced every flattened complex entry into `Modified` or `Unchanged`, including the entries that were legitimately `Added`. An `Added` element has an original ordinal of `-1` by design, so the state transition ran straight into `ValidateOrdinal` and threw. The fix is a one-line guard in `InternalEntryBase`, it is provider independent, and there is no configuration you need to change after upgrading.

## The error in context

The exception surfaces from `SaveChanges` or `SaveChangesAsync`, before any SQL is sent:

```
System.InvalidOperationException: Complex entry original ordinal '-1' is invalid for property
'XWidget.XDeepData.XMiddleData[]XDeepItem[]XInnerEntry.Inner' as it's outside of the collection
of length '1'.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.InternalEntryBase.
      InternalComplexCollectionEntry.ValidateOrdinal(InternalComplexEntry entry, Boolean original)
```

The property path in the message is a flattened chain, not a C# expression. `[]` marks a hop through a complex collection, so `XWidget.XDeepData.XMiddleData[]XDeepItem[]XInnerEntry.Inner` reads as "the `Inner` collection on `XInnerEntry`, which lives inside a `XDeepItem` element, which lives inside a `XMiddleData` element, which hangs off `XDeepData` on `XWidget`". That path is your fastest route to the offending property.

Two details are worth checking before you go any further, because they distinguish this error from its lookalikes. First, the message says **original ordinal** and **for property**. The sibling message says **ordinal** and **for the collection**, and it has a different root cause. Second, the count at the end is the size of the *original* collection, the one EF loaded from the database, not the size of the collection you are trying to save.

## Why the ordinal is -1: what EF Core actually tracks for a complex collection

Complex collections arrived in EF Core 10, and on relational providers they must be mapped to a single JSON column with `ToJson()`. They cannot go to a separate table. That constraint matters here: because there is no table and no key, EF cannot identify an element by its primary key the way it does for an owned entity. It identifies an element by its **position in the array**.

The change tracker therefore keeps two positions per element, on `InternalComplexEntry`:

```csharp
// EF Core 10.0 / 11.0, src/EFCore/ChangeTracking/Internal/InternalComplexEntry.cs
public int Ordinal
{
    // -1 is used to indicate that the entry is deleted
    get;
    set { /* ... */ }
}

public int OriginalOrdinal
{
    // -1 is used to indicate that the entry is added
    get;
    set { /* ... */ }
}
```

`Ordinal` is where the element sits in the collection you are about to save. `OriginalOrdinal` is where it sat in the collection EF materialized. The two sentinel values are the whole story:

- An element you **deleted** has no position in the current collection, so its `Ordinal` is `-1`.
- An element you **added** has no position in the original collection, so its `OriginalOrdinal` is `-1`.

Every state transition into a tracked state runs the corresponding ordinal through a bounds check:

```csharp
// EF Core 10.0, InternalEntryBase.InternalComplexCollectionEntry.ValidateOrdinal
public readonly int ValidateOrdinal(InternalComplexEntry entry, bool original, List<InternalComplexEntry?> entries)
{
    var ordinal = original ? entry.OriginalOrdinal : entry.Ordinal;
    if (ordinal < 0 || ordinal >= entries.Count)
    {
        var property = entry.ComplexProperty;
        throw new InvalidOperationException(
            original
                ? CoreStrings.ComplexCollectionEntryOriginalOrdinalInvalid(/* ... */)
                : CoreStrings.ComplexCollectionEntryOrdinalInvalid(/* ... */));
    }
    // ...
}
```

That check is correct in isolation. `-1` really is out of bounds. The bug was that something upstream asked an `Added` entry to become `Modified`, and `Added -> Modified` is exactly the transition that validates the original ordinal. An entry that is meant to have `OriginalOrdinal == -1` was pushed through a code path that forbids it.

The upstream caller was `SetComplexCollectionModified`. When change detection decided a complex collection had changed, it walked `GetFlattenedComplexEntries()`, which returns every complex entry in the entity's whole nested graph, and set each one to `Modified` or `Unchanged`. Newly added elements got swept up with the rest.

## Minimal repro: two JSON complex properties and a nested collection that grows

The reporter of [dotnet/efcore#38299](https://github.com/dotnet/efcore/issues/38299) narrowed the trigger to four conditions that must hold together:

1. The entity maps two or more complex properties with `ToJson()`.
2. One of those JSON documents contains nested objects that themselves hold collections.
3. The element type of a nested collection declares two or more `List<T>` sub-collection properties.
4. One of those sub-collections grows between load and save.

Miss any one of them and the entity saves cleanly, which is why this looks intermittent in a real codebase. Here is the smallest model that satisfies all four:

```csharp
// .NET 10, EF Core 10.0.7, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.1
public class Widget
{
    public int Id { get; set; }
    public required FlatData Flat { get; set; }   // JSON column 1
    public required DeepData Deep { get; set; }   // JSON column 2
}

public class FlatData
{
    public string? Note { get; set; }
}

public class DeepData
{
    public List<MiddleData> Middle { get; set; } = [];
}

public class MiddleData
{
    public string Name { get; set; } = "";
    public List<InnerEntry> Inner { get; set; } = [];   // sub-collection 1
    public List<InnerEntry> Extra { get; set; } = [];   // sub-collection 2
}

public class InnerEntry
{
    public string Value { get; set; } = "";
}
```

The mapping uses `ComplexProperty` for the two roots and `ComplexCollection` for everything nested. `ToJson()` on the root is enough; the nested collections inherit the JSON mapping:

```csharp
// .NET 10, EF Core 10.0.7
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Widget>(b =>
    {
        b.ComplexProperty(w => w.Flat, c => c.ToJson());

        b.ComplexProperty(w => w.Deep, c =>
        {
            c.ToJson();
            c.ComplexCollection(d => d.Middle, m =>
            {
                m.ComplexCollection(x => x.Inner);
                m.ComplexCollection(x => x.Extra);
            });
        });
    });
}
```

And the two lines that blow up:

```csharp
// .NET 10, EF Core 10.0.7. Throws on SaveChangesAsync, before any SQL is generated.
var widget = await db.Widgets.SingleAsync(w => w.Id == 1);
widget.Deep.Middle[0].Inner.Add(new InnerEntry { Value = "added" });
await db.SaveChangesAsync();
```

Nothing here is exotic. This is the shape you land on the moment you take Microsoft's own advice and move a JSON-mapped owned entity graph over to complex types, which is why the reports cluster around teams doing that migration. If you are weighing that move, [complex types vs owned entities in EF Core 11](/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) covers the tradeoffs, and the [step-by-step mapping guide](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) covers the configuration.

## Fix, in detail

### Upgrade to EF Core 10.0.10 or later

This is the real fix, shipped in [PR #38373](https://github.com/dotnet/efcore/pull/38373) against `release/10.0`. Bump every EF Core package in lockstep, including the provider:

```xml
<!-- .NET 10. Bump the provider package to a matching 10.0.x too. -->
<PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.12" />
<PackageReference Include="Microsoft.EntityFrameworkCore.Relational" Version="10.0.12" />
```

The change teaches the recursive walk to leave `Added` entries alone:

```csharp
// EF Core 10.0.10+, InternalEntryBase.SetComplexCollectionModified
if (recurse)
{
    var newElementState = isModified ? EntityState.Modified : EntityState.Unchanged;
    foreach (var complexEntry in GetFlattenedComplexEntries())
    {
        // Added elements represent pending additions with no original ordinal, so forcing them to
        // Modified/Unchanged is incorrect and would fail the original ordinal validation. Leave their
        // state (computed by change detection) untouched, mirroring the bulk state-change logic in
        // InternalComplexCollectionEntry.SetState.
        if (!UseOldBehavior38299
            && complexEntry.EntityState is EntityState.Added)
        {
            continue;
        }

        complexEntry.SetEntityState(newElementState, modifyProperties: true);
    }
}
```

Two things follow from reading the patch. The guard sits in the shared change tracker, above the provider abstraction, so it fixes SQL Server, Npgsql, and SQLite in one go; if you were hoping a provider bump alone would help, it will not. And the same guard is present in the EF Core 11 codebase without the `UseOldBehavior38299` flag, so an upgrade to EF Core 11 also clears it.

### If you are pinned below 10.0.10, write the JSON column without the change tracker

The crash lives entirely in change tracking. `ExecuteUpdateAsync` never goes near it, and EF Core 10 can target a JSON-mapped complex property directly:

```csharp
// .NET 10, EF Core 10.0.7. Untracked read, then a set-based write.
var deep = await db.Widgets
    .AsNoTracking()
    .Where(w => w.Id == id)
    .Select(w => w.Deep)
    .SingleAsync();

deep.Middle[0].Inner.Add(new InnerEntry { Value = "added" });

await db.Widgets
    .Where(w => w.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(w => w.Deep, deep));
```

You lose the usual `SaveChanges` guarantees in exchange: no optimistic concurrency token check, no interceptors on the write, and the whole JSON document is rewritten rather than the single changed path. Verify the translation against your provider before you commit to it, and if you are reaching for `ExecuteUpdate` more broadly, the tradeoffs are worked through in [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).

### If you can change the model, break one of the four trigger conditions

Condition 1 is the cheapest to remove. The walk only produces the bad `Added` and `-1` pairing when the entity carries more than one JSON complex property, so mapping the second one with table splitting instead takes it out of the picture:

```csharp
// .NET 10, EF Core 10.0.7. Flat becomes Flat_Note on the Widgets table.
b.ComplexProperty(w => w.Flat);   // no ToJson()
```

This needs a migration and it changes your storage shape, so treat it as a last resort rather than a quick unblock. Condition 3 is the other soft target: if the nested element type only declares one `List<T>`, the shape falls outside the reported trigger. Neither of these is a guarantee from the EF team, they are the reporter's minimised trigger list turned inside out, so confirm against your own model before you rely on either.

## Gotchas and variants: the other ordinal errors in this family

Three other messages come out of the same corner of the change tracker and get mistaken for this one.

**`Complex entry ordinal '-1' is invalid for the collection '...' as it's outside of the collection of length 'N'.`** Note the wording: *ordinal*, not *original ordinal*, and *for the collection*, not *for property*. This one fires when you move an entity from `Deleted` back to `Unchanged`, which is the classic hand-rolled soft-delete dance. It was [dotnet/efcore#37724](https://github.com/dotnet/efcore/issues/37724), fixed in **10.0.6** by restoring the current ordinal from the original one:

```csharp
// EF Core 10.0.6+, InternalComplexEntry.SetEntityState
if (oldState is EntityState.Detached or EntityState.Deleted
    && newState is not EntityState.Detached and not EntityState.Deleted)
{
    if (!UseOldBehavior37724 && Ordinal == -1)
    {
        Ordinal = OriginalOrdinal;
    }

    ContainingEntry.ValidateOrdinal(this, original: false);
}
```

If you are writing soft delete by flipping `EntityState` by hand, consider not doing that at all: [named query filters](/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) express the same intent without touching the change tracker.

**`Index was out of range. Must be non-negative and less than the size of the collection.`** An `ArgumentOutOfRangeException`, not an `InvalidOperationException`, thrown after the database update already succeeded, during the accept-changes phase. That is [dotnet/efcore#37585](https://github.com/dotnet/efcore/issues/37585), triggered by removing an element from a complex collection whose elements contain their own lists. Also fixed in **10.0.6**.

**`The complex type collection '...' must be initialized to a non-null value before the elements can be accessed.`** Setting a nullable complex property that contains a collection to `null` on a tracked entity, where the nested collection has two or more items. That is [dotnet/efcore#38632](https://github.com/dotnet/efcore/issues/38632), milestoned for **10.0.13**. As of EF Core 10.0.12, the latest stable patch, it is still open, so if this is the message you are getting, upgrading will not help yet.

There is also a case where the ordinal error is genuinely your bug rather than EF's. `ComplexCollectionEntry` exposes an indexer and `GetOriginalEntry(int)`, and both validate:

```csharp
// .NET 10, EF Core 10.0.12. Throws if the collection has fewer than 4 elements.
var entry = db.Entry(widget).ComplexCollection(w => w.Deep.Middle)[3];

// Throws if the collection loaded from the database had fewer than 4 elements,
// even when the current collection is longer.
var original = db.Entry(widget).ComplexCollection(w => w.Deep.Middle).GetOriginalEntry(3);
```

The second line is the trap. Reading an original entry at an index that only exists after your in-memory additions produces the same *original ordinal* wording as the bug above, with a positive ordinal instead of `-1`. If the ordinal in your message is not `-1`, you are looking at your own index arithmetic.

## What does the Microsoft.EntityFrameworkCore.Issue38299 switch actually do?

Every one of these patches ships behind an `AppContext` quirk switch on the `release/10.0` branch:

```csharp
// EF Core 10.0.x, InternalEntryBase.InternalComplexCollectionEntry.cs
internal static readonly bool UseOldBehavior37724 =
    AppContext.TryGetSwitch("Microsoft.EntityFrameworkCore.Issue37724", out var enabled) && enabled;

internal static readonly bool UseOldBehavior38299 =
    AppContext.TryGetSwitch("Microsoft.EntityFrameworkCore.Issue38299", out var enabled) && enabled;
```

Read the direction carefully, because it is the reverse of what the naming suggests to most people. Setting the switch to `true` **restores the old, broken behaviour**. It exists so that a team who built a workaround on top of the bug can take a patch release without their workaround breaking. It is not a fix, and turning it on will reintroduce the exact exception you came here for.

If you do need to pin the old behaviour temporarily, it goes in the project file rather than in code, so it is set before any EF type is loaded:

```xml
<!-- .NET 10. Restores pre-10.0.10 behaviour. Do not use this to "fix" the crash. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="Microsoft.EntityFrameworkCore.Issue38299" Value="true" />
</ItemGroup>
```

The switches double as a changelog. `grep` for `UseOldBehavior` in `src/EFCore/ChangeTracking/Internal/` and you get the full list of what moved in complex collection tracking across the 10.0 patch line: `37724` and `38299` on `InternalEntryBase`, `37585` and `38632` inside the nested `InternalComplexCollectionEntry` struct.

Because all four bugs live in change tracking rather than SQL generation, none of them show up in a query log, a profiler trace, or a `dotnet ef migrations script` diff. The first signal is always an exception at `SaveChanges` with a `ValidateOrdinal` frame near the top of the stack. If you see that frame, stop reading your model configuration and go straight to your package versions.

## Related

- [Complex types vs owned entities in EF Core 11: which should you pick?](/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)
- [How to map a complex type instead of an owned entity in EF Core 11](/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/)
- [How to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)
- [Fix: AS JSON option can be specified only for column of nvarchar(max) type in WITH clause](/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/)
- [How to use named query filters for soft delete and multi-tenancy in EF Core 11](/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)

## Sources

- [dotnet/efcore#38299: ComplexProperty ToJson(): SaveChangesAsync throws "ordinal -1 is invalid" when nested sub-collection grows](https://github.com/dotnet/efcore/issues/38299)
- [dotnet/efcore#38373: the fix, against release/10.0](https://github.com/dotnet/efcore/pull/38373)
- [dotnet/efcore#37724: Can't change state of entity with complex collection](https://github.com/dotnet/efcore/issues/37724)
- [dotnet/efcore#37585: Deleting an item from a ComplexCollection that contains an array results in Error](https://github.com/dotnet/efcore/issues/37585)
- [dotnet/efcore#38632: DetectChanges throws "must be initialized to a non-null value"](https://github.com/dotnet/efcore/issues/38632)
- [Complex types, EF Core documentation](https://learn.microsoft.com/en-us/ef/core/modeling/complex-types)
- [InternalComplexEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalComplexEntry.cs)
- [InternalEntryBase.InternalComplexCollectionEntry.cs, dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.InternalComplexCollectionEntry.cs)
