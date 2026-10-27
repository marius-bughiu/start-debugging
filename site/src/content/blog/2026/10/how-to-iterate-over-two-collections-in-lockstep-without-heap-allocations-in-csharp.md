---
title: "How to iterate over two collections in lockstep without heap allocations in C#"
description: "Enumerable.Zip allocates 144-208 bytes per call and runs about 10x slower than a plain loop. For arrays and lists, a for loop over two spans sliced to the same length is allocation-free and the fastest option; for foreach syntax, a small ref struct zip enumerator gets within 25% of it. Measured on .NET 10.0.10 and .NET 11 RC 3."
pubDate: 2026-10-27
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "linq"
  - "memory"
---

**Short answer:** if both sources are arrays, lists, or anything you can get a `ReadOnlySpan<T>` from, take the shorter length, slice both spans to it, and run one `for` loop with a single index. That allocates nothing and is the fastest shape the JIT knows. If you want `foreach (var (x, y) in ...)` syntax without the cost, write a 20-line `ref struct` zip enumerator that checks both lengths in `MoveNext`. If the sources are not indexable (a `HashSet<T>`, a `Dictionary<TKey, TValue>`), drive their struct enumerators by hand with two `GetEnumerator()` calls on the concrete types. Avoid `Enumerable.Zip` in hot paths: on .NET 10.0.10 and .NET 11 RC 3 it allocates 144 to 208 bytes per call and, in the benchmark below, ran about 10x slower than the plain loop.

Everything in this post was measured with C# 14 on .NET 10.0.10 (SDK 10.0.302) and .NET 11.0.0-rc.3.26522.148 on an Apple M4. The allocation numbers were identical on both runtimes.

## Where the bytes in Enumerable.Zip come from

`Enumerable.Zip` is the obvious answer to "loop over two sequences together", and since .NET Core 3.0 it has a tuple-returning overload, so the code reads well:

```csharp
// .NET 10, C# 14
long sum = 0;
foreach (var (x, y) in first.Zip(second))
    sum += (long)x * y;
```

The problem is that every piece of that pipeline is a reference type behind an interface. `Zip` takes two `IEnumerable<T>` parameters, so it calls `GetEnumerator()` through the interface on each source. For a `List<T>` that boxes its struct `List<T>.Enumerator`; for an array it allocates an array enumerator object. Then `Zip` itself returns an iterator object that holds both. Your `foreach` talks to that iterator through `IEnumerator<(T1, T2)>`, so every `MoveNext` and `Current` is an interface call that the JIT usually cannot inline.

I measured the steady-state allocations with `GC.GetAllocatedBytesForCurrentThread()` after letting each method tier up to Tier 1 with dynamic PGO, using two 1,000-element `int` sources:

| Approach | Allocated per call (.NET 10.0.10 and 11 RC 3) |
|---|---|
| `for` loop with one index over arrays | 0 B |
| `for` loop over two sliced `ReadOnlySpan<int>` | 0 B |
| `CollectionsMarshal.AsSpan` on two `List<int>` | 0 B |
| `ref struct` zip enumerator with `foreach` | 0 B |
| Two `List<int>.Enumerator` driven manually | 0 B |
| Two `IEnumerator<int>`, sources typed as `IEnumerable<int>` over arrays | 64 B |
| Two `IEnumerator<int>`, sources typed as `IEnumerable<int>` over lists | 80 B |
| `Enumerable.Zip` tuple overload, arrays | 144 B |
| `Enumerable.Zip` with a static result selector, arrays | 160 B |
| `Enumerable.Zip` tuple overload, lists | 160 B |
| `Enumerable.Zip` with three sources, arrays | 208 B |

The cost is per call, not per element, so it does not matter for a loop you run once at startup. It matters when the lockstep loop sits inside a request handler, a game tick, a parser, or anything else that runs millions of times. A few hundred bytes per call, multiplied by the call rate, is exactly the Gen0 churn that shows up in a trace.

Note the static lambda in the selector overload did not help: the delegate is cached, but the iterator and the two enumerators are still allocated.

## The fastest version: one index, two sliced spans

When both sources are contiguous memory, you do not need enumerators at all. One index walks both:

```csharp
// .NET 10, C# 14
static long DotProduct(ReadOnlySpan<int> a, ReadOnlySpan<int> b)
{
    int n = Math.Min(a.Length, b.Length);
    a = a[..n];
    b = b[..n];

    long sum = 0;
    for (int i = 0; i < a.Length; i++)
        sum += (long)a[i] * b[i];
    return sum;
}

int[] prices = [10, 20, 30];
int[] quantities = [3, 2, 1];
long total = DotProduct(prices, quantities); // 100
```

The slicing is not decoration. The loop condition is `i < a.Length`, which lets the JIT drop the bounds check on `a[i]`. After `b = b[..n]` with the same `n`, the JIT also knows `b.Length == a.Length`, so it can drop the check on `b[i]` too. Without the slice, `b[i]` keeps a bounds check on every iteration, because nothing in the loop proves `b` is at least as long as `a`. This is the same "make the length the loop bound" rule I covered in [what Span<T> is and when it actually makes code faster](/2026/06/what-is-span-and-when-does-it-make-my-code-faster/).

Arrays convert to `ReadOnlySpan<T>` implicitly, so call sites stay clean. For `List<T>`, take the span over its backing array with `CollectionsMarshal.AsSpan`:

```csharp
// .NET 10, C# 14
using System.Runtime.InteropServices;

List<int> prices = [10, 20, 30];
List<int> quantities = [3, 2, 1];

long total = DotProduct(
    CollectionsMarshal.AsSpan(prices),
    CollectionsMarshal.AsSpan(quantities));
```

`CollectionsMarshal.AsSpan` is free: it returns a span over the list's internal array, limited to `Count`. The catch is that the span does not know about the list anymore. If you `Add` to the list while holding the span and the list grows, the span keeps pointing at the old array, and you will read stale data with no exception. Do not mutate the list's size while the span is alive. The [List<T> vs Span<T> vs ReadOnlySpan<T>](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) comparison goes into the rest of that trade-off.

To write into one of the sequences while reading the other, make the target a `Span<T>` instead of a `ReadOnlySpan<T>`. The pattern does not change.

## Keeping foreach syntax with a ref struct zip enumerator

The index loop is fast but it is not pretty, and when the body is more than one line, `a[i]` and `b[i]` get noisy. C#'s `foreach` is pattern-based: it does not require `IEnumerable<T>`, only a `GetEnumerator()` method returning something with `MoveNext()` and `Current`. That something can be a `ref struct`, which means it can hold spans and can never be boxed:

```csharp
// .NET 10, C# 14
public ref struct SpanZip<T1, T2>
{
    private readonly ReadOnlySpan<T1> _first;
    private readonly ReadOnlySpan<T2> _second;
    private int _index;

    public SpanZip(ReadOnlySpan<T1> first, ReadOnlySpan<T2> second)
    {
        _first = first;
        _second = second;
        _index = -1;
    }

    public SpanZip<T1, T2> GetEnumerator() => this;

    public bool MoveNext()
    {
        int i = _index + 1;
        if ((uint)i < (uint)_first.Length && (uint)i < (uint)_second.Length)
        {
            _index = i;
            return true;
        }
        return false;
    }

    public (T1 First, T2 Second) Current => (_first[_index], _second[_index]);
}

public static class SpanZipExtensions
{
    public static SpanZip<T1, T2> ZipSpan<T1, T2>(
        this ReadOnlySpan<T1> first, ReadOnlySpan<T2> second) => new(first, second);
}
```

Usage reads like LINQ:

```csharp
// .NET 10, C# 14
int[] prices = [10, 20, 30];
int[] quantities = [3, 2, 1];

long total = 0;
foreach (var (price, quantity) in prices.ZipSpan(quantities))
    total += (long)price * quantity;
```

The returned tuple is a `ValueTuple`, a struct, so deconstructing it costs nothing on the heap. Calling a `ReadOnlySpan<T>` extension method directly on an `int[]`, with the type arguments inferred, relies on C# 14's first-class span conversions; on C# 13 you would write `prices.AsSpan()` first. With a `List<T>`, call it on `CollectionsMarshal.AsSpan(list)`.

The `MoveNext` shape matters more than it looks. My first version sliced both spans to the common length in the constructor and only compared `_index` against `_first.Length` in `MoveNext`. That was correct, but it ran at almost exactly 2x the cost of the plain loop. Checking both lengths in `MoveNext` brought it down to 1.23x. My reading of the result is that once `MoveNext` and `Current` are inlined, the JIT sees both comparisons right before the two indexer calls and can use them to drop bounds checks; a slice done in another method does not give it that fact. Either way, the measured difference is large, so keep both checks.

Two restrictions come with `ref struct`: you cannot use `SpanZip` across an `await` or `yield return`, and you cannot store it in a field of a normal class. If the compiler complains about lifetime, the rules are the ones described in [how C# decides ref-safe-context](/2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals/).

## When the sources are not indexable

`HashSet<T>`, `Dictionary<TKey, TValue>`, `Queue<T>`, `LinkedList<T>` and friends cannot give you a span, but every one of them exposes a public struct enumerator when you call `GetEnumerator()` on the concrete type. Drive two of them yourself:

```csharp
// .NET 10, C# 14
static long SumProducts(List<int> a, List<int> b)
{
    long sum = 0;
    using var ea = a.GetEnumerator();   // List<int>.Enumerator, a struct
    using var eb = b.GetEnumerator();
    while (ea.MoveNext() && eb.MoveNext())
        sum += (long)ea.Current * eb.Current;
    return sum;
}
```

This measured 0 B per call. The important detail is the static type of the parameters. Change `List<int>` to `IEnumerable<int>` and the exact same body allocates 80 B per call (two boxed `List<int>.Enumerator` instances), or 64 B when the runtime objects are arrays. The `var` hides this: `ea` is `List<int>.Enumerator` in one version and `IEnumerator<int>` in the other.

Struct enumerators also keep the collection's own safety checks. `List<T>.Enumerator` throws `InvalidOperationException` if the list is modified during enumeration, which the span-based versions cannot do.

Order is the other trap here. A lockstep walk over two `HashSet<T>` or `Dictionary<TKey, TValue>` instances pairs elements by internal bucket order, which is not insertion order and is not stable across different instances with the same contents. Zip ordered collections only. If you are really trying to match items by key, that is a join or a dictionary lookup, not a zip.

## What .NET 10's stack allocation does and does not fix

.NET 10 taught the JIT to devirtualize array interface methods and, through conditional escape analysis, to stack-allocate enumerators "in certain scenarios", as the [What's new in .NET 10 runtime](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime#array-enumeration-de-abstraction) page puts it. It is reasonable to hope that this makes the interface versions free. In my runs it did not:

- The `Enumerable.Zip` variants allocated the same bytes on .NET 10.0.10 and .NET 11 RC 3. The enumerators are created inside `Zip`'s iterator, which escapes to the caller, so escape analysis has nothing to work with.
- Two `IEnumerator<int>` over arrays allocated 64 B in my steady-state probe and 32 B under BenchmarkDotNet. That suggests the JIT stack-allocated one of the two enumerators in some compilations and neither in others. That is an optimization you cannot rely on, and it is never zero.

The de-abstraction work is real and it does help single-sequence `foreach` over an array typed as `IEnumerable<T>`. If you want the background, [.NET 10's stack allocation of small arrays](/2025/04/net-10-stack-allocation-of-arrays-of-value-types/) covers the related array work. It just does not cover the two-source case yet.

## The numbers

BenchmarkDotNet 0.15.8, `[MemoryDiagnoser]`, in-process toolchain, .NET 10.0.10 Arm64 RyuJIT, Apple M4, two arrays (or lists) of 1,000 `int` values, computing a sum of products:

| Method | Mean | Ratio | Allocated |
|---|---:|---:|---:|
| `for` with one index over arrays | 247.9 ns | 1.00 | 0 B |
| `for` over two sliced `ReadOnlySpan<int>` | 249.7 ns | 1.01 | 0 B |
| `CollectionsMarshal.AsSpan` on two lists | 250.9 ns | 1.01 | 0 B |
| `SpanZip` with both lengths checked in `MoveNext` | 310.0 ns | 1.23 | 0 B |
| `SpanZip` sliced in the constructor (first draft) | 489.6 ns | 1.97 | 0 B |
| Two `List<int>.Enumerator` driven manually | 652.5 ns | 2.63 | 0 B |
| Two `IEnumerator<int>` over arrays | 1,621.2 ns | 6.54 | 32 B |
| `Enumerable.Zip` with a static selector | 2,535.9 ns | 10.23 | 160 B |
| `Enumerable.Zip` tuple overload | 2,613.6 ns | 10.54 | 144 B |

The `SpanZip` row with both checks comes from a second run of the same benchmark class, where the `for` baseline measured 251.4 ns, so the ratio is against that run's baseline. The in-process toolchain was needed because BenchmarkDotNet cannot generate its usual separate project for a file-based `dotnet run bench.cs` app.

Two readings of the table. First, everything span-shaped lands within noise of the hand-written loop; `CollectionsMarshal.AsSpan` adds nothing measurable. Second, "allocation-free" and "fast" are different properties: the manual struct enumerators allocate nothing but still cost 2.6x, because `List<T>.Enumerator.MoveNext` carries a version check and a bounds check per element. If your concern is GC pressure, any zero-allocation row solves it. If your concern is throughput, use spans.

## Choosing between them

- Both sources are arrays, lists, `ImmutableArray<T>`, `Memory<T>`, or stack buffers: use the sliced-span `for` loop, or `SpanZip` if you prefer `foreach` and can afford about 20% on a tight numeric loop. For a loop body that does real work, that 60 ns per thousand elements disappears.
- Sources are other BCL collections: hold them by their concrete type and drive the struct enumerators. Never let them pass through an `IEnumerable<T>` parameter first.
- Lengths may differ and that is a bug: check `a.Length != b.Length` and throw before the loop. `Enumerable.Zip`, the span loop above, and `SpanZip` all silently stop at the shorter sequence, and the BCL has no strict zip; I checked the .NET 11 RC 3 reference assemblies and `Enumerable.Zip` is still the only zip in the box.
- Three or more sources: the span loop extends trivially (slice all three to the minimum length). `Enumerable.Zip`'s three-source overload, added in .NET 6, costs 208 B per call.
- Cold code, small inputs, or a LINQ pipeline that already allocates: keep `Enumerable.Zip`. It is the clearest version and the bytes do not matter there.

If you are migrating a lot of LINQ to spans, remember that C# 14 changed how array arguments bind to span overloads; [the implicit span conversions in C# 14](/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) explain why a call that used to pick an `IEnumerable<T>` overload may now pick a span one.

### Read next

- [What is Span<T> in C#, and when does it actually make your code faster?](/2026/06/what-is-span-and-when-does-it-make-my-code-faster/)
- [List<T> vs Span<T> vs ReadOnlySpan<T> in C#](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)
- [What is ref-safe-context in C#, and how does the compiler decide it for ref locals?](/2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals/)
- [.NET 10: stack allocation of arrays of value types](/2025/04/net-10-stack-allocation-of-arrays-of-value-types/)

### Sources

- [Enumerable.Zip method](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.zip) (Microsoft Learn)
- [CollectionsMarshal.AsSpan method](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan) (Microsoft Learn)
- [The foreach statement and pattern-based enumeration](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/iteration-statements#the-foreach-statement) (C# language reference)
- [ref struct types](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/ref-struct) (C# language reference)
- [What's new in .NET 10 runtime: array enumeration de-abstraction and stack allocation](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime)
- [.NET 10 de-abstraction plans, dotnet/runtime#108913](https://github.com/dotnet/runtime/issues/108913)
