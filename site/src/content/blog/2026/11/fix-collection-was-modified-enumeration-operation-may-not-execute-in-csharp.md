---
title: "Fix: Collection was modified; enumeration operation may not execute in C#"
description: "You changed a List or Dictionary while a foreach was walking it. Iterate a copy, use RemoveAll, loop backwards with for, or lock both sides. Which mutations throw on .NET 10 and 11, and why Dictionary.Remove does not."
pubDate: 2026-11-07
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "csharp"
  - "collections"
---

`InvalidOperationException: Collection was modified; enumeration operation may not execute` means a collection changed while an enumerator (usually a `foreach`) was still walking it. To remove items, call `list.RemoveAll(predicate)` or loop backwards with a `for` index. To change the collection from inside the loop body, iterate a snapshot (`foreach (var x in list.ToList())`). If another thread is writing, wrap both the loop and the writes in the same `lock`, or switch to a concurrent or immutable collection. Every result below was run on .NET 10.0.10 and .NET 11.0.0-rc.3.26522.148 (macOS arm64), and the two runtimes behaved identically.

## The error in context

```text
System.InvalidOperationException: Collection was modified; enumeration operation may not execute.
   at System.Collections.Generic.List`1.Enumerator.MoveNext()
   at Program.<Main>$(String[] args) in Program.cs:line 5
```

The top frame is the enumerator's `MoveNext`, not the line that changed the collection. The `Remove` or `Add` call ran fine and returned; the exception fires on the *next* iteration, when the loop asks for another item. That is why the stack trace points at the `foreach` line, and why it is easy to stare at the wrong statement. For a `Dictionary` the frame is `System.Collections.Generic.Dictionary`2.Enumerator.MoveNext()`, and `SortedDictionary` words the message differently: "Collection was modified after the enumerator was instantiated."

## Why the enumerator throws

`List<T>`, `Dictionary<TKey,TValue>`, `Queue<T>` and most other BCL collections keep a private `_version` counter. Every mutating method increments it. When you call `GetEnumerator()`, the enumerator copies the current version, and each `MoveNext()` compares its copy against the live counter. If they differ, it throws instead of guessing what you meant.

The check exists because the alternative is silent corruption. After a `Remove`, every element behind the removed one shifts left by one slot, so an index-based enumerator would skip the next item. After an `Add` that triggers a resize, the backing array is replaced. The [`IEnumerator.MoveNext` docs](https://learn.microsoft.com/en-us/dotnet/api/system.collections.ienumerator.movenext) spell out the contract: if the collection is changed, the enumerator is invalidated and the next call to `MoveNext` or `Reset` throws `InvalidOperationException`.

Note that "changed" means "the version counter moved", not "the element count changed". That has consequences, covered in the table below.

## Minimal repro

```csharp
// .NET 10.0.10 / .NET 11 RC3, C# 14
var list = new List<int> { 1, 2, 3, 4 };

foreach (var x in list)
{
    if (x % 2 == 0)
        list.Remove(x); // runs fine, the NEXT MoveNext() throws
}
```

The same thing happens with every variant people try first:

```csharp
// .NET 10.0.10 / .NET 11 RC3, C# 14
list.ForEach(x => { if (x == 2) list.Remove(x); });           // throws, List<T>.ForEach checks the version too

foreach (var x in list.Where(v => v % 2 == 0))                // throws: Where is lazy and
    list.Remove(x);                                           // still enumerates `list` underneath
```

The LINQ one catches a lot of people. `Where` does not produce a new list; it wraps the source enumerator, so you are still enumerating `list` while you remove from it.

## Which mutations throw on .NET 10 and .NET 11

Each case below was run through a small harness that catches the exception and prints the message. Results were identical on .NET 10.0.10 and .NET 11 RC3:

| Collection | Mutation inside `foreach` | Result |
| --- | --- | --- |
| `List<T>` | `Remove`, `Add`, `Insert`, `Clear` | throws |
| `List<T>` | `list[i] = value` (indexer set) | **throws** |
| `List<T>` | `Sort()` | **throws** |
| `List<T>` | `Remove` of the last element | throws |
| `T[]` | `array[i] = value` | no exception |
| `Dictionary<K,V>` | `Remove(key)` | **no exception** |
| `Dictionary<K,V>` | `Clear()` | **no exception** |
| `Dictionary<K,V>` | `dict[existingKey] = value` | **no exception** |
| `Dictionary<K,V>` | `dict[newKey] = value` / `Add` | throws |
| `Dictionary<K,V>` | `TrimExcess()` that actually shrinks | throws |
| `HashSet<T>` | `Remove` | no exception |
| `SortedDictionary<K,V>` | `Remove` | throws (different message) |
| `Queue<T>` | `Dequeue` | throws |
| `ObservableCollection<T>` | `Remove` | throws |
| `ConcurrentDictionary<K,V>` | `TryRemove`, add | no exception |

Three rows surprise people.

**Replacing a `List<T>` element throws.** The indexer setter bumps `_version`, so `list[i] = x * 10` inside a `foreach` over the same list fails even though the count never changes. An array has no version counter at all, so the same code over a `T[]` runs.

**`Dictionary.Remove` and `Clear` do not throw.** Since .NET Core 3.0, these two (plus overwriting the value of an existing key) no longer invalidate active enumerators. The [`Dictionary<TKey,TValue>.Remove` docs](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.dictionary-2.remove) state that ".NET Core 3.0+ only: this mutating method may be safely called without invalidating active enumerators on the Dictionary instance." `HashSet<T>` follows the same rule on .NET 10 and 11 (`Remove` and `RemoveWhere` inside a `foreach` both ran without an exception). On .NET Framework 4.x all of these still throw, which is why so many Stack Overflow answers say "you can never remove from a dictionary in a foreach". On modern .NET you can:

```csharp
// .NET 10.0.10 / .NET 11 RC3, C# 14
var stock = new Dictionary<string, int> { ["a"] = 1, ["b"] = 0, ["c"] = 3 };

foreach (var (sku, qty) in stock)
{
    if (qty == 0)
        stock.Remove(sku);        // fine on .NET Core 3.0+
    else
        stock[sku] = qty * 10;    // overwriting an existing key: also fine
}
// stock: [a, 10], [c, 30]
```

Adding a **new** key still throws, because it can trigger a resize and rehash.

**`SortedDictionary` and `SortedSet` did not get the relaxation.** They are red-black trees, and removal rebalances the tree, so the enumerator's stack of nodes would be stale. They still throw on `Remove`.

## Fix 1: remove in bulk with RemoveAll

If the loop exists only to delete matching items, delete them in one call:

```csharp
// .NET 10.0.10 / .NET 11 RC3, C# 14
var list = new List<int> { 1, 2, 3, 4 };
int removed = list.RemoveAll(v => v % 2 == 0);
// removed: 2, list: [1, 3]
```

[`List<T>.RemoveAll`](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.list-1.removeall) compacts the array in a single O(n) pass. A loop that calls `Remove(x)` per match is O(n²), because each `Remove` searches for the item and then shifts the tail. For dictionaries the equivalent is the loop above (on .NET Core 3.0+), and for `HashSet<T>` there is `RemoveWhere`.

## Fix 2: loop backwards with an index

When you need to decide per element and maybe do other work at the same time, a `for` loop over the indexes does not use an enumerator, so there is no version check. Go from the end so removals never shift elements you have not visited yet:

```csharp
// .NET 10.0.10 / .NET 11 RC3, C# 14
for (int i = list.Count - 1; i >= 0; i--)
{
    if (list[i] % 2 == 0)
        list.RemoveAt(i);
}
```

The forward version compiles, runs without an exception, and is wrong:

```csharp
// .NET 10.0.10 / .NET 11 RC3, C# 14 -- BUG: skips the element after each removal
var list = new List<int> { 2, 4, 5, 6 };
for (int i = 0; i < list.Count; i++)
    if (list[i] % 2 == 0)
        list.RemoveAt(i);
// list: [4, 5]  -- 4 and 6 were even, 4 survived
```

Removing index 0 shifts `4` into index 0, then `i++` moves past it. That is exactly the bug the version check in `foreach` exists to prevent, and a `for` loop gives you no such protection.

## Fix 3: iterate a snapshot

If the body adds items, calls something that modifies the collection, or you simply want the simplest correct code, enumerate a copy:

```csharp
// .NET 10.0.10 / .NET 11 RC3, C# 14
foreach (var x in list.Where(v => v % 2 == 0).ToList())
    list.Remove(x);
// list: [1, 3]
```

`ToList()` (or `ToArray()`) runs the query to completion before the loop starts, so the loop walks the copy and the original is free to change. The cost is one allocation and a copy of the matching items, which is negligible next to a database call and worth measuring only on hot paths. For the per-item `Remove` you are back at O(n²); use `RemoveAll` or a `HashSet` of items to remove when the list is large.

A related pattern is to collect what you want to change during the loop and apply it afterwards:

```csharp
// .NET 10.0.10 / .NET 11 RC3, C# 14
var toAdd = new List<Order>();
foreach (var order in orders)
{
    if (order.NeedsFollowUp)
        toAdd.Add(order.CreateFollowUp());
}
orders.AddRange(toAdd);
```

## Fix 4: when another thread is the one modifying

If the loop body does not touch the collection at all and you still get the exception, something else does. In one run of a test where a background task kept calling `Add` and `RemoveRange` on a shared `List<int>` while the main thread summed it in a `foreach`, 1,991 of 2,000 enumerations threw on .NET 10 and the same on .NET 11 RC3. With a `lock` around the writes **and** around the whole `foreach`, 0 of 2,000 threw.

```csharp
// .NET 10.0.10 / .NET 11 RC3, C# 14
private readonly List<int> _items = new();
private readonly Lock _gate = new();   // System.Threading.Lock, .NET 9+

public void Add(int x)
{
    lock (_gate) _items.Add(x);
}

public long Sum()
{
    lock (_gate)
    {
        long sum = 0;
        foreach (var x in _items) sum += x;
        return sum;
    }
}
```

Locking only the writers is not enough; the enumeration is the long read that has to be protected. If you cannot hold a lock for the whole loop, copy under the lock (`lock (_gate) snapshot = _items.ToArray();`) and enumerate the snapshot outside it.

The exception is the lucky outcome here. `List<T>` and `Dictionary<TKey,TValue>` are not thread-safe, and concurrent writes without a lock can corrupt their internal state. Modern `Dictionary` sometimes detects a corrupted bucket chain and throws `InvalidOperationException: Operations that change non-concurrent collections must have exclusive access`, a lookalike of this error with the same root cause; other times the damage is silent. Treat this exception from a loop that does not mutate anything as proof of a data race, not as a flaky test.

Alternatives that avoid the lock:

- `ConcurrentDictionary<TKey,TValue>`, `ConcurrentQueue<T>` and `ConcurrentBag<T>` never throw this exception during enumeration. The [`ConcurrentDictionary.GetEnumerator` docs](https://learn.microsoft.com/en-us/dotnet/api/system.collections.concurrent.concurrentdictionary-2.getenumerator) note the enumerator is safe to use concurrently with reads and writes but is not a moment-in-time snapshot, so it may or may not see changes made after it started.
- `ImmutableList<T>` and the other `System.Collections.Immutable` types never change in place. "Removing" returns a new instance, so the loop keeps enumerating the old one: `foreach (var x in list) if (x % 2 == 0) list = list.Remove(x);` runs and leaves `[1, 3]`.
- For producer/consumer handoff, a `Channel<T>` replaces the shared list entirely.

## Gotchas and lookalikes

**Event handlers and callbacks.** The loop body calls a method that raises an event, and a subscriber modifies the collection. Classic in WinForms and WPF (a `CheckedChanged` handler that edits the list being looped over) and in domain code where `order.Cancel()` removes itself from `customer.Orders`. The stack trace still shows only `MoveNext`, so put breakpoints on every call that mutates the collection (or wrap it in a class whose mutators log a stack trace) to find the code that actually changed it.

**`ObservableCollection<T>` has a second, different error.** Modifying it inside a `foreach` gives the same "Collection was modified" message. Modifying it inside its own `CollectionChanged` handler gives `InvalidOperationException: Cannot change ObservableCollection during a CollectionChanged event`, which is a reentrancy guard, not an enumerator check.

**`CollectionsMarshal.AsSpan` silently skips the check.** A `foreach` over `CollectionsMarshal.AsSpan(list)` walks the backing array directly. Calling `list.Add(4)` and `list[1] = 99` inside that loop threw nothing; the loop saw 3 items and the list ended as `[1, 99, 3, 4]`. If the `Add` had triggered a resize, the span would be reading the old, abandoned array. The span docs warn that items should not be added or removed while the span is in use; nothing enforces it. See [List vs Span vs ReadOnlySpan](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) for when that trade-off is worth it.

**Holding an enumerator manually.** `var e = list.GetEnumerator(); e.MoveNext(); list.Clear();` leaves `e.Current` returning the stale value `1` without complaint. Only the next `MoveNext()` throws. Do not rely on `Current` after a mutation.

**Async methods.** An `await` inside a `foreach` lets other code run on the same logical flow before the loop resumes. If that code (another request handler sharing a singleton list, a timer callback) adds to the collection, the exception appears on the iteration after the `await`. The fix is the same as for threads: lock, snapshot, or a concurrent collection, and note that a `lock` cannot contain an `await`, so use `SemaphoreSlim` or take a snapshot first.

## Related

- [Lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) covers which primitive to pick when the writer is on another thread or behind an `await`.
- [How to use the new System.Threading.Lock type](/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) explains the `Lock` field used in Fix 4.
- [Use channels instead of BlockingCollection](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) for replacing a shared list in a producer/consumer setup.
- [Is List.Sort stable in C#?](/2026/11/is-list-sort-stable-in-csharp/) for another `List<T>` behaviour that trips people up.

## Sources

- [`IEnumerator.MoveNext` remarks](https://learn.microsoft.com/en-us/dotnet/api/system.collections.ienumerator.movenext) on enumerator invalidation.
- [`Dictionary<TKey,TValue>.Remove`](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.dictionary-2.remove) and [`Dictionary<TKey,TValue>.Enumerator`](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.dictionary-2.enumerator) for the .NET Core 3.0 rule that `Remove` and `Clear` keep enumerators valid.
- [`List<T>.RemoveAll`](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.list-1.removeall).
- [`ConcurrentDictionary<TKey,TValue>.GetEnumerator`](https://learn.microsoft.com/en-us/dotnet/api/system.collections.concurrent.concurrentdictionary-2.getenumerator).
- [`CollectionsMarshal.AsSpan`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan).
- [`List<T>` source on GitHub](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Collections/Generic/List.cs) for the `_version` field and the enumerator check.
