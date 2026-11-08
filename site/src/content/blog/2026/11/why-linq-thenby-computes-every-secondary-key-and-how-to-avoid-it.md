---
title: "Why LINQ ThenBy computes every secondary key, and how to compute them only on ties"
description: "OrderBy(...).ThenBy(...) runs every key selector for every element before it compares anything, even when the OrderBy keys are already unique. Measured on .NET 10 and .NET 11 RC3: what the runtime does, why the popular lazy-key workaround still computes keys it never needs, and three patterns that call an expensive secondary key only for tied elements."
pubDate: 2026-11-08
tags:
  - "dotnet"
  - "csharp"
  - "linq"
  - "performance"
---

**Short answer:** you cannot make `Enumerable.ThenBy` lazy. In LINQ to Objects on .NET 10 and .NET 11 (checked on 10.0.14 and 11.0.0-rc.3), sorting an `OrderBy(...).ThenBy(...)` chain first copies the source into an array, then runs *every* key selector of the chain on *every* element and stores the keys in arrays, and only then sorts. If the secondary key is expensive and most primary keys are unique, return a lazily computed wrapper from `ThenBy` and compare it with a custom comparer (`ThenByLazy` below): in a 10,000-element benchmark with a hashed key and no ties it was 13.6x faster than `ThenBy`. If the secondary key is cheap, keep plain `ThenBy`: it was the fastest option in every cheap-key case.

The question comes up regularly, most recently on [Stack Overflow](https://stackoverflow.com/questions/79879541) with a tracing key selector that shows `ThenBy` touching all three elements even though only two of them share an age. The answers there propose several workarounds without measuring them. This post explains the behaviour from the runtime source, counts how many times each workaround actually calls the key selector, and benchmarks them.

## What OrderBy and ThenBy do when you enumerate them

`OrderBy` returns an `OrderedIterator<TElement, TKey>`. `ThenBy` does not sort anything either: it calls `CreateOrderedEnumerable`, which returns another `OrderedIterator` whose `_parent` points at the first one. Nothing runs until you enumerate, call `ToArray`, `ToList`, `First`, and so on.

When you do, the iterator builds a chain of `EnumerableSorter<TElement, TKey>` objects, one per `OrderBy`/`ThenBy` call, and the sort runs in three steps (from [OrderedEnumerable.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/OrderedEnumerable.cs) in dotnet/runtime):

1. `_source.ToArray()` buffers the input.
2. `ComputeMap` calls `ComputeKeys` on the first sorter. `ComputeKeys` allocates a `TKey[]`, runs the key selector on every element, and then calls `_next?.ComputeKeys(elements, count)`, so the next sorter does the same for its key, and so on to the end of the chain.
3. An `int[]` index map is sorted with `Span<int>.Sort` and a comparison that reads the precomputed keys. `CompareAnyKeys` compares the primary keys and only falls through to the next sorter on a tie:

```csharp
// dotnet/runtime, System.Linq, EnumerableSorter<TElement, TKey> (abridged)
internal override int CompareAnyKeys(int index1, int index2)
{
    int c = _comparer.Compare(_keys[index1], _keys[index2]);
    if (c == 0)
    {
        if (_next is null)
            return index1 - index2; // ensure stability of sort
        return _next.CompareAnyKeys(index1, index2);
    }
    return (_descending != (c > 0)) ? 1 : -1;
}
```

So the *comparisons* are already lazy: a secondary key is only compared when the primary keys tie. The *key computation* is not. Every secondary key is computed up front because the sorter does not know which elements will tie until the sort is done, and precomputing keys once per element is what keeps a sort with `O(n log n)` comparisons from calling the key selector `O(n log n)` times. That is a good trade when key selectors are property reads, which is the common case. It is a bad one when the secondary key is a hash, a regex match, a culture-aware normalization, or a lookup.

Precomputing is also what makes `OrderBy` stable: ties fall back to `index1 - index2`, the original position. The stability behaviour is covered in more detail in [is List<T>.Sort stable in C#](/2026/11/is-list-sort-stable-in-csharp/).

## Counting key-selector calls

To see the behaviour instead of reading about it, here is a counting harness. It sorts 10,000 `Person` records by `Age`, then by a secondary key that increments a counter, in three data shapes: every age unique, 9,500 distinct ages (1,000 elements involved in ties), and 100 distinct ages (every element tied with 99 others).

```csharp
// .NET 10.0.14 and .NET 11.0.0-rc.3.26522.148, C# 14
// <TargetFrameworks>net10.0;net11.0</TargetFrameworks>
int calls = 0;
string Expensive(Person p) { calls++; return p.Name; }

Person[] Make(int n, int distinctAges) =>
    Enumerable.Range(0, n)
        .Select(i => new Person($"P{(i * 7919) % n:D6}", i % distinctAges))
        .Reverse()
        .ToArray();

void Run(string label, Person[] data, Func<Person[], IEnumerable<Person>> query)
{
    calls = 0;
    _ = query(data).ToList();
    Console.WriteLine($"  {label,-38} secondary-key calls: {calls,8:N0}");
}

foreach (var (n, distinct) in new[] { (10_000, 10_000), (10_000, 9_500), (10_000, 100) })
{
    var data = Make(n, distinct);
    Console.WriteLine($"n={n:N0}, distinct primary keys={distinct:N0}");
    Run("OrderBy.ThenBy", data,
        d => d.OrderBy(p => p.Age).ThenBy(Expensive, StringComparer.Ordinal));
    Run("OrderBy.ThenBy.Take(10)", data,
        d => d.OrderBy(p => p.Age).ThenBy(Expensive, StringComparer.Ordinal).Take(10));
    // ...the workarounds below
}

record Person(string Name, int Age);
```

`dotnet run -c Release -f net10.0` and `-f net11.0` print identical counts on both runtimes (Apple Silicon, macOS):

| Variant | 10,000 distinct ages | 9,500 distinct | 100 distinct |
|---|---:|---:|---:|
| `OrderBy.ThenBy` | 10,000 | 10,000 | 10,000 |
| `OrderBy.ThenBy.Take(10)` | 10,000 | 10,000 | 10,000 |
| `OrderBy.ThenBy.First()` | 10,000 | 501 | 199 |
| `ThenByLazy` (as posted on Stack Overflow) | 0 | 1,546 | 10,000 |
| `ThenByLazy` with a self-comparison check | 0 | 1,000 | 10,000 |
| `ThenBy(p => p, keyComparer)` | 0 | 2,164 | 138,322 |
| `Order(IComparer<Person>)` | 0 | 2,164 | 138,322 |
| `OrderByThenByOnTies` | 0 | 1,000 | 10,000 |

Three things stand out.

`Take(10)` does not help. `Take` on an ordered sequence switches to a partial quicksort (`SortedMap(buffer, minIdx, maxIdx)`), but that still goes through `ComputeMap`, which computes every key of every level. The same is true for `Skip` and `ElementAt`.

`First()` is the exception, and it is data dependent. `OrderBy(...).ThenBy(...).First()` does not sort at all: it scans once with a `CachingComparerWithChild`, which computes the secondary key on a primary tie *and* every time a new running minimum is found, because it caches the child key of the current winner. The harness feeds the data in descending age order, so every element is a new minimum when ages are unique, and all 10,000 secondary keys are computed anyway. On shuffled input the minimum changes far less often.

The comparer-based workarounds do the opposite of `ThenBy`: they compute nothing up front and recompute both keys on every comparison that reaches the tiebreaker. With 100 elements per tie group that is 138,322 calls for 10,000 elements, almost 14 per element.

## Workaround 1: a lazy key compared by a custom comparer

The best answer in the Stack Overflow thread passes `ThenBy` a key selector that returns a small object holding the element and the real selector, plus a comparer that unwraps it. `ComputeKeys` still runs once per element, but all it does is allocate the wrapper. The real key is computed the first time a comparison reaches the tiebreaker and cached in the wrapper.

There is a catch the counts expose: with 9,500 distinct ages, 1,000 elements are involved in ties, yet the original version computed 1,546 keys. The extra 546 come from the sort comparing an element with itself. `Span<T>.Sort` is an introsort, and its partition loop can compare the pivot against itself. For that self-comparison the primary keys are trivially equal, so `CompareAnyKeys` falls through to the tiebreaker, which forces the lazy key of an element that has no real tie. Instrumenting the comparer showed 555 self-comparisons in that run. Adding a `ReferenceEquals` check brings the count down to exactly 1,000:

```csharp
// .NET 10 / .NET 11, C# 14
public static class OrderingExtensions
{
    // Like ThenBy, but keySelector runs only for elements whose earlier keys tie,
    // and at most once per element.
    public static IOrderedEnumerable<TSource> ThenByLazy<TSource, TKey>(
        this IOrderedEnumerable<TSource> source,
        Func<TSource, TKey> keySelector,
        IComparer<TKey>? comparer = null)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(keySelector);
        comparer ??= Comparer<TKey>.Default;

        var lazyComparer = Comparer<LazyKey<TSource, TKey>>.Create(
            (x, y) => ReferenceEquals(x, y) ? 0 : comparer.Compare(x.Value, y.Value));

        return source.ThenBy(x => new LazyKey<TSource, TKey>(keySelector, x), lazyComparer);
    }

    private sealed class LazyKey<TSource, TKey>(Func<TSource, TKey> keySelector, TSource item)
    {
        private Func<TSource, TKey>? _selector = keySelector;
        private TKey _value = default!;

        public TKey Value
        {
            get
            {
                if (_selector is not null)
                {
                    _value = _selector(item);
                    _selector = null; // also drops the reference to the delegate
                }
                return _value;
            }
        }
    }
}
```

Usage reads like normal LINQ, and you can keep chaining:

```csharp
var sorted = people
    .OrderBy(p => p.Age)
    .ThenByLazy(p => ExpensiveNormalize(p.Name), StringComparer.Ordinal)
    .ThenBy(p => p.Id);
```

The result is identical to `ThenBy`: the harness checks `SequenceEqual` against `OrderBy(p => p.Age).ThenBy(p => p.Name, StringComparer.Ordinal)` for all three data shapes. Stability is preserved because the last tiebreaker is still the runtime's own `index1 - index2`.

What it costs: one wrapper allocation per element (40 bytes on 64-bit for a reference-type element and a reference-type key), whether or not the element ties. `LazyKey` is a hand-rolled class rather than `Lazy<T>` because `new Lazy<TKey>(() => keySelector(x))` allocates more per element (the `Lazy<T>`, a closure, and a delegate) and, in its default `ExecutionAndPublication` mode, synchronizes on first access. The differences between the lazy primitives are covered in [Lazy<T> vs LazyInitializer vs double-checked locking](/2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp/). `LazyKey` is not thread-safe, which is fine for LINQ to Objects, where the sort runs on one thread; I did not test it with PLINQ.

## Workaround 2: count the primary keys, then compute the secondary key only for ties

If you sort the whole sequence anyway, there is a simpler way to know which elements tie: count the primary keys before sorting. A `Dictionary<TKey, int>` pass is cheap compared to the sort, and the secondary key selector can return `default` for every element whose primary key is unique, because those elements never reach the tiebreaker.

```csharp
// .NET 10 / .NET 11, C# 14
using System.Runtime.InteropServices;

public static IEnumerable<TSource> OrderByThenByOnTies<TSource, TKey1, TKey2>(
    this IEnumerable<TSource> source,
    Func<TSource, TKey1> primary,
    Func<TSource, TKey2> secondary,
    IComparer<TKey2>? secondaryComparer = null)
    where TKey1 : notnull
{
    // Compute each primary key once and keep it next to its element.
    var keyed = source.Select(x => (Item: x, Key: primary(x))).ToArray();

    var counts = new Dictionary<TKey1, int>();
    foreach (var (_, key) in keyed)
        CollectionsMarshal.GetValueRefOrAddDefault(counts, key, out _)++;

    return keyed
        .OrderBy(p => p.Key)
        .ThenBy(p => counts[p.Key] > 1 ? secondary(p.Item) : default!, secondaryComparer)
        .Select(p => p.Item);
}
```

It computes the secondary key exactly once for every tied element and never for the others (1,000 calls in the 9,500-distinct case), allocates no per-element wrapper objects, and keeps the sort itself on the runtime's precomputed-key path. The benchmark below shows it is still slower than `ThenByLazy`, so treat it as the option for when you want a predictable call count rather than the fastest one. The counting loop is the same thing [`CountBy`](/2026/01/optimizing-frequency-counting-with-linq-countby/) does; `GetValueRefOrAddDefault` just avoids a second lookup per element.

The limitations are real, so pick it deliberately:

- It returns `IEnumerable<TSource>`, not `IOrderedEnumerable<TSource>`, so you cannot add another `ThenBy` after it. A third level means another variant or `ThenByLazy`.
- The primary key comparer must agree with the dictionary's equality. If you sort with `StringComparer.OrdinalIgnoreCase`, build the dictionary with the same comparer, or two keys that sort as equal will be counted as different and their secondary keys will both be `default`, which silently breaks the order.
- `TKey1` must be non-null because `Dictionary` rejects null keys. Map nulls to a sentinel if your primary key is nullable.
- It always computes keys for every tied element, even ones that a partial sort (`Take`, `First`) would never compare. That rarely matters, but `ThenByLazy` is strictly lazier.

## Workaround 3, and why to avoid it here: compute keys inside the comparer

The other two answers in the thread move the key computation into an `IComparer<T>`, either through `ThenBy(x => x, comparer)` or with a single `Order(IComparer<Person>)` call that compares `Age` and then `Name`. Both compute nothing up front, which looks ideal in the unique-keys case. But every comparison that reaches the tiebreaker recomputes *both* keys, and a sort makes `O(k log k)` comparisons inside a tie group of size `k`. The table shows the result: 2,164 calls for 1,000 tied elements, and 138,322 for 10,000. Unless you add your own cache (at which point you have rebuilt `ThenByLazy` with more allocations), this is the pattern to avoid when the key is expensive.

A comparer that compares cheap fields directly, such as `x.Age.CompareTo(y.Age)` followed by `string.CompareOrdinal(x.Name, y.Name)`, is a different story: no key selector is involved, and `Order(IComparer<T>)` can be perfectly fine there.

## Benchmark: when each option pays off

The counts say how often the key runs; the benchmark says whether avoiding it is worth the overhead. Setup: 10,000 shuffled `Person` records, three tie shapes, and two secondary keys: a cheap one (`p.Name`) and an expensive stand-in (hex-encoded SHA-256 of the name, about 0.6 microseconds per call in this run). BenchmarkDotNet 0.15.8, in-process toolchain (0.15.8 does not recognize the .NET 11 moniker for out-of-process runs), 3 warmup and 10 measured iterations, .NET 11.0.0-rc.3.26522.148, Apple M4, macOS 27.0.1.

```csharp
// .NET 11 RC3, C# 14, BenchmarkDotNet 0.15.8
[MemoryDiagnoser]
[InProcess, WarmupCount(3), IterationCount(10)]
public class ThenByBench
{
    [Params(10_000, 9_500, 100)] public int DistinctAges;
    [Params(false, true)] public bool ExpensiveKey;

    private Person[] _data = [];
    private Func<Person, string> _key = null!;

    [GlobalSetup]
    public void Setup()
    {
        _data = Enumerable.Range(0, 10_000)
            .Select(i => new Person($"P{i:D6}", i % DistinctAges)).ToArray();
        new Random(42).Shuffle(_data);
        _key = ExpensiveKey ? Hash : static p => p.Name;
    }

    private static string Hash(Person p) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(p.Name)));

    [Benchmark(Baseline = true)]
    public Person[] ThenBy() =>
        _data.OrderBy(p => p.Age).ThenBy(_key, StringComparer.Ordinal).ToArray();

    [Benchmark]
    public Person[] ThenByLazy() =>
        _data.OrderBy(p => p.Age).ThenByLazy(_key, StringComparer.Ordinal).ToArray();

    [Benchmark]
    public Person[] OrderWithComparer()
    {
        var key = _key;
        return _data.Order(Comparer<Person>.Create((x, y) =>
        {
            int c = x.Age.CompareTo(y.Age);
            return c != 0 ? c : string.CompareOrdinal(key(x), key(y));
        })).ToArray();
    }

    [Benchmark]
    public Person[] OrderByThenByOnTies() =>
        _data.OrderByThenByOnTies(p => p.Age, _key, StringComparer.Ordinal).ToArray();
}
```

With the **expensive** secondary key:

| Distinct ages | Method | Mean | Ratio | Allocated |
|---|---|---:|---:|---:|
| 10,000 (no ties) | `ThenBy` | 6,572.9 us | 1.00 | 2,656.73 KB |
| | `ThenByLazy` | 482.9 us | 0.07 | 703.74 KB |
| | `OrderWithComparer` | 1,068.3 us | 0.16 | 201.78 KB |
| | `OrderByThenByOnTies` | 860.1 us | 0.13 | 1,205.78 KB |
| 9,500 (10% tied) | `ThenBy` | 6,574.3 us | 1.00 | 2,656.73 KB |
| | `ThenByLazy` | 1,091.3 us | 0.17 | 938.13 KB |
| | `OrderWithComparer` | 1,659.2 us | 0.25 | 438.03 KB |
| | `OrderByThenByOnTies` | 1,495.4 us | 0.23 | 1,440.16 KB |
| 100 (all tied) | `ThenBy` | 6,794.1 us | 1.00 | 2,656.73 KB |
| | `ThenByLazy` | 7,413.4 us | 1.09 | 3,047.52 KB |
| | `OrderWithComparer` | 83,325.5 us | 12.27 | 32,474.36 KB |
| | `OrderByThenByOnTies` | 7,153.2 us | 1.05 | 2,898.99 KB |

With the **cheap** secondary key (`p.Name`):

| Distinct ages | `ThenBy` | `ThenByLazy` | `OrderWithComparer` | `OrderByThenByOnTies` |
|---|---:|---:|---:|---:|
| 10,000 | 434.0 us | 487.4 us (1.12) | 1,046.0 us (2.41) | 861.8 us (1.99) |
| 9,500 | 413.9 us | 487.5 us (1.18) | 1,022.5 us (2.47) | 863.3 us (2.09) |
| 100 | 709.4 us | 1,112.4 us (1.57) | 1,272.1 us (1.79) | 1,015.8 us (1.43) |

How to read it:

- **Expensive key, few ties**: `ThenByLazy` is 13.6x faster than `ThenBy` with no ties and 6x faster with 10% of elements tied. All of `ThenBy`'s time is the 10,000 hash calls; the sort itself is under half a millisecond.
- **Expensive key, everything tied**: nothing can skip work, so the workarounds only add overhead. `ThenByLazy` costs 9% more. Computing the key inside the comparer is the outlier at 12x slower and 32 MB allocated, because each of the roughly 138,000 tiebreak calls hashes again.
- **Cheap key**: plain `ThenBy` wins every row. `ThenByLazy` costs 12 to 57%, mostly the wrapper allocation (the `Allocated` column grows by about 390 KB, roughly 40 bytes per element). Do not apply the workaround by reflex.
- **`OrderByThenByOnTies`** lands between the two in every expensive case and roughly doubles the cost of a cheap sort. The `Gen2` column in the raw results explains part of it: the `(Person, int)` tuple array is 160 KB, above the 85 KB large object heap threshold, so every run allocates on the LOH and triggers gen 2 collections. Its exact call count is its selling point, not its speed.

The rule of thumb from these numbers: if the secondary key costs more than a few hundred nanoseconds and most primary keys are unique, use `ThenByLazy`. Otherwise use `ThenBy`. Measure with your own key, because the break-even point moves with its cost.

## Things that do not change this behaviour

- **`IQueryable`**: for EF Core and other providers, `OrderBy` and `ThenBy` become `ORDER BY a, b` and the database decides what to evaluate. None of this applies, and `ThenByLazy` will not translate because of its custom comparer. If you are unsure which interface a query is running against, [IEnumerable vs IAsyncEnumerable vs IQueryable](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) walks through the difference.
- **Materializing first**: calling `ToList()` before `OrderBy` changes nothing, because the ordered iterator buffers the source into an array regardless. See [how to tell whether an IEnumerable has already been materialized](/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/) for when an extra `ToList()` is actually wasted.
- **`Order()` with no arguments**: for types the runtime treats as implicitly stable (primitives and similar), `Order()` sorts the buffer in place with `Span<T>.Sort` and has no key arrays at all. It does not help with a composite sort.
- **.NET 11**: the counts above are identical on 10.0.14 and 11.0.0-rc.3, and `ComputeKeys` on the dotnet/runtime `main` branch still fills every key array of the chain before sorting.

## Sources

- [`OrderedEnumerable.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/OrderedEnumerable.cs) and [`OrderedEnumerable.SpeedOpt.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/OrderedEnumerable.SpeedOpt.cs) in dotnet/runtime: `ComputeKeys`, `CompareAnyKeys`, `CachingComparerWithChild`, and the `Take`/`ElementAt` paths.
- [`Enumerable.ThenBy`](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.thenby) and [`Enumerable.Order`](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.order) on Microsoft Learn.
- [`CollectionsMarshal.GetValueRefOrAddDefault`](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.getvaluereforadddefault) on Microsoft Learn.
- The Stack Overflow question [How to avoid unnecessary evaluations in LINQ queries using OrderBy followed by multiple ThenBy clauses](https://stackoverflow.com/questions/79879541), whose answers by Theodor Zoulias, T N and Ivan Petrov proposed the lazy-key and comparer approaches measured here.
