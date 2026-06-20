---
title: "What is ValueTask<T> and when is it worth it?"
description: "ValueTask and ValueTask<T> are structs that let an async method return a result without heap-allocating a Task when it completes synchronously. The win is one fewer allocation on hot paths that usually finish without awaiting. The cost is a strict await-once contract. Here is what the type actually is, how it works, and the narrow set of cases where it earns its keep."
pubDate: 2026-06-20
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
  - "dotnet-11"
---

`ValueTask` and `ValueTask<T>` are value-type (struct) awaitables that an async method can return instead of `Task` or `Task<T>`. Their single purpose is to avoid the heap allocation that `Task<T>` incurs when an async method completes synchronously, which is the common case for a cache hit, a buffered read, or a memoized computation. When the method finishes without ever awaiting, a `ValueTask<T>` carries the result inline on the stack and allocates nothing; only when it has to wait on real asynchronous work does it fall back to wrapping a `Task`. The catch is that this saving comes with a contract: you may await a `ValueTask` exactly once, and you must not block on it, await it twice, or stash it in a field to await later. Because of that contract, the default return type for an async method is still `Task` / `Task<T>`. `ValueTask` is a profiler-driven optimization for a hot path, not a better `Task`.

Everything here targets .NET 11 (SDK `11.0.100`) and C# 14, current as of June 2026, but the `ValueTask` contract has been stable since it shipped in .NET Core 2.1, so the mechanics apply to every version from 2.1 onward.

## The allocation ValueTask exists to remove

Start with what `Task<T>` costs. When you write an `async` method that returns `Task<T>`, the C# compiler builds a state machine and, the moment the method actually suspends or needs to hand back a pending operation, it allocates a `Task<T>` object on the heap (24 bytes on 64-bit for the object header plus fields, before any continuation state). The runtime caches a handful of common results: `Task.FromResult(true)`, `Task.FromResult(false)`, and small boxed integers reuse singleton tasks. But for an arbitrary reference type like your `User`, every call that returns a `Task<User>` is a fresh allocation, even when the method had the answer sitting in a dictionary and never awaited anything.

For a method called a few thousand times a second, that allocation is invisible. For one on a genuinely hot path that almost always completes synchronously, those `Task<T>` objects become garbage-collector pressure that shows up as gen-0 churn in a profiler. `ValueTask<T>` was designed for exactly that shape: a method that *usually* returns a value it already has, and only *occasionally* has to go async.

Here is the canonical motivating example, a cache with a slow fallback:

```csharp
// .NET 11, C# 14
// Returns Task<User>: allocates a Task<User> even on the cache-hit fast path.
public Task<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return Task.FromResult(user);   // heap allocation on every cache hit

    return LoadFromDbAsync(id);          // genuinely async, allocates anyway
}
```

The `Task.FromResult(user)` line allocates a `Task<User>` on every cache hit. If your hit rate is 99 percent and the method runs millions of times, you are allocating millions of short-lived task objects to wrap a value you already had on the stack.

## What ValueTask<T> actually is

`ValueTask<T>` is a `readonly struct` that holds one of three things internally: a direct `TResult`, a `Task<TResult>`, or an `IValueTaskSource<TResult>` (more on that below). When the method completes synchronously, the struct carries the result directly and no `Task` is ever created. When the method has to await real work, the struct wraps the `Task<T>` that the async machinery produced. The same example, rewritten:

```csharp
// .NET 11, C# 14
// Returns ValueTask<User>: zero allocation on the cache-hit fast path.
public ValueTask<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return new ValueTask<User>(user);     // no allocation, result is inline

    return new ValueTask<User>(LoadFromDbAsync(id)); // wraps the real Task
}
```

On the cache hit, `new ValueTask<User>(user)` constructs a struct on the stack with the user inside it. Nothing reaches the heap. On the miss, it wraps the `Task<User>` from `LoadFromDbAsync`, so the asynchronous path costs exactly what it did before. You can also use the `async` keyword directly, and the compiler handles the wrapping for you:

```csharp
// .NET 11, C# 14
// The async keyword builds a state machine that returns a ValueTask<User>.
// Synchronous completion still avoids the Task<User> allocation via a pooled
// state machine box when possible.
public async ValueTask<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return user;                     // completes synchronously

    return await LoadFromDbAsync(id);    // suspends, goes async
}
```

The non-generic `ValueTask` exists for the same reason on methods that return no value (`async ValueTask DoWorkAsync()`), and it avoids allocating the singleton-ish completed `Task` in the cases where even that matters.

## The contract: await once, never block, never store

Everything that makes `ValueTask` cheaper also makes it more dangerous, and the danger is entirely in how the *caller* consumes it. A `Task<T>` is a durable object you can await as many times as you like, from as many threads as you like, store in a field, and block on with `.Result`. A `ValueTask<T>` guarantees none of that. From the [official ValueTask&lt;TResult&gt; documentation](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1), the rules are:

- **Await it at most once.** A `ValueTask<T>` may wrap a pooled `IValueTaskSource<T>` that gets recycled after the first await. Awaiting twice can observe a result that now belongs to a different operation.
- **Do not await it concurrently.** Two threads awaiting the same `ValueTask<T>` is undefined behavior for the same reason.
- **Do not access `.Result` before it completes.** On `Task<T>`, blocking on `.Result` is merely a deadlock risk; on `ValueTask<T>` it is undefined behavior unless the value task is already known to be complete.
- **Do not store it to await later.** Assigning a `ValueTask<T>` to a field and awaiting it after some other code has run is the most common way teams corrupt results under load.

If you need to do any of those things, call `.AsTask()` once to materialize a real `Task<T>`, then use that:

```csharp
// .NET 11, C# 14
// Need to await twice or fan out? Convert exactly once, then treat as a Task.
ValueTask<User> vt = repo.GetUserAsync(id);
Task<User> task = vt.AsTask();   // materialize the Task once
var a = await task;
var b = await task;              // safe: Task<T> is awaitable repeatedly
```

That `.AsTask()` call allocates the very `Task<T>` you were trying to avoid, which is the point: if your call site needs `Task` semantics, you were never going to get the saving, and the `ValueTask` was pure risk. The same friction appears with combinators. `Task.WhenAll` and `Task.WhenAny` take `Task`, so a `ValueTask`-returning API forces every caller that fans out to write `.AsTask()` first, allocating per item and erasing the benefit.

## The analyzer that catches the violations

You do not have to police the contract by eye. The .NET SDK ships **CA2012 ("Use ValueTasks correctly")**, which flags double-awaits, stored value tasks, and direct `.Result` access. It is enabled as a suggestion by default in .NET 10 and later. Promote it to a warning so the build fails on a misuse:

```ini
# .editorconfig - .NET 11 SDK, CA2012 ships in the built-in analyzers
[*.cs]
dotnet_diagnostic.CA2012.severity = warning
```

If you adopt `ValueTask` anywhere, turning CA2012 into a warning is not optional. It is the guardrail that makes the type safe to use across a team where not everyone has read Stephen Toub's rules. A codebase that returns `ValueTask` without CA2012 promoted is one careless double-await away from a heisenbug that only shows up under concurrency.

## IValueTaskSource<T>: the pooling that makes it really pay

The third thing a `ValueTask<T>` can wrap is an `IValueTaskSource<T>`. This is the advanced case and the one that delivers the biggest win: a single backing object, implementing `IValueTaskSource<T>`, can be reused across many operations, so even the asynchronous path allocates nothing per call. The runtime uses this internally for `Socket`, `NetworkStream`, and the `System.IO.Pipelines` machinery, where a connection performs millions of reads and you cannot afford a `Task` per read.

You rarely write one by hand. When you do, `ManualResetValueTaskSourceCore<T>` is the helper that implements the hard parts (continuation scheduling, token versioning to enforce await-once):

```csharp
// .NET 11, C# 14
// A reusable async signal: one backing source serves many awaits over its
// lifetime, allocation-free per operation. ManualResetValueTaskSourceCore
// handles version tokens so a stale await throws instead of silently aliasing.
public sealed class Signaller : IValueTaskSource<int>
{
    private ManualResetValueTaskSourceCore<int> _core;

    public ValueTask<int> WaitAsync() => new(this, _core.Version);

    public void Complete(int value) => _core.SetResult(value);

    public int GetResult(short token) => _core.GetResult(token);
    public ValueTaskSourceStatus GetStatus(short token) => _core.GetStatus(token);
    public void OnCompleted(Action<object?> cont, object? state, short token,
        ValueTaskSourceOnCompletedFlags flags)
        => _core.OnCompleted(cont, state, token, flags);
}
```

This is the only context where `ValueTask` reliably beats `Task` on the *asynchronous* path too, not just the synchronous fast path. If you are not pooling a source like this, the asynchronous branch of your method allocates a `Task` anyway and the only thing `ValueTask` saved you was the synchronous-completion allocation.

## When it is worth it, concretely

Reach for `ValueTask<T>` only when all of these hold:

1. **A profiler shows `Task<T>` allocation is a real cost on this path.** Not "might be," but a gen-0 line in a memory trace. `ValueTask` is an optimization you apply after measuring, exactly like you would not reach for `Span<T>` or [Native AOT](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) without a reason.
2. **Synchronous completion is the common case.** Cache hits, buffered reads, memoized results. If the method usually awaits real I/O, you allocate a backing `Task` on most calls anyway and gain nothing.
3. **The call sites are simple awaits.** A single `await` at each consumer, no fan-out, no caching the awaitable, no blocking. The moment a caller needs `.AsTask()`, the saving is gone.
4. **You have promoted CA2012 to a warning.** So a future contributor cannot silently break the contract.

The async-streams machinery is the one place `ValueTask` is correct by default rather than by measurement: `IAsyncEnumerator<T>.MoveNextAsync` returns `ValueTask<bool>` and `DisposeAsync` returns `ValueTask`, precisely because an enumerator reuses one backing source across every iteration. If you work with streams at all, [using IAsyncEnumerable<T> with EF Core 11](/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) shows the pattern in context, and you should never "revert" those signatures to `Task`.

## When to stay on Task<T>

For the overwhelming majority of async methods, return `Task` / `Task<T>`. Stephen Toub's canonical [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/) puts it bluntly: "the default choice is still `Task` / `Task<TResult>`." Concrete signals you are reaching for `ValueTask` by reflex rather than evidence:

- The method does real I/O on most calls. You are allocating a `Task` on the common path regardless, so the struct buys nothing and costs caution.
- Callers need to await twice, cache the result, or fan out with `Task.WhenAll`. Every `.AsTask()` reintroduces the allocation and adds a line of code.
- You never ran a `BenchmarkDotNet` `[MemoryDiagnoser]` pass to confirm there was an allocation to remove. If the numbers are flat, the type is pure overhead.
- The method is public API on a NuGet package. Changing `ValueTask` back to `Task` later is a binary-breaking change, so do not commit to it without data.

If you already have `ValueTask` in a codebase and the data does not justify it, the reverse is a safe, mechanical edit: [migrating ValueTask<T> back to Task<T>](/2026/06/migrate-from-valuetask-back-to-task-when-and-why/) walks the full checklist, including what to do with any hand-rolled `IValueTaskSource<T>`. And whichever type you return, the rules for not blocking the thread pool are the same: see [how to cancel a long-running Task without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) and the still-relevant question of whether [ConfigureAwait(false) matters in .NET 11](/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## The one-line decision

`ValueTask<T>` removes a `Task<T>` allocation on the synchronous-completion path, at the price of an await-once contract that your whole team has to respect. Use it when a profiler proves that allocation matters and synchronous completion is the common case, lean on `IValueTaskSource<T>` if you can pool a backing source, turn CA2012 into a warning, and keep it on async streams where it is correct by design. Everywhere else, return `Task<T>` and spend your caution budget on something that actually moves a number.

## Sources

- [ValueTask&lt;TResult&gt; Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1)
- [Understanding the Whys, Whats, and Whens of ValueTask -- .NET Blog (Stephen Toub)](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/)
- [CA2012: Use ValueTasks correctly -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012)
- [ManualResetValueTaskSourceCore&lt;TResult&gt; -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.manualresetvaluetasksourcecore-1)
- [ValueTask Restrictions -- Stephen Cleary](https://blog.stephencleary.com/2020/03/valuetask.html)
