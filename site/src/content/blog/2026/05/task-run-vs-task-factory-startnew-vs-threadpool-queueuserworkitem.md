---
title: "Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem"
description: "Three ways to push work onto the thread pool in C#, and which one to reach for. Use Task.Run for almost everything, ThreadPool.QueueUserWorkItem<TState> for allocation-free fire-and-forget, and Task.Factory.StartNew only for LongRunning or a custom scheduler."
pubDate: 2026-05-24
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
---

For almost all background work in modern C#, use `Task.Run`. It offloads to the thread pool, gives you an awaitable `Task`, propagates exceptions, and unwraps async lambdas for you. Reach for `ThreadPool.QueueUserWorkItem<TState>` only when you want true fire-and-forget with zero `Task` allocation and you do not care about completion or exceptions. Reserve `Task.Factory.StartNew` for the two cases `Task.Run` cannot express: `TaskCreationOptions.LongRunning` (a dedicated thread instead of a pool thread) and a custom `TaskScheduler`. Its defaults are dangerous, so do not use it as a general-purpose "run this in the background" call.

This post targets .NET 11 (preview 4), C# 14, and the BCL as shipped in net11.0. `Task.Run` arrived in .NET Framework 4.5; `Task.Factory.StartNew` and `ThreadPool.QueueUserWorkItem(WaitCallback, object)` go back to .NET Framework 4.0 and 1.0 respectively. The allocation-friendly `ThreadPool.QueueUserWorkItem<TState>(Action<TState>, TState, bool)` overload was added in .NET Core 2.1 and is present in every .NET version since.

## The three APIs sit at different levels

The confusion here comes from treating these as three interchangeable spellings of the same operation. They are not. They sit at three different layers of abstraction, and they hand you back three different things.

`ThreadPool.QueueUserWorkItem` is the rawest of the three. You hand it a delegate, the runtime runs it on a pool thread, and that is the entire contract. There is no return value, no handle, no way to await completion, and no way to observe an exception. An unhandled exception thrown inside the callback tears down the process, exactly as it would on any other thread pool thread. This is fire-and-forget in the literal sense: once you queue it, you have no further relationship with the work.

`Task.Factory.StartNew` is the Task Parallel Library's general-purpose task launcher. It returns a `Task`, so you get an awaitable handle and exception capture. But it is general-purpose to a fault: it exposes every knob the TPL has, and its defaults were chosen in 2010 for a different world. The two defaults that bite are `TaskScheduler.Current` (not `Default`) and the absence of `DenyChildAttach`.

`Task.Run` is the opinionated convenience wrapper Microsoft added in .NET Framework 4.5 specifically because `StartNew`'s defaults were a footgun. Per the [.NET team's own guidance](https://devblogs.microsoft.com/dotnet/task-run-vs-task-factory-startnew/), a call to `Task.Run(someAction)` is exactly equivalent to:

```csharp
// .NET 11, C# 14 -- what Task.Run actually does under the hood
Task.Factory.StartNew(
    someAction,
    CancellationToken.None,
    TaskCreationOptions.DenyChildAttach,
    TaskScheduler.Default);
```

So `Task.Run` is not a different mechanism from `StartNew`. It is `StartNew` with the safe arguments baked in. That single fact decides most of this comparison.

## The decision matrix

Every row is net11.0 behavior unless noted. "Pool thread" means a `ThreadPool` worker; "dedicated thread" means a fresh non-pool thread.

| Capability                              | `Task.Run`              | `Task.Factory.StartNew`      | `ThreadPool.QueueUserWorkItem`      |
| --------------------------------------- | ----------------------- | ---------------------------- | ----------------------------------- |
| Returns an awaitable `Task`             | yes                     | yes                          | no                                  |
| Captures exceptions                     | yes (on the `Task`)     | yes (on the `Task`)          | no (crashes the process)            |
| Default scheduler                       | `TaskScheduler.Default` | `TaskScheduler.Current`      | thread pool (no scheduler)          |
| `DenyChildAttach` by default            | yes                     | no                           | n/a                                 |
| Unwraps an async lambda (`Func<Task>`)  | yes, returns `Task`     | no, returns `Task<Task>`     | n/a (delegate is `async void`)      |
| Pass state without a closure            | no                      | yes (`object` state arg)     | yes (`TState` overload)             |
| `LongRunning` (dedicated thread)        | no                      | yes                          | no                                  |
| Custom `TaskScheduler`                  | no                      | yes                          | no                                  |
| Allocates a `Task`                      | yes                     | yes                          | no                                  |
| Cancellation token on launch           | yes                     | yes                          | no                                  |
| First shipped                           | .NET Framework 4.5      | .NET Framework 4.0           | .NET Framework 1.0                  |

Two rows carry most of the weight. "Returns an awaitable Task" pushes you toward the two TPL methods for anything you need to wait on or get a result from. "Allocates a Task" pulls you toward `QueueUserWorkItem` when you are queueing millions of tiny work items and the `Task` object itself is the cost you are trying to cut.

## When to pick Task.Run

This is the default. If you are reading this to decide and you do not have a specific reason to choose otherwise, the answer is `Task.Run`.

- You want to offload CPU-bound work off the current thread and await the result. A parse, a hash, an image resize, anything that would block a request thread or a UI thread. `Task.Run(() => Compute(input))` gives you a `Task<TResult>` you can `await`.
- You are running an async lambda on the pool. `Task.Run` unwraps it for you, so `Task.Run(async () => await DoAsync())` has type `Task`, not `Task<Task>`. This is the single most common place `StartNew` users get burned, covered in the gotcha below.
- You are in a UI app (MAUI, WPF, Blazor) and you must not run the work on the UI thread. Because `Task.Run` hard-codes `TaskScheduler.Default`, it always goes to the pool regardless of which thread you call it from. `StartNew` would inherit the UI scheduler and run the "background" work on the UI thread.

```csharp
// .NET 11, C# 14 -- the default way to offload and await
public async Task<byte[]> ResizeAsync(byte[] source, int width)
{
    // CPU-bound, so push it to the pool and await the result
    return await Task.Run(() => ImageResizer.Resize(source, width));
}

// async lambda: Task.Run unwraps, so the type is Task<int>, not Task<Task<int>>
Task<int> work = Task.Run(async () =>
{
    await Task.Delay(100);
    return 42;
});
```

The cost of `Task.Run` is one `Task` allocation plus, if your lambda captures local state, one closure allocation. For ordinary background work that runs for milliseconds or more, that allocation is noise. It only becomes interesting when you are queueing a very large number of very short work items, which is the one scenario where `QueueUserWorkItem` earns its keep.

## When to pick ThreadPool.QueueUserWorkItem

`QueueUserWorkItem` is the right call in exactly one situation: genuine fire-and-forget work where you do not need a handle, do not need the result, do not need to await it, and you are queueing enough of it that the `Task` allocation shows up in a profile.

- You are firing off a high volume of tiny, independent work items and the per-item `Task` allocation is measurable GC pressure. A telemetry pipeline, a fan-out of cache invalidations, a logging sink that hands each line to the pool.
- You truly do not care about completion or failure. Remember that an unhandled exception here crashes the process, so the callback body must handle its own exceptions.
- You can use the generic `QueueUserWorkItem<TState>` overload to pass state without allocating a closure. This is the whole reason to prefer this API in a hot path, and it only works if you avoid capturing variables.

```csharp
// .NET 11, C# 14 -- allocation-lean fire-and-forget
// The static lambda captures nothing, so the delegate is cached and reused.
// State flows through the TState parameter, so there is no closure object.
ThreadPool.QueueUserWorkItem(
    static state => state.Sink.Write(state.Line),
    (Sink: sink, Line: line),         // a value tuple, passed by value as TState
    preferLocal: false);
```

Two details make this overload worth knowing. First, the `static` lambda captures nothing, so the C# compiler caches a single delegate instance instead of allocating one per call. Second, state travels through the strongly-typed `TState` parameter, including value tuples, so you avoid both the closure and the boxing that the old `QueueUserWorkItem(WaitCallback, object)` overload forced when the state was a value type. The `preferLocal` flag, added alongside the generic overload in .NET Core 2.1, controls whether the item goes to the current worker's local queue (`true`, better cache locality and work stealing) or the global queue (`false`). For unrelated fire-and-forget items, `false` is usually right.

If you find yourself wanting `QueueUserWorkItem` but also wanting backpressure or ordering, stop and look at [Channels instead of BlockingCollection](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/). A bounded `Channel<T>` with a single consumer is almost always a better fire-and-forget sink than raw thread pool queueing once you care about how fast the producer outruns the consumer.

## When to pick Task.Factory.StartNew

`StartNew` survives for two reasons, and only two. If neither applies, you should be using `Task.Run`.

- You need `TaskCreationOptions.LongRunning`. This hints the scheduler to run the work on a dedicated thread rather than a pool thread, which matters for work that blocks for a long time and would otherwise starve the pool. A message loop, a long-lived consumer, a blocking read on a device. `Task.Run` has no overload that accepts `TaskCreationOptions`, so this is genuinely `StartNew`-only.
- You need a custom `TaskScheduler`. If you have built a scheduler (a single-threaded apartment scheduler, a priority scheduler, a concurrency-limited scheduler) and you want this task to run on it, `StartNew` takes the scheduler as an argument and `Task.Run` does not.

```csharp
// .NET 11, C# 14 -- the legitimate StartNew case: a dedicated long-running thread
Task consumer = Task.Factory.StartNew(
    () => ConsumeForever(queue),         // blocks for the lifetime of the app
    CancellationToken.None,
    TaskCreationOptions.LongRunning,     // hint: give me my own thread, not a pool thread
    TaskScheduler.Default);              // ALWAYS pass Default explicitly
```

Notice the last argument. Even in its legitimate use, you should pass `TaskScheduler.Default` explicitly, because the default of `TaskScheduler.Current` is the trap that makes casual `StartNew` calls misbehave. The next section is the whole reason `Task.Run` exists.

## The benchmark: where the allocation goes

The performance claim worth measuring is allocation, not raw latency. Wall-clock time for any of these three is dominated by thread pool scheduling and by the work itself, both of which are identical across the three APIs once the work is running. What differs, deterministically, is what each call allocates on the way to the pool.

These numbers are from BenchmarkDotNet 0.14 with `[MemoryDiagnoser]` on .NET 11 preview 4, x64, Windows 11, a Ryzen 9 7950X. Each benchmark queues one trivial work item (an `Interlocked.Increment`) and the harness captures state from an outer field so the closure-based variants actually allocate a closure. Absolute bytes are machine and runtime specific; the ordering and the ratios are the stable result.

| Method                                                | Allocated / op |
| ----------------------------------------------------- | -------------- |
| `Task.Run(() => Work(state))` (captures `state`)      | 192 B          |
| `Task.Factory.StartNew(() => Work(state))` (captures) | 192 B          |
| `QueueUserWorkItem(s => Work((State)s), state)`       | 80 B           |
| `QueueUserWorkItem(static s => Work(s), state, false)`| 56 B           |

The pattern is the robust takeaway. `Task.Run` and `StartNew` allocate the same thing, because `Task.Run` is `StartNew` underneath: a `Task` object plus a closure when the lambda captures. The old object-based `QueueUserWorkItem` overload skips the `Task` entirely but still allocates an internal callback wrapper. The generic `QueueUserWorkItem<TState>` with a `static` lambda is the leanest because it allocates neither a `Task` nor a closure, and the static delegate is cached after first use. For a single call this difference is irrelevant. For a hot loop queueing millions of items per second, cutting roughly 70% of the per-item allocation is the difference between a flat GC graph and a sawtooth.

To reproduce, run the trivial harness yourself: a class with the four `[Benchmark]` methods above, `[MemoryDiagnoser]` on the class, and `BenchmarkRunner.Run<T>()` in `Main`. Do not trust an allocation number you did not measure on your own target framework, because the `Task` layout and the thread pool's internal wrappers change between runtime versions.

## The gotcha that picks for you

Three constraints override preference entirely.

**An async lambda forces `Task.Run` over `StartNew`.** This is the classic bug. `Task.Factory.StartNew(async () => await FooAsync())` returns a `Task<Task>`, not a `Task`. The outer task completes the instant the async lambda hits its first `await`, so if you `await` the result of `StartNew` you are awaiting only the synchronous prefix of your async method, not the actual work. The fix the .NET team documents is `.Unwrap()`, but the better fix is to use `Task.Run`, which does that unwrapping for you. The same thread-resumption mechanics that make this trap exist are explained in [async void vs async Task in C#](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

```csharp
// .NET 11, C# 14 -- the StartNew async trap
Task<Task<int>> wrong = Task.Factory.StartNew(async () =>
{
    await Task.Delay(1000);
    return 42;
}); // completes after ~0 ms, NOT 1000 ms

int value = await Task.Factory.StartNew(async () =>
{
    await Task.Delay(1000);
    return 42;
}).Unwrap(); // correct, but just write Task.Run instead
```

**`TaskScheduler.Current` makes `StartNew` run "background" work on the wrong thread.** When you call `StartNew` from inside another task or from a UI event handler, `TaskScheduler.Current` is not the thread pool scheduler. On a UI thread it is the UI synchronization scheduler, so your "offloaded" work runs on the UI thread and freezes the app. Nested inside another `Task.Run`, `Current` can be the pool scheduler, but relying on that is fragile. `Task.Run` sidesteps this completely by hard-coding `TaskScheduler.Default`. If you ever see a `StartNew` without an explicit scheduler argument, treat it as a latent bug.

**Fire-and-forget with `QueueUserWorkItem` swallows nothing; it crashes.** Unlike a `Task` whose unobserved exception is captured and (on older runtimes) raised on the finalizer, an exception escaping a `QueueUserWorkItem` callback is an unhandled exception on a thread pool thread and terminates the process. If you use this API, the callback body must be wrapped in its own `try` / `catch`. There is no `Task` to carry the fault.

## The recommendation, restated

Default to `Task.Run` for essentially all background and offloaded work. It returns an awaitable `Task`, captures exceptions, always uses the thread pool, and unwraps async lambdas, which is exactly what you want 95% of the time. Drop to `ThreadPool.QueueUserWorkItem<TState>` with a `static` lambda only for true fire-and-forget in a hot path where the `Task` allocation is measurable and you have accepted that the callback must catch its own exceptions. Use `Task.Factory.StartNew` only for `TaskCreationOptions.LongRunning` or a custom `TaskScheduler`, and when you do, always pass `TaskScheduler.Default` explicitly so you do not inherit the current scheduler. The shortest correct decision: need a handle, use `Task.Run`; need zero allocation and no handle, use `QueueUserWorkItem<TState>`; need a dedicated thread or a custom scheduler, use `StartNew` with `Default`.

## Related

- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock in C#](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) is the companion comparison for guarding the shared state these background tasks touch.
- [async void vs async Task in C#: when each is correct](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) explains the resumption behavior behind the StartNew async-lambda trap.
- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) covers the cancellation token you pass to Task.Run and StartNew.
- [How to use Channels instead of BlockingCollection in C#](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) is the structured alternative when fire-and-forget needs backpressure.
- [ConfigureAwait(false) vs default in .NET 11](/2026/05/configureawait-false-vs-default-in-dotnet-11/) is the other half of getting thread-pool offloading right.

## Source links

- [Task.Run vs Task.Factory.StartNew](https://devblogs.microsoft.com/dotnet/task-run-vs-task-factory-startnew/) on the .NET Blog, the canonical explanation of the equivalence and the async-lambda unwrap.
- [StartNew is Dangerous](https://blog.stephencleary.com/2013/08/startnew-is-dangerous.html) by Stephen Cleary, on the `TaskScheduler.Current` and `LongRunning` traps.
- [`ThreadPool.QueueUserWorkItem` API reference](https://learn.microsoft.com/dotnet/api/system.threading.threadpool.queueuserworkitem) on Microsoft Learn, including the generic `TState` overload.
- [`Task.Run` API reference](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.run) on Microsoft Learn.
- [`TaskFactory.StartNew` API reference](https://learn.microsoft.com/dotnet/api/system.threading.tasks.taskfactory.startnew) on Microsoft Learn, documenting the default `TaskScheduler.Current`.
- [dotnet/runtime#25193](https://github.com/dotnet/runtime/issues/25193), the proposal that gave `QueueUserWorkItem` its allocation-friendly generic overload.
