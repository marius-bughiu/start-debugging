---
title: "Building a Microsecond-Latency Database Engine in C#"
description: "Loic Baumann's Typhon project targets 1-2 microsecond ACID commits using ref structs, hardware intrinsics, and pinned memory, proving C# can compete at the systems programming level."
pubDate: 2026-04-14
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "database"
---

The assumption that high-performance database engines require C, C++, or Rust is deeply ingrained. Loic Baumann's [Typhon project](https://nockawa.github.io/blog/why-building-database-engine-in-csharp/) challenges that directly: an embedded ACID database engine written in C#, targeting 1-2 microsecond transaction commits. The project recently [hit the front page of Hacker News](https://news.ycombinator.com/item?id=47720060), sparking a lively debate about what modern .NET can actually do.

## The Performance Toolkit in Modern C#

Baumann's core argument is that the bottleneck in database engine design is memory layout, not language choice. Modern C# provides the tools to control memory at a level that would have been impossible a decade ago.

`ref struct` types live exclusively on the stack, eliminating heap allocations on hot paths:

```csharp
ref struct TransactionContext
{
    public Span<byte> WriteBuffer;
    public int PageIndex;
    public bool IsDirty;
}
```

For memory regions that must never move, `GCHandle.Alloc` with `GCHandleType.Pinned` keeps the garbage collector out of critical sections. Combined with `[StructLayout(LayoutKind.Explicit)]`, you get C-level control over every byte offset:

```csharp
[StructLayout(LayoutKind.Explicit, Size = 64)]
struct PageHeader
{
    [FieldOffset(0)]  public long PageId;
    [FieldOffset(8)]  public long TransactionId;
    [FieldOffset(16)] public int RecordCount;
    [FieldOffset(20)] public PageFlags Flags;
}
```

## Hardware Intrinsics for Hot Paths

The `System.Runtime.Intrinsics` namespace gives direct access to SIMD instructions. For a database engine scanning pages or computing checksums, this is the difference between "fast enough" and "competitive with C":

```csharp
using System.Runtime.Intrinsics;
using System.Runtime.Intrinsics.X86;

static unsafe uint Crc32Page(byte* data, int length)
{
    uint crc = 0;
    int i = 0;
    for (; i + 8 <= length; i += 8)
        crc = Sse42.Crc32(crc, *(ulong*)(data + i));
    for (; i < length; i++)
        crc = Sse42.Crc32(crc, data[i]);
    return crc;
}
```

## Enforcing Discipline at Compile Time

One of the more interesting aspects of Typhon's approach is using Roslyn analyzers as safety rails. Custom analyzers enforce domain-specific rules (no accidental heap allocations in transaction code, no unchecked pointer arithmetic outside approved modules) at compile time rather than relying on code review.

Constrained generics with `where T : unmanaged` provide another layer, ensuring that generic data structures work only with blittable types that have predictable memory layouts.

## What This Means for .NET

Typhon is not a production database yet. But the project demonstrates that the gap between C# and traditional systems languages has narrowed significantly. Between `Span<T>`, hardware intrinsics, `ref struct`, and explicit memory layout control, .NET 10 gives you the building blocks for performance-critical systems work without leaving the managed ecosystem.

The [full write-up](https://nockawa.github.io/blog/why-building-database-engine-in-csharp/) is worth reading for the architectural details and benchmarks.
