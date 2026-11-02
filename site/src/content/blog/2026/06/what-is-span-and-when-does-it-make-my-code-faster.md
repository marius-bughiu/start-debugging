---
title: "What is Span<T> in C#, and when does it actually make your code faster?"
description: "Span<T> can avoid temporary copies and allocations when parsing or formatting contiguous memory. Learn what it owns, lifetime limits and what to measure."
pubDate: 2026-06-20
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
---

`Span<T>` is a fixed-length view over contiguous memory. It can refer to an array, stack-allocated storage or appropriately managed unmanaged memory. `ReadOnlySpan<T>` provides read-only access through the view; strings expose `ReadOnlySpan<char>`, not a mutable `Span<char>`.

A span does not allocate or own the underlying storage merely by creating a view. That does not make an entire operation allocation-free, nor does it guarantee faster execution.

**Correction — November 2, 2026:** removed unverified timing results and a universal speedup claim; corrected the UTF-8 literal type, return-lifetime restrictions and allocation descriptions. These examples were checked with SDK 10.0.302 and C# 14, without a performance benchmark.

## Avoid temporary substrings

Use span-aware parsers when the alternative creates intermediate strings. This example parses an exact date format without first allocating year, month and day substrings:

```csharp
using System;
using System.Globalization;

string input = "2026-06-01";
DateOnly date = ParseIsoDate(input.AsSpan());
Console.WriteLine(date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));

static DateOnly ParseIsoDate(ReadOnlySpan<char> input) =>
    DateOnly.ParseExact(input, "yyyy-MM-dd", CultureInfo.InvariantCulture);
```

`ParseExact` validates the date and throws for invalid input. Use `TryParseExact` when invalid input is an expected outcome. A simple set of `int.Parse(input.Slice(...))` calls would not, on its own, validate separators or calendar dates.

## Reuse a bounded scratch buffer

```csharp
using System;
using System.Globalization;

Span<char> scratch = stackalloc char[32];
if (12345.TryFormat(scratch, out int written, provider: CultureInfo.InvariantCulture))
{
    ReadOnlySpan<char> formatted = scratch[..written];
    Console.Out.WriteLine(formatted); // 12345
    string owned = new string(formatted); // Allocates the resulting string.
    Console.WriteLine(owned);
}

ReadOnlySpan<byte> method = "GET"u8;
Console.WriteLine(method.SequenceEqual(new byte[] { 71, 69, 84 })); // True
```

The scratch buffer avoids allocating an intermediate character array. Constructing the final `string` still allocates. The byte array in the comparison is also an explicit allocation; it is shown to make the byte values clear, not as a benchmark. A UTF-8 literal such as `"GET"u8` has type `ReadOnlySpan<byte>`.

Use a small bounded `stackalloc` size. Large allocations or repeated allocations in a loop can exhaust the stack; do not derive an unchecked size from request input. Use an array or a carefully managed pooled buffer for larger data.

## A view shares storage and has lifetime restrictions

Slicing a span does not copy elements. An array-backed span can be returned if the backing memory remains valid. A span over a local stack buffer cannot escape that method. Span fields are allowed inside another `ref struct`, not an ordinary class or struct. C# 13 permits ref-struct locals in async methods only where they do not cross an `await`; use `Memory<T>` for a view that must cross it.

`ReadOnlySpan<T>` does not freeze the source buffer. With `CollectionsMarshal.AsSpan(list)`, do not add or remove list items while using the view. These restrictions apply even when the list has spare capacity.

## When to expect a useful improvement

Look for an allocation or copy you can actually remove: substring creation, copied slices or temporary formatting arrays. A normal array or list loop may already be optimized well. Bounds-check elimination and relative throughput depend on the runtime, loop and workload; there is no reliable fixed multiplier for replacing a list loop with a span loop.

Measure equivalent work in Release mode, using the deployed runtime and representative inputs. Keep setup outside the measured operation, include allocations, and retain the benchmark source and output. This article does not present newly measured timing results.

Basic implicit array-to-span conversions predate C# 14. C# 14, shipped with .NET 10, extends their language integration; it did not introduce spans themselves. C# 13's `allows ref struct` only opens generic APIs that explicitly opt in.

For the ownership decision before optimizing, see [List versus Span versus ReadOnlySpan](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/). For asynchronous storage, see [ReadOnlyMemory from an array](/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/).

## Sources

- [Memory and Span usage guidelines](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Span<T>](https://learn.microsoft.com/en-us/dotnet/api/system.span-1?view=net-10.0)
- [CollectionsMarshal.AsSpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan?view=net-10.0)
- [C# 14 first-class span types](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [C# 13 ref struct interfaces and generic arguments](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/ref-struct-interfaces.md)
