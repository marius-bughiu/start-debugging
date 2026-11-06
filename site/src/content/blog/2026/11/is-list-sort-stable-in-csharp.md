---
title: "Is List<T>.Sort stable in C#? Why equal elements change order"
description: "List<T>.Sort, Array.Sort, Span<T>.Sort and ImmutableArray.Sort are unstable introsorts, so items with equal keys can swap places. Enumerable.OrderBy is stable. Measured on .NET 10: why lists of 16 or fewer items look stable, why three items are not, how to get a stable in-place sort, and what it costs."
pubDate: 2026-11-06
tags:
  - "dotnet"
  - "csharp"
  - "linq"
  - "performance"
---

**Short answer:** no. `List<T>.Sort`, `Array.Sort`, `Span<T>.Sort` (`MemoryExtensions.Sort`) and `ImmutableArray<T>.Sort` all run the same introspective sort, and it is unstable: when the comparer returns `0` for two elements, their final order is not guaranteed to match their original order. `Enumerable.OrderBy`, `OrderByDescending`, `ThenBy` and .NET 7's `Order()` are stable, because LINQ breaks every tie by the element's original index. If you need a stable sort, use `OrderBy(...).ThenBy(...)`, or keep `List<T>.Sort` and add your own tiebreak on an original index. Everything below was run on .NET 10.0.10 (SDK 10.0.302, macOS arm64, Apple M4), and the algorithm is the same in the .NET 11 `main` branch.

## What the docs and the runtime source actually say

The `List<T>.Sort` documentation is explicit: it "uses Array.Sort, which applies the introspective sort", and the remarks add that "this implementation performs an unstable sort; that is, if two elements are equal, their order might not be preserved." `Array.Sort` carries the same sentence. `Enumerable.OrderBy` says the opposite: "This method performs a stable sort." The `MemoryExtensions.Sort` page has no remarks at all, but it calls into the same helper, so it inherits the same behavior.

Introsort is a hybrid. The implementation lives in [`ArraySortHelper.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Collections/Generic/ArraySortHelper.cs) and does this for each partition:

1. If the partition has 2 elements, swap them if the first is greater.
2. If it has 3 elements, run three compare-and-swaps: `(0,1)`, `(0,2)`, `(1,2)`.
3. If it has 16 or fewer elements (`Array.IntrosortSizeThreshold = 16`), run insertion sort.
4. If recursion is deeper than `2 * (log2(n) + 1)`, switch to heapsort.
5. Otherwise pick a median-of-three pivot, partition (quicksort), and recurse.

Quicksort partitioning and heapsort move elements across long distances without looking at their original position, so equal elements get shuffled. Insertion sort, as written there, only shifts an element left while `comparer(t, keys[j]) < 0`, so it never moves an item past an equal one. That one detail explains most of the confusing behavior people report.

LINQ is different by construction. [`OrderedEnumerable.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Linq/src/System/Linq/OrderedEnumerable.cs) extracts the keys into an array, sorts an array of indexes, and when the key comparison returns `0` it returns `index1 - index2`, with the comment `// ensure stability of sort`.

## The smallest unstable case is three elements

Here is a probe that shows the instability directly. It is a .NET 10 file-based app, so it runs with `dotnet run probe.cs` and no project file.

```csharp
// .NET 10 (SDK 10.0.302), C# 14: dotnet run probe.cs
var three = new List<Item> { new(1, "a"), new(1, "b"), new(0, "c") };
three.Sort((x, y) => x.Key.CompareTo(y.Key));
Console.WriteLine("List.Sort: " + string.Join(" ", three));

var linq = new List<Item> { new(1, "a"), new(1, "b"), new(0, "c") }
    .OrderBy(i => i.Key).ToList();
Console.WriteLine("OrderBy:   " + string.Join(" ", linq));

record Item(int Key, string Tag)
{
    public override string ToString() => $"{Key}{Tag}";
}
```

Output on .NET 10.0.10:

```text
List.Sort: 0c 1b 1a
OrderBy:   0c 1a 1b
```

`1a` came before `1b` in the input and comes after it in the `List.Sort` result. Walk the three-element network by hand: `(0,1)` compares `1a` with `1b`, equal, no swap. `(0,2)` compares `1a` with `0c`, greater, swap, giving `0c 1b 1a`. `(1,2)` compares `1b` with `1a`, equal, no swap. The swap at step two jumped `1a` over `1b`, and nothing ever puts it back.

## Why your 10-item unit test says it is stable

The insertion-sort path is the trap. A test that sorts a handful of records with a few duplicate keys will almost always pass, and then production data with hundreds of rows reorders equal items. The probe measured this directly: for each size it built 1000 random lists (keys drawn from `0` to `max(2, n / 10)`, so there are many duplicates), sorted them with `List<T>.Sort`, and counted how many results had any pair of equal keys out of original order.

```text
n=    2: List.Sort unstable in    0/1000 trials
n=    3: List.Sort unstable in  136/1000 trials
n=    4: List.Sort unstable in    0/1000 trials
n=   10: List.Sort unstable in    0/1000 trials
n=   16: List.Sort unstable in    0/1000 trials
n=   17: List.Sort unstable in 1000/1000 trials
n=   20: List.Sort unstable in 1000/1000 trials
n=   50: List.Sort unstable in 1000/1000 trials
n=  100: List.Sort unstable in 1000/1000 trials
n= 1000: List.Sort unstable in 1000/1000 trials
```

Sizes 4 through 16 go straight to insertion sort and never reorder equal elements. Size 3 uses the compare-and-swap network and breaks about one time in seven with two distinct keys. At 17 elements the first quicksort partition runs, and with this many duplicates every single trial came back out of order. The exact rate depends on how many duplicates you have, but the cliff at 16/17 is a property of the algorithm, not of the data. Do not rely on any of these numbers either: the stable behavior below 17 elements is an implementation detail, and the docs reserve the right to change it.

## Every sorting API, checked

The same probe sorted one 1000-item list (keys `0` to `99`) through every common API and checked whether equal keys kept their input order:

```text
List<T>.Sort(Comparison)       stable: False
List<T>.Sort(IComparer)        stable: False
Array.Sort(T[], Comparison)    stable: False
Array.Sort(keys, items)        stable: False
Span<T>.Sort(Comparison)       stable: False
ImmutableArray.Sort            stable: False
Enumerable.OrderBy             stable: True
Enumerable.Order(comparer)     stable: True
OrderByDescending              stable: True
AsParallel().OrderBy           stable: False
List.Sort + index tiebreak     stable: True
```

Two lines deserve a comment.

`OrderByDescending` is stable in the useful sense: equal keys keep their original relative order, they are not reversed. Only the key comparison is inverted; the index tiebreak still runs forward.

`AsParallel().OrderBy` is not stable, and the `ParallelEnumerable.OrderBy` documentation says so: "In contrast to the sequential implementation, this is not a stable sort." The docs suggest projecting the index first and adding `ThenBy` on it, which is the same fix as for `List<T>.Sort`.

## The bug this causes: sorting twice

The classic way instability bites is a two-pass sort. You sort by name, then by department, expecting names to stay alphabetical inside each department. That works with a stable sort (it is how spreadsheet "sort by column" stacking works) and fails with `List<T>.Sort` as soon as the list is longer than 16:

```csharp
// .NET 10 (SDK 10.0.302), C# 14: dotnet run twopass.cs
var people = new List<Person>
{
    new("Ana", "Ops"), new("Ben", "Dev"), new("Cara", "Ops"), new("Dan", "Dev"),
    new("Eve", "Ops"), new("Finn", "Dev"), new("Gus", "Ops"), new("Hana", "Dev"),
    new("Ivo", "Ops"), new("Jo", "Dev"), new("Kim", "Ops"), new("Lea", "Dev"),
    new("Max", "Ops"), new("Nia", "Dev"), new("Oto", "Ops"), new("Pia", "Dev"),
    new("Quin", "Ops"), new("Rui", "Dev"),
};

var twoPass = new List<Person>(people);
twoPass.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
twoPass.Sort((a, b) => string.CompareOrdinal(a.Dept, b.Dept));
Console.WriteLine(string.Join(" ", twoPass.Select(p => $"{p.Dept}:{p.Name}")));

record Person(string Name, string Dept);
```

With 18 people, the output on .NET 10.0.10 is:

```text
Dev:Rui Dev:Ben Dev:Pia Dev:Dan Dev:Finn Dev:Nia Dev:Hana Dev:Jo Dev:Lea Ops:Oto Ops:Max Ops:Ivo Ops:Quin Ops:Gus Ops:Eve Ops:Cara Ops:Kim Ops:Ana
```

The departments are grouped, but the name order from the first pass is gone. Remove two people and the same code prints a perfect result, which is how this kind of bug survives code review.

## Three ways to get a stable result

### Put every key in one comparer

The cleanest fix for the two-pass case is to stop relying on stability at all. Sort once, with a comparer that orders by department and then by name:

```csharp
// .NET 10, C# 14
composite.Sort((a, b) =>
{
    int c = string.CompareOrdinal(a.Dept, b.Dept);
    return c != 0 ? c : string.CompareOrdinal(a.Name, b.Name);
});
```

This prints `Dev:Ben Dev:Dan ... Dev:Rui Ops:Ana ... Ops:Quin`. Elements that are still equal after all keys are compared are equal for every purpose you care about, so stability no longer matters. If you are on a record or class you control, implementing `IComparable<T>` with the same chain is equivalent.

### Use OrderBy and ThenBy

```csharp
// .NET 10, C# 14
var sorted = people
    .OrderBy(p => p.Dept, StringComparer.Ordinal)
    .ThenBy(p => p.Name, StringComparer.Ordinal)
    .ToList();
```

This gives the same output as the composite comparer and is stable for whatever ties remain. It allocates a new list instead of sorting in place, which matters for very large collections (numbers below).

### Keep List<T>.Sort and tiebreak on the original index

When you must sort in place and genuinely want "equal items stay where they were" (for example, items with the same priority should keep their arrival order), carry the original position along and compare it last:

```csharp
// .NET 10, C# 14
var tagged = items.Select((item, index) => (item, index)).ToList();
tagged.Sort((x, y) =>
{
    int c = x.item.Priority.CompareTo(y.item.Priority);
    return c != 0 ? c : x.index.CompareTo(y.index);
});
var stable = tagged.Select(t => t.item).ToList();
```

No two elements are ever equal under this comparer, so the instability of the algorithm cannot show. If the type already has a monotonically increasing field (an auto-increment ID, a sequence number, a timestamp with enough resolution), use that instead of projecting an index.

## What stability costs, measured

A quick Stopwatch measurement on the same machine: 1,000,000 records with an `int` key in the range `0` to `999`, three warm-up runs, then the median of 10 runs, Release configuration via the file-based app's `#:property Configuration=Release` directive. This is a rough single-machine measurement, not a BenchmarkDotNet run, so treat the ratios as indicative.

```text
List.Sort (unstable)         median   131.3 ms  alloc    7.6 MB
List.Sort + Seq tiebreak     median   222.6 ms  alloc    7.6 MB
OrderBy(Key).ToList()        median   108.8 ms  alloc   31.3 MB
```

The 7.6 MB in the `List.Sort` rows is the copy of the source list each run makes, so the sort itself allocates nothing. Two results are worth knowing:

- Adding a tiebreak to the comparison delegate cost about 70% more time here, because nearly every comparison hits the tie path (1000 distinct keys across a million rows).
- `OrderBy` was faster than `List<T>.Sort` with a `Comparison<T>` delegate. LINQ extracts the `int` keys once into an array and compares them with the default comparer, instead of invoking a lambda that dereferences two records per comparison. You pay for it in memory: about 4x the allocation (key array, index map, result list).

So "stable is slow" is not a safe assumption. If allocation is acceptable, `OrderBy` is often the fastest stable option and sometimes the fastest option, period. If you need in-place and allocation-free, a composite comparer that avoids ties is cheaper than an index tiebreak. For a deeper look at choosing between `List<T>` and span-based APIs for hot paths, see [List vs Span vs ReadOnlySpan in C#](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).

## Edge cases that look like stability problems

**Values that compare equal but print differently.** Stability is invisible for plain `int` arrays, because two equal ints are indistinguishable. It is not invisible for `double`: `0.0` and `-0.0` compare equal. Sorting an 18-element array of mixed zeros and positive numbers with `Array.Sort(double[])` on .NET 10.0.10 printed `0 -0 0 -0 0 -0 -0 0 -0 0 0 -0 1 2 3 4 5 6`, with the zeros in an order that matches neither the input nor any rule. The same applies to strings under `StringComparer.OrdinalIgnoreCase` (`"a"` and `"A"`) or a culture comparer, and to records where the comparer looks at only one property. If the output must be deterministic, make the comparer distinguish them.

**`OrderBy(...).First()` and `MinBy`.** LINQ optimizes `OrderBy(k).First()` so it does not sort the whole sequence, but it keeps the stable meaning: the probe confirmed it returns the first element in source order among those with the smallest key. `MinBy` did the same in a separate check (`[(1,a), (0,b), (0,c)].MinBy(x => x.k)` returned `(0, b)`). Both are safe replacements when you only need the top item.

**A comparer that is not consistent.** Instability is not the same as a broken comparer. If `Compare(a, b)` and `Compare(b, a)` disagree, or the comparer is not transitive, the result is simply wrong. On .NET 10.0.10, `Array.Sort` of 100 ints with a comparer that returned a random `-1` or `1` finished without any exception and left the array in a meaningless order. Only a comparer that throws is reported, as `InvalidOperationException: Failed to compare two elements in the array.` with your exception as the inner one. The `Array.Sort` docs note that since .NET Framework 4.5 the insertion sort and heapsort paths "do not detect an invalid comparer", so do not count on the sort to catch a bad one. That history also matters for old code: .NET Framework 4 and earlier used plain quicksort, which was equally unstable, so code that "used to work" on Framework never had a guarantee either.

**Hash-based ordering is a separate problem.** If you sort the output of a `Dictionary` or `HashSet` and break ties by iteration order, the result can still change between runs, because string hash codes are randomized per process. That is covered in [why string.GetHashCode() returns a different value every run](/2026/11/why-does-string-gethashcode-return-a-different-value-every-run-in-dotnet/).

## Related

- [Record vs class vs struct in C#](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) covers how records implement equality, which is a different question from how they compare for sorting.
- [Optimizing frequency counting with LINQ CountBy](/2026/01/optimizing-frequency-counting-with-linq-countby/) is another case where a newer LINQ operator beats the hand-written loop.
- [Why Math.Round(2.5) returns 2 in C#](/2026/11/why-does-math-round-2-5-return-2-in-csharp/) is another long-standing default that surprises people and is documented in the remarks nobody reads.

## Sources

- [`List<T>.Sort` remarks](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.list-1.sort) (introsort, unstable)
- [`Array.Sort` remarks and notes to callers](https://learn.microsoft.com/en-us/dotnet/api/system.array.sort) (introsort, .NET Framework 4.5 change)
- [`Enumerable.OrderBy` remarks](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.orderby) (stable)
- [`ParallelEnumerable.OrderBy` remarks](https://learn.microsoft.com/en-us/dotnet/api/system.linq.parallelenumerable.orderby) (not stable)
- [`ArraySortHelper.cs` in dotnet/runtime, release/10.0](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Collections/Generic/ArraySortHelper.cs)
- [`OrderedEnumerable.cs` in dotnet/runtime, release/10.0](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Linq/src/System/Linq/OrderedEnumerable.cs)
