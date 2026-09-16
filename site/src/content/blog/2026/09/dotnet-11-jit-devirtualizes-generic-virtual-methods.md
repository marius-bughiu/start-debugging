---
title: "The .NET 11 JIT Devirtualizes Generic Virtual Methods, and the Allocation Goes With Them"
description: "Stephen Toub's Performance Improvements in .NET 11 post shows generic virtual method calls dropping from 6.7 ns and 24 bytes to 1.8 ns and zero allocation. Three RyuJIT pull requests unlocked inlining on the dispatch that used to be the most opaque one in .NET."
pubDate: 2026-09-16
tags:
  - "dotnet"
  - "dotnet-11"
  - "jit"
  - "performance"
  - "csharp"
---

Stephen Toub published ["Performance Improvements in .NET 11"](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-11/) on September 15, 2026, and buried in the deabstraction section is a change that has been blocked for years: RyuJIT can now devirtualize generic virtual methods.

GVMs have been the slowest dispatch shape in .NET for a long time, and for a structural reason. A normal virtual method has a vtable slot, so the JIT knows where to look. `int SizeOf<T>(T value)` declared on an interface has no single slot, because every instantiation is a different method body keyed by the type arguments. Resolving one means a runtime lookup, and to the JIT the result is an opaque function pointer. Opaque means no inlining, and no inlining means escape analysis never gets to see through the call.

## The benchmark from the post

```csharp
[Benchmark]
public int NonShared() => ((IProcessor)new Processor()).SizeOf(42);

[Benchmark]
public int Shared() => ((IProcessor)new Processor()).SizeOf("hello");

private interface IProcessor
{
    int SizeOf<T>(T value);
}

private sealed class Processor : IProcessor
{
    public int SizeOf<T>(T value) => Unsafe.SizeOf<T>();
}
```

`NonShared` instantiates over `int`, so the runtime compiles a dedicated body. `Shared` instantiates over `string`, which uses the shared reference-type body and therefore needs a generic context argument threaded through the call. Both used to be slow:

| Method | Runtime | Mean | Ratio | Allocated |
| --- | --- | --- | --- | --- |
| NonShared | .NET 10.0 | 6.678 ns | 1.00 | 24 B |
| NonShared | .NET 11.0 | 1.764 ns | 0.26 | 0 B |
| Shared | .NET 10.0 | 7.166 ns | 1.00 | 24 B |
| Shared | .NET 11.0 | 1.764 ns | 0.25 | 0 B |

## Three pull requests, in order

[dotnet/runtime#120866](https://github.com/dotnet/runtime/pull/120866) landed first, in November 2025, and it is the unblocking one. The JIT used to spill the `ldvirtftn` call target into a temporary before setting up arguments, which was enough to keep the dispatch opaque through the rest of the pipeline. Removing the spill let target evaluation move ahead of argument evaluation where that is legal.

[dotnet/runtime#122023](https://github.com/dotnet/runtime/pull/122023) then taught the JIT to devirtualize non-shared GVMs, carrying the generic context that the call needs so the indirect dispatch becomes a direct, inlineable call. [dotnet/runtime#128702](https://github.com/dotnet/runtime/pull/128702) extended that to shared GVMs and to default interface implementations that require instantiating stubs, which is why the `Shared` row lands on the same 1.764 ns as `NonShared`.

## Why the 24 bytes disappear

The allocation was never the point of the call. `new Processor()` exists only so the interface cast has a receiver. In .NET 10, the opaque call meant the JIT had to assume the receiver escaped, so `Processor` went on the heap: 24 bytes per invocation.

Once the call inlines, escape analysis can prove the object never leaves the frame. The instance is stack allocated, nothing reads it, and it folds away entirely. `Unsafe.SizeOf<T>()` becomes a constant in the same pass. The 3.8x speedup is real, but the zero in the Allocated column is the part that shows up in a GC-heavy service.

One caveat: this needs the JIT to know the exact receiver type at the call site, as it does here with a locally constructed `sealed` type. For a genuinely polymorphic call site you are still relying on guarded devirtualization from [dynamic PGO](/2026/07/what-is-pgo-in-dotnet-and-do-i-need-to-opt-in/), which gets you a type check plus an inlined fast path rather than a direct call.

If you write visitor interfaces, generic serializer hooks, or any abstraction where the method rather than the type carries the type parameter, this is the .NET 11 change worth measuring on your own code. The [full post](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-11/) has the disassembly.
