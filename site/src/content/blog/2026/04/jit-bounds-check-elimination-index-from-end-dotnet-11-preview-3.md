---
title: "RyuJIT trims more bounds checks in .NET 11 Preview 3: index-from-end and i + constant"
description: ".NET 11 Preview 3 teaches RyuJIT to eliminate redundant bounds checks on consecutive index-from-end access and on i + constant < length patterns, cutting branch pressure in tight loops."
pubDate: 2026-04-19
tags:
  - "dotnet"
  - "dotnet-11"
  - "jit"
  - "performance"
  - "csharp"
---

Bounds check elimination is the JIT optimization that quietly decides how fast a lot of .NET code is. Every `array[i]` and `span[i]` in managed code carries an implicit compare-and-branch, and when RyuJIT can prove the index is in range, that branch goes away. .NET 11 Preview 3 extends that proof to two common patterns that previously paid the check anyway.

Both changes are documented in the [runtime release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/runtime.md) and called out in the [.NET 11 Preview 3 announcement](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) from April 14, 2026.

## Back-to-back index-from-end access

The index-from-end operator `^1`, `^2`, introduced with C# 8, is syntactic sugar for `Length - 1`, `Length - 2`. The JIT has been able to elide the bounds check on the first such access for a while, but a second access right after it was often treated independently and forced a redundant compare-and-branch.

In .NET 11 Preview 3, the range analysis reuses the length proof across consecutive index-from-end accesses:

```csharp
static int TailSum(int[] values)
{
    // .NET 10: two bounds checks, one per access.
    // .NET 11 Preview 3: the JIT proves both are in range from a single length test.
    return values[^1] + values[^2];
}
```

If you disassemble `TailSum` in [Rider 2026.1's ASM viewer](https://blog.jetbrains.com/dotnet/), you can see the second `cmp`/`ja` pair simply disappear. Code that walks the tail of a buffer, ring-buffer accessors, parsers that peek at the last token, or fixed-window comparators, all benefit without a source change.

## `i + constant < length` loops

The second improvement targets a pattern that shows up constantly in numeric and parsing code. A stride-2 loop used to look fine on paper but still paid a bounds check on the second access:

```csharp
static int SumPairs(ReadOnlySpan<int> buffer)
{
    int sum = 0;
    for (int i = 0; i + 1 < buffer.Length; i += 2)
    {
        // buffer[i] is trivially safe, but buffer[i + 1] used to
        // get its own bounds check, even though the loop condition
        // already proved it.
        sum += buffer[i] + buffer[i + 1];
    }
    return sum;
}
```

The loop condition `i + 1 < buffer.Length` already proves `buffer[i + 1]` is in range, but RyuJIT used to treat the two accesses independently. Preview 3 teaches the analysis to reason about an index plus a small constant against a length, so both `buffer[i]` and `buffer[i + 1]` compile to a plain load.

The same rewrite applies to `i + 2`, `i + 3`, and so on, as long as the constant offset matches what the loop condition guarantees. Widen the loop condition to `i + 3 < buffer.Length`, and a stride-4 inner loop becomes bounds-check-free across all four accesses.

## Why small branches add up

A single bounds check costs under a nanosecond on modern CPUs. The real pressure is second-order: the branch slot it consumes, the loop-unrolling decisions it blocks, the vectorization opportunities it defeats. When RyuJIT proves a whole inner loop is bounds-safe, it is free to unroll more aggressively and hand the block to the auto-vectorizer. That is where a 1% micro-win on paper turns into a 10 to 20% improvement on a real numeric kernel.

## Trying it today

Neither optimization needs a feature flag. Run any .NET 11 Preview 3 SDK and they kick in automatically. Set `DOTNET_JitDisasm=TailSum` to dump the generated code, run once on .NET 10 and once on Preview 3, and diff. If you maintain hot loops over arrays or spans, especially anything that peeks at the end of a buffer or walks with a fixed stride, this is a free speedup waiting in Preview 3.
