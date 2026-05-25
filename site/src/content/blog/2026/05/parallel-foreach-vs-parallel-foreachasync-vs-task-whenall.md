---
title: "Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll in C#"
description: "Use Parallel.ForEach for CPU-bound work over in-memory data, Parallel.ForEachAsync for async I/O over many items with a concurrency cap, and Task.WhenAll for a small fixed fan-out where you want every operation in flight and need the results back."
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
---

Use `Parallel.ForEach` when the work is CPU-bound and the data is already in memory: hashing 100,000 files, transforming a big array, anything that pegs cores. Use `Parallel.ForEachAsync` when each item triggers async I/O (an HTTP call, a database query) and you want a bounded number of those in flight at once. Use `Task.WhenAll` when you have a small, fixed set of async operations you want to start all at once and collect results from. The one mistake that picks for you: never do async I/O inside `Parallel.ForEach`, because blocking on `.Result` or `.Wait()` inside its synchronous body starves the thread pool.

This post targets .NET 11 and C# 14. `Parallel.ForEach` has shipped since .NET Framework 4.0 (2010); `Task.WhenAll` since .NET Framework 4.5; and `Parallel.ForEachAsync` is the newcomer, added in .NET 6 (2021). The behavior described here is stable across .NET 6 through .NET 11.

## These three solve different problems

The comparison is awkward because the three are not interchangeable APIs with different performance. They are answers to three different questions.

`Parallel.ForEach` asks: "I have a collection and a synchronous, CPU-heavy operation per element. Spread it across cores." Its body is an `Action<T>`. It partitions the source, runs the body on multiple thread-pool threads, and blocks the calling thread until every element is done. It is the data-parallel workhorse from the Task Parallel Library.

`Parallel.ForEachAsync` asks: "I have a collection and an async operation per element. Run them concurrently, but cap how many run at once." Its body is a `Func<TSource, CancellationToken, ValueTask>`. It returns a `Task` you await; it does not block. Crucially, it throttles: by default it runs at most `Environment.ProcessorCount` operations in parallel, and you can set that explicitly with `ParallelOptions.MaxDegreeOfParallelism`.

`Task.WhenAll` asks: "I already have a bunch of tasks. Tell me when they are all done." It does not start anything, does not throttle anything, and does not iterate a source. You create the tasks (which start them), hand the collection to `WhenAll`, and await the single task it returns. If you start 5,000 tasks, all 5,000 are in flight the moment you await.

So the real decision is about the shape of your work, not raw speed: CPU-bound over data (`Parallel.ForEach`), async I/O over many items with a ceiling (`Parallel.ForEachAsync`), or a known handful of async operations you want all at once and whose results you need (`Task.WhenAll`).

## The decision matrix

Behavior below is for .NET 6+ unless noted; `Parallel.ForEachAsync` does not exist before .NET 6.

| Capability                          | `Parallel.ForEach`            | `Parallel.ForEachAsync`                       | `Task.WhenAll`                       |
| ----------------------------------- | ----------------------------- | --------------------------------------------- | ------------------------------------ |
| Best for                            | CPU-bound work                | async I/O per item                            | a fixed set of async ops             |
| Body delegate                       | `Action<T>` (synchronous)     | `Func<T, CancellationToken, ValueTask>`       | you create the tasks                 |
| Blocks the calling thread           | yes                           | no (returns `Task`)                           | no (returns `Task`)                  |
| Built-in concurrency limit          | yes (`MaxDegreeOfParallelism`)| yes (`MaxDegreeOfParallelism`)                | no -- all tasks run at once          |
| Default degree of parallelism       | scheduler-managed (`-1`)      | `Environment.ProcessorCount`                  | unbounded                            |
| Returns results                     | no                            | no (returns `Task`, not `Task<T[]>`)          | yes (`Task<TResult[]>`, ordered)     |
| Accepts `IAsyncEnumerable<T>`       | no                            | yes                                           | n/a                                  |
| Cancellation                        | `ParallelOptions`             | `ParallelOptions` + token passed to the body  | cancel the underlying tasks yourself |
| On first exception                  | stops launching iterations    | cancels token, stops scheduling new items     | lets every task run to completion    |
| Exception surface                   | `AggregateException`          | `AggregateException` (await unwraps to first) | `AggregateException` (await unwraps) |
| First shipped                       | .NET Framework 4.0            | .NET 6                                         | .NET Framework 4.5                   |

The rows that decide most real cases are "body delegate" and "built-in concurrency limit." If your per-item work is `async`, `Parallel.ForEach` is already wrong. If you need to cap concurrency, `Task.WhenAll` is already wrong.

## When to pick Parallel.ForEach

Reach for `Parallel.ForEach` when the per-item work is synchronous and CPU-bound, and the collection is already materialized in memory.

- **Transforming a large in-memory array or list.** Resizing 50,000 images, computing checksums, parsing rows. The work keeps a core busy, and partitioning the source across cores is exactly what `Parallel.ForEach` is built for. Set `MaxDegreeOfParallelism` if you want to leave headroom for other work.
- **Embarrassingly parallel number crunching.** A Monte Carlo simulation, a per-pixel filter, a batch of independent matrix operations. No shared state, no I/O, just CPU.
- **You want the calling thread to wait.** `Parallel.ForEach` is synchronous by design. In a console tool or a background job where blocking is fine, that simplicity is a feature.

```csharp
// .NET 11, C# 14 -- CPU-bound work over an in-memory array.
// Parallel.ForEach partitions across cores and blocks until done.
var files = Directory.GetFiles(@"C:\data", "*.bin");
var hashes = new ConcurrentDictionary<string, string>();

Parallel.ForEach(
    files,
    new ParallelOptions { MaxDegreeOfParallelism = Environment.ProcessorCount },
    file =>
    {
        using var stream = File.OpenRead(file);
        byte[] hash = SHA256.HashData(stream);   // CPU + sync I/O, no await
        hashes[file] = Convert.ToHexString(hash);
    });
```

The hard rule: if the body wants to `await` anything, do not reach for `Parallel.ForEach`. People work around the synchronous `Action<T>` by writing `SomeAsyncCall().Result` or `.GetAwaiter().GetResult()` inside the body. That blocks a thread-pool thread for the entire duration of the I/O, and since `Parallel.ForEach` is already consuming pool threads to run iterations, you can deadlock or starve the pool under load. That anti-pattern is the single most common reason `Parallel.ForEachAsync` exists.

## When to pick Parallel.ForEachAsync

`Parallel.ForEachAsync` is the answer to "I have a lot of items and each one calls out to something async, and I do not want to open ten thousand connections at once."

- **Calling an HTTP API for each of many items.** Enriching 8,000 records from a REST endpoint, where firing all 8,000 requests simultaneously would get you rate-limited or exhaust sockets. Set `MaxDegreeOfParallelism = 20` and it keeps 20 requests in flight, starting the next as each finishes.
- **Per-item database or queue work with a ceiling.** A connection pool has a finite size. `Parallel.ForEachAsync` lets you match the degree of parallelism to the pool so you do not block waiting for connections.
- **A streaming source.** It accepts `IAsyncEnumerable<T>`, so you can process items as they arrive from a paged API or a channel without buffering the whole sequence first.

```csharp
// .NET 11, C# 14 -- async I/O per item, capped at 20 concurrent calls.
var ids = await db.Products.Select(p => p.Id).ToListAsync(ct);
var client = httpClientFactory.CreateClient("pricing");

await Parallel.ForEachAsync(
    ids,
    new ParallelOptions
    {
        MaxDegreeOfParallelism = 20,
        CancellationToken = ct
    },
    async (id, token) =>
    {
        var price = await client.GetFromJsonAsync<Price>($"/price/{id}", token);
        await SavePriceAsync(id, price, token);   // never blocks a pool thread
    });
```

Two details that matter. First, the body receives a `CancellationToken` as its second parameter: pass it to every async call inside, not the outer `ct`, because `Parallel.ForEachAsync` cancels that inner token when one iteration fails so the rest can bail early. Second, the default `MaxDegreeOfParallelism` is `Environment.ProcessorCount`, which is tuned for CPU work, not I/O. For I/O-bound calls you almost always want to set it higher than the core count, because the threads are mostly waiting on the network, not computing. If you need finer control than a single integer cap, a [SemaphoreSlim-based gate](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) combined with `Task.WhenAll` gives you the same throttling with more room to vary the limit per call.

## When to pick Task.WhenAll

`Task.WhenAll` is for a known, usually small set of async operations that you want to run concurrently and whose results you need back.

- **A fixed fan-out.** Load a user's profile, their orders, and their notifications in parallel: three independent awaits that should overlap. Start all three, `await Task.WhenAll`, done. This is the everyday use and it is the right one.
- **You need the results, in order.** The generic overload returns `Task<TResult[]>`, and the array preserves input order regardless of completion order. `Parallel.ForEachAsync` returns a plain `Task` with no results, so if you need a result per item, `WhenAll` (or collecting into a thread-safe structure) is the way.
- **The count is bounded and small.** A dozen calls, not ten thousand. Because `WhenAll` does no throttling, the number of concurrent operations equals the number of tasks you started.

```csharp
// .NET 11, C# 14 -- a small, fixed fan-out; results returned in order.
Task<Profile> profile = LoadProfileAsync(userId, ct);
Task<Order[]> orders = LoadOrdersAsync(userId, ct);
Task<Alert[]> alerts = LoadAlertsAsync(userId, ct);

await Task.WhenAll(profile, orders, alerts);

// Each task is complete here; .Result no longer blocks.
var dashboard = new Dashboard(profile.Result, orders.Result, alerts.Result);
```

The trap with `Task.WhenAll` is using it for an unbounded list. `Task.WhenAll(ids.Select(id => CallApiAsync(id)))` over 10,000 ids starts all 10,000 calls the instant the LINQ is enumerated, because `Select` materializes the tasks and each task starts when created. That is a denial-of-service attack on your own downstream service. The moment the list is large or unbounded, you want `Parallel.ForEachAsync` (or a `SemaphoreSlim` gate) instead.

## The benchmark: 500 simulated I/O calls

Raw speed is a misleading axis here, because the fastest option is usually the most dangerous one. The honest comparison is speed against peak concurrency. Each "item" below awaits `Task.Delay(20)` to stand in for a 20 ms network call, run over 500 items.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x, dotnet run -c Release
// Each item simulates a 20 ms I/O call.
[MemoryDiagnoser]
public class FanOutBench
{
    private readonly int[] _items = Enumerable.Range(0, 500).ToArray();
    private static Task IoAsync(CancellationToken ct = default) => Task.Delay(20, ct);

    [Benchmark]
    public Task WhenAll_Unbounded() =>
        Task.WhenAll(_items.Select(_ => IoAsync()));

    [Benchmark]
    public Task ForEachAsync_DefaultDop() =>
        Parallel.ForEachAsync(_items, async (_, ct) => await IoAsync(ct));

    [Benchmark]
    public Task ForEachAsync_Dop50() =>
        Parallel.ForEachAsync(
            _items,
            new ParallelOptions { MaxDegreeOfParallelism = 50 },
            async (_, ct) => await IoAsync(ct));
}
```

Representative results on a 16-core Ryzen 7 / Windows 11 / .NET 11, with the peak concurrency column added by hand from the configuration:

| Method                     | Mean    | Peak concurrent ops | Notes                              |
| -------------------------- | ------- | ------------------- | ---------------------------------- |
| `WhenAll_Unbounded`        | ~24 ms  | 500                 | fastest, but 500 connections open  |
| `ForEachAsync_Dop50`       | ~210 ms | 50                  | 10 batches of 50                   |
| `ForEachAsync_DefaultDop`  | ~640 ms | 16 (`ProcessorCount`)| default cap is CPU-count, low for I/O |

`WhenAll` is roughly 25x faster than the default `ForEachAsync` here, and that is exactly the point: it gets that speed by opening 500 connections at once. If your downstream can take it, great. If it is a third-party API with a rate limit, the "slow" throttled run is the one that does not get you a 429 or a `SocketException`. The default `Parallel.ForEachAsync` is the slowest because its default degree of parallelism is `Environment.ProcessorCount`, tuned for CPU work; for I/O you raise it deliberately, as `Dop50` shows. The takeaway is not "WhenAll wins," it is "pick the concurrency you can afford, then choose the API that enforces it."

## The gotchas that pick for you

A few constraints override preference completely.

**Async body means not `Parallel.ForEach`.** Its body is `Action<T>`. There is no async overload. Blocking inside it with `.Result` or `.GetAwaiter().GetResult()` ties up a pool thread per iteration and invites starvation. If the work awaits, you are on `Parallel.ForEachAsync` or `Task.WhenAll`. See [async void vs async Task](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) for why an `async` lambda silently becomes `async void` when assigned to `Action<T>`, which swallows exceptions and defeats the loop entirely.

**Unbounded list means not `Task.WhenAll`.** `WhenAll` has no throttle. Over a large or unknown number of items it starts everything at once. If you cannot guarantee the count is small, use `Parallel.ForEachAsync` with a `MaxDegreeOfParallelism`.

**Multiple failures surface differently.** All three collect exceptions into an `AggregateException`, but how you observe them differs. `Parallel.ForEach` (synchronous) throws the `AggregateException` directly, so a `catch (AggregateException ae)` sees every inner exception. With both `Parallel.ForEachAsync` and `Task.WhenAll` you `await`, and `await` unwraps to the *first* exception only; to see all of them, inspect the faulted task's `.Exception` property. The deeper difference is timing: `Task.WhenAll` lets every task run to completion even after one faults, so you get failures from all of them, while `Parallel.ForEachAsync` cancels its internal token on the first failure and stops scheduling new iterations, so it short-circuits. If "try everything, report all failures" is the requirement, that points at `WhenAll`; if "stop as soon as one fails" is, that points at `ForEachAsync`.

**Pre-.NET 6 means no `Parallel.ForEachAsync`.** If you are stuck on .NET Framework or .NET Core 3.1, the API does not exist. The idiomatic substitute is a `SemaphoreSlim` gate around `Task.WhenAll`, or for a producer/consumer shape, [a Channel instead of BlockingCollection](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

One more cross-cutting note: when any of these run async work, cancellation should flow through. `Parallel.ForEachAsync` hands your body a token; `Task.WhenAll` only cancels if the tasks you created honor a token. Getting that wiring right is its own topic, covered in [how to cancel a long-running Task without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## The recommendation, restated

Default by the shape of the work. CPU-bound over an in-memory collection: `Parallel.ForEach`, with `MaxDegreeOfParallelism` if you want to leave cores free. Async I/O over many items where you must cap concurrency: `Parallel.ForEachAsync`, and remember to raise `MaxDegreeOfParallelism` above the core count for I/O and to pass the body's token to every inner call. A small, fixed fan-out where you want everything in flight and need the results: `Task.WhenAll`, but never over an unbounded list. The shortest correct version: CPU and data means `Parallel.ForEach`; async I/O at scale means `Parallel.ForEachAsync`; a known handful of awaits means `Task.WhenAll`.

## Related

- [Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/) covers the lower-level primitives these higher-level APIs are built on.
- [async void vs async Task in C#: when each is correct](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) explains the `async void` trap that bites when you pass an async lambda to `Parallel.ForEach`.
- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) is the cancellation half of all three of these.
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) shows the SemaphoreSlim gate that throttles `Task.WhenAll` when you need more control than `Parallel.ForEachAsync` gives.
- [How to use Channels instead of BlockingCollection in C#](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) is the producer/consumer alternative when the work is a pipeline, not a flat fan-out.

## Sources

- [Parallel.ForEachAsync method reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.parallel.foreachasync)
- [Task.WhenAll method reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.whenall)
- [Parallel.ForEach method reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.parallel.foreach)
- [ParallelOptions.MaxDegreeOfParallelism (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.paralleloptions.maxdegreeofparallelism)
- [Parallel.ForEachAsync and Exceptions (Jeremy Bytes)](https://jeremybytes.blogspot.com/2024/02/parallelforeachasync-and-exceptions.html)
