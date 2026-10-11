---
title: "How to check whether an entity is already tracked by the DbContext before attaching it in EF Core"
description: "Use DbSet.Local.FindEntry(key) to ask the change tracker whether an entity with a given key is tracked, without a database round trip or a scan. Why Entry(entity).State lies for this question, why Find queries, and a tested AttachOrMerge helper for EF Core 10."
pubDate: 2026-10-11
template: how-to
tags:
  - "ef-core"
  - "dotnet-10"
  - "csharp"
  - "change-tracker"
  - "how-to"
---

**Short answer:** call `db.Set<T>().Local.FindEntry(id)`. It returns the tracked `EntityEntry<T>` for that primary key, or `null` if nothing with that key is tracked, and it never queries the database. If it returns an entry, copy your values onto it with `entry.CurrentValues.SetValues(incoming)` instead of attaching. If it returns `null`, `Attach` or `Update` is safe. For composite keys use `Local.FindEntryUntyped([part1, part2])`. Do not use `db.Entry(incoming).State == EntityState.Detached` for this check: it only tells you about that one object instance, not about the key.

Everything below was run against EF Core 10.0.12 (`Microsoft.EntityFrameworkCore.Sqlite` 10.0.12) on .NET 10 SDK 10.0.302. The `LocalView<T>.FindEntry` family was added in EF Core 8 ([dotnet/efcore#29686](https://github.com/dotnet/efcore/pull/29686)), so the same code works on EF Core 8, 9, 10 and the EF Core 11 release candidates.

## Why "is it tracked?" is a question about keys, not objects

The change tracker keeps an identity map: for each entity type, one tracked CLR instance per primary key value. When you call `Attach`, `Update`, or `Add` with a second instance whose key is already in the map, EF Core throws the familiar [`The instance of entity type cannot be tracked because another instance with the same key value is already being tracked`](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/) exception.

So the question you actually need answered before attaching is "does the identity map already hold *any* instance with this key?" That is a different question from "is *this* instance tracked?", and the most commonly suggested check answers the second one.

## A minimal repro of the trap

```csharp
// .NET 10, EF Core 10.0.12, Microsoft.EntityFrameworkCore.Sqlite
using var db = new Shop(options);

var tracked  = db.Customers.First(c => c.Id == 1);           // tracked, Unchanged
var incoming = new Customer { Id = 1, Name = "changed" };    // e.g. deserialized from a request

Console.WriteLine(db.Entry(tracked).State);   // Unchanged
Console.WriteLine(db.Entry(incoming).State);  // Detached  <-- looks "safe"

db.Attach(incoming);
// InvalidOperationException: The instance of entity type 'Customer' cannot be tracked
// because another instance with the same key value for {'Id'} is already being tracked.
```

`db.Entry(incoming)` happily returns an entry in the `Detached` state, because `incoming` really is not tracked. It does not throw, and it does not start tracking the object (the change tracker still held exactly one entry afterwards in my run). Code that does `if (db.Entry(x).State == EntityState.Detached) db.Attach(x);` passes the check and then throws on the next line. That pattern is fine for "did I already attach this exact object?", and wrong for disconnected scenarios where the object came from a DTO, a cache, or a JSON body.

## The options, measured

I wired a counter onto `CoreEventId.DetectChangesStarting` and a `DbCommandInterceptor` that counts executed readers, then ran every candidate against a context tracking one `Customer`:

| Check | Answers the key question? | `DetectChanges` passes | DB queries |
| --- | --- | --- | --- |
| `db.Entry(incoming).State` | No, only that instance | 0 | 0 |
| `db.ChangeTracker.Entries<Customer>().Any(e => e.Entity.Id == 1)` | Yes, by linear scan | 1 | 0 |
| `db.Customers.Find(1)` (tracked) | Yes, returns the tracked instance | 0 | 0 |
| `db.Customers.Find(2)` (not tracked) | Not a check: loads the row | 0 | 1 |
| `db.Customers.Local.FindEntry(1)` | Yes, by identity-map lookup | 1 (from the `Local` getter) | 0 |
| `cachedLocal.FindEntry(1)` | Yes | 0 | 0 |

A few things stand out.

**`Find` is not a tracking check.** It looks in the identity map first, which is why the tracked case costs nothing, but when the key is not tracked it goes to the database and starts tracking whatever it finds. Using `Find` to decide whether to attach means you either load a row you did not want, or you get back a tracked instance and then attach your own copy on top of it, which throws.

**`ChangeTracker.Entries<T>()` works but scans.** It runs `DetectChanges` first and then enumerates every tracked entry of that type. With ten entities that is noise. With a long-lived context in a desktop app or a batch job holding tens of thousands of entries, doing it once per incoming item is quadratic. (On EF Core 11 the [`GetEntriesForState` API](/2026/04/efcore-11-changetracker-getentriesforstate/) skips the `DetectChanges` pass but is still an enumeration.)

**`Local.FindEntry` is the purpose-built API.** It resolves the key through the same identity map that `Attach` checks, so it gives exactly the answer `Attach` will act on. The one `DetectChanges` in the table comes from the `DbSet<T>.Local` property getter, not from `FindEntry`: when I cached the `LocalView<Customer>` in a variable and called `FindEntry` on it, the counter stayed at zero. The [API docs](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentry) say the same thing and recommend reusing the `Local` object for repeated lookups.

## Check, then attach or merge

Here is the procedure for a disconnected update, the scenario where this question usually comes up:

1. Get the local view once: `var local = db.Customers.Local;`.
2. Look up the key with `local.FindEntry(incoming.Id)`.
3. If an entry comes back, copy the incoming values onto the tracked instance with `entry.CurrentValues.SetValues(incoming)`. EF Core marks only the properties whose values actually changed as modified.
4. If `null` comes back, nothing holds that key, so `Update(incoming)` (or `Attach` plus explicit `IsModified` flags) is safe.
5. Call `SaveChanges` once at the end.

As a helper:

```csharp
// .NET 10, EF Core 10.0.12
static Customer AttachOrMerge(Shop db, Customer incoming)
{
    var existing = db.Customers.Local.FindEntry(incoming.Id);
    if (existing is null)
    {
        db.Customers.Update(incoming);   // nothing tracked with this key
        return incoming;
    }

    existing.CurrentValues.SetValues(incoming);  // merge into the tracked instance
    return existing.Entity;
}
```

Running it against the context that already tracks customer 1:

```text
Helper: same=True state=Modified name=merged modifiedProps=Name
```

The returned object is the instance the context was already tracking, its state moved from `Unchanged` to `Modified`, and only `Name` is flagged, so the generated `UPDATE` touches one column. Return the tracked instance to callers rather than `incoming`: after the merge, `incoming` is still a detached object that EF Core knows nothing about.

## A generic version for any entity type

You rarely want one helper per entity. `FindEntryUntyped` takes the key values as `IEnumerable<object?>` in key order, and the model tells you which properties make up the primary key:

```csharp
// .NET 10, EF Core 10.0.12
static EntityEntry<T>? FindTrackedEntry<T>(DbContext db, T entity) where T : class
{
    var key = db.Model.FindEntityType(typeof(T))!.FindPrimaryKey()!;
    var entry = db.Entry(entity);   // Detached entry, does not start tracking
    var keyValues = key.Properties
        .Select(p => entry.Property(p.Name).CurrentValue)
        .ToArray();

    return db.Set<T>().Local.FindEntryUntyped(keyValues);
}

static bool IsTracked<T>(DbContext db, params object?[] keyValues) where T : class
    => db.Set<T>().Local.FindEntryUntyped(keyValues) is not null;
```

Reading the key through `db.Entry(entity).Property(...)` instead of reflection means shadow-property keys and keys mapped to fields work without special cases. In the repro, `FindTrackedEntry(db, incoming)` found the tracked customer even though `incoming` itself was a different object, which is exactly the behaviour the `Entry(...).State` check lacks.

## Gotchas that will bite you

### Composite keys need `FindEntryUntyped`, not `FindEntry`

`FindEntry` is generic, `FindEntry<TKey>(TKey keyValue)`. Pass it an array or a list and the compiler happily binds `TKey` to `object[]` or `List<object?>`, then EF Core treats the whole thing as a single key value:

```csharp
// .NET 10, EF Core 10.0.12. OrderLine has HasKey(x => new { x.OrderId, x.LineNo })
db.OrderLines.Local.FindEntry(new object[] { 10, 1 });
// ArgumentException: Entity type 'OrderLine' is defined with a 2-part composite key,
// but 1 values were passed to the 'Find' method.

db.OrderLines.Local.FindEntryUntyped([10, 1]);   // works, returns the tracked entry
```

I also tried a variable typed as `IEnumerable<object?>`, hoping to hit a non-generic overload. Same exception: there is no `FindEntry(IEnumerable<object?>)` overload for primary keys, the untyped version has its own name.

### The key type must match exactly

`FindEntry<TKey>` does not convert. With an `int` key:

```text
FindEntry(1L): ArgumentException: Property 'Customer.Id' is of type 'int' but the generic type provided is of type 'long'.
```

`FindEntryUntyped` is no more forgiving, it checks the boxed type instead:

```text
FindEntryUntyped([1L]): ArgumentException: The 'FindEntry' or 'GetEntries' method was passed a 'long' value for the 'Id' property, when a 'int' value was expected.
```

This shows up when the key arrives from a route value or a generic repository typed as `long` or `object`. Convert to the CLR type of the key property (`key.Properties[i].ClrType`) before the call.

### Deleted entities are still tracked

After `db.Customers.Remove(customer2)`:

```text
FindEntry(2) after Remove: Deleted; Local.Count=1; Find(2)=entity
```

The local *collection* hides `Deleted` entities (`Local.Count` dropped to 1, as [the docs describe](https://learn.microsoft.com/en-us/ef/core/change-tracking/entity-entries#the-local-view)), but `FindEntry` still returns the entry, and so does `Find`. That is correct for our purpose, since the key is still in the identity map and `Attach` would still throw. But if your merge logic assumes "found" means "alive", check `entry.State` before calling `SetValues`, or you will resurrect property changes onto a row that `SaveChanges` is about to delete.

### "Not tracked" does not mean "exists in the database"

When `FindEntry` returns `null`, the helper calls `Update`, which marks every property as modified and generates an `UPDATE`. For a key that does not exist in the table, `SaveChanges` affects zero rows and throws `DbUpdateConcurrencyException`. In the repro, `AttachOrMerge(db, new Customer { Id = 3 })` left the entity in `Modified`, not `Added`. If the incoming object can be new, decide that from your own data (a default key, a version column, an explicit flag) before choosing between `Add` and `Update`. Another option is to skip tracking altogether and use [`ExecuteUpdate`](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) for the write.

### Default key values on store-generated keys

Attaching a `Customer` whose `Id` is `0` does not throw and does not collide: EF Core sees an unset store-generated key and tracks the entity as `Added` with a temporary value. Checking `FindEntry(0)` first tells you nothing useful there. Branch on `entry.IsKeySet` (or `id == default`) before doing the lookup.

### Lookups by alternate key or foreign key

`LocalView<T>` also has `FindEntry<TProperty>(string propertyName, TProperty value)` and `GetEntries(...)` for non-primary-key lookups, for example `Local.FindEntry(nameof(Customer.Email), email)`. These are fast when the property is an alternate key or foreign key, because EF Core already maintains lookups for those. For ordinary properties they fall back to scanning the tracked entries. In the repro, `Local.FindEntry(nameof(Customer.Name), "a")` returned the right entry, but `Name` is not a key, so it was a scan.

### Turning off AutoDetectChanges

With `db.ChangeTracker.AutoDetectChangesEnabled = false`, neither the `Local` getter nor `Entries<T>()` triggers `DetectChanges` (counter at 0 for both). Identity-map lookups are not affected, since keys cannot change on a tracked entity. If you turn auto-detection off for a bulk import loop, call `db.ChangeTracker.DetectChanges()` yourself before `SaveChanges` when you mutate tracked entities directly.

## When the better fix is not tracking at all

If the check is in your code because a read earlier in the same context tracked the entity you now want to update, the cleaner fix is often upstream. Read with `AsNoTracking()` when the result is only displayed or mapped to a DTO (the [AsNoTracking vs AsNoTrackingWithIdentityResolution comparison](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) covers which one to pick), and keep contexts short-lived so that one unit of work does not inherit another's tracked entities. `FindEntry` is the right tool when one context legitimately sees the same key from two directions: a desktop app with a long-lived context, a batch job that merges records from several files, or a graph that arrives partially overlapping entities you already loaded.

The same lookup is useful in tests. If you replaced the provider with a fake and your assertions depend on what is tracked, `Local.FindEntry` reads the real identity map, which keeps you honest in the way described in [mocking a DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

### Read next

- [Fix: The instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)
- [EF Core 11 adds GetEntriesForState to skip DetectChanges](/2026/04/efcore-11-changetracker-getentriesforstate/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)

## Sources

- [`LocalView<TEntity>.FindEntry` method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentry), Microsoft Learn.
- [`LocalView<TEntity>.FindEntryUntyped` method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.localview-1.findentryuntyped), Microsoft Learn.
- [Accessing tracked entities](https://learn.microsoft.com/en-us/ef/core/change-tracking/entity-entries), EF Core docs (Entry, Find, Entries, the local view and its `DetectChanges` cost).
- [Lookup entities by primary key, alternate key, or foreign key](https://github.com/dotnet/efcore/pull/29686), dotnet/efcore PR #29686 (merged December 2022, shipped in EF Core 8).
- [Disconnected entities](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities), EF Core docs.
