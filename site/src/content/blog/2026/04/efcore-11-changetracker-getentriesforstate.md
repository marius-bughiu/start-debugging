---
title: "EF Core 11 Adds GetEntriesForState to Skip DetectChanges"
description: "EF Core 11 Preview 3 introduces ChangeTracker.GetEntriesForState, a state-filtered enumerator that avoids an extra DetectChanges pass in hot paths like SaveChanges interceptors and audit hooks."
pubDate: 2026-04-16
tags:
  - "ef-core"
  - "dotnet-11"
  - "performance"
  - "csharp"
---

`ChangeTracker.Entries()` has one quirk that bites every app that uses it in a hot path: it implicitly calls `DetectChanges()` before returning. For an audit interceptor or a pre-`SaveChanges` validator, that cost is paid again on the actual save, doubling the scan over every tracked entity. [EF Core 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) introduces `GetEntriesForState` specifically to remove that redundant pass.

## The API shape

The new method lives on `ChangeTracker` alongside `Entries()` and accepts four flags, one per `EntityState` value that the scanner walks:

```csharp
IEnumerable<EntityEntry> GetEntriesForState(
    bool added,
    bool modified,
    bool deleted,
    bool unchanged);
```

It skips `DetectChanges` entirely and returns entries whose current state already matches the requested flags. You lose automatic change detection for the call, which is exactly the trade you want in code that is about to trigger a save (and therefore detection) a few lines later.

The feature tracks as [dotnet/efcore #37847](https://github.com/dotnet/efcore/issues/37847) and shipped in the Preview 3 EF Core bits.

## Auditing without the double scan

A typical audit interceptor pulls modified and deleted entries out of the tracker and writes them to an audit table. With `Entries()`, that interceptor forces a full detection pass on potentially thousands of entities, then `SaveChanges` does it again:

```csharp
public override InterceptionResult<int> SavingChanges(
    DbContextEventData eventData,
    InterceptionResult<int> result)
{
    var context = eventData.Context!;

    // In EF Core 10: this call runs DetectChanges() even though
    // SaveChanges is about to run it again a moment later.
    foreach (var entry in context.ChangeTracker
        .GetEntriesForState(added: false, modified: true, deleted: true, unchanged: false))
    {
        WriteAudit(entry);
    }

    return result;
}
```

Because `SaveChanges` always runs its own detection pass, the audit loop now reads the freshly computed state without paying for it twice.

## When to reach for it

`GetEntriesForState` is not a drop-in replacement for `Entries()`. Use it when you already know which states matter and a detection pass is scheduled to happen anyway. Good fits:

- `SaveChangesInterceptor` implementations.
- Outbox publishers that run inside the same transaction as the save.
- Soft-delete rewriters that only need entries in `Deleted`.
- Validators that accept "slightly stale" results in exchange for throughput.

Avoid it for code that must see every pending change before save, for example a UI that renders "you have 3 unsaved edits". In that case `Entries()` is still correct because its detection pass is the whole point.

## Measuring the win

The impact grows with tracked-entity count. For a context holding 10,000 entities with complex value objects, `Entries()` runs a per-property scan to decide whether anything changed. Replacing an audit read of `Entries().Where(e => e.State != EntityState.Unchanged)` with `GetEntriesForState(false, true, true, false)` trims one full pass, which is typically 10-30% of total `SaveChanges` time in audit-heavy OLTP paths.

As always, measure: if your context rarely holds more than a few dozen entities, the API is still nicer, but the perf delta is noise. The full list of EF Core changes shipping in this preview is in the [EF Core 11 Preview 3 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md).
