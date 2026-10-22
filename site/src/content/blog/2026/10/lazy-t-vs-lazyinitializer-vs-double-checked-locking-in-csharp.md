---
title: "Lazy<T> vs LazyInitializer.EnsureInitialized vs double-checked locking in C#"
description: "Use Lazy<T> by default: it runs the factory once, caches exceptions, and its reads are too cheap to measure after initialization. Use LazyInitializer.EnsureInitialized when you lazily fill many fields or array slots and cannot afford an extra object per value. Hand-written double-checked locking is almost never worth it on .NET 10."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "performance"
---

Use `Lazy<T>` by default. With the default constructor mode (`ExecutionAndPublication`), it guarantees the factory runs exactly once even under contention, it caches the factory's exception, and once the value exists a read is one null check plus a field load, too cheap for BenchmarkDotNet to measure. Reach for `LazyInitializer.EnsureInitialized` when you have many lazily created values (a field per property on a hot type, or slots in an array) and the extra `Lazy<T>` object per value is the cost you are trying to avoid. Hand-written double-checked locking gives you nothing that `LazyInitializer.EnsureInitialized(ref field, ref syncLock, factory)` does not already give you, so write it only when you need behaviour neither API offers.

Everything below was measured on .NET 10.0.10 (SDK 10.0.302), C# 14, BenchmarkDotNet 0.15.8, on an Apple M4 (arm64). The APIs themselves have not changed shape since .NET Core 3.0, so the advice holds for .NET 8, 9, 10, and 11.

## The comparison at a glance

| | `Lazy<T>` (default) | `LazyInitializer.EnsureInitialized(ref t, f)` | `EnsureInitialized(ref t, ref sync, f)` | Double-checked locking |
| --- | --- | --- | --- | --- |
| Factory runs at most once under contention | Yes | No, every racing thread may run it | Yes | Yes, if written correctly |
| Exception from factory | Cached, rethrown forever | Not cached, next call retries | Not cached, next call retries | Whatever you write |
| Extra allocation per lazy value | `Lazy<T>` object plus a lock helper | None | One lock object, only if contended or first call | One lock object (or shared) |
| Hot read after init (measured) | below 1 ns, unmeasurable | below 1 ns | below 1 ns | below 1 ns |
| One-time create + init (measured) | 13.96 ns, 96 B | 6.19 ns, 48 B | 14.03 ns, 80 B | 8.96 ns, 72 B |
| Works with value types | Yes | No (`where T : class`) | No, use the `ref bool initialized` overload | Yes, with a separate flag |
| Factory may return `null` | Yes | No, throws `InvalidOperationException` | No, throws `InvalidOperationException` | Yes, with a separate flag |
| Re-entrancy from the factory | Throws `InvalidOperationException` | Stack overflow | Stack overflow (`Monitor` is re-entrant) | Depends on the lock type |
| Lines of code you own | 1 | 1 | 2 fields + 1 call | ~10 |

## What each option actually does

### `Lazy<T>`

`Lazy<T>` wraps a factory and a slot. Its `Value` property in .NET 10 is one line:

```csharp
// System.Private.CoreLib, release/10.0, src/System/Lazy.cs
public T Value => _state == null ? _value! : CreateValue();
```

`_state` is a volatile `LazyHelper` reference that describes the mode and, for `ExecutionAndPublication`, doubles as the lock object. The first call goes into `CreateValue`, which takes `lock (executionAndPublication)`, re-checks, runs your factory, stores `_value`, and then sets `_state = null` with a volatile write. Every later call sees `_state == null` and returns the field. That is double-checked locking, written once, by people who have read the memory model spec more carefully than most of us.

The thread-safety mode is picked by the constructor:

```csharp
// .NET 10, C# 14
var a = new Lazy<Config>(LoadConfig);                                          // ExecutionAndPublication
var b = new Lazy<Config>(LoadConfig, isThreadSafe: true);                      // ExecutionAndPublication
var c = new Lazy<Config>(LoadConfig, LazyThreadSafetyMode.PublicationOnly);    // threads race, first publish wins
var d = new Lazy<Config>(LoadConfig, LazyThreadSafetyMode.None);               // single-threaded only
```

### `LazyInitializer.EnsureInitialized`

`LazyInitializer` is a static class that operates on a field you own, through a `ref`. There is no wrapper object. The two-argument overload is, in full:

```csharp
// System.Private.CoreLib, release/10.0, src/System/Threading/LazyInitializer.cs
public static T EnsureInitialized<T>(ref T? target, Func<T> valueFactory) where T : class =>
    Volatile.Read(ref target!) ?? EnsureInitializedCore(ref target, valueFactory);

private static T EnsureInitializedCore<T>(ref T? target, Func<T> valueFactory) where T : class
{
    T value = valueFactory() ?? throw new InvalidOperationException(SR.Lazy_StaticInit_InvalidOperation);
    Interlocked.CompareExchange(ref target, value, null!);
    return target;
}
```

No lock. Every thread that sees `null` runs the factory, and `CompareExchange` decides whose result gets stored. Losers' objects are dropped on the floor (and the docs point out that the method "will not dispose of the objects that were not stored"). This is `PublicationOnly` semantics without the wrapper.

The three-argument overload, `EnsureInitialized(ref target, ref syncLock, valueFactory)`, adds a lock. It lazily creates a plain `object` into `syncLock` with `CompareExchange`, then does `lock (syncLock) { if (Volatile.Read(ref target) == null) Volatile.Write(ref target, valueFactory()); }`. That is textbook double-checked locking, and it runs the factory once.

For value types, or when `null` is a legitimate result, there are overloads with an extra `ref bool initialized` flag. They always take the lock path.

### Hand-written double-checked locking

The correct modern version on .NET 9 and later, using the `System.Threading.Lock` type:

```csharp
// .NET 10, C# 14
public sealed class ReportCache
{
    private volatile Report? _report;
    private readonly Lock _lock = new();

    public Report Report
    {
        get
        {
            var r = _report;               // one volatile read on the fast path
            if (r is not null) return r;
            lock (_lock)
            {
                return _report ??= BuildReport();
            }
        }
    }

    private static Report BuildReport() => new();
}

public sealed class Report;
```

The `volatile` is doing real work. The .NET memory model spec (`docs/design/specs/Memory-model.md` in dotnet/runtime) does say that storing an object reference to shared memory is a release and that data-dependent reads through it are ordered, so the classic "half-constructed object" bug cannot happen on CoreCLR. But it also explicitly warns that the ordering side-effects of reference assignment should not be used for general ordering purposes, and a non-volatile field lets the JIT hoist or merge reads of `_report`. Mark it `volatile`, or read it with `Volatile.Read`, and the pattern is correct on every architecture .NET runs on.

## Proving the contention behaviour

Docs say "may run more than once". I wanted a number. This probe starts 16 threads on a `Barrier`, has them all hit the lazy value at once, uses a factory that spins for about 20,000 iterations to widen the race window, and repeats 200 times, recording the worst round:

```csharp
// .NET 10.0.10, C# 14, Apple M4, 10 cores
static int Race(Func<Func<object>, Func<object>> makeAccessor)
{
    int maxCalls = 0;
    for (int r = 0; r < 200; r++)
    {
        int calls = 0;
        Func<object> factory = () =>
        {
            Interlocked.Increment(ref calls);
            Thread.SpinWait(20_000);
            return new object();
        };
        var access = makeAccessor(factory);
        using var barrier = new Barrier(16);
        var results = new object[16];
        var threads = Enumerable.Range(0, 16)
            .Select(i => new Thread(() => { barrier.SignalAndWait(); results[i] = access(); }))
            .ToArray();
        foreach (var t in threads) t.Start();
        foreach (var t in threads) t.Join();
        if (results.Distinct().Count() != 1) throw new Exception("different instances returned");
        maxCalls = Math.Max(maxCalls, calls);
    }
    return maxCalls;
}
```

Results, worst round out of 200:

| Option | Max factory calls in one round |
| --- | --- |
| `Lazy<T>` default (`ExecutionAndPublication`) | 1 |
| `Lazy<T>` `PublicationOnly` | 11 |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 12 |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 1 |

Every option returned the same instance to all 16 threads in every round, so none of them is "unsafe". The difference is wasted work. If your factory opens a socket, reads a 40 MB file, or calls a paid API, 12 parallel executions is a real bug even though the published value is correct.

## The exception-caching trap

This is the behaviour difference that bites in production. Same factory, fails on the first call, succeeds on the second:

```csharp
// .NET 10.0.10, C# 14
int attempts = 0;
Func<string> flaky = () => ++attempts == 1 ? throw new InvalidOperationException("transient") : "ok";

var lazy = new Lazy<string>(flaky);
// lazy.Value -> InvalidOperationException: transient
// lazy.Value -> InvalidOperationException: transient   (factory not called again)

string? field = null;
// LazyInitializer.EnsureInitialized(ref field, flaky) -> InvalidOperationException: transient
// LazyInitializer.EnsureInitialized(ref field, flaky) -> "ok"
```

The probe confirmed it: the default `Lazy<T>` called the factory once and threw the same exception on every access afterwards. `PublicationOnly` and `LazyInitializer` called it twice and recovered.

The MS Learn exception table spells out the rule: any `Lazy<T>` constructor that takes a `valueFactory` caches exceptions, unless the mode is `PublicationOnly`. The parameterless constructor (which uses `Activator.CreateInstance`) does not cache. So a `Lazy<HttpClient>` whose factory reads a config value that is missing at startup will throw for the lifetime of the process, even after the config shows up. If the failure can be transient, either use `PublicationOnly`, use `LazyInitializer`, or replace the `Lazy<T>` instance in a `catch`.

The same trap is twice as sneaky with `Lazy<Task<T>>`: the factory does not throw, it returns a faulted `Task`, and that faulted task is cached as a successful value in every mode. If you cache async work, check `IsFaulted` and swap the instance, or use a real cache.

## The benchmark

Two questions: what does a read cost once the value exists, and what does each option cost per instance when you create the owner and touch the value once. Methodology: BenchmarkDotNet 0.15.8, default job, `[MemoryDiagnoser]`, .NET 10.0.10 arm64 RyuJIT, Apple M4, macOS. Each holder class exposes a `Value` property; `Expensive` is a tiny class so the measurement is the lazy machinery, not the factory. Full source is the `HotPath` and `ColdPath` classes below.

```csharp
// .NET 10.0.10, C# 14, BenchmarkDotNet 0.15.8
public sealed class LazyHolder
{
    private readonly Lazy<Expensive> _value = new(() => new Expensive());
    public Expensive Value => _value.Value;
}

public sealed class LazyInitHolder
{
    private Expensive? _value;
    public Expensive Value => LazyInitializer.EnsureInitialized(ref _value, static () => new Expensive());
}

public sealed class LazyInitLockHolder
{
    private Expensive? _value;
    private object? _sync;
    public Expensive Value => LazyInitializer.EnsureInitialized(ref _value, ref _sync, static () => new Expensive());
}

[MemoryDiagnoser]
public class ColdPath
{
    [Benchmark(Baseline = true)] public int Plain() => new PlainHolder().Value.Id;
    [Benchmark] public int Lazy_ExecutionAndPublication() => new LazyHolder().Value.Id;
    [Benchmark] public int LazyInitializer_Factory() => new LazyInitHolder().Value.Id;
    [Benchmark] public int LazyInitializer_SyncLock() => new LazyInitLockHolder().Value.Id;
    [Benchmark] public int DoubleChecked_Lock() => new DoubleCheckedHolder().Value.Id;
    [Benchmark] public int Lazy_NeverTouched() => new LazyHolder() is null ? 0 : 1;
}
```

Hot path (value already created, one read):

| Method (.NET 10.0.10, arm64) | Mean | Allocated |
| --- | --- | --- |
| Plain field (`??=`, not thread-safe) | 0.000 ns | 0 B |
| `Lazy<T>` `ExecutionAndPublication` | 0.000 ns | 0 B |
| `Lazy<T>` `PublicationOnly` | 0.000 ns | 0 B |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 0.495 ns | 0 B |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 0.289 ns | 0 B |
| Double-checked locking (`volatile` + `Lock`) | 0.314 ns | 0 B |

Cold path (allocate the owner, read the value once):

| Method (.NET 10.0.10, arm64) | Mean | Ratio | Allocated |
| --- | --- | --- | --- |
| Plain field (`??=`, not thread-safe) | 1.53 ns | 1.00 | 24 B |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 6.19 ns | 4.04 | 48 B |
| Double-checked locking (`volatile` + `Lock`) | 8.96 ns | 5.85 | 72 B |
| `Lazy<T>` `PublicationOnly` | 9.68 ns | 6.32 | 64 B |
| `Lazy<T>` `ExecutionAndPublication` | 13.96 ns | 9.12 | 96 B |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 14.03 ns | 9.16 | 80 B |
| `Lazy<T>` created, `Value` never read | 6.17 ns | 4.03 | 72 B |

The hot path is a wash. Every option is below BenchmarkDotNet's resolution once the value exists: the tier-1 JIT inlines `Lazy<T>.Value` down to a null check on `_state` and a field load, and BenchmarkDotNet reports it as indistinguishable from an empty method. The sub-nanosecond numbers for the other rows are within noise. If someone tells you to replace `Lazy<T>` with hand-rolled code "for read performance", the measurement says there is nothing to win.

The cold path is where the options differ, and it is mostly allocation. The `Lazy<T>` rows tell the story: a `Lazy<T>` costs 72 bytes before anyone reads it (the `Lazy<T>` object itself plus the `LazyHelper` that `ExecutionAndPublication` allocates in the constructor to lock on), and about 14 ns to create and initialize once. `PublicationOnly` skips the helper, so it is 8 bytes and 4 ns cheaper. The lock-free `LazyInitializer` overload is the cheapest thread-safe option at 6.2 ns, because it allocates nothing besides the value. The `ref syncLock` overload pays for the lock object it creates on the first call, so its one-time cost lands next to `Lazy<T>`.

One caveat on the `Allocated` column: .NET 10's escape analysis stack-allocates holder objects that provably do not escape, which is why the plain baseline shows only 24 bytes. Read the column relative to the baseline, not as absolute object sizes.

In absolute terms, 8 ns and 48 bytes per lazy value only matter when you create millions of owners. A service with a `Lazy<T>` field that is constructed once at startup will never see it.

## When to pick `Lazy<T>`

- **A singleton-ish dependency inside a class**: a parsed config, a compiled `Regex`, a client built from options. One `Lazy<T>` field, one line, the factory runs once.
- **Expensive or side-effecting factories**: anything that opens a connection or calls an API. The default mode is the only zero-effort option that guarantees one execution.
- **Value types or `null` results**: `Lazy<int>` and `Lazy<string?>` just work. The probe confirmed `new Lazy<string?>(() => null).Value` returns `null` with `IsValueCreated == true`.
- **You want a clear error on recursion**: a factory that touches its own `Value` gets `InvalidOperationException: ValueFactory attempted to access the Value property of this instance.` instead of a stack overflow.

## When to pick `LazyInitializer.EnsureInitialized`

- **Many lazy fields on a type with many instances**: the `Lazy<T>` wrapper is one object per value, and it is created even if nobody ever reads it (72 bytes in the "never read" row of the cold-path table). That is the case the MS Learn guidance calls out for `LazyInitializer`: lazy initialization "without the overhead of a class".
- **Arrays of lazily built entries**: `LazyInitializer.EnsureInitialized(ref _slots[i], () => Build(i))` works on array elements because they are `ref`-able. There is no `Lazy<T>[]` equivalent that does not allocate one wrapper per slot up front.
- **Cheap, pure factories**: if running the factory twice under a race costs nothing, the lock-free two-argument overload is the cheapest correct option.
- **You want retry after failure**: no overload caches exceptions.

Use the `ref syncLock` overload when the factory must run once. Pass a field typed `object?` that starts as `null`: it is only allocated on the first call that reaches the slow path.

## When hand-written double-checked locking is still justified

Rarely. Two cases I have actually needed:

- **You need to reset or swap the value**. Neither `Lazy<T>` nor `LazyInitializer` lets you invalidate a value. A cache that rebuilds on a signal needs its own lock and a volatile field.
- **The slow path needs more than a factory**: initializing two fields atomically, or calling an async API under a `SemaphoreSlim`. At that point it is not really lazy initialization any more, it is a small state machine, and you should write it explicitly.

If you write it, use `System.Threading.Lock` on .NET 9+, keep the field `volatile`, read it into a local once on the fast path, and never lock on `this`.

## The gotcha that picks for you

For **static** lazy values, you probably do not need any of the three. A `static readonly` field initialized by the type initializer is lazy (the runtime runs it before the first access to the field), thread-safe, and free on the hot path, because the tier-1 JIT treats `static readonly` fields of an already-initialized class as constants:

```csharp
// .NET 10, C# 14
public static class Pricing
{
    public static readonly FrozenDictionary<string, decimal> Table = LoadTable();
    private static FrozenDictionary<string, decimal> LoadTable() => /* ... */ FrozenDictionary<string, decimal>.Empty;
}
```

The catch: if `LoadTable` throws, the type is broken for the lifetime of the process and every access throws `TypeInitializationException`. That is the same caching behaviour as `Lazy<T>`, just harder to recover from. Use a static `Lazy<T>` when you need `PublicationOnly` retry semantics or when the type has other static members you want usable even if the load fails.

## The recommendation, again

Start with `Lazy<T>` and the default mode. It runs the factory once, it is a single null check on the hot path, and its one real downside (cached exceptions) is something you can opt out of with `PublicationOnly`. Switch to `LazyInitializer.EnsureInitialized` when profiling shows the wrapper allocations matter, which in practice means many instances with several lazy fields each. Use the `ref syncLock` overload if the factory must run once. Write double-checked locking yourself only when you need to reset the value or initialize more than one thing atomically.

## Related

- If you are writing the locked slow path yourself, [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) covers which primitive to pick.
- The [System.Threading.Lock type walkthrough](/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) explains why `lock` on a `Lock` field is faster than locking on an `object`.
- For what `volatile` and `Volatile.Read` actually emit on arm64, see [Volatile.Read vs Volatile.ReadBarrier in .NET 10](/2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10/).
- When the lazy value is really a cache entry that should expire or be async, [HybridCache vs IMemoryCache vs IDistributedCache](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) is the better tool.
- A `Lazy<T>` inside a singleton that captures a scoped service is the same captive-dependency bug described in [fixing "Cannot consume scoped service from singleton"](/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

## Sources

- [Lazy initialization](https://learn.microsoft.com/en-us/dotnet/framework/performance/lazy-initialization) on MS Learn, including the exception-caching table.
- [`LazyInitializer.EnsureInitialized`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lazyinitializer.ensureinitialized) API reference.
- [`LazyThreadSafetyMode`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lazythreadsafetymode) API reference.
- [`Lazy.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Lazy.cs) and [`LazyInitializer.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Threading/LazyInitializer.cs) in dotnet/runtime `release/10.0`.
- [.NET memory model spec](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Memory-model.md), sections "Object assignment" and "Data-dependent reads are ordered".
