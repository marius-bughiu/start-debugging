---
title: "Lookup<TKey, TElement> vs Dictionary<TKey, List<TValue>> for duplicate keys in C#"
description: "Use ToLookup when you group once and only read: it is immutable, returns an empty sequence for missing keys, accepts null keys and keeps first-seen order. Use Dictionary<TKey, List<TValue>> when the groups change after construction or cross a JSON boundary."
pubDate: 2026-09-12
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "linq"
  - "collections"
  - "performance"
---

When one key has to map to many values in C#, the two built-in answers are `ILookup<TKey, TElement>` (what `Enumerable.ToLookup` returns) and a hand-rolled `Dictionary<TKey, List<TValue>>`. **Pick `ToLookup` when you build the grouping once from an existing sequence and then only read it**: it is one line, immutable, returns an empty sequence instead of throwing for a missing key, accepts a `null` key, and enumerates groups in first-seen order. **Pick `Dictionary<TKey, List<TValue>>` when groups change after construction, when you need `TryGetValue`, or when the result has to round-trip through JSON.** Performance leans toward the dictionary, but not by enough to decide most cases: on .NET 11 RC 1 a hand-rolled dictionary builds about 30% faster than `ToLookup` and reads 3-13% faster, which for 100,000 items is under 2 ms. Everything below was run on .NET 11 RC 1 (runtime `11.0.0-rc.1.26425.128`, C# 15), and the behaviour described has been stable since `ToLookup` arrived in .NET Framework 3.5.

## The two shapes side by side

| Behaviour (.NET 11 RC 1)                    | `ILookup<TKey, TElement>` via `ToLookup` | `Dictionary<TKey, List<TValue>>`        |
| ------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| Add or remove after construction            | no, immutable                            | yes                                     |
| Indexer on a missing key                    | empty sequence                           | `KeyNotFoundException`                  |
| `null` key                                  | allowed                                  | `ArgumentNullException`                 |
| Group enumeration order                     | first-seen key order, by construction    | insertion order in practice, not guaranteed |
| Element order within a group                | source order                             | whatever order you `Add`                |
| `TryGetValue`                               | no (`Contains` + indexer)                | yes                                     |
| Public constructor                          | no                                       | yes                                     |
| `System.Text.Json` serialize                | array of arrays, keys lost               | object keyed by `TKey`                  |
| `System.Text.Json` deserialize              | `NotSupportedException`                  | yes                                     |
| Build 100k items, 100 keys                  | 660 us, 1.91 MB                          | 477 us, 1.91 MB                         |
| Read 1,000 probes, 10,000 keys              | 66.1 us, 29,344 B                        | 61.0 us, 0 B                            |

The rows that decide most real cases are the first two and the JSON ones. The rest are details that bite you later if you picked on the wrong axis.

## What ToLookup actually builds

`Lookup<TKey, TElement>` has no public constructor. `Enumerable.ToLookup` is the only way to get one, and the source in [`Lookup.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Lookup.cs) shows exactly what you get back:

- The runtime type is an internal `CollectionLookup<TKey, TElement>`, a subclass of the public `Lookup<TKey, TElement>` that also implements `ICollection<IGrouping<TKey, TElement>>` with every mutating member throwing `NotSupportedException`.
- It is its own small hash table: an array of `Grouping<TKey, TElement>` buckets, sized to a prime and resized with `HashHelpers.ExpandPrime`, with chaining through a `_hashNext` field. It does not wrap a `Dictionary`.
- Every group is also a node in a circular linked list, appended as each new key is seen. Enumeration walks that list, which is why groups come back in first-seen order. That is a structural property of the type, not an accident of the hash layout.
- Each `Grouping` stores its elements in a `TElement[]` that starts at length 1 and doubles, just like `List<T>`, and implements `IList<TElement>` read-only.
- A `null` key hashes to `0` instead of calling the comparer, so `null` is a legal key.
- If the source is an empty array, you get a shared `EmptyLookup<TKey, TElement>.Instance` singleton and nothing is allocated.

Two things fall out of this. First, `ToLookup` is **eager**: it walks the whole source immediately, unlike `GroupBy`, which is deferred and builds the same internal `Lookup` each time you enumerate it. Second, `lookup[key].Count()` is O(1), because `Enumerable.Count` sees the `ICollection<T>` implementation on `Grouping` and reads the count directly.

## The behaviours that actually differ

Here is a small program that exercises every row of the table. Run it as a console app on .NET 11:

```csharp
// .NET 11 RC 1 (11.0.0-rc.1.26425.128), C# 15
var orders = new List<Order>
{
    new("alice", 1), new("bob", 2), new("alice", 3), new(null, 4), new("carol", 5),
};

var lookup = orders.ToLookup(o => o.Customer);
Console.WriteLine(lookup.GetType());                     // System.Linq.CollectionLookup`2[...]
Console.WriteLine(lookup.Count);                         // 4 (keys, not orders)
Console.WriteLine(lookup["dave"].Count());               // 0, no exception
Console.WriteLine(string.Join(",", lookup[null].Select(o => o.Id)));            // 4
Console.WriteLine(string.Join(",", lookup.Select(g => g.Key ?? "<null>")));     // alice,bob,<null>,carol

try { ((IList<Order>)lookup["alice"]).Add(new("alice", 99)); }
catch (NotSupportedException) { Console.WriteLine("groups are read-only"); }

// Eager vs deferred
var source = new List<Order> { new("x", 1) };
var eager = source.ToLookup(o => o.Customer);
var deferred = source.GroupBy(o => o.Customer);
source.Add(new("x", 2));
Console.WriteLine(eager["x"].Count());       // 1, snapshot taken at ToLookup
Console.WriteLine(deferred.First().Count()); // 2, re-evaluated on enumeration

var map = new Dictionary<string, List<Order>>();
// map["dave"]      -> KeyNotFoundException
// map.Add(null!, []) -> ArgumentNullException

record Order(string? Customer, int Id);
```

The eager-vs-deferred line is the one that causes real bugs. If you keep a `GroupBy` result in a field and enumerate it twice, you pay for the grouping twice and you see whatever the source looks like at that moment. `ToLookup` takes a snapshot. If you are not sure whether a sequence you received has already been materialized, [check it before you group it](/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/).

`Count` is the other trap: on a lookup it is the number of **keys**, not the number of elements. To get the element total you need `lookup.Sum(g => g.Count())`.

## Building a Dictionary of lists without the double lookup

If you go the dictionary route, the classic pattern hashes the key twice for every new key (`TryGetValue`, then `Add`):

```csharp
// .NET 11 RC 1, C# 15
var map = new Dictionary<int, List<Order>>();
foreach (var o in orders)
{
    if (!map.TryGetValue(o.CustomerId, out var list))
    {
        list = new List<Order>();
        map.Add(o.CustomerId, list);
    }
    list.Add(o);
}
```

Since .NET 6 you can do it with one hash probe per item using [`CollectionsMarshal.GetValueRefOrAddDefault`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.getvaluereforadddefault), which returns a `ref` to the value slot and inserts a default entry when the key is missing:

```csharp
// .NET 11 RC 1, C# 15
using System.Runtime.InteropServices;

var map = new Dictionary<int, List<Order>>();
foreach (var o in orders)
{
    ref var list = ref CollectionsMarshal.GetValueRefOrAddDefault(map, o.CustomerId, out _);
    (list ??= []).Add(o);
}
```

The docs carry one rule you must respect: do not add or remove dictionary entries while you hold that `ref`. In the loop above the `ref` dies before the next iteration, so it is safe.

If you prefer a LINQ one-liner, `GroupBy(...).ToDictionary(g => g.Key, g => g.ToList())` works but allocates the intermediate groupings and then copies every element into a new list. And if you reach for .NET 9's `AggregateBy`, use the `seedSelector` overload. The `seed` overload hands the **same** instance to every key:

```csharp
// .NET 11 RC 1, C# 15
var orders = new[] { new Order("alice", 1), new Order("bob", 2), new Order("alice", 3) };

var broken = orders.AggregateBy(o => o.Customer, seed: new List<int>(),
    (acc, o) => { acc.Add(o.Id); return acc; });
// alice: 1,2,3   bob: 1,2,3   <- one shared List

var correct = orders.AggregateBy(o => o.Customer, seedSelector: _ => new List<int>(),
    (acc, o) => { acc.Add(o.Id); return acc; });
// alice: 1,3     bob: 2
```

`AggregateBy` and its sibling `CountBy` are great when you want a single aggregate per key; I covered the counting case in [frequency counting with LINQ CountBy](/2026/01/optimizing-frequency-counting-with-linq-countby/). For "all the values per key", they are the wrong tool.

## The benchmark

BenchmarkDotNet 0.15.8 cannot resolve the `net11.0` moniker yet (it throws `NotImplementedException` from `GetRuntimeVersion`), so these ran with `--inProcess` on .NET 11 RC 1, Arm64 RyuJIT, on an Apple M4 (10 cores, 16 GB) under macOS 26.6. The source is 100,000 `Order` records keyed by an `int` `CustomerId`, with either 100 or 10,000 distinct keys. The read benchmark probes 1,000 random keys, 10% of which are missing, and sums a `decimal` field over each group.

Building the grouping from 100,000 orders:

| Method (.NET 11 RC 1)                          | Keys   | Mean     | Ratio | Allocated |
| ---------------------------------------------- | ------ | -------: | ----: | --------: |
| `ToLookup`                                     | 100    | 660.1 us | 1.00  | 1.91 MB   |
| `GroupBy(...).ToDictionary(g => g.ToList())`   | 100    | 883.0 us | 1.34  | 2.69 MB   |
| `TryGetValue` + `Add` loop                     | 100    | 476.7 us | 0.72  | 1.91 MB   |
| `CollectionsMarshal.GetValueRefOrAddDefault`   | 100    | 485.8 us | 0.74  | 1.91 MB   |
| `ToLookup`                                     | 10,000 | 5,934 us | 1.00  | 3.86 MB   |
| `GroupBy(...).ToDictionary(g => g.ToList())`   | 10,000 | 7,537 us | 1.27  | 6.06 MB   |
| `TryGetValue` + `Add` loop                     | 10,000 | 4,070 us | 0.69  | 3.59 MB   |
| `CollectionsMarshal.GetValueRefOrAddDefault`   | 10,000 | 4,384 us | 0.74  | 3.59 MB   |

Reading 1,000 random keys and summing each group:

| Method (.NET 11 RC 1)                          | Keys   | Mean     | Ratio | Allocated |
| ---------------------------------------------- | ------ | -------: | ----: | --------: |
| `foreach (var o in lookup[k])`                 | 100    | 3,736 us | 1.00  | 29,344 B  |
| `TryGetValue` + `foreach` over `List<T>`       | 100    | 3,617 us | 0.97  | 0 B       |
| `TryGetValue` + `CollectionsMarshal.AsSpan`    | 100    | 3,299 us | 0.88  | 0 B       |
| `foreach (var o in lookup[k])`                 | 10,000 | 66.1 us  | 1.00  | 29,344 B  |
| `TryGetValue` + `foreach` over `List<T>`       | 10,000 | 61.0 us  | 0.92  | 0 B       |
| `TryGetValue` + `CollectionsMarshal.AsSpan`    | 10,000 | 57.8 us  | 0.87  | 0 B       |

A few things stand out.

**The lookup is about 1.4x slower to build than a plain loop, with identical allocations.** Both end up with 1.91 MB at 100 keys, so the gap is per-item work, not memory. `ToLookup` invokes the `keySelector` delegate and calls `IEqualityComparer<TKey>.GetHashCode` and `Equals` through the interface for every item. `Dictionary<TKey, TValue>` special-cases value-type keys with no custom comparer and calls `EqualityComparer<TKey>.Default` directly, which the JIT devirtualizes and inlines. With `string` keys that advantage shrinks, because the dictionary also goes through a comparer object.

**`GroupBy(...).ToDictionary(...)` is the worst of both worlds.** It builds the same internal lookup that `ToLookup` builds, then copies every group into a fresh `List<T>`: 27-34% slower than `ToLookup` and up to 57% more memory. If you want a dictionary, write the loop.

**`CollectionsMarshal` did not beat `TryGetValue` here.** The double hash only happens when a key is seen for the first time, which is 100 or 10,000 times out of 100,000 items. The single-probe version pays off when most items introduce a new key, and it is never slower in a way that matters, so it is still my default for the loop.

**Every lookup read allocates.** The indexer returns `IEnumerable<TElement>`, and `Grouping.GetEnumerator` hands back a heap-allocated `PartialArrayEnumerator<TElement>`: 29,344 bytes for roughly 917 hits, 32 bytes each. `List<T>` has a struct enumerator that `foreach` uses without boxing, and `CollectionsMarshal.AsSpan` removes the enumerator entirely for another 5-9%. At 100 keys the read is dominated by summing about 1,000 `decimal` values per group, which is why the ratios converge.

The honest conclusion is that none of these numbers should pick the type for you. If a grouping sits on a path hot enough for a 10% read gap and 32 bytes per probe to matter, you are probably better served by a [`FrozenDictionary`](/2024/04/net-8-performance-dictionary-vs-frozendictionary/) built once over arrays, or by iterating spans instead of `IEnumerable<T>`, which is the same trade-off I walked through in [List vs Span vs ReadOnlySpan](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).

## Gotchas that decide it for you

**You cannot expose a `Dictionary<TKey, List<TValue>>` as a read-only multimap for free.** `IReadOnlyDictionary<TKey, TValue>` is invariant in `TValue`, so this does not compile:

```csharp
// .NET 11 RC 1, C# 15
Dictionary<string, List<int>> map = new() { ["a"] = [1] };
IReadOnlyDictionary<string, IReadOnlyList<int>> ro = map;
// error CS0266: Cannot implicitly convert type 'Dictionary<string, List<int>>'
// to 'IReadOnlyDictionary<string, IReadOnlyList<int>>'
```

The explicit cast the compiler suggests throws `InvalidCastException` at runtime. Your options are to declare the dictionary as `Dictionary<string, IReadOnlyList<int>>` from the start (and lose `Add` on the values without a cast), to copy it, or to return an `ILookup`, which is read-only by construction. If "callers must not mutate this" is a requirement, that alone is a good reason to pick the lookup.

**`ILookup` does not survive JSON.** `System.Text.Json` serializes it as an `IEnumerable<IGrouping<...>>`, so you get `[[{...},{...}],[{...}]]` with the keys gone, and deserializing into `ILookup<TKey, TElement>` throws `NotSupportedException` because the interface cannot be instantiated. A `Dictionary<string, List<T>>` serializes as `{"alice":[...],"bob":[...]}` and round-trips. For API responses and cached payloads, convert with `lookup.ToDictionary(g => g.Key, g => g.ToList())` at the boundary, or build the dictionary in the first place.

**There is no `TryGetValue` on `ILookup`.** `if (lookup.Contains(k)) use(lookup[k]);` hashes the key twice. Since a missing key already returns an empty sequence, just call the indexer and let the empty case fall through. Only use `Contains` when "no values" and "key absent" must be handled differently, which with a lookup they never are (a key cannot exist with zero elements).

**The comparer is fixed at construction.** Both types take an `IEqualityComparer<TKey>`. For string keys, pass `StringComparer.OrdinalIgnoreCase` to `ToLookup` or to the dictionary constructor; you cannot change it later on either type.

**Dictionary enumeration order is an implementation detail.** A `Dictionary` that only ever had adds happens to enumerate in insertion order, but the docs say the order is undefined and a single `Remove` followed by an `Add` reuses the freed slot: on .NET 11 RC 1, keys `a, b, c` followed by `Remove("a")` and `Add("d")` enumerate as `d, b, c`. If you render groups in the order they first appeared, the lookup gives you that guarantee structurally.

**Neither type is thread-safe for writers.** Lookups are immutable, so concurrent reads are fine. A dictionary of lists needs a lock around both the dictionary and every list, and `ConcurrentDictionary<TKey, List<T>>` does not solve it, because the lists inside are still plain `List<T>`. If you need concurrent appends, use `ConcurrentDictionary<TKey, ConcurrentQueue<T>>` or an immutable collection swapped atomically.

**There is no `MultiValueDictionary` in the box.** Microsoft prototyped one in `Microsoft.Experimental.Collections` in 2014, but it never moved into the runtime and the corefxlab repo is now archived. For a mutable multimap, the dictionary of lists is still the standard answer.

## Which one to reach for

Default to `ToLookup` whenever the grouping is a read-only index over data you already have: joining two in-memory sets, bucketing rows for a report, precomputing children-by-parent for a tree. It is shorter, it cannot be mutated behind your back, and the missing-key and null-key behaviour removes a class of defensive code. Switch to `Dictionary<TKey, List<TValue>>`, built with `CollectionsMarshal.GetValueRefOrAddDefault`, when the groups change over the object's lifetime, when you serialize the result, or when you are writing the one hot loop where you have measured that the read gap matters. If you are torn between exposing `IEnumerable<T>` or something richer from the method that returns these groups, the same reasoning applies as in [IEnumerable vs IAsyncEnumerable vs IQueryable](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/): return the narrowest type that keeps callers honest, which for a finished grouping is `ILookup`.

### Related

- [How to tell whether an IEnumerable has already been materialized in C#](/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/)
- [Optimizing frequency counting with LINQ CountBy](/2026/01/optimizing-frequency-counting-with-linq-countby/)
- [Dictionary vs FrozenDictionary in .NET 8](/2024/04/net-8-performance-dictionary-vs-frozendictionary/)
- [List vs Span vs ReadOnlySpan in C#](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)
- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)

### Sources

- [`Lookup<TKey, TElement>` class](https://learn.microsoft.com/en-us/dotnet/api/system.linq.lookup-2), MS Learn
- [`Enumerable.ToLookup`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.tolookup), MS Learn
- [`CollectionsMarshal.GetValueRefOrAddDefault`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.getvaluereforadddefault), MS Learn
- [`Enumerable.AggregateBy`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.aggregateby), MS Learn
- [`Lookup.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Lookup.cs) and [`Grouping.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Grouping.cs) at the `v11.0.0-rc.1.26425.128` tag, dotnet/runtime
- [MultiDictionary becomes MultiValueDictionary](https://devblogs.microsoft.com/dotnet/multidictionary-becomes-multivaluedictionary/), .NET Blog
- [Release the Microsoft.Experimental.Collections.MultiValueDictionary](https://github.com/dotnet/runtime/issues/14406), dotnet/runtime issue
