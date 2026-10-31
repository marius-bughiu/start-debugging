---
title: "yield return iterator vs returning a List<T>: what an IEnumerable method actually costs in C#"
description: "A yield return method costs one 40-byte state machine object per call no matter how many items it produces; a List<T> costs the whole backing array up front. Measured on .NET 10.0.10: iterator wins on memory and early exit, List<T> wins when the caller enumerates more than once, needs Count, or calls ToList()."
pubDate: 2026-10-31
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "linq"
  - "performance"
---

**Short answer:** a `yield return` method allocates exactly one small object per call (40 bytes for a simple `IEnumerable<int>` loop on .NET 10.0.10), whether it produces 10 items or a million. A method that builds and returns a `List<T>` allocates the list plus a backing array sized to the result, which is 4,056 bytes for 1,000 ints with a pre-sized list and 8,424 bytes without one. Pick the iterator when the caller enumerates once (a single `foreach` over it was about 2x faster than filling and reading a list at 1,000 items), may stop early, or the sequence is large or unbounded. Pick `List<T>` (and say so in the return type, `List<T>` or `IReadOnlyList<T>`) when the caller needs `Count`, indexing, or will enumerate more than once, because every extra pass over an iterator reruns your method body.

Everything below was measured with C# 14 on .NET 10.0.10 (SDK 10.0.302) on an Apple M4, using BenchmarkDotNet 0.15.8 for timings and `GC.GetAllocatedBytesForCurrentThread()` for per-call allocation counts.

## The comparison at a glance

| | `yield return` iterator | `List<T>` returned as `IEnumerable<T>` |
| --- | --- | --- |
| Allocation per call (.NET 10.0.10, `int`) | 40 B, constant (sometimes 0 B when the JIT inlines it) | 32 B + backing array (4,056 B for 1,000 ints) |
| Work done at call time | none, not even argument checks | all of it |
| Work done if the caller stops after 1 item | 1 item | all items |
| Second `foreach` | reruns the method body | reads the stored items |
| `Count()` | walks the whole sequence | O(1) through `ICollection<T>` |
| `TryGetNonEnumeratedCount` | `false` | `true` |
| `ToList()` / `ToArray()` | grows by doubling / exact-size copy | one exact-size copy |
| Exceptions thrown | on first `MoveNext()` | at call time |
| Thread-safety of the result | a new state machine per enumeration | safe to read from many threads |

## What the compiler turns `yield return` into

This is the iterator used throughout the post:

```csharp
// .NET 10.0.10, C# 14
public static IEnumerable<int> Iterator(int n)
{
    for (int i = 0; i < n; i++)
        yield return i * 2;
}
```

Roslyn rewrites the method into a hidden class, here named `<Iterator>d__0`, and the method body becomes "allocate that class, store the arguments, return it". Reflection on the generated type shows exactly what lives inside:

```text
Src+<Iterator>d__0
  field Int32 <>1__state
  field Int32 <>2__current
  field Int32 <>l__initialThreadId
  field Int32 n
  field Int32 <>3__n
  field Int32 <i>5__2
  implements IEnumerable`1, IEnumerable, IEnumerator`1, IDisposable, IEnumerator
```

Six `int` fields plus the 16-byte object header and method table pointer gives the 40 bytes. Every local that survives a `yield return` becomes a field (`<i>5__2` is the loop variable), and every parameter is stored twice: `<>3__n` keeps the original value so the sequence can be enumerated again, `n` is the working copy. A method with a `string` parameter and a `DateTime` local gets bigger fields, but the shape never depends on how many items you yield. That is the whole point: memory is O(1) in the item count.

The same object is both the `IEnumerable<T>` and, on the first `GetEnumerator()` call from the creating thread, the `IEnumerator<T>`. So a plain `foreach (var x in Iterator(n))` costs one allocation, not two.

The `List<T>` version is the code most people write first:

```csharp
// .NET 10.0.10, C# 14
public static List<int> ListCap(int n)
{
    var list = new List<int>(n);
    for (int i = 0; i < n; i++)
        list.Add(i * 2);
    return list;
}
```

Here the cost is the 32-byte `List<int>` object plus an `int[]` of `n` elements (24 bytes of header and length, then 4 bytes per item). Drop the `n` from the constructor and the list grows 4, 8, 16, ..., 1024, leaving every intermediate array for the GC.

## Allocations per call, measured

Each case was run 200,000 times to reach tier-1 code, then averaged over 1,000 calls:

| Items | Iterator, `foreach` | `List<T>(n)`, `foreach` | `List<T>()`, `foreach` | Iterator `.ToList()` | Iterator `.ToArray()` |
| --- | --- | --- | --- | --- | --- |
| 0 | 40 B | 32 B | 32 B | 72 B | 40 B |
| 1 | 40 B | 64 B | 72 B | 112 B | 72 B |
| 10 | 40 B | 96 B | 216 B | 256 B | 104 B |
| 1,000 | 40 B | 4,056 B | 8,424 B | 8,464 B | 4,064 B |

Three things stand out.

First, at zero items the list is actually cheaper (32 B vs 40 B), and at one item the gap is tiny. For short, bounded results, memory is not the reason to choose either.

Second, `Iterator(n).ToList()` is the worst column. The iterator does not implement `ICollection<T>`, so `ToList()` cannot pre-size and grows by doubling, exactly like the list without capacity, plus the 40-byte state machine. If every caller immediately calls `ToList()` on your iterator, you are paying for both designs. Return a pre-sized `List<T>` instead.

Third, `ToArray()` on an iterator is nearly free of waste on .NET 10: 4,064 B for 1,000 ints, only 8 bytes more than the exact array plus the iterator. Since .NET 9, `ToArray()` buffers unknown-length sequences in stack-allocated segments and copies once into an exact-size array; I covered that change in [ToList vs ToArray on .NET 9](/2025/01/net-performance-tolist-vs-toarray/). If a caller needs to materialize an iterator, `ToArray()` is the cheaper call.

## What the .NET 10 JIT removes for you

Returning `List<T>` typed as `IEnumerable<T>` used to cost one more allocation: `foreach` over the interface calls `IEnumerable<T>.GetEnumerator()`, which boxes the `List<T>.Enumerator` struct (40 bytes on 64-bit). On .NET 10.0.10 the "List as `IEnumerable`" case allocates the same 64 B as the concrete list at one item. Rerunning the probe with `DOTNET_JitObjectStackAllocation=0` brings the box back (104 B), which shows that the JIT's guarded devirtualization plus object stack allocation, part of the [.NET 10 enumerator de-abstraction work](https://github.com/dotnet/runtime/issues/108913), now puts that enumerator on the stack. With zero items there is no box even with the knob off, because `List<T>` hands out a shared empty enumerator when `Count == 0`.

The iterator's 40 bytes did not move in the `foreach` cases, with or without escape analysis. The state machine is returned out of your method, so it escapes by definition, and the JIT can only stack-allocate it when it inlines the iterator method and everything that consumes it into one caller. That did happen for some LINQ calls in the benchmark below, but not reliably.

## Timings: where each one wins

BenchmarkDotNet 0.15.8, default job, .NET 10.0.10 Arm64 RyuJIT, Apple M4. Every method builds the sequence and consumes it inside the benchmark, so the "List" rows include filling the list. Mean time, allocation in parentheses:

| Benchmark | N = 10 | N = 1,000 | N = 100,000 |
| --- | --- | --- | --- |
| Iterator, `foreach` | 10.7 ns (40 B) | 580 ns (40 B) | 56.9 us (40 B) |
| `List<T>(n)`, `foreach` | 12.7 ns (96 B) | 1,004 ns (4,056 B) | 116.3 us (400,140 B) |
| `List<T>()`, `foreach` | 30.1 ns (216 B) | 1,214 ns (8,424 B) | 145.8 us (1,049,168 B) |
| `List<T>(n)` as `IEnumerable<T>`, `foreach` | 13.2 ns (96 B) | 1,148 ns (4,056 B) | 114.6 us (400,140 B) |
| Iterator, `.First()` | 2.1 ns (0 B) | 2.1 ns (0 B) | 2.0 ns (0 B) |
| `List<T>(n)`, `.First()` | 11.4 ns (96 B) | 666 ns (4,056 B) | 77.3 us (400,140 B) |
| Iterator, `.ToList()` | 34.1 ns (216 B) | 1,452 ns (8,424 B) | 166.9 us (1,049,168 B) |
| Iterator, `.Count()` | 7.3 ns (0 B) | 541 ns (0 B) | 53.5 us (0 B) |

For a single pass, the iterator is faster at every size: about 1.2x at 10 items and 2x at 1,000 and 100,000. That surprises people who expect "an interface call per item" to lose to "a list". The list version does the same loop to fill the list, then a second loop to read it, and pays for the array; the iterator does one loop. At 100,000 ints the pre-sized list's 400,140-byte array is past the 85,000-byte threshold, so it lands on the Large Object Heap and every call forces Gen2 collections in the BenchmarkDotNet run.

Early exit is where the gap becomes absurd: `First()` on the iterator costs 2 ns regardless of size, because it computes one item. The list version computes all 100,000 before `First()` sees any of them.

The two rows where the iterator loses are the ones that need the whole result anyway. `Iterator(n).ToList()` is the slowest row in every column, slower than building the list directly without capacity, because it adds the interface calls on top of the doubling growth. And while `Count()` on the iterator is fast here, it is fast because it consumes the sequence; if you call `Count()` and then `foreach`, you run the method twice, and the list's O(1) `Count` wins.

The 0 B on the iterator's `First()` and `Count()` rows is the .NET 10 JIT again: in those benchmarks it inlined the iterator method and the LINQ call and stack-allocated the state machine. My allocation probe saw the same thing at some call sites and a normal 40 B at others, and `DOTNET_JitObjectStackAllocation=0` restored 40 B everywhere. Treat it as a bonus, not something to design around.

## The iterator reuses itself, sometimes

One detail explains a surprising number in the probe: enumerating the same iterator twice allocated 40 bytes in total, not 80. The generated `GetEnumerator()` returns `this` when the state field is `-2` (freshly created) and the caller is on the creating thread. Disassembling the generated `Dispose()` on SDK 10.0.302 shows it is just `this.<>1__state = -2`, so once a `foreach` finishes, or `break`s, and disposes the enumerator, the object is back in its initial state and the next `foreach` on the same thread gets the same instance:

```csharp
// .NET 10.0.10, C# 14 (SDK 10.0.302)
var seq = Iterator(5);
foreach (var x in seq) { if (x == 2) break; }
var again = seq.GetEnumerator();
Console.WriteLine(ReferenceEquals(seq, again)); // True: reused after Dispose

var fresh = Iterator(5);
var e1 = fresh.GetEnumerator();
e1.MoveNext();
var e2 = fresh.GetEnumerator();
Console.WriteLine(ReferenceEquals(fresh, e2));  // False: e1 still owns the instance
```

A second enumerator taken while the first is still live, or one taken from another thread, gets a new instance initialized from the stored `<>3__` parameter copies. You never need to reason about this for correctness, but it means "iterator enumerated twice" is cheap in bytes. It is not cheap in work, which is the next point.

## Gotchas that decide it for you

### Every enumeration reruns your method

The iterator stores no items. A second `foreach`, a `Count()` followed by a `foreach`, or `Any()` followed by `ToList()` executes the method body again, including any database call, file read, or `Console.WriteLine` inside it:

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<string> ReadNames(string path)
{
    Console.WriteLine($"opening {path}");
    foreach (var line in File.ReadLines(path))
        yield return line.Trim();
}

var names = ReadNames("names.txt");
if (names.Any())                      // opening names.txt
    Console.WriteLine(names.Count()); // opening names.txt (again)
```

The .NET analyzers flag this as [CA1851: Possible multiple enumerations of IEnumerable collection](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1851), but the rule is off by default. If your callers routinely need two passes, return a list. If you inherited an `IEnumerable<T>` and cannot tell whether it is safe to walk twice, [the checks in this post on detecting a materialized IEnumerable](/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/) are the closest the BCL gets.

### Argument validation is deferred

Nothing in an iterator body runs until the first `MoveNext()`, and that includes the guard clauses at the top:

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<int> Take(IEnumerable<int> source, int count)
{
    ArgumentNullException.ThrowIfNull(source); // runs on first MoveNext, not here
    foreach (var x in source)
    {
        if (count-- <= 0) yield break;
        yield return x;
    }
}

var q = Take(null!, 3);   // no exception
foreach (var x in q) { }  // ArgumentNullException thrown here
```

The stack trace then points at the `foreach`, possibly far from the bad call. The standard fix, and the reason the BCL's own LINQ operators throw at call time, is to split the method in two: a non-iterator public method that validates and a private iterator (a local function works) that yields:

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<int> Take(IEnumerable<int> source, int count)
{
    ArgumentNullException.ThrowIfNull(source); // throws at call time
    ArgumentOutOfRangeException.ThrowIfNegative(count);
    return Core(source, count);

    static IEnumerable<int> Core(IEnumerable<int> source, int count)
    {
        foreach (var x in source)
        {
            if (count-- <= 0) yield break;
            yield return x;
        }
    }
}
```

A `List<T>` method has no such trap: it runs to completion, or throws, before it returns.

### `finally` runs only if someone disposes the enumerator

`try`/`finally` and `using` blocks inside an iterator run when enumeration completes or when the enumerator is disposed. `foreach` always disposes, including on `break` and on exceptions. Code that calls `GetEnumerator()` and `MoveNext()` by hand and forgets `Dispose()` leaves files and connections open until the GC finalizes whatever owned them. A list holds no resources after it returns.

### Recursive iterators are quadratic

`yield return` cannot forward a nested sequence, so a recursive tree walk written as `foreach (var child in Walk(node.Left)) yield return child;` allocates one state machine per node and pushes every item up through every level: O(n x depth) `MoveNext` calls. For deep trees, use an explicit `Stack<T>` inside a single iterator, or fill one `List<T>` passed down the recursion.

### The return type is a promise

Returning `IEnumerable<T>` from a method that actually builds a `List<T>` hides the fact that `Count` is free, and invites callers to call `ToList()` "just in case", copying the data a second time (the 8,112 B `List.ToList()` case at 1,000 items in the [allocation table above](#allocations-per-call-measured), against 4,056 B for the list itself). If you materialize, return `List<T>`, `IReadOnlyList<T>`, or an array, so callers can see it. If you stream, return `IEnumerable<T>` and document that it is lazy. For data coming from a database or the network, neither is right; [IEnumerable vs IAsyncEnumerable vs IQueryable](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) covers when to stream asynchronously instead, and [what IAsyncEnumerable is for](/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) goes deeper on `await foreach`.

## Which one to return

Use a `yield return` iterator when:

- The caller enumerates once, top to bottom, which is the common case for `foreach` pipelines and LINQ chains.
- The caller might stop early (`First`, `Any`, `Take`, a `break` on a match). The iterator does only the work that was asked for.
- The sequence is large, unbounded, or produced from a stream (lines of a file, pages of an API). Memory stays at one object instead of the whole result.

Return a `List<T>` (typed as `List<T>` or `IReadOnlyList<T>`) when:

- The caller needs `Count`, indexing, or more than one pass.
- The result is small and bounded, where the iterator's 40 bytes and per-item interface calls buy nothing.
- Callers will call `ToList()` anyway. Pre-size it with `new List<T>(capacity)` when you know the count.
- The method has side effects or validation that must happen exactly once, at call time.

My default for public APIs is the second list: materialized and honestly typed. I reach for `yield return` when early exit or memory is the actual requirement, and then I split validation out into a non-iterator wrapper every time.

## Related

- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#: which one should the method return?](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)
- [How to tell whether an IEnumerable<T> has already been materialized in C#](/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/)
- [.NET Performance: ToList vs ToArray](/2025/01/net-performance-tolist-vs-toarray/)
- [What is IAsyncEnumerable and when should I use it?](/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)
- [How to iterate over two collections in lockstep without heap allocations in C#](/2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp/)

## Sources

- [yield statement](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/yield) (C# language reference)
- [Iterators](https://learn.microsoft.com/dotnet/csharp/iterators) (C# guide)
- [CA1851: Possible multiple enumerations of IEnumerable collection](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1851) (Microsoft Learn)
- [Enumerable.TryGetNonEnumeratedCount](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) (Microsoft Learn)
- [Roslyn iterator rewriter source](https://source.dot.net/Microsoft.CodeAnalysis.CSharp/Lowering/IteratorRewriter/IteratorMethodToStateMachineRewriter.cs.html) (source.dot.net)
- [.NET 10 de-abstraction plans, dotnet/runtime#108913](https://github.com/dotnet/runtime/issues/108913)
- [What's new in the .NET 10 runtime](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime) (Microsoft Learn)
