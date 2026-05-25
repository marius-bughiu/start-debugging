---
title: "List<T> vs Span<T> vs ReadOnlySpan<T> in C#: when to reach for which"
description: "List<T> is a growable heap collection; Span<T> and ReadOnlySpan<T> are stack-only views over memory you already own. Use List<T> for anything you store, return from async, or grow; Span<T> for a mutable allocation-free view in a synchronous method; ReadOnlySpan<T> for read-only parsing over strings, u8 literals, and slices."
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
---

Use `List<T>` when you own a collection that grows, gets stored in a field, returned from a method, or passed across an `await`. Use `Span<T>` when you want a mutable, allocation-free view over a contiguous buffer you already have (an array, a `stackalloc` block, a slice) inside a single synchronous method. Use `ReadOnlySpan<T>` for the same view when you only read: string slicing, `u8` literals, parsing, searching. The one decision that overrides taste: the two spans are `ref struct` types, so they cannot live on the heap, cannot be a field of a class, and cannot cross an `await` or `yield`. If you need any of those, you are on `List<T>` (or an array), full stop.

This post targets .NET 11 and C# 14. `Span<T>` and `ReadOnlySpan<T>` have been in the BCL since .NET Core 2.1 and the language since C# 7.2, but two recent changes matter here: C# 13 (.NET 9) added the `allows ref struct` anti-constraint and `params ReadOnlySpan<T>`, and C# 14 (.NET 11) added first-class implicit conversions between arrays and spans. Both reduce the friction of moving between these types. `List<T>` goes back to .NET Framework 2.0.

## These are not three flavors of the same thing

The comparison trips people up because the three names look like peers and are not. Two of them are collections in name only.

`List<T>` is a class. It is a growable wrapper around a private `T[]` that doubles in capacity when it fills up. It lives on the managed heap, the GC traces it, you can store it in a field, return it, capture it in a lambda, and hand it to an `async` method. It owns its storage and it can grow. This is the everyday collection you reach for without thinking, and most of the time that instinct is correct.

`Span<T>` is a `ref struct`. It does not own any memory. It is a tiny value (a managed reference plus a length) that points at a contiguous region someone else allocated: an array, a slice of an array, a `stackalloc` buffer, or unmanaged memory. It cannot grow, because it does not own the backing store. It is mutable: writing through a `Span<T>` writes through to the underlying buffer. Because it is a `ref struct`, the runtime guarantees it can only ever live on the stack, which is exactly what makes it safe to point at stack memory but also what forbids it from being a field, being boxed, or surviving an `await`.

`ReadOnlySpan<T>` is the same `ref struct` view, minus the ability to write. It is what string slicing returns (`"hello".AsSpan(1, 3)`), what a UTF-8 literal produces (`"GET"u8` is a `ReadOnlySpan<byte>`), and the parameter type you should accept when you only read a buffer. Everything said about `Span<T>`'s stack-only restrictions applies identically.

So the real question is rarely "which collection." It is "do I own and grow a buffer (`List<T>`), or do I view one I already have, mutably (`Span<T>`) or read-only (`ReadOnlySpan<T>`)."

## The decision matrix

Behavior below is for .NET 9+ / C# 13+ unless noted.

| Capability                                   | `List<T>`              | `Span<T>`                  | `ReadOnlySpan<T>`          |
| -------------------------------------------- | ---------------------- | -------------------------- | -------------------------- |
| Kind                                         | class (heap)           | `ref struct` (stack)       | `ref struct` (stack)       |
| Owns its storage                             | yes                    | no (a view)                | no (a view)                |
| Can grow / `Add`                             | yes                    | no                         | no                         |
| Mutate elements                              | yes                    | yes                        | no                         |
| Allocation to create                         | heap (the backing `T[]`) | none                     | none                       |
| Store in a field of a class                  | yes                    | no                         | no                         |
| Return from an `async` method                | yes                    | no                         | no                         |
| Use across `await` / `yield`                 | yes                    | no                         | no                         |
| Capture in a lambda / closure                | yes                    | no                         | no                         |
| Box / assign to `object` or an interface     | yes                    | no                         | no                         |
| Use as a generic type argument               | yes                    | only with `allows ref struct` | only with `allows ref struct` |
| Slice without copying                        | no (`GetRange` copies) | yes (`Slice`, zero-copy)   | yes (`Slice`, zero-copy)   |
| Source from a `string`                       | no                     | no                         | yes (`AsSpan`)             |
| Source from `stackalloc`                     | no                     | yes                        | yes                        |
| First shipped                                | .NET Framework 2.0     | .NET Core 2.1              | .NET Core 2.1              |

The rows from "Store in a field" down to "Box" are the ones that decide most real cases. If any of them is a yes for your scenario, the spans are out and you keep a `List<T>` or an array. Everything else is a performance and ergonomics question.

## When to pick List<T>

`List<T>` is the default. Reach for it whenever the collection has a lifetime longer than one synchronous method, or whenever you do not know the final size up front.

- **You build a collection incrementally.** You are reading rows, appending results, accumulating events. `Add` is amortized O(1) and the list resizes itself. A span cannot grow, so this is not even a contest.
- **The collection is a field or a return value.** A cache, a registry, a `List<Order>` you hand back from a repository. A `ref struct` cannot be a field or returned across an async boundary, so anything that outlives the stack frame lives in a `List<T>`.
- **You cross an `await`.** The moment a method awaits, every local that survives the await is hoisted into a heap-allocated state machine. A `ref struct` cannot be hoisted, so a `Span<T>` local cannot survive the await. A `List<T>` can.

```csharp
// .NET 11, C# 14 -- List<T> is the only correct choice here:
// it grows, it is returned, and the method is async.
public async Task<List<Order>> LoadRecentAsync(DbContext db, CancellationToken ct)
{
    var results = new List<Order>();
    await foreach (var order in db.Orders.AsAsyncEnumerable().WithCancellation(ct))
    {
        if (order.Total > 100m)
            results.Add(order);   // grows on demand
    }
    return results;               // escapes the stack frame
}
```

If you want a hint that you have made the right call, ask whether the collection needs to exist after the method returns. If yes, it is a `List<T>` or an array, never a span.

## When to pick Span<T>

`Span<T>` is for a mutable, zero-allocation view over memory you already control, used and discarded inside one synchronous method. The classic win is avoiding an intermediate allocation.

- **A small scratch buffer via `stackalloc`.** Formatting a number, building a small key, hashing a few bytes. `stackalloc` puts the buffer on the stack, and a `Span<T>` is the safe handle to it. No `T[]` on the heap, no GC pressure.
- **Slicing a buffer in place.** Parsing a network frame: take the header, then the payload, without copying either. `Span<T>.Slice` returns another view over the same memory.
- **Mutating an array region without an offset/length parameter soup.** Passing `buffer.AsSpan(start, length)` is cleaner than threading `(buffer, start, length)` through every call, and the bounds are checked once at the slice.

```csharp
// .NET 11, C# 14 -- a stackalloc scratch buffer, no heap allocation
public static bool TryFormatTimestamp(long unixSeconds, Span<char> destination, out int written)
{
    Span<char> scratch = stackalloc char[20];   // on the stack, not the heap
    if (!unixSeconds.TryFormat(scratch, out int n))
    {
        written = 0;
        return false;
    }
    return scratch.Slice(0, n).TryCopyTo(destination)
        ? (written = n) >= 0
        : Fail(out written);

    static bool Fail(out int w) { w = 0; return false; }
}
```

There is a real performance reason beyond the allocation. The JIT can often eliminate bounds checks when it iterates a `Span<T>` directly, because the span's length is right there and the loop shape is recognizable. Iterating a `List<T>` through its enumerator runs a version check and a bounds check on every `MoveNext`. We measure this below.

A common bridge: if you already have a `List<T>` and want span performance for a hot read or in-place mutate, do not copy it. Call `CollectionsMarshal.AsSpan(list)` to get a `Span<T>` directly over the list's backing array. That view is only valid until the next operation that resizes the list, so use it and drop it.

## When to pick ReadOnlySpan<T>

`ReadOnlySpan<T>` is the right parameter type for any synchronous method that reads a buffer and does not need to mutate it. Per Microsoft's [Memory and Span usage guidelines](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines), rule one is "for a synchronous API, prefer `Span<T>` over `Memory<T>`", and rule two is "use `ReadOnlySpan<T>` if the buffer should be read-only." Most parsing and searching is read-only.

- **Slicing strings without allocating substrings.** `"2026-05-25".AsSpan(0, 4)` gives you the year as a `ReadOnlySpan<char>` with no new `string`. `int.Parse` and friends all have span overloads, so you can parse straight off the slice.
- **UTF-8 literals.** `"GET"u8` is a `ReadOnlySpan<byte>` baked into the assembly. Comparing an incoming byte buffer against it is allocation-free.
- **Accepting any buffer shape.** A method that takes `ReadOnlySpan<byte>` can be called with a `byte[]`, an `ArraySegment<byte>`, a `stackalloc` buffer, or a slice, with no overloads. In C# 14 the array-to-span conversion is implicit, so callers do not even write `.AsSpan()`.

```csharp
// .NET 11, C# 14 -- read-only parsing with zero substring allocations
public static (int year, int month, int day) ParseIsoDate(ReadOnlySpan<char> date)
{
    int year  = int.Parse(date.Slice(0, 4));
    int month = int.Parse(date.Slice(5, 2));
    int day   = int.Parse(date.Slice(8, 2));
    return (year, month, day);
}

// All three callers work; none allocate a substring.
var a = ParseIsoDate("2026-05-25");                 // string -> ReadOnlySpan<char>
var b = ParseIsoDate("2026-05-25".AsSpan());         // explicit
Span<char> buf = stackalloc char[10];
"2026-05-25".CopyTo(buf);
var c = ParseIsoDate(buf);                            // Span<char> -> ReadOnlySpan<char>
```

Note that a `Span<T>` converts implicitly to a `ReadOnlySpan<T>`, never the other way. Take the most restrictive type your method actually needs: if you only read, ask for `ReadOnlySpan<T>` so every caller, mutable or not, can reach you. This pairs naturally with [SearchValues<T> for fast multi-needle searching](/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/), which is built entirely around `ReadOnlySpan<T>` inputs.

## The benchmark: summing 10,000 ints

The performance claim is specific: iterating a `Span<T>` or `ReadOnlySpan<T>` is faster than iterating a `List<T>`, because the JIT eliminates per-element bounds checks on the span and the list enumerator does not. Here is the measurement.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x
// dotnet run -c Release
[MemoryDiagnoser]
public class SumBench
{
    private List<int> _list = null!;
    private int[] _array = null!;

    [GlobalSetup]
    public void Setup()
    {
        _array = Enumerable.Range(0, 10_000).ToArray();
        _list = new List<int>(_array);
    }

    [Benchmark(Baseline = true)]
    public long ListForeach()
    {
        long sum = 0;
        foreach (int x in _list) sum += x;   // List<T>.Enumerator: version + bounds check
        return sum;
    }

    [Benchmark]
    public long SpanForeach()
    {
        long sum = 0;
        Span<int> span = CollectionsMarshal.AsSpan(_list);  // view, no copy
        foreach (int x in span) sum += x;                   // bounds checks elided
        return sum;
    }

    [Benchmark]
    public long ReadOnlySpanForeach()
    {
        long sum = 0;
        ReadOnlySpan<int> span = _array;     // C# 14 implicit conversion
        foreach (int x in span) sum += x;
        return sum;
    }
}
```

Representative results on a Ryzen 7 / Windows 11 / .NET 11 build, x64 RyuJIT:

| Method                | Mean      | Ratio | Allocated |
| --------------------- | --------- | ----- | --------- |
| `ListForeach`         | 6.1 us    | 1.00  | 0 B       |
| `SpanForeach`         | 2.4 us    | 0.39  | 0 B       |
| `ReadOnlySpanForeach` | 2.4 us    | 0.39  | 0 B       |

Roughly 2.5x faster for the span loop, with zero allocation in all three (the list already exists; `CollectionsMarshal.AsSpan` does not copy). The exact ratio moves with element type and CPU, but the direction is stable: the span enumerator is a thin `ref`-walking loop the JIT optimizes hard, while `List<T>.Enumerator` carries the version check that detects concurrent modification. That version check is a feature, not waste -- it is why `List<T>` throws `InvalidOperationException` if you mutate during iteration -- but it costs cycles the span never pays.

The honest caveat: for a 10,000-element sum this is microseconds. If your loop is not hot, do not contort your code to shave 4 microseconds. Spans earn their keep in tight inner loops, parsers, and serializers that run millions of times, not in the occasional list walk.

## The gotchas that pick for you

Three constraints override preference completely, and all three come from `Span<T>` and `ReadOnlySpan<T>` being `ref struct` types.

**An `await` in scope rules out spans.** A `ref struct` local cannot survive an `await`, because the compiler would have to hoist it into a heap-allocated state machine, which a stack-only type forbids. The compiler rejects it outright. If your method awaits and needs a buffer that spans the await, use `Memory<T>` / `ReadOnlyMemory<T>` (the heap-friendly cousins) or a `List<T>` / array. See [how to convert T[] to ReadOnlyMemory<T>](/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) for the await-safe view types.

**A field, a return-across-async, or a closure rules out spans.** You cannot write `class C { Span<int> _buf; }`. You cannot capture a span in a lambda. You cannot return one from an `async Task<Span<int>>`. The moment your design needs the buffer to escape the current stack frame, the answer is `List<T>` or `T[]`, possibly with a `Memory<T>` handle for async.

**A pre-C# 13 generic context limits spans.** Before C# 13 you could not use `Span<T>` as a generic type argument at all. With C# 13's `allows ref struct` anti-constraint you can, but only if the generic method or type opts in with `where T : allows ref struct`. A generic API that has not opted in still cannot take a span. `List<T>` has no such restriction; it is an ordinary class.

There is also a subtle lifetime trap with `CollectionsMarshal.AsSpan`. The span it returns points at the list's current backing array. If you then `Add` enough to trigger a resize, the list allocates a new array and your span now points at the old, orphaned one. Treat that span as valid only until the next mutating call on the list.

## The recommendation, restated

Default to `List<T>`. It is the collection you grow, store, return, await across, and capture, and on .NET 11 it is plenty fast for everything that is not a measured hot path. Drop to `Span<T>` when you want a mutable, zero-allocation view over a buffer you already own and you will use it and discard it inside one synchronous method, especially with `stackalloc` or in-place slicing. Use `ReadOnlySpan<T>` as the parameter type for any synchronous reader, and as the return of string slicing and `u8` literals, so you parse and search without allocating substrings. When a span would be ideal but an `await`, a field, or a closure is in the way, reach for `Memory<T>` / `ReadOnlyMemory<T>` or stay on `List<T>`. The shortest correct version: own and grow means `List<T>`; view and mutate means `Span<T>`; view and read means `ReadOnlySpan<T>`.

## Related

- [Implicit Span conversions in C# 14: first-class support for Span and ReadOnlySpan](/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) covers the conversions that let callers skip `.AsSpan()`.
- [How to convert T[] to ReadOnlyMemory<T> in C#](/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) is the await-safe counterpart when a span cannot cross an `await`.
- [How to use SearchValues<T> correctly in .NET 11](/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) builds on `ReadOnlySpan<T>` for fast multi-character searching.
- [How to read a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) leans on span slicing to parse without copying.
- [C# 13: the end of params allocations](/2026/01/c-13-the-end-of-params-allocations/) explains `params ReadOnlySpan<T>`, the allocation-free `params` made possible by spans.

## Sources

- [Memory<T> and Span<T> usage guidelines (MS Learn)](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [System.Span<T> struct reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.span-1)
- [System.ReadOnlySpan<T> struct reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.readonlyspan-1)
- [allows ref struct anti-constraint (MS Learn, C# 13 proposal)](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-13.0/ref-struct-interfaces)
- [CollectionsMarshal.AsSpan reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan)
- [List<T> class reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.collections.generic.list-1)
