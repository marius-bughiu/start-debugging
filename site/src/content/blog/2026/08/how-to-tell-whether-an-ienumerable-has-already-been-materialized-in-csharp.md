---
title: "How to tell whether an IEnumerable<T> has already been materialized in C#"
description: "There is no HasBeenEnumerated flag on IEnumerable<T>. Here is what TryGetNonEnumeratedCount actually checks, why Enumerable.Range passes an ICollection<T> test, and the guard that avoids a wasted ToList()."
pubDate: 2026-08-23
tags:
  - "csharp"
  - "linq"
  - "dotnet"
  - "performance"
---

There is no API in .NET that answers "has this `IEnumerable<T>` already been enumerated", and there is no API that answers "is this sequence backed by memory". The interface has exactly one member, `GetEnumerator()`, and nothing in the contract requires an implementation to remember that you called it. What you actually get is `Enumerable.TryGetNonEnumeratedCount` (.NET 6 and later), which tells you whether the *count* is cheap, plus a set of type tests you can run yourself. Those two signals overlap with "already materialized" but are not the same thing, and the gaps are where the bugs live. Everything below was measured on .NET 10.0.201 with C# 14.

## Why the question has no direct answer

`IEnumerable<T>` is a factory for enumerators, not a container. Calling `GetEnumerator()` twice is legal, and each call is entitled to produce a fresh, independent walk over the data. A `List<int>` hands you a struct enumerator over an existing array. A `yield return` method builds a state machine that runs your method body from the top. A `DbSet<T>` opens a connection and issues SQL. All three satisfy the same interface, and only the first one is holding elements in memory.

So "has it been materialized" splits into three separate questions that people conflate:

1. Are the elements already sitting in memory, so a second pass is free?
2. Is the count available without walking the sequence?
3. Has *this particular* sequence object already been walked once?

The BCL gives you a partial answer to (1), a good answer to (2), and no answer at all to (3).

## What the runtime does track: the iterator state machine

Compiler-generated iterators do carry a state field, and you can look at it. This is a debugging aid, not an API, but it is worth seeing once because it explains the behaviour you observe:

```csharp
// .NET 10.0.201, C# 14
static IEnumerable<int> Lazy()
{
    yield return 1;
    yield return 2;
}

static string ReadState(object o)
{
    var f = o.GetType().GetField("<>1__state",
        BindingFlags.Instance | BindingFlags.NonPublic);
    return f is null ? "no state field" : $"{f.GetValue(o)}";
}

var seq = Lazy();
Console.WriteLine(ReadState(seq));      // -2  : constructed, never enumerated
var e = seq.GetEnumerator();
Console.WriteLine(ReferenceEquals(seq, e)); // True : the first call returns "this"
e.MoveNext();
Console.WriteLine(ReadState(seq));      // 1   : mid-enumeration
```

The `-2` sentinel is the compiler's fast path: the first `GetEnumerator()` on the creating thread flips the state to `0` and returns the same object rather than allocating a clone. Every call after that returns a clone with its own state. That is why the second enumerator restarts from the beginning while the first one keeps its position, and it is why there is no shared "already enumerated" bit for you to read. Reflecting on `<>1__state` tells you about one object, on one code path, for one compiler; do not ship it.

## TryGetNonEnumeratedCount, and exactly what it tests

Added in .NET 6 and still the same shape in .NET 11, `Enumerable.TryGetNonEnumeratedCount` is the only supported "can I look without touching" primitive. The [runtime implementation](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Count.cs) is three type tests in order:

```csharp
// System.Linq.Enumerable, .NET 10, abridged
public static bool TryGetNonEnumeratedCount<TSource>(
    this IEnumerable<TSource> source, out int count)
{
    if (source is ICollection<TSource> collectionoft) { count = collectionoft.Count; return true; }
    if (source is Iterator<TSource> iterator)
    {
        int c = iterator.GetCount(onlyIfCheap: true);
        if (c >= 0) { count = c; return true; }
    }
    if (source is ICollection collection) { count = collection.Count; return true; }
    count = 0;
    return false;
}
```

`Iterator<TSource>` is the internal base class for LINQ's own iterators, so the middle branch is the part you cannot replicate from outside `System.Linq`. The [documented remarks](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) say it plainly: "a series of type tests, identifying common subtypes whose count can be determined without enumerating."

Running every common sequence shape through that method, plus the type tests you would write by hand, gives this on .NET 10.0.201:

| Sequence | `TryGetNonEnumeratedCount` | `is ICollection<T>` | `is IReadOnlyCollection<T>` | `is IQueryable` |
| --- | --- | --- | --- | --- |
| `int[]` | true, 3 | true | true | false |
| `List<int>` | true, 3 | true | true | false |
| `HashSet<int>` | true, 3 | true | true | false |
| `Queue<int>` | true, 3 | **false** | true | false |
| `Stack<int>` | true, 3 | **false** | true | false |
| `ReadOnlyCollection<int>` | true, 3 | true | true | false |
| `ImmutableArray<int>` | true, 3 | true | true | false |
| `Enumerable.Empty<int>()` | true, 0 | true | true | false |
| `Enumerable.Range(0, 1_000_000_000)` | **true, 1000000000** | **true** | true | false |
| `Enumerable.Repeat(7, 500)` | true, 500 | true | true | false |
| `list.Select(x => x)` | **true, 3** | false | false | false |
| `list.Where(x => true)` | false | false | false | false |
| `list.Take(2)` | true, 2 | **true** | true | false |
| `list.Skip(1)` | true, 2 | **true** | true | false |
| `list.OrderBy(x => x)` | true, 3 | false | false | false |
| `list.Distinct()` | false | false | false | false |
| `list.Concat(list)` | true, 6 | false | false | false |
| `((IEnumerable)list).Cast<int>()` | true, 3 | true | true | false |
| `list.DefaultIfEmpty()` | true, 3 | false | false | false |
| `Enumerable.Reverse(list)` | true, 3 | false | false | false |
| `list.GroupBy(x => x).SelectMany(g => g)` | false | false | false | false |
| `yield return` iterator method | false | false | false | false |
| `list.AsQueryable()` | false | false | false | **true** |
| `list.ToList()` / `.ToArray()` | true, 3 | true | true | false |

## Three traps hiding in that table

**A cheap count is not a materialized sequence.** `Enumerable.Range(0, 1_000_000_000)` reports a count of one billion in constant time and passes `is ICollection<int>`, but nothing has been allocated. `RangeIterator` has implemented `IList<T>` since .NET 8; on .NET 6 and .NET 7 the same expression fails the `ICollection<T>` test because the iterator only implemented the internal `IPartition<int>`. If your code says `if (source is ICollection<T>) { /* safe to keep the reference */ }` you are also saying "safe to hold a billion-element sequence and enumerate it twice."

The same trap shows up on `Select`. `list.Select(x => x)` returns `true` from `TryGetNonEnumeratedCount` with the source list's count, because the count of a projection equals the count of its source. The selector has not run for a single element. Getting the count told you nothing about whether the work is done.

**`ICollection<T>` misses two very common types.** `Queue<T>` and `Stack<T>` implement the non-generic `ICollection` and the generic `IReadOnlyCollection<T>`, but not `ICollection<T>`. A guard written as `source as ICollection<T>` silently falls through to a defensive copy for both. `IReadOnlyCollection<T>` is the better test if all you need is `Count` and repeat enumeration.

**Deferred does not mean uncountable, and countable does not mean cheap to walk.** `Where` and `Distinct` return `false` even when the source is a `List<int>`, because the predicate decides the count. `OrderBy` returns `true` with the source count, but enumerating it still performs a full sort. Do not treat a `true` result as permission to enumerate freely.

## A lazy ICollection<T> defeats every check

Every technique here is a type test, and a type test can be satisfied by an implementation that does expensive work on each `GetEnumerator()`. This is not hypothetical: an EF Core collection navigation under lazy-loading proxies is an `ICollection<T>` whose enumeration can hit the database.

```csharp
// .NET 10.0.201, C# 14
sealed class LazyCollection : ICollection<int>
{
    public static int WorkDone;
    public int Count => 3;              // cheap, known up front
    public bool IsReadOnly => true;
    public IEnumerator<int> GetEnumerator()
    {
        WorkDone++;                     // expensive, runs on every pass
        return Enumerable.Range(0, 3).GetEnumerator();
    }
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    // mutating members omitted
}
```

That type reports `is ICollection<int> == true` and `TryGetNonEnumeratedCount == true` with a count of 3, having done zero work. One `foreach` later, `WorkDone` is 1, and it climbs on every subsequent pass. No API can distinguish this from a `List<int>`. If you own the boundary, the fix is to stop passing `IEnumerable<T>` and start passing `IReadOnlyList<T>` or a concrete type, which turns a runtime guess into a compile-time guarantee. That is the same argument for [choosing the right return type between IEnumerable, IAsyncEnumerable, and IQueryable](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/).

## The guard worth writing

In practice nobody wants a `HasBeenEnumerated` flag. They want to know whether a defensive `ToList()` is going to be wasted. Answer that question directly:

```csharp
// .NET 10.0.201, C# 14
public static IReadOnlyCollection<T> Materialize<T>(this IEnumerable<T> source)
{
    ArgumentNullException.ThrowIfNull(source);

    return source switch
    {
        // Deferred against a remote store: always pull it in, once.
        IQueryable<T> q => q.ToList(),

        // Known in-memory BCL types: reuse the reference, no copy.
        T[] a => a,
        List<T> l => l,
        IReadOnlyCollection<T> c when c.GetType().Assembly == typeof(List<T>).Assembly => c,

        _ => source.ToList(),
    };
}
```

The `IQueryable<T>` arm goes first because a queryable is the one case where a second enumeration is unambiguously a second round trip, and where the LINQ type tests all return `false` anyway. The assembly check on the third arm is deliberately conservative: it accepts `Queue<T>`, `Stack<T>`, `ReadOnlyCollection<T>` and friends while rejecting the `LazyCollection` above and any ORM navigation type. If your codebase does not have lazily-backed collections, drop that arm to a plain `IReadOnlyCollection<T> c => c` and keep the one-liner.

Note what is *not* in the guard: `TryGetNonEnumeratedCount`. It answers a different question. Use it when you genuinely want a count and are willing to fall back, which is the pattern it was designed for:

```csharp
// .NET 10.0.201, C# 14
int capacity = source.TryGetNonEnumeratedCount(out int known) ? known : 16;
var buffer = new List<T>(capacity);
```

## What the guard saves

Measured with `Stopwatch` and `GC.GetAllocatedBytesForCurrentThread`, 100 iterations, on a `List<int>` of 1,000,000 elements passed as `IEnumerable<int>`, .NET 10.0.201 Release:

| Approach | Time | Allocated |
| --- | --- | --- |
| `input.ToList()` | 793.93 us/op | 4,000,056 bytes/op |
| `input as IReadOnlyCollection<int> ?? input.ToList()` | 1.09 us/op | 0 bytes/op |

Those are coarse loop timings rather than BenchmarkDotNet numbers, but the allocation column is exact and is the point: the blind copy allocates a second four-megabyte backing array on the large object heap every call, and the guard allocates nothing. On a hot path that takes an already-materialized list, the defensive copy is the whole cost of the method. The same reasoning applies whenever you are trying to [read a large file without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/).

## Let the analyzer find the call sites

You do not have to audit this by hand. CA1851, "Possible multiple enumerations of 'IEnumerable' collection", was introduced in .NET 7 and is still **not enabled by default in .NET 10**. Turn it on:

```ini
# .editorconfig
[*.{cs,vb}]
dotnet_diagnostic.CA1851.severity = warning
```

With `EnableNETAnalyzers` and `AnalysisLevel` set to `latest`, this code produces two diagnostics on .NET 10.0.201:

```csharp
public static void Twice(IEnumerable<int> input)
{
    var count = input.Count();              // CA1851
    foreach (var i in input) { _ = i; }     // CA1851
}
```

```text
warning CA1851: Possible multiple enumerations of 'IEnumerable' collection.
Consider using an implementation that avoids multiple enumerations.
```

Rewriting the body to bind through a guard first clears both warnings:

```csharp
public static void Guarded(IEnumerable<int> input)
{
    var list = input as IReadOnlyCollection<int> ?? input.ToList();
    var count = list.Count;
    foreach (var i in list) { _ = i; }
}
```

Two configuration knobs matter for real codebases. `enumeration_methods` lets you register your own methods that consume an `IEnumerable` argument, and `assume_method_enumerates_parameters` flips the default assumption, which is currently that a custom method does *not* enumerate what you hand it. That default is why CA1851 stays quiet when you pass the same sequence to two of your own helpers.

## IQueryable and IAsyncEnumerable need separate rules

For `IQueryable<T>`, none of this applies: every type test returns `false`, and each enumeration is a fresh provider translation and a fresh round trip. The signal you want is the static type, and the fix is to call `ToListAsync()` once at the boundary. Repeated enumeration of a queryable inside a loop is one of the shapes behind [N+1 query problems in EF Core](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), and a query that cannot be translated at all produces [the "LINQ expression could not be translated" error](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) rather than a silent double round trip.

For `IAsyncEnumerable<T>` there is no `TryGetNonEnumeratedCount` at all, no `ICollection<T>` equivalent, and no cheap count. The only way to know how many elements an async sequence holds is to await all of them, which is exactly what [IAsyncEnumerable is designed to let you avoid](/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/). Materialize once with `await source.ToListAsync()` and pass the list around, or restructure so that a single pass is enough.

The honest summary is that "has this been materialized" is unanswerable and "will a second pass be cheap" is answerable most of the time. Test for `IQueryable<T>` first, then for `IReadOnlyCollection<T>` rather than `ICollection<T>`, treat `TryGetNonEnumeratedCount` as a capacity hint rather than a materialization check, and let CA1851 tell you where you forgot.

## Related

- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#: which one should the method return?](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)
- [What is IAsyncEnumerable&lt;T&gt; and when should I use it?](/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [How to read a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [Fix: "The LINQ expression could not be translated" in EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)

## Sources

- [Enumerable.TryGetNonEnumeratedCount&lt;TSource&gt; Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) on MS Learn
- [Count.cs in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Count.cs), the implementation of the type tests
- [Range.SpeedOpt.cs in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Range.SpeedOpt.cs), where `RangeIterator` declares `IList<T>`
- [CA1851: Possible multiple enumerations of 'IEnumerable' collection](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1851) on MS Learn
- [Deferred execution and lazy evaluation in LINQ](https://learn.microsoft.com/en-us/dotnet/standard/linq/deferred-execution-lazy-evaluation) on MS Learn
