---
title: "How to use the new System.Threading.Lock type in .NET 11"
description: "System.Threading.Lock arrived in .NET 9 and is the default synchronization primitive on .NET 11 and C# 14. This guide shows how to migrate from lock(object), how EnterScope works, and the gotchas around await, dynamic, and downlevel targets."
pubDate: 2026-04-30
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
template: "how-to"
---

The shortest answer: replace `private readonly object _gate = new();` with `private readonly Lock _gate = new();`, leave every `lock (_gate) { ... }` statement exactly as it is, and let the C# 14 compiler bind the `lock` keyword to `Lock.EnterScope()` instead of `Monitor.Enter`. On .NET 11 the result is a smaller object, no sync block inflation, and a measurable throughput win on contended fast paths. The only places you have to think harder are when a block needs to `await`, when the field is exposed via `dynamic`, when you have a `using static` for `System.Threading`, and when the same code has to compile against `netstandard2.0`.

This guide targets .NET 11 (preview 4) and C# 14. `System.Threading.Lock` itself is a .NET 9 type, so everything here works on .NET 9, .NET 10, and .NET 11. The compiler-level pattern recognition that makes `lock` bind to `Lock.EnterScope()` shipped with C# 13 in .NET 9 and is unchanged in C# 14.

## Why `lock(object)` was always a workaround

For nineteen years, the canonical C# pattern for "make this section thread-safe" was a private `object` field plus a `lock` statement. The compiler lowered that to [`Monitor.Enter`](https://learn.microsoft.com/dotnet/api/system.threading.monitor.enter) and `Monitor.Exit` calls against the object's identity. The mechanism worked, but it had three structural costs.

First, every locked region pays for an object header word. Reference types on the CLR managed heap carry an `ObjHeader` plus a `MethodTable*`, totaling 16 bytes on x64 just to exist. The `object` you allocate to lock against has no purpose other than identity. It contributes nothing to your domain model and the GC still has to trace it.

Second, the moment two threads contend on the lock, the runtime inflates the header into a [SyncBlock](https://github.com/dotnet/runtime/blob/main/docs/design/coreclr/botr/sync-block-table.md). The SyncBlock table is a process-wide table of `SyncBlock` entries, each one allocated on demand and never freed until process exit. A long-running service that locks on millions of distinct objects ends up with a SyncBlock table that grows monotonically. This was rare but real, and it was diagnosable only with `dotnet-dump` and `!syncblk`.

Third, `Monitor.Enter` is recursive (the same thread can enter twice and only releases on the matching exit count) and supports `Monitor.Wait` / `Pulse` / `PulseAll`. Most code does not need any of that. It needs mutual exclusion. You were paying for features you never used.

`System.Threading.Lock` is the type Microsoft would have shipped in 2002 if `Monitor` had not also been doing duty as the implementation backing `lock`. The proposal that introduced it ([dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812), accepted in 2024) describes it as "a faster lock with a smaller footprint and clearer semantics." It is a sealed reference type that exposes only what mutual exclusion needs: enter, try-enter, exit, and a check for whether the current thread holds the lock. No `Wait`. No `Pulse`. No object-header magic.

## The mechanical migration

Take a typical legacy cache:

```csharp
// .NET Framework 4.x / .NET 8, C# 12 -- the old shape
public class LegacyCache
{
    private readonly object _gate = new();
    private readonly Dictionary<string, byte[]> _store = new();

    public byte[]? Get(string key)
    {
        lock (_gate)
        {
            return _store.TryGetValue(key, out var v) ? v : null;
        }
    }

    public void Set(string key, byte[] value)
    {
        lock (_gate)
        {
            _store[key] = value;
        }
    }
}
```

Migrate it to .NET 11 by changing exactly one line:

```csharp
// .NET 11, C# 14 -- the new shape, single-line diff
public class ModernCache
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, byte[]> _store = new();

    public byte[]? Get(string key)
    {
        lock (_gate)
        {
            return _store.TryGetValue(key, out var v) ? v : null;
        }
    }

    public void Set(string key, byte[] value)
    {
        lock (_gate)
        {
            _store[key] = value;
        }
    }
}
```

The body of every `lock` statement is unchanged. The compiler sees that `_gate` is a `Lock` and lowers `lock (_gate) { body }` to:

```csharp
// What the compiler emits, simplified
using (_gate.EnterScope())
{
    // body
}
```

`EnterScope()` returns a `Lock.Scope` struct whose `Dispose()` releases the lock. Because `Scope` is a `ref struct`, it cannot be boxed, captured by an iterator, captured by an async method, or stored in a field. That last constraint is what makes the new lock cheap: no allocation, no virtual dispatch, just a stack-local handle.

If you reverse the order (`Lock _gate` but a tool somewhere else does `Monitor.Enter(_gate)`), the C# compiler emits CS9216 starting with C# 13: "A value of type `System.Threading.Lock` converted to a different type will use likely unintended monitor-based locking in `lock` statement." The conversion is allowed (a `Lock` is still an `object`), but the compiler warns you because you have just thrown away every benefit of the new type.

## What `EnterScope` actually returns

You can use the new type without the `lock` keyword if you need to:

```csharp
// .NET 11, C# 14
public byte[] GetOrCompute(string key, Func<string, byte[]> factory)
{
    using (_gate.EnterScope())
    {
        if (_store.TryGetValue(key, out var existing))
            return existing;

        var fresh = factory(key);
        _store[key] = fresh;
        return fresh;
    }
}
```

`EnterScope()` blocks until the lock is acquired. There is also `TryEnter()` (returns a `bool`, no `Scope`) and `TryEnter(TimeSpan)` for time-bounded acquisition. If you call `TryEnter` and it returns `true`, you must call `Exit()` yourself, exactly once, on the same thread. Skip `Exit` and you have leaked the lock; the next acquirer will block forever.

```csharp
// .NET 11, C# 14 -- TryEnter idiom for non-blocking back-pressure
if (_gate.TryEnter())
{
    try
    {
        DoWork();
    }
    finally
    {
        _gate.Exit();
    }
}
else
{
    // back off, reschedule, drop the message, etc.
}
```

`Lock.IsHeldByCurrentThread` is a `bool` property that returns `true` only when the calling thread currently holds the lock. It is meant for `Debug.Assert` calls in invariants; do not use it as a flow-control mechanism. It is `O(1)` but it has acquire-release semantics, so calling it in a hot loop will cost you.

## The await trap, made worse

You could never `await` inside a `lock` statement on `Monitor`. The compiler outright refused with [CS1996](https://learn.microsoft.com/dotnet/csharp/misc/cs1996): "Cannot await in the body of a lock statement." The reason is that `Monitor` tracks ownership by managed thread ID, so resuming an `await` on a different thread would release the lock from the wrong owner.

`Lock` has the same constraint, and the compiler enforces it the same way. Try this:

```csharp
// .NET 11, C# 14 -- DOES NOT COMPILE
public async Task DoIt()
{
    lock (_gate)
    {
        await Task.Delay(100); // CS1996
    }
}
```

You get `CS1996` again. Good. The bigger trap is `using (_gate.EnterScope())` because the compiler does not know the `Scope` came from a `Lock`. As of .NET 11 SDK 11.0.100-preview.4, this code compiles:

```csharp
// .NET 11, C# 14 -- COMPILES, but is broken at runtime
public async Task Broken()
{
    using (_gate.EnterScope())
    {
        await Task.Delay(100);
        // Resumes on a thread-pool thread, which does NOT hold _gate.
        // Disposing the Scope here calls Lock.Exit on a thread that
        // never entered, throwing SynchronizationLockException.
    }
}
```

The fix is the same as it has always been: hoist the lock to wrap only the synchronous critical section, and use `SemaphoreSlim` (which is async-aware) when you genuinely need cross-`await` mutual exclusion. `Lock` is a fast synchronous primitive. It is not, and is not trying to be, an async lock.

## Performance: what actually changed

The .NET 9 release notes claim that contended lock acquisition is roughly 2-3x faster than the equivalent `Monitor.Enter` path, and that uncontended acquisition is dominated by a single interlocked compare-exchange. Stephen Toub's [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) post includes microbenchmarks showing exactly this, and they reproduce on .NET 11.

The savings you can measure in your own service are smaller than the synthetic numbers suggest, because real services rarely spend most of their time inside `lock`. The places you will see a difference:

- **Working set**: every gate goes from "an `object` plus its sync block on contention" to "a `Lock`, which is roughly `object` size plus 8 bytes of state." If you have thousands of gates (one per cache entry, say), the sync block table no longer grows under contention.
- **GC2 traversal**: the `Lock` is still a reference type, but it never inflates an external table the GC has to walk separately.
- **Contended fast path**: the new fast path is a single `CMPXCHG` plus a memory fence. The old path went through `Monitor`, which does several conditional branches before the fence.

What does not change: throughput of the protected section itself, fairness (the new `Lock` is also unfair, with a small amount of starvation prevention layered on), and recursion (`Lock` is recursive on the same thread, identical to `Monitor`).

## Gotchas that will bite you

**`using static System.Threading;`** -- if any file in your project does this, the unqualified name `Lock` becomes ambiguous with any `Lock` class you wrote yourself. The fix is to delete the `using static` or qualify the type explicitly: `System.Threading.Lock`. The compiler will tell you with [CS0104](https://learn.microsoft.com/dotnet/csharp/misc/cs0104) but the error site is wherever you used `Lock`, not where the conflict was introduced.

**`dynamic`** -- a `lock` statement on a `dynamic`-typed expression cannot resolve to `Lock.EnterScope()` because the binding happens at runtime. The compiler emits CS9216 and falls back to `Monitor`. If you have one of those rare `dynamic` codebases, cast to `Lock` before the `lock`:

```csharp
// .NET 11, C# 14
dynamic d = GetGate();
lock ((Lock)d) { /* ... */ } // cast is required
```

**Boxing into `object`** -- because `Lock` derives from `object`, you can pass it to any API that takes `object`, including `Monitor.Enter`. That defeats the new path. CS9216 is your friend; turn it into an error in `Directory.Build.props`:

```xml
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);CS9216</WarningsAsErrors>
</PropertyGroup>
```

**`netstandard2.0` libraries** -- if your library multi-targets `netstandard2.0` and `net11.0`, `Lock` does not exist on the `netstandard2.0` side. You have two options. The clean one is to keep an `object` field on `netstandard2.0` and a `Lock` field on `net11.0`, guarded by a `#if NET9_0_OR_GREATER`:

```csharp
// .NET 11, C# 14 -- multi-target gate
#if NET9_0_OR_GREATER
private readonly System.Threading.Lock _gate = new();
#else
private readonly object _gate = new();
#endif
```

The dirty one is to type-forward `Lock` from a polyfill package; do not do this, it ends in tears when the polyfill diverges from the real type's semantics.

**WPF and WinForms `Dispatcher`** -- the dispatcher's internal queue still uses `Monitor`. You cannot replace its lock. Your application's locks can move; the framework's cannot.

**Source generators that emit `lock(object)`** -- regenerate. CommunityToolkit.Mvvm 9 and several others moved to `Lock` in late 2024. Check the generated file for `private readonly object`; if it is still there, update the package.

## When not to use `Lock`

Do not use `Lock` (or any short-lived mutex) when the answer is "no lock at all." `ConcurrentDictionary<TKey, TValue>` does not need an external gate. `ImmutableArray.Builder` does not. `Channel<T>` does not. The fastest synchronization is the synchronization you do not write.

Do not use `Lock` when the protected section is across an `await`. Use `SemaphoreSlim(1, 1)` and `await semaphore.WaitAsync()`. The overhead is higher per-acquisition but it is the only correct option.

Do not use `Lock` for inter-process or inter-machine coordination. It is intra-process only. Use [`Mutex`](https://learn.microsoft.com/dotnet/api/system.threading.mutex) (named, kernel-backed) or a database row lock or Redis `SETNX` for those.

## Related

- [How to use Channels instead of BlockingCollection in C#](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) covers the producer/consumer pattern that often replaces locks entirely.
- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) is the cancellation companion to this post.
- [.NET 9: The End of lock(object)](/2026/01/net-9-the-end-of-lockobject/) is the news-style introduction to the type, written when .NET 9 shipped.
- [How to write a source generator for INotifyPropertyChanged](/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) shows the kind of generator you may need to update for `Lock` support.

## Source links

- [`System.Threading.Lock` API reference](https://learn.microsoft.com/dotnet/api/system.threading.lock) on Microsoft Learn.
- [dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812) -- the proposal and design discussion.
- [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) by Stephen Toub.
- [What's new in C# 13](https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-13) covers the compiler-level pattern recognition.
