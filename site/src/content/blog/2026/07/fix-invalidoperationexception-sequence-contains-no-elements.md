---
title: "Fix: System.InvalidOperationException: Sequence contains no elements"
description: "This exception means you called .First() or .Single() on an empty sequence. Use FirstOrDefault/SingleOrDefault and null-check, or guard the query, or fix why the source is empty."
pubDate: 2026-07-21
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "linq"
  - "ef-core"
---

`System.InvalidOperationException: Sequence contains no elements` means you called `.First()`, `.Single()`, `.Last()`, or one of their aggregate cousins (`.Average()`, `.Max()`, `.Min()`) on a sequence that turned out to be empty. The operator promised to return an element and there was none, so it threw. The fix is to decide what "empty" should mean for that call: if empty is a normal outcome, switch to `.FirstOrDefault()` / `.SingleOrDefault()` and handle the `null` (or default) you get back; if empty is a bug, fix the query or the data so the sequence is never empty at that point. This is verified against .NET 11, C# 14, and EF Core 11.0.0, but the message and behavior have been stable since LINQ shipped in .NET Framework 3.5, so the guidance applies to every version.

## The error in context

The full exception, thrown from inside `System.Linq`, looks like this:

```
System.InvalidOperationException: Sequence contains no elements
   at System.Linq.ThrowHelper.ThrowNoElementsException()
   at System.Linq.Enumerable.First[TSource](IEnumerable`1 source)
   at MyApp.OrderService.GetLatest() in /src/OrderService.cs:line 42
```

The giveaway is the top frame: `System.Linq.ThrowHelper.ThrowNoElementsException`. If you see that in the stack, an element-returning LINQ operator ran against an empty source. The exact wording matters for search, because LINQ throws four closely related messages from the same class and they mean different things:

- `Sequence contains no elements` -- `.First()`, `.Single()`, `.Last()` (no predicate) on an empty source.
- `Sequence contains no matching element` -- `.First(predicate)`, `.Single(predicate)`, `.Last(predicate)` where nothing matched.
- `Sequence contains more than one element` -- `.Single()` on a source with two or more items.
- `Sequence contains more than one matching element` -- `.Single(predicate)` where more than one item matched.

This post is about the first one. The others are covered in the variants section, because landing on the wrong one wastes your time.

## Why this happens

`.First()` and `.Single()` are contract operators: their return type is a non-nullable `TSource`, so they have no way to signal "nothing here" except by throwing. When the source is empty, there is no element to hand back, and returning `default(TSource)` would be a lie for a reference type (you would get `null` where the signature promised a value). So the runtime throws `InvalidOperationException` instead. That is a deliberate design choice, not a bug: the `*OrDefault` variants exist precisely for the case where empty is acceptable.

The confusing part is that the sequence is often empty for reasons that are invisible at the call site. A `Where` filter upstream removed every row. A database table has no matching record yet. A collection was cleared, or was never populated because an earlier `await` failed silently. The exception fires on the `.First()` line, but the real cause is three lines (or three method calls) earlier. That is why "just wrap it in try/catch" is rarely the right instinct: you want to know why the sequence is empty, not just swallow the symptom.

## Minimal repro

The smallest code that throws it:

```csharp
// .NET 11, C# 14
var numbers = new List<int>();     // empty
int first = numbers.First();       // System.InvalidOperationException: Sequence contains no elements
```

The same thing happens when a filter eliminates everything, which is the far more common real-world shape:

```csharp
// .NET 11, C# 14
var orders = new List<Order>
{
    new(Id: 1, Status: "shipped"),
    new(Id: 2, Status: "shipped"),
};

// No pending orders exist, so the filtered sequence is empty.
Order next = orders.First(o => o.Status == "pending");
// System.InvalidOperationException: Sequence contains no matching element
```

Note the second message is the `no matching element` variant, because a predicate was supplied. Both come from the same family of bugs: you assumed at least one element would be there, and it was not.

## Fix, in detail

Work through these in order. The first two cover almost every real occurrence.

### 1. Use FirstOrDefault / SingleOrDefault and handle the empty case

If an empty sequence is a legitimate outcome (no rows yet, an optional lookup, a search that can miss), switch to the `*OrDefault` overload and check what you get back:

```csharp
// .NET 11, C# 14
Order? next = orders.FirstOrDefault(o => o.Status == "pending");
if (next is null)
{
    // No pending order. Handle it: return early, use a fallback, log, whatever fits.
    return;
}
Process(next);
```

`FirstOrDefault` returns `default(TSource)` when the sequence is empty: `null` for a reference type, `0` for `int`, `default` for a struct. On a nullable-annotated codebase (`<Nullable>enable</Nullable>`, the default in new .NET 11 templates), the compiler types the result as `Order?` and will nag you until you null-check it, which is exactly the safety you want. Do not skip the check: replacing `First` with `FirstOrDefault` and then immediately dereferencing the result just trades `InvalidOperationException` for a `NullReferenceException` one line later. If the nullable warnings feel noisy, that is the compiler pointing at the real work, and it ties directly into [CS8618 and non-nullable properties](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/).

Since .NET 6 there is also an overload that lets you supply your own default, which is cleaner than a separate null-check when you have a sensible fallback:

```csharp
// .NET 11, C# 14 -- FirstOrDefault(predicate, defaultValue) added in .NET 6
Order next = orders.FirstOrDefault(o => o.Status == "pending", Order.None);
```

### 2. Guard the sequence before you call First

When you genuinely need the first element but only if one exists, check emptiness first. For an in-memory collection, `Count` or `Any()` is enough:

```csharp
// .NET 11, C# 14
if (orders.Count > 0)
{
    Order first = orders.First();   // safe: we know it is non-empty
    Process(first);
}
```

Prefer `Count` (or `Count > 0`) for anything that implements `ICollection<T>`, such as `List<T>` or an array, because it is O(1). Use `.Any()` for a lazily-evaluated `IEnumerable<T>` where you cannot cheaply get a count. Do not write `if (orders.Count() > 0)` on a lazy sequence: `Count()` enumerates the entire thing, whereas `Any()` stops after the first element.

### 3. Fix why the sequence is empty

Sometimes empty is the bug, not a valid state. If `orders.First(o => o.Status == "pending")` should always find a row and does not, the real fix is upstream: a filter that is too strict, a case-sensitivity mismatch (`"Pending"` vs `"pending"`), a join that dropped rows, or data that was never inserted. Reach for a `*OrDefault` here only after you have confirmed the sequence is allowed to be empty. Swallowing a "this should never be empty" case with `FirstOrDefault` hides a genuine data or logic error and moves the crash somewhere harder to diagnose.

### 4. For aggregates, use a nullable overload or DefaultIfEmpty

`.Average()`, `.Max()`, `.Min()`, and `.Sum()` share the same trap. `.Average()` and the value-type `.Max()`/`.Min()` throw `Sequence contains no elements` on an empty source (`.Sum()` returns 0, which is its own surprise). Two clean fixes:

```csharp
// .NET 11, C# 14
var prices = new List<int>();

// Option A: project to a nullable so the aggregate returns null instead of throwing.
double? avg = prices.Average(p => (int?)p);   // null when empty, no exception

// Option B: supply a fallback element before aggregating.
int max = prices.DefaultIfEmpty(0).Max();     // 0 when empty
```

`DefaultIfEmpty` is the general-purpose escape hatch: it yields a single default element when the source is empty, so any downstream operator, including `.First()`, sees at least one item.

## Gotchas and variants

A few situations produce this exception, or a close relative, for reasons the message does not spell out:

- **`no matching element` is a different message with the same cause.** `.First()` on an empty source says `Sequence contains no elements`; `.First(predicate)` that matches nothing says `Sequence contains no matching element`. They are thrown by different helpers but the fix is identical: `FirstOrDefault(predicate)` and a null-check. If your source has rows but the predicate never matches, the sequence handed to `First` is effectively empty.

- **`.Single()` throws two different messages.** `.Single()` guarantees *exactly one* element, so it can fail two ways: `Sequence contains no elements` when there are zero, and `Sequence contains more than one element` when there are two or more. If you are seeing the "more than one" variant, `FirstOrDefault` is not the fix; either your uniqueness assumption is wrong (a missing `WHERE` clause, a duplicate key) or you should be using `First` because you only want one of several. Use `Single` only when a second match would itself be a bug worth throwing over.

- **EF Core throws the same thing from `First`/`Single`, and their async versions too.** `dbContext.Orders.First(o => o.Id == id)` translates to `SELECT TOP(1)` and throws `Sequence contains no elements` when no row matches. `FirstAsync` and `SingleAsync` throw identically. The fix is `FirstOrDefaultAsync` / `SingleOrDefaultAsync` plus a null-check. Because these run against the database, an empty result is often normal (the row was deleted, the id is wrong), so the `*OrDefault` async overloads are usually what you want. See [IEnumerable vs IAsyncEnumerable vs IQueryable](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) for why the LINQ operator behaves the same whether it runs in memory or as SQL.

- **`FirstOrDefault` on a value-type sequence returns 0, not null.** For `List<int>`, `FirstOrDefault()` on an empty list returns `0`, which is a valid `int` and indistinguishable from a real first element of `0`. If you need to tell "empty" apart from "the first value happens to be the default," project to a nullable (`.Select(x => (int?)x).FirstOrDefault()`) or guard with `.Any()` instead of relying on the default sentinel.

- **The empty sequence can come from a mistranslated query, not missing data.** In EF Core, a query that silently evaluates part of a filter client-side, or one that could not be translated at all, can return a different (often empty) result set than you expect. If a `First` against the database throws and you are sure the row exists, check whether the query translated as you intended. That failure mode is covered in [the LINQ expression could not be translated](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

- **Wrapping in try/catch hides the real question.** Catching `InvalidOperationException` around a `First` call technically stops the crash, but it also catches unrelated `InvalidOperationException`s (a modified-collection-during-enumeration error, for instance) and tells you nothing about why the sequence was empty. Prefer `*OrDefault` plus an explicit branch: it is faster (no exception machinery), narrower, and self-documenting.

The mental model to keep: `.First()` and `.Single()` are assertions that an element exists. `Sequence contains no elements` is that assertion failing. Decide whether the empty case is legal. If it is, express that with `FirstOrDefault`/`SingleOrDefault` and handle the default you get back. If it is not, fix the query or the data upstream so the sequence is never empty at that point, rather than papering over it at the call site.

## Related

- [Fix: The LINQ expression could not be translated in EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) for when the empty result comes from a query that did not run the way you expected.
- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) for why `First` behaves the same in memory and against a database, and when the query actually executes.
- [Fix: CS8618 non-nullable property must contain a non-null value](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) for handling the nullable result that `FirstOrDefault` hands back.
- [LINQ FullJoin and tuple-returning joins in .NET 11](/2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5/) for shaping join results without dropping rows that would leave a sequence empty.

## Sources

- Microsoft Learn, [Enumerable.First Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.first) (throws `InvalidOperationException` when the source sequence is empty or no element matches the predicate; use `FirstOrDefault` to return a default instead).
- Microsoft Learn, [Enumerable.Single Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.single) (throws when the sequence is empty, contains more than one element, or no element matches).
- Microsoft Learn, [Enumerable.FirstOrDefault Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.firstordefault) (returns `default(TSource)` for an empty sequence, plus the .NET 6 overload that accepts an explicit default value).
- Microsoft Learn, [Enumerable.DefaultIfEmpty Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.defaultifempty) (yields a single default element when the source is empty).
