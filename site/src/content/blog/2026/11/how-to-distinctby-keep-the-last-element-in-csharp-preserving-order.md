---
title: "How to do DistinctBy but keep the last element of each duplicate in C#, in source order"
description: "Enumerable.DistinctBy keeps the first element per key. To keep the last one and still return results in the order they appear in the source, buffer the input, scan it backwards with a HashSet, and yield the survivors forwards. Eight implementations checked for order, null keys, double enumeration and argument validation on .NET 10.0.10 and .NET 11 RC3, and benchmarked on .NET 10."
pubDate: 2026-11-08
tags:
  - "dotnet"
  - "csharp"
  - "linq"
  - "performance"
---

**Short answer:** `Enumerable.DistinctBy` always keeps the *first* element for each key, and there is no built-in "keep last" overload in .NET 10 or .NET 11. Write a `DistinctLastBy` that buffers the source into an array, walks it backwards with a `HashSet<TKey>` so the first key it sees is the last occurrence, marks survivors in a `bool[]`, and then yields the marked elements front to back. That gives the last element of each group, in the order those last elements appear in the source, with null keys and custom comparers handled exactly like `DistinctBy`. The one-liner `source.Reverse().DistinctBy(keySelector, comparer).Reverse()` produces the same output and is a fine choice when you do not need the extra speed: it measured 1.2x to 1.7x slower than the hand-written version on 10,000 elements. Avoid the `GroupBy(...).Select(g => g.Last())` version: it returns elements in *first*-occurrence order, which is the bug that usually sends people looking for this.

Everything below was run on .NET 10.0.10 (SDK 10.0.302) and .NET 11.0.0-rc.3 (SDK 11.0.100-rc.3.26522.148) on an Apple Silicon Mac. The correctness output was byte-identical on both runtimes; the benchmark numbers are from .NET 10 only.

## What "keep the last element" means, precisely

The question, as asked on [Stack Overflow](https://stackoverflow.com/questions/79824071), uses a list of animals that count as duplicates when they start with the same letter (case-insensitive):

```csharp
// .NET 10, C# 14
string[] source = ["giraffe", "Elephant", "Cat", "Eagle", "Gazelle", "Cow", "chicken"];
// keys:              g          e          c       e        g         c       c
```

Keeping the last element per key gives `Gazelle` (g), `Eagle` (e) and `chicken` (c). The interesting part is the order. `Eagle` is at index 3, `Gazelle` at index 4, `chicken` at index 6, so the expected output is:

```text
Eagle, Gazelle, chicken
```

In other words, the output is the source sequence with every element removed that has a later duplicate. That is the mirror image of `DistinctBy`, which removes every element that has an *earlier* duplicate. Keep that definition in mind, because several plausible implementations return the right three elements in the wrong order.

## Why GroupBy(...).Select(g => g.Last()) returns the wrong order

The first thing most people write is:

```csharp
// .NET 10, C# 14 -- returns the right elements in the wrong order
public static IEnumerable<T> DistinctLastBy<T, TKey>(
    this IEnumerable<T> source, Func<T, TKey> keySelector, IEqualityComparer<TKey>? comparer = null)
    => source.GroupBy(keySelector, comparer).Select(g => g.Last());
```

It prints `Gazelle, Eagle, chicken`. `GroupBy` yields groups in the order their keys were *first* seen: `g` (giraffe, index 0), then `e` (Elephant, index 1), then `c` (Cat, index 2). `g.Last()` picks the right element from each group, but the groups themselves are ordered by first occurrence. The documentation for `GroupBy` says so explicitly: groups are yielded "in an order based on the order of the elements in source that produced the first key of each IGrouping".

The same trap catches a second popular pattern: a `Dictionary<TKey, int>` that remembers where each key was first stored in a result list and overwrites that slot when a duplicate arrives. It also keeps the last element at the position of the *first* one, and also prints `Gazelle, Eagle, chicken`.

So "keep last" has two requirements: pick the last element per key, and order the survivors by *their own* position, not by the position of their group's first member.

## The implementation to use

```csharp
// .NET 10 / .NET 11, C# 14
public static class EnumerableExtensions
{
    public static IEnumerable<TSource> DistinctLastBy<TSource, TKey>(
        this IEnumerable<TSource> source,
        Func<TSource, TKey> keySelector,
        IEqualityComparer<TKey>? comparer = null)
    {
        // Validate eagerly, like the built-in operators do.
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(keySelector);
        return Iterator(source, keySelector, comparer);

        static IEnumerable<TSource> Iterator(
            IEnumerable<TSource> source, Func<TSource, TKey> keySelector, IEqualityComparer<TKey>? comparer)
        {
            TSource[] items = source.ToArray();
            if (items.Length == 0) yield break;

            var keep = new bool[items.Length];
            var seen = new HashSet<TKey>(comparer);

            // Walking backwards, the first time we see a key is its last occurrence.
            for (int i = items.Length - 1; i >= 0; i--)
                keep[i] = seen.Add(keySelector(items[i]));

            // Walking forwards again restores source order.
            for (int i = 0; i < items.Length; i++)
                if (keep[i]) yield return items[i];
        }
    }
}
```

```csharp
var distinct = source.DistinctLastBy(x => x.Substring(0, 1), StringComparer.OrdinalIgnoreCase);
Console.WriteLine(string.Join(", ", distinct)); // Eagle, Gazelle, chicken
```

Why each piece is there:

- **`HashSet<TKey>`, not `Dictionary<TKey, ...>`.** `HashSet<T>` accepts `null` as an element, `Dictionary<TKey, TValue>` throws `ArgumentNullException` for a null key. The built-in `DistinctBy` is itself a `HashSet<TKey>` loop (see [Distinct.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Distinct.cs) in dotnet/runtime), so using the same collection gives you the same null and comparer semantics.
- **One `keySelector` call per element.** Key selectors are sometimes expensive (string slicing, hashing, a property chain). This version calls it exactly `n` times, which the test harness below confirms.
- **A `bool[]` instead of a list of indices.** The marks array is allocated once at the right size, and the forward pass is a plain loop with no sort.
- **A wrapper plus a local iterator function.** If you put `ThrowIfNull` directly inside a method that contains `yield return`, the whole body, including the validation, runs on the first `MoveNext()`. `DistinctLastBy(null!, f)` would then return happily and blow up somewhere far away. Splitting it keeps the call-time `ArgumentNullException` that `DistinctBy`, `Where` and friends give you. The [yield return vs List&lt;T&gt; comparison](/2026/10/yield-return-iterator-vs-returning-a-list-in-csharp/) goes into this deferred-validation behaviour in more detail.

Execution is still deferred: calling `DistinctLastBy` does not touch the source; the first `MoveNext()` reads all of it. That is unavoidable. You cannot know that element 3 survives until you have checked that no later element shares its key, so any correct "keep last" operator has to read the whole input before yielding the first element. If your source is an infinite or very long stream, this operator is the wrong tool; keep a running `Dictionary` of "latest per key" instead and read it when you need it.

## The double-Reverse one-liner, and why it is correct today

The accepted answer on Stack Overflow is:

```csharp
// .NET 10, C# 14
public static IEnumerable<T> DistinctLastBy<T, TKey>(
    this IEnumerable<T> source, Func<T, TKey> keySelector, IEqualityComparer<TKey>? comparer = null)
    => source.Reverse().DistinctBy(keySelector, comparer).Reverse();
```

It is the same algorithm expressed with stock operators. The first `Reverse()` buffers the source and yields it back to front, `DistinctBy` keeps the first element it sees per key (which is the last in source order), and the second `Reverse()` buffers again and restores the direction. It handles null keys, honours the comparer, calls the key selector once per element and validates `source` at call time, because `Reverse` and `DistinctBy` both validate eagerly.

Its answerer noted one theoretical weakness: the `DistinctBy` docs say it "returns an unordered sequence that contains no duplicate values". In practice the implementation in both .NET 10 and the .NET 11 release candidates is a single forward `foreach` with `HashSet.Add`, so it yields in first-occurrence order, and changing that would break a great deal of code. The hand-written version above does not depend on that implementation detail at all, which is another small reason to prefer it in a shared library.

The other cost is buffering twice: one array for the first `Reverse`, another for the second. That shows up in the benchmark below.

## Every published approach, checked

The Stack Overflow thread has six answers plus the question's own attempt, and none of them compare notes. The harness ran each one through four checks on .NET 10.0.10 and .NET 11.0.0-rc.3 (identical output on both):

1. the animals example with `StringComparer.OrdinalIgnoreCase`;
2. a source where the key selector returns `null`: `["giraffe", null, "Gazelle", null]` with `x => x?.Substring(0, 1)`, expected `Gazelle, <null>`;
3. a source with two *equal elements* under one key: `["Cat", "Cow", "Cat"]`, expected `Cat` once;
4. a counting `IEnumerable<T>` wrapper that records how many times `GetEnumerator()` is called, plus a counter in the key selector, and a call with `source: null` that is never enumerated.

```text
Runtime: 10.0.10
Approach                          animals                    null key                 equal elems  GetEnumerator  null source at call
GroupBy + Last (question)         Gazelle, Eagle, chicken    Gazelle, <null>          Cat          1              throws
Reverse + DistinctBy + Reverse    Eagle, Gazelle, chicken    Gazelle, <null>          Cat          1              throws
GroupBy + index + OrderBy         Eagle, Gazelle, chicken    Gazelle, <null>          Cat          1              throws
Dictionary lastIndex + OrderBy    Eagle, Gazelle, chicken    ArgumentNullException    Cat          1              no throw (deferred)
GroupBy -> HashSet + Where        Eagle, Gazelle, chicken    <null>, Gazelle, <null>  Cat, Cat     2              throws
Resolver (overwrite first slot)   Gazelle, Eagle, chicken    ArgumentNullException    Cat          1 (at call)    NullReferenceException
OrderedDictionary remove + add    Eagle, Gazelle, chicken    ArgumentNullException    Cat          1              no throw (deferred)
Backward HashSet + bool[]         Eagle, Gazelle, chicken    Gazelle, <null>          Cat          1              throws
```

(The table is condensed from the harness output; the harness itself is at the end of the post.) Every approach called the key selector exactly 7 times for 7 elements. What the table shows:

- **Wrong order:** the question's `GroupBy` + `Last` and the "resolver" answer that overwrites the first occurrence's slot. Both return `Gazelle, Eagle, chicken`.
- **Breaks on null keys:** every approach built on `Dictionary<TKey, ...>` or `OrderedDictionary<TKey, TValue>`. If your keys are never null this does not matter, but it is a silent behaviour difference from `DistinctBy`.
- **Wrong with equal elements:** "group, put the winners into a `HashSet<T>`, then `source.Where(hashSet.Contains)`" filters by *element* equality, not position. Two equal `"Cat"` strings are both in the set, so both pass, and for the null-key source it yields `null` twice. It also enumerates the source twice (once at call time, because `ToHashSet` is not deferred), which is wrong for a one-shot `IEnumerable` such as a database reader or a `yield` method with side effects.
- **Eager instead of deferred:** the resolver version builds a `List<T>` when you call it, so the source is read at call time and later changes to it are not seen. It also dereferences a null source with a `NullReferenceException` instead of an `ArgumentNullException`.
- **Deferred validation:** the two `yield`-based dictionary versions put `ThrowIfNull` inside the iterator, so a null argument is only reported on first enumeration.

The `GroupBy` + index + `OrderBy` answer is fully correct (`GroupBy` uses a `Lookup` that tolerates null keys), it is just slow, as the next section shows.

## Benchmark: what each correct approach costs

[BenchmarkDotNet](https://benchmarkdotnet.org/) 0.15.8, .NET 10.0.10, Arm64 RyuJIT, `--job short` (3 iterations, so treat differences under about 10% as noise). 10,000 `int` elements with the identity key selector, fed through a `yield` wrapper so no operator can take an array fast path. Three input shapes:

- **FewKeys**: random values in `[0, 100)`, so 100 groups of about 100 elements;
- **MostlyUnique**: random values in `[0, 100,000)`, so about 9,500 distinct keys;
- **RepeatedBlock**: `i % 5,000`, the sequence `0..4,999` twice, so every key has exactly two occurrences far apart.

`BuiltInDistinctByFirst` is plain `DistinctBy` (keeps the *first* element), included only as the floor.

| Method                 | Shape         |         Mean |  Ratio |  Allocated |
|----------------------- |-------------- |-------------:|-------:|-----------:|
| BackwardHashSet        | FewKeys       |     53.53 us |   1.00 |   54.88 KB |
| DoubleReverse          | FewKeys       |     64.18 us |   1.20 |   45.49 KB |
| GroupByIndexOrderBy    | FewKeys       |     78.83 us |   1.47 |  227.73 KB |
| DictLastIndexOrderBy   | FewKeys       |     48.93 us |   0.91 |      12 KB |
| OrderedDictionary      | FewKeys       |    739.64 us |  13.82 |    7.39 KB |
| BuiltInDistinctByFirst | FewKeys       |     29.94 us |   0.56 |     5.9 KB |
| BackwardHashSet        | MostlyUnique  |    117.60 us |   1.00 |  575.11 KB |
| DoubleReverse          | MostlyUnique  |    198.65 us |   1.69 |  602.55 KB |
| GroupByIndexOrderBy    | MostlyUnique  |  1,093.49 us |   9.30 | 1243.22 KB |
| DictLastIndexOrderBy   | MostlyUnique  |    295.53 us |   2.51 | 1069.43 KB |
| OrderedDictionary      | MostlyUnique  |  2,641.71 us |  22.48 |  657.54 KB |
| BuiltInDistinctByFirst | MostlyUnique  |     91.15 us |   0.78 |   526.1 KB |
| BackwardHashSet        | RepeatedBlock |     79.84 us |   1.00 |  301.26 KB |
| DoubleReverse          | RepeatedBlock |    105.13 us |   1.32 |  311.01 KB |
| GroupByIndexOrderBy    | RepeatedBlock |    235.23 us |   2.95 |  831.95 KB |
| DictLastIndexOrderBy   | RepeatedBlock |    140.78 us |   1.76 |  519.51 KB |
| OrderedDictionary      | RepeatedBlock | 23,827.30 us | 298.44 |  315.26 KB |
| BuiltInDistinctByFirst | RepeatedBlock |     54.05 us |   0.68 |  252.27 KB |

Measured on an Apple M4, macOS 27.0.1. What the numbers say:

- **The backward `HashSet` version was the fastest correct option in two of three shapes**, and within 10% of the fastest in the third. Keeping the last element costs it roughly 1.3x to 1.8x the time of plain `DistinctBy` here, which is the price of buffering the input and walking it twice.
- **The double `Reverse` was 1.2x to 1.7x slower** than the hand-written version, with about the same allocations. For most application code that is irrelevant, and the one-liner is easier to review.
- **`Dictionary` + `OrderBy` won narrowly on FewKeys** (0.91x) because it never buffers the source: it only stores 100 entries and sorts 100 indices. As soon as there are many distinct keys, the `OrderBy` over all of them dominates and it falls to 1.8x to 2.5x, with nearly double the allocations. Remember that it also rejects null keys.
- **`GroupBy` + index + `OrderBy` was 1.5x to 9.3x slower** and allocated the most, because it creates a tuple per element, a grouping per key, and then sorts.
- **`OrderedDictionary` remove + re-add was the slowest in every shape**, 14x even with only 100 keys and 298x on RepeatedBlock.

The `OrderedDictionary<TKey, TValue>` answer deserves its own look. It looks attractive on .NET 9+ because the collection keeps insertion order, so the code removes a key when it reappears and re-adds it at the end. But `OrderedDictionary<TKey, TValue>.RemoveAt` has to shift every entry after the removed one, so a duplicate near the front of a large dictionary costs O(n). On the RepeatedBlock shape, where every duplicate removes an entry from the front, it is quadratic. A separate `Stopwatch` run on .NET 10.0.10 (single run, first call includes JIT, so only the trend is meaningful):

```text
RepeatedBlock n=10000: OrderedDictionary   88.8 ms, Backward HashSet 1.42 ms
RepeatedBlock n=20000: OrderedDictionary  113.2 ms, Backward HashSet 0.24 ms
RepeatedBlock n=40000: OrderedDictionary  439.3 ms, Backward HashSet 0.58 ms
RepeatedBlock n=80000: OrderedDictionary 1682.3 ms, Backward HashSet 3.68 ms
```

Doubling the input roughly quadruples the `OrderedDictionary` time. With few distinct keys (a small dictionary) it is fine, so it can pass a quick test and then fall over on production data.

## Variants and edge cases

**You want the last element, but in the order of the first occurrence.** Sometimes that is the actual requirement: "one row per customer, positioned where the customer first appeared, with their latest data". Then the `GroupBy(...).Select(g => g.Last())` version is the correct one, not a bug. Decide which order you need before you pick an implementation, and name the method so the next reader knows (`DistinctByKeepLast` vs `LatestPerKeyInFirstSeenOrder`).

**The source is already an array or a list.** The `ToArray()` call copies it. If you have a `T[]` or `List<T>` and the copy matters, add an overload that takes `IReadOnlyList<T>` and indexes it directly; the backward loop needs nothing but `Count` and the indexer.

**You need a materialized result.** Call `.ToList()` or `.ToArray()` on the result as usual. If you know the input is small and you call this in a hot loop, a version that returns `List<T>` directly saves the iterator object, but it gives up deferred execution, so keep the `IEnumerable<T>` version as the default for a general-purpose extension.

**`IQueryable` and EF Core.** This is LINQ to Objects only. EF Core will not translate a custom extension method, and it cannot translate the `Reverse` + `DistinctBy` one-liner either. For "latest row per key" in a database, use a window function (`ROW_NUMBER() OVER (PARTITION BY key ORDER BY id DESC)`) or a `GroupBy` with `Max` in a subquery, and keep in mind that SQL has no "source order" unless you sort by a column. See [how to write reusable LINQ predicates EF Core can translate](/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/) for why custom methods do not survive translation.

**Counting instead of deduplicating.** If what you really want is "how many per key", `CountBy` (since .NET 9) does it in one pass without buffering; see [frequency counting with LINQ CountBy](/2026/01/optimizing-frequency-counting-with-linq-countby/).

## The test harness

The full harness, including all eight implementations, the counting source, and the benchmark class, is a single console project:

```xml
<!-- Lab.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework> <!-- net11.0 for the RC3 run, without BenchmarkDotNet -->
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="BenchmarkDotNet" Version="0.15.8" />
  </ItemGroup>
</Project>
```

The correctness core, trimmed to the parts that matter:

```csharp
// .NET 10 / .NET 11, C# 14
using System.Collections;

string?[] animals = ["giraffe", "Elephant", "Cat", "Eagle", "Gazelle", "Cow", "chicken"];
string?[] withNull = ["giraffe", null, "Gazelle", null];
string?[] equalElems = ["Cat", "Cow", "Cat"];
Func<string?, string?> first = x => x?.Substring(0, 1);
var ci = StringComparer.OrdinalIgnoreCase;

Console.WriteLine(string.Join(", ", animals.DistinctLastBy(first, ci)));        // Eagle, Gazelle, chicken
Console.WriteLine(string.Join(", ", withNull.DistinctLastBy(first, ci)
                                            .Select(x => x ?? "<null>")));      // Gazelle, <null>
Console.WriteLine(string.Join(", ", equalElems.DistinctLastBy(first, ci)));     // Cat

var counting = new CountingSource<string?>(animals);
int keyCalls = 0;
var q = counting.DistinctLastBy(x => { keyCalls++; return first(x); }, ci);
Console.WriteLine(counting.GetEnumeratorCalls);   // 0: nothing read yet
_ = q.ToList();
Console.WriteLine($"{counting.GetEnumeratorCalls} {keyCalls}"); // 1 7

try { _ = ((IEnumerable<string>)null!).DistinctLastBy(x => x); }
catch (ArgumentNullException e) { Console.WriteLine(e.ParamName); }  // source, at call time

class CountingSource<T>(IEnumerable<T> inner) : IEnumerable<T>
{
    public int GetEnumeratorCalls;
    public IEnumerator<T> GetEnumerator() { GetEnumeratorCalls++; return inner.GetEnumerator(); }
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}
```

Run it with `dotnet run -c Release`, and the benchmark with `dotnet run -c Release -- bench --filter '*' --job short` after wiring `BenchmarkSwitcher` to a `bench` argument.

## Related

- [yield return iterator vs returning a List&lt;T&gt;](/2026/10/yield-return-iterator-vs-returning-a-list-in-csharp/): why validation inside an iterator is deferred, and what an iterator costs.
- [Why LINQ ThenBy computes every secondary key](/2026/11/why-linq-thenby-computes-every-secondary-key-and-how-to-avoid-it/): another LINQ to Objects operator whose buffering behaviour surprises people.
- [ILookup vs Dictionary of lists for duplicate keys](/2026/09/lookup-vs-dictionary-of-lists-for-duplicate-keys-in-csharp/): the other half of "what do I do with duplicates", when you need all of them.
- [Frequency counting with LINQ CountBy](/2026/01/optimizing-frequency-counting-with-linq-countby/).

## Sources

- [Stack Overflow: DistinctBy, but preserve the last element of each group of duplicates](https://stackoverflow.com/questions/79824071)
- [Enumerable.DistinctBy (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.distinctby)
- [Enumerable.GroupBy (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.groupby)
- [OrderedDictionary&lt;TKey, TValue&gt;.RemoveAt (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/system.collections.generic.ordereddictionary-2.removeat)
- [Distinct.cs in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Distinct.cs)
