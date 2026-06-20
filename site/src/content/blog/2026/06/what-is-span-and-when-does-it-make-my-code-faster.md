---
title: "What is Span<T> in C#, and when does it actually make your code faster?"
description: "Span<T> is a stack-only ref struct that points at memory you already own, so it has no backing allocation. It speeds code up in exactly three situations: replacing a heap buffer with stackalloc, slicing without copying, and tight loops where the JIT elides bounds checks. Everywhere else it changes nothing, and across an await it does not compile."
pubDate: 2026-06-20
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
---

`Span<T>` is a stack-only `ref struct` that represents a contiguous region of memory you already own: an array, a slice of one, a `stackalloc` buffer, a piece of a string, or unmanaged memory. It is a managed reference plus a length, nothing more. It does not allocate, it does not copy, and it cannot grow. That is the whole type. The reason people reach for it is speed, but it only makes code faster in three concrete situations: when it lets you replace a heap allocation with `stackalloc`, when it lets you slice a buffer without copying, and when it turns a loop into a shape the JIT can strip bounds checks from. Outside those, a span is a clarity tool, not a performance tool, and forcing it into code that does none of the three buys you nothing. This post targets .NET 11 and C# 14, though `Span<T>` itself has been in the BCL since .NET Core 2.1 and the language since C# 7.2.

The trap is that "use `Span<T>`, it's faster" gets repeated without the second half of the sentence. So let me give you the second half: what the type actually is, the exact mechanisms by which it saves cycles, and the equally important list of cases where dropping a span in changes the generated code by approximately zero.

## A view over memory, not a container

The mental model that fixes most confusion: `Span<T>` is not a collection. It is a window. A `List<T>` or a `T[]` owns its storage, lives on the heap, and the garbage collector tracks it. A `Span<T>` owns nothing. It holds a reference to the start of some memory and a count of how many elements are valid. Create one and no allocation happens, because there is nothing to allocate: the bytes already exist somewhere, and the span just names a stretch of them.

```csharp
// .NET 11, C# 14
int[] numbers = { 10, 20, 30, 40, 50 };

Span<int> all = numbers;          // a view over the whole array, no copy
Span<int> middle = all.Slice(1, 3); // {20, 30, 40}, still the same backing memory

middle[0] = 99;                   // writes THROUGH to numbers[1]
Console.WriteLine(numbers[1]);    // 99
```

`middle` did not copy three integers. It is a reference to `numbers[1]` plus the length `3`. Writing through it writes into the original array, because there is only one array. That aliasing is the entire point: a span is a cheap, typed, bounds-checked handle to memory that lives elsewhere.

Because the runtime guarantees a `ref struct` can only live on the stack, a span is safe to point at stack memory (a `stackalloc` buffer) without the lifetime hazards that a heap reference to stack memory would create. That same guarantee is the source of every restriction the type has, which we will get to. First, the part you came for.

## Where the speed actually comes from

A span makes code faster through three distinct mechanisms. They are independent: a given piece of code might hit one, two, or none of them. If it hits none, the span is doing nothing for your runtime.

### Mechanism 1: it lets you not allocate at all

This is the big one, and it is not really the span doing the work. The span is the safe handle that makes `stackalloc` usable. A small scratch buffer (formatting a number, building a lookup key, hashing a few bytes) traditionally meant a `new byte[n]` or `new char[n]` on the heap, which the GC then has to collect. With `stackalloc`, the buffer lives on the stack frame and vanishes for free when the method returns. The `Span<T>` is how you safely read and write that stack memory.

```csharp
// .NET 11, C# 14 -- format an int to text with zero heap allocation
public static string ToHex(int value)
{
    Span<char> buffer = stackalloc char[8];   // on the stack, not the heap
    value.TryFormat(buffer, out int written, "X");
    return new string(buffer[..written]);     // the only allocation is the final string
}
```

The win is measured in GC pressure, not raw loop speed. Allocate a million tiny throwaway buffers per second and you generate a million objects the gen-0 collector has to walk. Move them to `stackalloc` and that pressure goes to zero. In a hot path, removing allocations is often a bigger end-to-end win than shaving instructions off a loop, because GC pauses touch the whole process, not just your method. This is the same instinct behind [params ReadOnlySpan<T> killing params allocations](/2026/01/c-13-the-end-of-params-allocations/): the fastest allocation is the one that never happens.

### Mechanism 2: it lets you slice without copying

The second mechanism is `Slice`. On a `string`, taking a substring with `Substring` allocates a brand-new `string` and copies the characters. On an array, `GetRange` or LINQ's `Skip`/`Take` materializing to a new collection copies too. A span's `Slice` does neither: it returns another span pointing into the same memory, offset and length adjusted. Zero copy, zero allocation.

```csharp
// .NET 11, C# 14 -- parse "2026-06-20" with no substring allocations
public static (int Year, int Month, int Day) ParseIsoDate(ReadOnlySpan<char> date)
{
    int year  = int.Parse(date.Slice(0, 4));  // no new string
    int month = int.Parse(date.Slice(5, 2));
    int day   = int.Parse(date.Slice(8, 2));
    return (year, month, day);
}

var parsed = ParseIsoDate("2026-06-20");      // string converts to ReadOnlySpan<char> implicitly
```

Every `int.Parse` here reads straight off a slice of the original string. The old `date.Substring(0, 4)` version would allocate three short-lived strings per call. In a parser that runs over millions of lines, that is millions of avoided allocations. The span overloads of `int.Parse`, `DateTime.Parse`, `Guid.Parse`, and friends exist precisely so you can parse off slices without ever materializing a substring. This is the backbone of fast CSV and log parsing, which is why [reading a large CSV without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) leans on span slicing to walk each line in place.

### Mechanism 3: the JIT elides bounds checks in tight loops

The third mechanism is the subtlest and the one people most often invoke without understanding. When you iterate a span with a `for` loop bounded by `span.Length`, the JIT can prove every index is in range and remove the per-element bounds check entirely. It recognizes the pattern `for (int i = 0; i < span.Length; i++)` and knows `span[i]` cannot be out of range, so it drops the comparison-and-branch that would otherwise guard each access. Microsoft's JIT team has spent years teaching RyuJIT to recognize span bounds checks the same way it recognizes array bounds checks, and .NET 10 made the underlying assertion analysis less order-dependent so more loop shapes qualify, as documented in the [Performance Improvements in .NET 10](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-10/) writeup.

Compare that with iterating a `List<T>` through its enumerator. `List<T>.Enumerator.MoveNext` runs a version check on every step (the mechanism that throws `InvalidOperationException` if you mutate the list mid-iteration) plus a bounds check. That version check is a correctness feature, not waste, but it costs cycles a span never pays.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x -- dotnet run -c Release
[MemoryDiagnoser]
public class SumBench
{
    private List<int> _list = null!;

    [GlobalSetup]
    public void Setup() => _list = new List<int>(Enumerable.Range(0, 10_000));

    [Benchmark(Baseline = true)]
    public long ListForeach()
    {
        long sum = 0;
        foreach (int x in _list) sum += x;   // version + bounds check per step
        return sum;
    }

    [Benchmark]
    public long SpanForeach()
    {
        long sum = 0;
        Span<int> span = CollectionsMarshal.AsSpan(_list);  // a view, no copy
        foreach (int x in span) sum += x;                   // bounds checks elided
        return sum;
    }
}
```

Representative results on a Ryzen 7 / Windows 11 / .NET 11 build, x64 RyuJIT:

| Method        | Mean   | Ratio | Allocated |
| ------------- | ------ | ----- | --------- |
| `ListForeach` | 6.1 us | 1.00  | 0 B       |
| `SpanForeach` | 2.4 us | 0.39  | 0 B       |

Roughly 2.5x faster, no allocation in either (the list already exists; `CollectionsMarshal.AsSpan` hands you a span over its backing array without copying). The exact ratio shifts with element type and CPU, but the direction is stable. Notice the unit, though: this is microseconds over 10,000 elements. That number is the whole reason for the next section.

## When Span<T> does nothing for you

Here is the part the cargo-cult version of the advice leaves out. A span only helps when one of those three mechanisms is in play. Drop it into code that triggers none of them and you have written more constrained code for an identical runtime. Worse, you may have made it slower or stopped it compiling.

**You convert to a span and immediately copy out of it.** If your "optimization" is `array.AsSpan().ToArray()` or slicing a span only to `.ToArray()` the result, you allocated anyway. The copy is the cost; the span in front of it bought nothing. The win from mechanism 2 exists only as long as you keep reading through the view.

**The loop is not hot.** Mechanism 3 saved 3.7 microseconds across 10,000 elements. If that loop runs once per web request, or a few hundred times total, you will never measure the difference against network and database latency that dwarf it by five orders of magnitude. Contorting readable code to shave microseconds off a cold path is a net loss: you pay in clarity and constraints for a speedup nobody can observe. Spans earn their keep in parsers, serializers, and inner loops that run millions of times, not in the occasional collection walk.

**You already had an array and you only read it sequentially.** A plain `foreach` over a `T[]` already gets bounds-check elision from the JIT; arrays are the original case that optimization was built for. Wrapping the array in a span first does not make the loop faster, because the array loop was already fast. The span helps when the source is a `List<T>` (whose enumerator carries the version check) or when you need to slice, not when you already hold an array and walk it start to end.

**You force a `stackalloc` that is too big.** Mechanism 1 only wins for small buffers. `stackalloc` on a large or caller-controlled size risks a stack overflow, which is a crash, not a slow path. The usual guidance is to cap `stackalloc` at a small constant (commonly a few hundred bytes to ~1 KB) and fall back to a pooled or heap array above that. A span over a too-large `stackalloc` is not faster, it is a latent `StackOverflowException`.

The honest test before reaching for a span: which of the three mechanisms am I buying? If you cannot name one, you are reaching for the type out of habit. The [List vs Span vs ReadOnlySpan decision guide](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) walks the full ownership-and-lifetime axis if you are choosing between them for a specific field or return value.

## The constraints, and why they exist

Every restriction on `Span<T>` follows from one fact: it is a `ref struct`, so the runtime forces it to live only on the stack. That is what makes it safe to point at `stackalloc` memory, and it is non-negotiable.

**It cannot cross an `await` or `yield`.** When a method awaits, the compiler hoists every local that survives the await into a heap-allocated state machine. A stack-only type cannot be hoisted, so the compiler rejects a `Span<T>` local that spans an `await`. This is the constraint people hit first. If you need a buffer across an asynchronous boundary, use `Memory<T>` or `ReadOnlyMemory<T>`, the heap-friendly cousins; [converting an array to ReadOnlyMemory<T>](/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) covers the await-safe view types.

**It cannot be a field of a class, boxed, or captured in a lambda.** You cannot write `class C { Span<int> _buf; }`, cannot assign a span to `object`, and cannot close over one in a closure. Each of those would let the span escape its stack frame, which the type forbids. The moment your design needs the view to outlive the current method, the answer is a `List<T>`, a `T[]`, or a `Memory<T>` handle.

**Generic use needs `allows ref struct`.** Before C# 13 you could not use `Span<T>` as a generic type argument at all. C# 13's `allows ref struct` anti-constraint lifted that, but only for generic methods and types that explicitly opt in with `where T : allows ref struct`. An older generic API that has not opted in still cannot take a span.

**A `CollectionsMarshal.AsSpan` view is valid only until the list resizes.** That span points at the list's current backing array. `Add` enough to trigger a resize and the list allocates a new array, leaving your span pointing at the orphaned old one. Use such a span immediately and drop it; never hold it across a mutating call on the list.

One more nicety landed in C# 14: arrays now convert to spans implicitly, so you write `ReadOnlySpan<char> s = "GET"u8` and pass `myArray` where a span is expected without a visible `.AsSpan()`. The [implicit Span conversions in C# 14](/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) writeup covers exactly which conversions the compiler now does for you.

## The short version

`Span<T>` is a no-allocation, stack-only view over memory you already own. It makes code faster in three specific ways: it lets you replace heap buffers with `stackalloc`, it lets you slice strings and arrays without copying, and it gives the JIT a loop shape it can strip bounds checks from. Those wins are real and large in parsers, serializers, and hot inner loops that run millions of times. They are invisible in cold paths, and they evaporate entirely if you copy back out of the span, if your source is already an array you walk sequentially, or if there is no measured hot loop at all. And because it is a `ref struct`, it stops at the first `await`, field, or closure in your design. Reach for it when you can name which of the three mechanisms you are buying. If you cannot, you are adding constraints for a speedup that is not there.

## Related

- [List<T> vs Span<T> vs ReadOnlySpan<T> in C#: when to reach for which](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) is the decision guide when you are choosing between the three for a specific field or return.
- [How to convert T[] to ReadOnlyMemory<T> in C#](/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) is the await-safe path when a span cannot cross an `await`.
- [How to use SearchValues<T> correctly in .NET 11](/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) builds on `ReadOnlySpan<T>` for SIMD-accelerated multi-needle searching.
- [How to read a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) parses each line in place with span slicing.
- [Implicit Span conversions in C# 14](/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) covers the conversions that let callers skip `.AsSpan()`.

## Sources

- [System.Span<T> struct reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.span-1)
- [Memory<T> and Span<T> usage guidelines (MS Learn)](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Performance Improvements in .NET 10 (.NET Blog)](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-10/)
- [allows ref struct anti-constraint (MS Learn, C# 13)](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-13.0/ref-struct-interfaces)
- [CollectionsMarshal.AsSpan reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan)
