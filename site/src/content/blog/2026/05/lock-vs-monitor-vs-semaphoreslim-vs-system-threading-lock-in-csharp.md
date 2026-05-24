---
title: "lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock in C#"
description: "Four ways to guard a critical section in C#, and a decision matrix for picking one. Use System.Threading.Lock for synchronous mutual exclusion on .NET 9+, SemaphoreSlim when the section spans an await, and Monitor only when you need Wait/Pulse."
pubDate: 2026-05-24
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
---

For synchronous mutual exclusion in new code on .NET 9 or later, use `System.Threading.Lock` and write it with the `lock` keyword. If the critical section has to `await` something, none of the synchronous primitives are legal, so reach for `SemaphoreSlim(1, 1)` and `await WaitAsync()`. Reserve bare `Monitor` for the one case the others cannot do at all: condition variables (`Monitor.Wait` / `Pulse` / `PulseAll`). The classic `lock (object)` idiom is not wrong, it just compiles to a slightly heavier `Monitor` path than `Lock` does, so on .NET 9+ there is no reason to start a new gate with a plain `object`.

This post targets .NET 11 (preview 4), C# 14, and the BCL as of `System.Threading` in net11.0. `System.Threading.Lock` is a .NET 9 type, so the recommendation applies to .NET 9, .NET 10, and .NET 11 equally. `Monitor` and the `lock` keyword go back to .NET 1.1 and C# 1.0; `SemaphoreSlim` arrived in .NET Framework 4.0.

## The four contenders are not really peers

The reason this comparison confuses people is that the four names sit at different layers.

`lock` is a C# language statement. It does not implement anything itself. The compiler lowers `lock (x) { body }` into one of two shapes depending on the static type of `x`. If `x` is a `System.Threading.Lock`, it becomes `using (x.EnterScope()) { body }`. For any other reference type it becomes a `Monitor.Enter` / `Monitor.Exit` pair wrapped in a `try` / `finally`. So "should I use `lock` or `Monitor`" is mostly a false choice: `lock (someObject)` *is* `Monitor`, written more safely.

`Monitor` is the static API behind the classic idiom. It does mutual exclusion, but it also carries two features the others lack: recursion (the same thread can enter twice) and condition variables via `Wait`, `Pulse`, and `PulseAll`. Those condition-variable methods are the only capability in this whole comparison that has no substitute among the other three.

`System.Threading.Lock` is the dedicated mutual-exclusion type introduced in .NET 9. It is what `Monitor` would have been if it had not also been doing duty as the backing implementation for `lock (object)`. It exposes exactly what a mutex needs and nothing else. The deep dive on [how System.Threading.Lock works and how to migrate to it](/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) covers its mechanics in detail.

`SemaphoreSlim` is a counting semaphore, not a mutex, but it becomes a mutex when you construct it with a count of one. The thing that sets it apart from all three of the others is `WaitAsync`: it is the only primitive here that you can legally hold across an `await`.

## The decision matrix

Every row in this table is for .NET 9+ / C# 13+ behavior unless noted.

| Capability                              | `lock (object)`        | `Monitor`              | `SemaphoreSlim`             | `System.Threading.Lock`   |
| --------------------------------------- | ---------------------- | ---------------------- | --------------------------- | ------------------------- |
| Mutual exclusion (one holder)           | yes                    | yes                    | yes, when `new(1, 1)`       | yes                       |
| Limit to N > 1 concurrent holders       | no                     | no                     | yes, `new(N, N)`            | no                        |
| Legal to `await` inside the held region | no (CS1996)            | no (CS1996)            | yes, via `WaitAsync`        | no (CS1996)               |
| Condition variables (`Wait` / `Pulse`)  | no                     | yes                    | no                          | no                        |
| Reentrant on the same thread            | yes                    | yes                    | no (deadlocks)              | yes                       |
| Enforces thread / owner identity        | yes                    | yes                    | no                          | yes                       |
| Lowers to                               | `Monitor.Enter`/`Exit` | (itself)               | `Wait`/`Release`            | `Lock.EnterScope()`       |
| Sync-block inflation under contention   | yes                    | yes                    | no                          | no                        |
| Try-acquire with timeout                | `Monitor.TryEnter`     | `TryEnter(TimeSpan)`   | `Wait(TimeSpan)`            | `TryEnter(TimeSpan)`      |
| Cancellable acquire                     | no                     | no                     | yes (`CancellationToken`)   | no                        |
| Cross-process                           | no                     | no                     | no (use `Semaphore`)        | no                        |
| `IDisposable`                           | no                     | no                     | yes                         | no                        |
| First shipped                           | C# 1.0                 | .NET 1.1               | .NET Framework 4.0          | .NET 9                    |

Two rows decide almost every real case: "legal to `await` inside" and "condition variables." If you need the first, you are on `SemaphoreSlim`. If you need the second, you are on `Monitor`. Everything else points at `System.Threading.Lock`.

## When to pick System.Threading.Lock

This is the default for new synchronous code on .NET 9+.

- You are guarding a short, CPU-bound critical section: an in-memory cache update, a counter, a `Dictionary` mutation, a lazy-init field. The body does not `await` anything. This is 90% of locking in a typical service.
- You are migrating an existing `lock (object)` gate and the body is synchronous. The change is one line: `private readonly object _gate = new();` becomes `private readonly Lock _gate = new();`. Every `lock (_gate) { ... }` statement stays byte-for-byte the same, and the compiler rebinds it from `Monitor.Enter` to `Lock.EnterScope()`.
- You want the smaller footprint. A `Lock` never inflates a process-wide sync block under contention, so a service holding thousands of gates (one per cache entry, say) does not grow the sync block table the way `Monitor` does.

```csharp
// .NET 11, C# 14 -- the default gate for synchronous critical sections
public sealed class Counter
{
    private readonly Lock _gate = new();
    private long _value;

    public void Increment()
    {
        lock (_gate) // lowers to using (_gate.EnterScope())
        {
            _value++;
        }
    }

    public long Read()
    {
        lock (_gate)
        {
            return _value;
        }
    }
}
```

If you cannot move to .NET 9 yet, the fallback is the classic `lock (object)`. It is the same semantics, slightly heavier. Do not reach for `Monitor` explicitly just to lock; the `lock` keyword already wraps `Monitor.Enter` / `Exit` in the correct `try` / `finally` so the lock is released even if the body throws. Hand-written `Monitor.Enter` without a `finally` is a classic source of orphaned locks.

## When to pick SemaphoreSlim

`SemaphoreSlim` is the answer to exactly one question the synchronous primitives cannot answer: how do I serialize a section that contains an `await`?

- The critical section spans an `await`. You are calling an async API (an `HttpClient` request, an EF Core query, a file write) and you need only one caller inside the region at a time. `lock`, `Monitor`, and `Lock` all forbid `await` in the held region. `SemaphoreSlim` does not.
- You want to cap concurrency at N greater than one. A throttle that allows three concurrent outbound calls is `new SemaphoreSlim(3, 3)`. No mutex can express this.
- You need a cancellable or timed acquire on an async path. `WaitAsync(CancellationToken)` and `WaitAsync(TimeSpan)` integrate with the rest of your cancellation story.

```csharp
// .NET 11, C# 14 -- async-safe mutual exclusion across an await
public sealed class AsyncCache : IDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1); // count 1 == mutex
    private readonly Dictionary<string, byte[]> _store = new();

    public async Task<byte[]> GetOrAddAsync(string key, Func<string, Task<byte[]>> factory)
    {
        await _gate.WaitAsync();
        try
        {
            if (_store.TryGetValue(key, out var existing))
                return existing;

            var fresh = await factory(key); // legal: we are holding a semaphore, not a lock
            _store[key] = fresh;
            return fresh;
        }
        finally
        {
            _gate.Release(); // ALWAYS in finally
        }
    }

    public void Dispose() => _gate.Dispose();
}
```

Three traps come with `SemaphoreSlim`, and all three trace back to the same root: it does not track who holds it. Per the [SemaphoreSlim documentation](https://learn.microsoft.com/dotnet/api/system.threading.semaphoreslim), the class "doesn't enforce thread or task identity on calls to the Wait, WaitAsync, and Release methods."

1. **No reentrancy.** If a method that holds the semaphore calls another method that also waits on the same semaphore, you deadlock. `Monitor` and `Lock` would let the same thread re-enter; `SemaphoreSlim` cannot, because it has no concept of an owning thread to compare against.
2. **Release is unguarded.** Nothing stops you from calling `Release` more times than you called `Wait`, which silently pushes `CurrentCount` above the initial count and breaks the invariant. Always pair `Wait` / `WaitAsync` with `Release` in a `finally`.
3. **It is `IDisposable`.** Unlike the other three, a `SemaphoreSlim` owns a lazily-allocated `WaitHandle` and must be disposed. A field-level semaphore means your class is now `IDisposable` too.

The overhead per acquisition is higher than a `Lock`. That is the price of async support. Do not use `SemaphoreSlim` for a purely synchronous fast path just because you already have one in scope.

## When to pick Monitor explicitly

Almost never, with one real exception: you need a condition variable.

`Monitor.Wait`, `Monitor.Pulse`, and `Monitor.PulseAll` let a thread release the lock, sleep until another thread signals a state change, and re-acquire on wake. This is the classic bounded-buffer / producer-consumer coordination primitive. No other type in this comparison exposes it. `System.Threading.Lock` deliberately dropped it; `SemaphoreSlim` never had it.

```csharp
// .NET 11, C# 14 -- the one job only Monitor can do: condition variables
public sealed class BoundedBuffer<T>
{
    private readonly object _gate = new();
    private readonly Queue<T> _items = new();
    private readonly int _capacity;

    public BoundedBuffer(int capacity) => _capacity = capacity;

    public void Add(T item)
    {
        lock (_gate)
        {
            while (_items.Count == _capacity)
                Monitor.Wait(_gate);     // release + sleep until pulsed

            _items.Enqueue(item);
            Monitor.PulseAll(_gate);     // wake any waiting consumers
        }
    }

    public T Take()
    {
        lock (_gate)
        {
            while (_items.Count == 0)
                Monitor.Wait(_gate);

            var item = _items.Dequeue();
            Monitor.PulseAll(_gate);
            return item;
        }
    }
}
```

Note the gate here is a plain `object`, not a `Lock`: `Monitor.Wait`/`Pulse` operate on an object's sync block and are not available on `System.Threading.Lock`. That is the trade. If you find yourself writing this pattern from scratch in 2026, stop and check whether a [`Channel<T>` would replace the whole thing](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/). `System.Threading.Channels` gives you a bounded, async-friendly producer/consumer queue with backpressure built in, and you never touch `Monitor.Wait` again. The hand-rolled bounded buffer is mostly of historical and educational interest now.

The other place you might call `Monitor` directly is `Monitor.TryEnter` for a non-blocking attempt, but `System.Threading.Lock` has `TryEnter` too, so on .NET 9+ that reason evaporates.

## The benchmark: what Lock actually saves over Monitor

The performance claim is specifically that `System.Threading.Lock` is faster than the `Monitor`-backed `lock (object)` for both the uncontended fast path and the contended path. Stephen Toub's [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) post measures this with BenchmarkDotNet. Uncontended acquisition collapses to a single interlocked compare-exchange plus a fence; contended acquisition is roughly 2-3x faster than the `Monitor.Enter` path because `Monitor` runs several conditional branches before its fence.

What the synthetic numbers do not tell you is how little this matters in a real service, because real services spend almost none of their wall-clock time inside `lock`. The measurable wins in production are structural, not throughput:

- **Working set.** Every gate goes from "an `object` plus a sync block on contention" to "a `Lock`, roughly object-sized plus a few bytes of state." With thousands of gates, the sync block table stops growing under load.
- **GC traversal.** The `Lock` is still a reference type the GC traces, but it never inflates a separate process-wide table the GC has to walk.

What does *not* change between `Monitor` and `Lock`: throughput of the protected section itself, fairness (both are unfair with light anti-starvation), and recursion behavior (both are reentrant on the same thread).

`SemaphoreSlim` is in a different class entirely and the comparison is not apples-to-apples: a `WaitAsync` that completes synchronously is still markedly more expensive than a `Lock.EnterScope`, and one that completes asynchronously allocates and round-trips through the thread pool. You do not pick `SemaphoreSlim` for speed. You pick it because it is the only correct option across an `await`, and correctness beats the cycle count every time.

## The gotcha that picks for you

Three constraints override preference completely:

**An `await` in the critical section forces `SemaphoreSlim`.** This is not a style choice. `lock`, `Monitor`, and `Lock` track ownership by managed thread, and an `await` can resume on a different thread, which would release the lock from the wrong owner. The C# compiler refuses `await` inside `lock` with [CS1996](https://learn.microsoft.com/dotnet/csharp/misc/cs1996). The sneaky variant is `using (_gate.EnterScope())` around an `await`: that may compile, but it throws `SynchronizationLockException` at runtime when the continuation tries to dispose the scope on a thread that never entered. If the body awaits, you are on `SemaphoreSlim`. Full stop. This is the same reasoning behind [why async void and async Task behave so differently](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) under the hood.

**Condition variables force `Monitor`.** If your coordination genuinely needs "sleep until signaled" semantics and a `Channel<T>` does not fit, only `Monitor.Wait` / `Pulse` will do it.

**A pre-.NET 9 target rules out `Lock`.** If your library multi-targets `netstandard2.0`, `System.Threading.Lock` does not exist on that side. Guard it with `#if NET9_0_OR_GREATER` and keep an `object` gate on the down-level path. Do not type-forward `Lock` from a polyfill; the semantics will diverge from the real type.

## The recommendation, restated

Default to `System.Threading.Lock` for synchronous mutual exclusion on .NET 9+, and write it through the `lock` keyword so the compiler manages the `try` / `finally` for you. Drop to a plain `object` gate only when you must target a runtime older than .NET 9, where `lock (object)` gives you identical semantics at a slightly higher cost. Switch to `SemaphoreSlim(1, 1)` the moment the protected region contains an `await`, and use `SemaphoreSlim(N, N)` when you want to cap concurrency above one. Touch `Monitor` directly only for `Wait` / `Pulse` condition variables, and first ask whether a `Channel<T>` makes the whole hand-rolled coordination disappear. The shortest correct decision: synchronous and short means `Lock`; asynchronous means `SemaphoreSlim`; signaling means `Monitor`.

## Related

- [How to use the new System.Threading.Lock type in .NET 11](/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) is the deep dive on migrating to and using the new type.
- [.NET 9: The End of lock(object)](/2026/01/net-9-the-end-of-lockobject/) is the original news-style introduction to `System.Threading.Lock`.
- [How to use Channels instead of BlockingCollection in C#](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) shows the producer/consumer pattern that replaces hand-rolled `Monitor.Wait` coordination.
- [async void vs async Task in C#: when each is correct](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) explains the thread-resumption behavior behind the no-await-in-a-lock rule.
- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) pairs with the cancellable `WaitAsync` overloads.

## Source links

- [`System.Threading.Lock` API reference](https://learn.microsoft.com/dotnet/api/system.threading.lock) on Microsoft Learn.
- [`SemaphoreSlim` class reference](https://learn.microsoft.com/dotnet/api/system.threading.semaphoreslim) on Microsoft Learn, including the thread-identity note.
- [`Monitor` class reference](https://learn.microsoft.com/dotnet/api/system.threading.monitor), covering `Wait`, `Pulse`, and `PulseAll`.
- [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) by Stephen Toub, with the `Lock` vs `Monitor` microbenchmarks.
- [dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812), the proposal that introduced `System.Threading.Lock`.
