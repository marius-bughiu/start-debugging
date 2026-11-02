---
title: "How to use System.Threading.Lock in .NET"
description: "Use System.Threading.Lock for synchronous critical sections on .NET 9 and later. Understand compiler lowering, async restrictions and Monitor compatibility."
pubDate: 2026-04-30
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
template: "how-to"
---

`System.Threading.Lock` was introduced in .NET 9. Starting with C# 13, a `lock` statement whose expression has that static type uses `EnterScope()` instead of the `Monitor`-based path. It is an option for synchronous, process-local mutual exclusion; existing `lock(object)` code is not automatically migrated.

**Correction — November 2, 2026:** the previous version incorrectly said SyncBlocks are never reclaimed and that `EnterScope()` can span an `await`. It also overstated memory and performance benefits. The compiler examples below were checked with SDK 10.0.302 and C# 14; no .NET 11 execution is claimed.

## A private, strongly typed gate

```csharp
using System.Threading;

public sealed class Counter
{
    private readonly Lock _gate = new();
    private int _value;

    public int Next()
    {
        lock (_gate)
        {
            return ++_value;
        }
    }
}
```

The compiler lowers this lock to a scope that releases the gate even when the body throws. `Lock.Scope` is a `ref struct`; it is not a heap-allocated disposable wrapper. `Lock` itself is a reference type and supports reentrant acquisition by the owning thread. Every successful `Enter()` or `TryEnter()` must have a matching `Exit()` on that thread; use `try/finally` for those manual APIs.

## Do not mix Lock and Monitor

`lock (_gate)` and `Monitor.Enter(_gate)` use different synchronization mechanisms. A `Lock` passed through an `object` or `dynamic` expression uses monitor-based locking unless the lock expression is explicitly cast back to `Lock`. Mixing these paths can leave the protected data unsynchronized.

CS9216 warns about some statically visible conversions in a lock expression, such as `lock ((object)gate)`. It is not a guarantee that every indirect or explicit `Monitor` call will be diagnosed. Keep the gate private and its type visible. Use `using System.Threading;` or the fully qualified type name; `using static System.Threading;` is invalid because `System.Threading` is a namespace.

## Await requires a different approach

An `await` inside a `lock` statement is rejected. A `Lock.Scope` also cannot remain live across an `await`; changing the syntax to `using` does not bypass that restriction:

```csharp
// Does not compile: CS4007 on .NET SDK 10.0.302, C# 14.
using System.Threading;
using System.Threading.Tasks;

public static class InvalidExample
{
    public static async Task InvalidAsync()
    {
        Lock gate = new();
        using (gate.EnterScope())
        {
            await Task.Delay(10);
        }
    }
}
```

Keep synchronous work inside a short critical section. When an operation really must serialize asynchronous work, a shared `SemaphoreSlim(1, 1)` is one suitable option:

```csharp
using System;
using System.Threading;
using System.Threading.Tasks;

public static class AsyncOperations
{
    public static async Task RunExclusiveAsync(
        SemaphoreSlim gate, Func<Task> work, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await work();
        }
        finally
        {
            gate.Release();
        }
    }
}
// Share a SemaphoreSlim(1, 1) between callers of this operation.
```

Do not use `Lock.Enter()`/`Exit()` manually across an `await` either: ownership belongs to the thread, and a continuation may run on another thread. A synchronous lock block that completes before a later await compiled in the checked C# 14 example.

## SyncBlocks and performance

Monitor can use an object header and, when needed, an associated SyncBlock. Contention does not mean every object immediately acquires a permanent SyncBlock. CoreCLR contains cleanup paths, a free SyncBlock pool and a free list for table entries. Reuse of entries is distinct from returning all table capacity to the operating system.

`Lock` avoids using the same object-monitor mechanism for its own acquisition, but that does not establish a fixed object-size saving or a universal throughput multiplier. Benchmark your actual runtime, contention and critical-section workload. Both APIs are reentrant; neither gives a general fairness guarantee.

On older targets without `System.Threading.Lock`, retain an `object` gate or use conditional compilation for .NET 9 and later. Neither `Lock` nor a process-local semaphore coordinates separate processes. Also, a mutable builder such as `ImmutableArray<T>.Builder` is not automatically safe for concurrent mutation merely because its result is immutable.

For async producer/consumer coordination, see [Channels versus BlockingCollection](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## Sources

- [System.Threading.Lock API](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock?view=net-10.0)
- [C# lock statement](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/lock)
- [CoreCLR SyncBlock implementation, .NET 10](https://github.com/dotnet/runtime/blob/v10.0.0/src/coreclr/vm/syncblk.cpp)
- [C# 13 lock-object proposal](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/lock-object.md)
