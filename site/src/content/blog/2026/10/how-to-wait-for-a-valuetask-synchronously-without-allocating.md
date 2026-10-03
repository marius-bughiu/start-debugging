---
title: "How to wait for a ValueTask synchronously in a non-async method without allocating"
description: "Check IsCompleted first and read the result through GetAwaiter().GetResult(), which costs 0 bytes. Only fall back to blocking when the ValueTask is still pending, and do that with a cached event and UnsafeOnCompleted instead of AsTask(), which allocates 72 to 208 bytes per call. Measured on .NET 10 and .NET 11 RC1."
pubDate: 2026-10-03
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "valuetask"
  - "performance"
---

To read a `ValueTask<T>` from a synchronous method without allocating, check `IsCompleted` first. If it is already done, call `vt.GetAwaiter().GetResult()` once and you are finished: 0 bytes, about 3 ns. If it is still pending, you have to block. `vt.AsTask().GetAwaiter().GetResult()` is the standard safe fallback, but it allocates a `Task<T>` wrapper on every call. A small helper that spins briefly and then waits on a cached `ManualResetEventSlim` via `UnsafeOnCompleted` blocks with zero allocations. Never call `.Result` or `.GetAwaiter().GetResult()` on a `ValueTask` that has not completed: for `IValueTaskSource`-backed instances that is undefined behaviour, and in practice it throws `InvalidOperationException`. Every number below was measured on an Apple M4 with SDK 10.0.302 (.NET 10, C# 14) and repeated on SDK 11.0.100-rc.1.26425.128 (.NET 11 RC1).

## Why blocking on a ValueTask is different from blocking on a Task

A `Task<T>` is a reference type that supports blocking. `Task.Wait()`, `.Result` and `GetAwaiter().GetResult()` all spin for a moment, then park the thread on an event until the task completes. Calling them on an unfinished `Task` is slow and risky (deadlocks, thread-pool starvation), but the call itself is defined: it waits.

A `ValueTask<T>` is a struct that wraps one of three things: a plain `T` result, a `Task<T>`, or an `IValueTaskSource<T>` plus a `short` token. The third case is the one that breaks blocking. `IValueTaskSource<T>` exposes `GetStatus`, `OnCompleted` and `GetResult`, and nothing in that contract says `GetResult` must wait. The [ValueTask&lt;TResult&gt; docs](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1) list four things you must never do with an instance, including "Using `.Result` or `.GetAwaiter().GetResult()` when the operation hasn't yet completed", and say plainly that if you do, "the results are undefined". Stephen Toub's [ValueTask design post](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/) explains why: the source "need not support blocking until the operation completes, and likely doesn't".

The sources that matter in practice do not support it. `Socket`, `NetworkStream`, `System.IO.Pipelines` and `System.Threading.Channels` all hand out `ValueTask`s backed by pooled `IValueTaskSource` objects, and most hand-written sources use `ManualResetValueTaskSourceCore<T>`, which throws if you ask for the result too early.

## A minimal repro of the undefined case

Here is a pooled source that completes on the thread pool, the same shape `Socket` uses internally:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
using System.Threading.Tasks.Sources;

sealed class PooledSource : IValueTaskSource<int>, IThreadPoolWorkItem
{
    private ManualResetValueTaskSourceCore<int> _core;

    public ValueTask<int> StartAsync()
    {
        _core.Reset();
        ThreadPool.UnsafeQueueUserWorkItem(this, preferLocal: false);
        return new ValueTask<int>(this, _core.Version);
    }

    void IThreadPoolWorkItem.Execute() { Thread.SpinWait(50); _core.SetResult(42); }

    public int GetResult(short token) => _core.GetResult(token);
    public ValueTaskSourceStatus GetStatus(short token) => _core.GetStatus(token);
    public void OnCompleted(Action<object?> c, object? s, short token,
        ValueTaskSourceOnCompletedFlags f) => _core.OnCompleted(c, s, token, f);
}
```

Block on it the way you would block on a `Task`:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
var src = new PooledSource();
int r = src.StartAsync().GetAwaiter().GetResult();
// System.InvalidOperationException:
//   Operation is not valid due to the current state of the object.
```

On both SDKs this throws immediately. `ManualResetValueTaskSourceCore<T>.GetResult` checks whether the operation has completed and throws if not. That is the friendly outcome. A custom source that does not guard this can return `default(T)`, return the result of a previous operation that reused the same pooled object, or corrupt its own state. Code that "works" in development because the operation happens to finish quickly can fail in production under load. The same applies to the non-generic `ValueTask`.

## Step 1: read a completed ValueTask for free

Most `ValueTask` APIs exist because they usually complete synchronously: a cache hit, a buffered read, a channel that already has an item. When that is true, there is nothing to wait for, and the docs allow you to read `.Result` or `GetAwaiter().GetResult()` once the instance has completed. `SocketsHttpHandler` in `System.Net.Http` uses exactly this fast path with `IsCompletedSuccessfully`.

```csharp
// .NET 10 / .NET 11 RC1, C# 14
ValueTask<int> vt = cache.GetAsync(key);

if (vt.IsCompleted)
{
    // Allowed: the operation is finished, and we consume it exactly once.
    int value = vt.GetAwaiter().GetResult();
}
```

Prefer `IsCompleted` plus `GetAwaiter().GetResult()` over `IsCompletedSuccessfully` plus `.Result` in a synchronous helper. `IsCompleted` is also true for faulted and canceled instances, and `GetAwaiter().GetResult()` rethrows the original exception (an `InvalidOperationException` stays an `InvalidOperationException`), the same way `await` would. If you only check `IsCompletedSuccessfully`, a faulted `ValueTask` drops into your slow path and gets wrapped in a `Task` just so you can observe its exception.

Here is what the fast path saves compared with the usual advice to call `AsTask()` first, for a `ValueTask<int>` that already holds the value 42 (200,000 iterations, `GC.GetTotalAllocatedBytes(precise: true)` before and after):

| Approach, already-completed `ValueTask<int>` | .NET 10 | .NET 11 RC1 |
| --- | --- | --- |
| `vt.AsTask().GetAwaiter().GetResult()` | 72 B, ~22 ns | 72 B, ~20 ns |
| `vt.IsCompleted` then `vt.GetAwaiter().GetResult()` | 0 B, ~3 ns | 0 B, ~3 ns |

`AsTask()` on a value-backed `ValueTask` has to manufacture a `Task<T>` through `Task.FromResult`, and the runtime only caches those for a handful of values (`true`, `false`, and small integers from -1 to 8). Your `User` object, or the integer 42, gets a fresh 72-byte task every time. For a value that never needed waiting, that allocation buys nothing.

## Step 2: block on a pending ValueTask without AsTask

When `IsCompleted` is false, you have to wait. The documented safe option is `vt.AsTask().GetAwaiter().GetResult()`, which the [.Result vs GetAwaiter().GetResult() comparison](/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) recommends for exactly this situation. It is correct, but for an `IValueTaskSource`-backed instance `AsTask()` allocates a dedicated `Task<T>` subclass that registers itself with the source, and if the wait lasts long enough for `Task` to stop spinning and park the thread, the blocking machinery allocates a second object for the event.

You can avoid both by using the awaiter directly. The awaiter's `UnsafeOnCompleted` registers a plain `Action` continuation with the underlying source or task and does not capture the `ExecutionContext`. If that `Action` is a cached delegate to a cached `ManualResetEventSlim.Set`, registering it allocates nothing:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
public static class ValueTaskSyncExtensions
{
    [ThreadStatic] private static ManualResetEventSlim? t_event;
    [ThreadStatic] private static Action? t_set;

    public static T WaitSync<T>(this ValueTask<T> task)
    {
        if (task.IsCompleted)
            return task.GetAwaiter().GetResult();   // fast path, 0 bytes

        // Short spin: many pending operations finish within microseconds.
        // Polling IsCompleted calls GetStatus, which may be called repeatedly.
        var spinner = new SpinWait();
        while (!task.IsCompleted && !spinner.NextSpinWillYield)
            spinner.SpinOnce();
        if (task.IsCompleted)
            return task.GetAwaiter().GetResult();

        var mres = t_event ??= new ManualResetEventSlim(false, spinCount: 0);
        var set = t_set ??= mres.Set;
        mres.Reset();

        var awaiter = task.ConfigureAwait(false).GetAwaiter();
        awaiter.UnsafeOnCompleted(set);             // no ExecutionContext capture
        mres.Wait();
        return awaiter.GetResult();                 // consume exactly once
    }

    public static void WaitSync(this ValueTask task)
    {
        if (task.IsCompleted) { task.GetAwaiter().GetResult(); return; }

        var spinner = new SpinWait();
        while (!task.IsCompleted && !spinner.NextSpinWillYield)
            spinner.SpinOnce();
        if (task.IsCompleted) { task.GetAwaiter().GetResult(); return; }

        var mres = t_event ??= new ManualResetEventSlim(false, spinCount: 0);
        var set = t_set ??= mres.Set;
        mres.Reset();

        var awaiter = task.ConfigureAwait(false).GetAwaiter();
        awaiter.UnsafeOnCompleted(set);
        mres.Wait();
        awaiter.GetResult();
    }
}
```

The details that make it correct:

1. **One consumption.** The `ValueTask` is read exactly once, through `GetResult()`, after the continuation has fired. Polling `IsCompleted` does not count as a consumption; it calls `GetStatus` on the source, which is allowed to be called repeatedly before the result is read.
2. **One event per thread.** A blocked thread can only wait on one thing at a time, so a `[ThreadStatic]` event is enough, and nested waits on the same thread cannot happen while that thread is blocked. The cached `Action` delegate is created once per thread too.
3. **`ConfigureAwait(false)`.** Without it, the source would be told to run the continuation on the captured `SynchronizationContext`. On a UI thread that context is the thread you are blocking, so `Set` would never run. With `ConfigureAwait(false)` the continuation runs wherever the source completes.
4. **`UnsafeOnCompleted`, not `OnCompleted`.** The safe variant captures and restores the `ExecutionContext`, which is pointless for a delegate that only sets an event.
5. **Spin before parking.** `Task` blocking spins before it sleeps, and so should this helper. In the first version of my benchmark I parked immediately (`spinCount: 0`, no spin loop), and it was roughly twice as slow as `AsTask()` on short operations because every wait paid for a kernel transition.

## What the numbers say

Same harness, 200,000 iterations for short operations and 2,000 for the 1 ms case, bytes per call measured across all threads:

| Pending `ValueTask<int>` | Approach | .NET 10 | .NET 11 RC1 |
| --- | --- | --- | --- |
| `IValueTaskSource`, completes in microseconds | `AsTask().GetAwaiter().GetResult()` | 80 B | 80 B |
| `IValueTaskSource`, completes in microseconds | `WaitSync()` | 0 B | 0 B |
| `IValueTaskSource`, completes after ~1 ms | `AsTask().GetAwaiter().GetResult()` | 144 B | 208 B |
| `IValueTaskSource`, completes after ~1 ms | `WaitSync()` | 0 B | 0 B |
| `Task`-backed (`Task.Run`) | `AsTask().GetAwaiter().GetResult()` | 72 B | 72 B |
| `Task`-backed (`Task.Run`) | `WaitSync()` | 72 B | 72 B |

The fractional bytes the harness reported for `WaitSync()` (0.1 to 0.3 B per call) are thread-pool bookkeeping, not per-call allocations. The 72 B in the `Task`-backed rows is the `Task<int>` that `Task.Run` itself creates. For a `Task`-backed `ValueTask`, `AsTask()` just returns the wrapped task, so neither approach adds anything there.

Latency is not where the helper wins. On short operations both approaches took between 1 and 6 microseconds per call, with run-to-run noise larger than the difference between them. In the 1 ms case both were within 1% of each other, because the wait dominates. If your goal is speed rather than allocations, the only thing that actually helps is the Step 1 fast path, and after that, not blocking at all.

So the honest summary is: the `IsCompleted` check is free and saves 72 bytes on every synchronous completion, which is the common case for any API that earned its `ValueTask` return type. The blocking helper saves another 80 to 208 bytes on the slow path, which only matters if the slow path is itself hot.

## Gotchas and edge cases

**This does not fix sync-over-async deadlocks.** `ConfigureAwait(false)` on *your* awaiter only controls where *your* continuation runs. If the async method you are blocking on has an `await` without `ConfigureAwait(false)` inside it, and you call `WaitSync()` from a WPF, WinForms, MAUI or classic ASP.NET thread, that inner continuation is queued to the thread you just blocked, and you deadlock exactly as you would with `.Result`. The mechanism and the fixes are in [why blocking on an async method deadlocks](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

**It does not fix thread-pool starvation either.** A thread-pool thread parked in `mres.Wait()` is a thread the pool cannot use to run the very continuation that would wake it. Zero allocations does not mean zero cost. Use this at genuine synchronous seams (a `Dispose` method, a synchronous interface you do not own, a `Stream.Read` override implemented over an async core), not as a way to avoid making a call chain async. If the seam can move, [migrating blocking calls to async all the way up](/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/) is still the real fix.

**Do not touch the ValueTask again after `WaitSync()`.** Once `GetResult` has been called, a pooled source may already be serving a different operation. Copying the struct and awaiting the copy later is the same bug as awaiting it twice. CA2012 ("Use ValueTasks correctly") catches the obvious versions, but not all of them, because the analyzer cannot follow a `ValueTask` through a helper method like this one. The [ValueTask explainer](/2026/06/what-is-valuetask-and-when-is-it-worth-it/) covers the full await-once contract.

**`Preserve()` is not a shortcut.** `ValueTask<T>.Preserve()` returns an instance you can consume multiple times, but for a pending `IValueTaskSource`-backed instance it does that by calling `AsTask()` internally, so it allocates the same wrapper you were trying to avoid.

**Exceptions come out unwrapped.** Because the helper ends in `GetAwaiter().GetResult()`, a faulted operation throws its original exception type, just like `await`. In the harness, a `ValueTask<int>` that threw `InvalidOperationException` after a `Task.Yield()` surfaced as `InvalidOperationException` from `WaitSync()`, not as an `AggregateException`.

**Cancellation surfaces as `OperationCanceledException`.** If the operation was canceled, `GetResult` throws `TaskCanceledException` or `OperationCanceledException` depending on the source. There is no timeout overload in the helper above. If you need one, pass a timeout to `mres.Wait`, and on timeout do not touch the `ValueTask` again: its continuation is still registered and will call `Set` on your thread-static event later, so you must also replace `t_event` and `t_set` with fresh instances before the next wait on that thread.

**If you own the API, consider whether it should be `ValueTask` at all.** A method that is routinely consumed synchronously is a method whose callers are fighting its return type. Either expose a synchronous `TryGet` sibling for the fast path, or go back to `Task<T>` as described in [migrating from ValueTask back to Task](/2026/06/migrate-from-valuetask-back-to-task-when-and-why/).

## The decision in order

1. If you can `await`, `await`. Everything in this post is for synchronous seams you cannot remove.
2. Check `IsCompleted`. If true, `GetAwaiter().GetResult()` once. Zero allocations, original exception type.
3. If it is pending and the call is not hot, `AsTask().GetAwaiter().GetResult()` is correct and boring. Use it.
4. If it is pending and hot enough that 80 to 208 bytes per call shows up in a profiler, use the `WaitSync()` helper above.
5. Never call `.Result` or `GetAwaiter().GetResult()` on a pending `ValueTask`. It is undefined, and with `ManualResetValueTaskSourceCore<T>` it throws.

## Related

- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await in C#](/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) covers the `Task` side of the same question.
- [What is ValueTask and when is it worth it](/2026/06/what-is-valuetask-and-when-is-it-worth-it/) explains `IValueTaskSource` pooling and the await-once rule.
- [Migrate from ValueTask back to Task](/2026/06/migrate-from-valuetask-back-to-task-when-and-why/) is the option when callers keep needing synchronous access.
- [Fix the deadlock when calling .Result or .Wait() on an async method](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) explains why none of this is safe on a UI thread.

## Sources

- [ValueTask&lt;TResult&gt; Struct](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1), Microsoft Learn (remarks on undefined usage)
- [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/), Stephen Toub, .NET Blog
- [IValueTaskSource&lt;TResult&gt; Interface](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.ivaluetasksource-1), Microsoft Learn
- [ManualResetValueTaskSourceCore&lt;TResult&gt; Struct](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.manualresetvaluetasksourcecore-1), Microsoft Learn
- [CA2012: Use ValueTasks correctly](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012), Microsoft Learn
- [ValueTask.cs in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/ValueTask.cs)
