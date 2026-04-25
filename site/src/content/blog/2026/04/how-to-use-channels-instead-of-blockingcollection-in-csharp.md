---
title: "How to use Channels instead of BlockingCollection in C#"
description: "System.Threading.Channels is the async-first replacement for BlockingCollection in .NET 11. This guide shows how to migrate, how to choose bounded vs unbounded, and how to handle backpressure, cancellation, and graceful shutdown without deadlocking."
pubDate: 2026-04-25
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
  - "async"
---

If you have a `BlockingCollection<T>` in a .NET app written before .NET Core 3.0, the modern replacement is `System.Threading.Channels`. Replace `new BlockingCollection<T>(capacity)` with `Channel.CreateBounded<T>(capacity)`, replace `Add` / `Take` with `await WriteAsync` / `await ReadAsync`, and call `channel.Writer.Complete()` instead of `CompleteAdding()`. Consumers iterate with `await foreach (var item in channel.Reader.ReadAllAsync(ct))` instead of `foreach (var item in collection.GetConsumingEnumerable(ct))`. Everything stays thread-safe, no thread is ever blocked while waiting on items, and backpressure works through `await` instead of by parking a worker thread.

This guide targets .NET 11 (preview 3) and C# 14, but `System.Threading.Channels` has been a stable, in-box API since .NET Core 3.0 and is available on .NET Standard 2.0 through the [`System.Threading.Channels` NuGet package](https://www.nuget.org/packages/System.Threading.Channels). Nothing here is preview-only.

## Why BlockingCollection no longer fits

`BlockingCollection<T>` arrived with .NET Framework 4.0 in 2010. Its design assumed a world where one thread per consumer was cheap and where async/await did not exist. `Take()` parks the calling thread on a kernel synchronization primitive until an item is available; `Add()` does the same when the bounded capacity is full. In a console app processing 10 items per second, that is fine. In an ASP.NET Core endpoint, a worker service, or anything running under `ThreadPool` pressure, every blocked consumer takes a thread out of rotation. Twenty consumers blocked on `Take()` are twenty threads the runtime cannot use for anything else, and the thread pool's hill-climbing heuristic responds by spawning more threads, which are themselves expensive (about 1 MB of stack each on Windows by default).

`System.Threading.Channels` was added in .NET Core 3.0 specifically to remove that cost. A consumer waiting on `ReadAsync` does not hold a thread at all -- the continuation is queued onto the thread pool only when an item is actually written. This is the same async-state-machine pattern that powers `Task` and `ValueTask`, and it is why a single ASP.NET Core process can host tens of thousands of concurrent channel consumers without exhausting the thread pool. The official Microsoft .NET Blog [introduction to channels](https://devblogs.microsoft.com/dotnet/an-introduction-to-system-threading-channels/) makes the explicit recommendation: use channels for any new producer-consumer pattern that touches I/O, and reserve `BlockingCollection<T>` for synchronous, CPU-bound worker scenarios where blocking a thread is genuinely acceptable.

There is also a measurable throughput difference. Microsoft's own benchmarks and several independent comparisons (see Michael Shpilt's [producer/consumer performance showdown](https://michaelscodingspot.com/performance-of-producer-consumer/)) put `Channel<T>` at roughly 4x the throughput of `BlockingCollection<T>` for typical message sizes, because the channel uses lock-free `Interlocked` operations on the fast path and avoids the kernel transitions that `BlockingCollection` incurs.

## A minimal repro of the BlockingCollection pattern

Here is the canonical `BlockingCollection<T>` setup that most legacy code follows. It uses a bounded capacity (so producers throttle when consumers fall behind), a `CancellationToken`, and `CompleteAdding` to let consumers exit cleanly.

```csharp
// .NET 11, C# 14 -- legacy pattern, do not write new code like this
using System.Collections.Concurrent;

var queue = new BlockingCollection<int>(boundedCapacity: 100);
using var cts = new CancellationTokenSource();

var producer = Task.Run(() =>
{
    for (int i = 0; i < 10_000; i++)
        queue.Add(i, cts.Token);

    queue.CompleteAdding();
});

var consumer = Task.Run(() =>
{
    foreach (int item in queue.GetConsumingEnumerable(cts.Token))
        Process(item);
});

await Task.WhenAll(producer, consumer);

static void Process(int item) { /* work */ }
```

Two threads are dedicated for the lifetime of this pipeline. If `Process` does I/O, the consumer thread sits idle during every `await`-equivalent wait and the channel can do better. If you scale to four producers and eight consumers, that is twelve threads consumed.

## The Channels equivalent

Here is the same pipeline using `System.Threading.Channels`. The shape of the code is similar; the difference is that no thread is ever blocked.

```csharp
// .NET 11, C# 14 -- modern replacement
using System.Threading.Channels;

var channel = Channel.CreateBounded<int>(new BoundedChannelOptions(100)
{
    FullMode = BoundedChannelFullMode.Wait,
    SingleReader = false,
    SingleWriter = false
});

using var cts = new CancellationTokenSource();

var producer = Task.Run(async () =>
{
    for (int i = 0; i < 10_000; i++)
        await channel.Writer.WriteAsync(i, cts.Token);

    channel.Writer.Complete();
});

var consumer = Task.Run(async () =>
{
    await foreach (int item in channel.Reader.ReadAllAsync(cts.Token))
        await ProcessAsync(item);
});

await Task.WhenAll(producer, consumer);

static ValueTask ProcessAsync(int item) => ValueTask.CompletedTask;
```

Three differences are worth pointing at directly. `WriteAsync` returns a `ValueTask` rather than blocking when the buffer is full -- the producer's continuation resumes only when there is room. `ReadAllAsync` returns an `IAsyncEnumerable<T>` that completes when `Writer.Complete()` is called, exactly mirroring `GetConsumingEnumerable`'s behaviour after `CompleteAdding`. And `Channel.CreateBounded` requires you to declare `FullMode` explicitly, which forces a decision that `BlockingCollection` quietly took for you (it always blocked).

## Bounded vs unbounded: pick deliberately

`Channel.CreateBounded(capacity)` has a hard upper bound on buffered items and pushes back on producers when the buffer is full. `Channel.CreateUnbounded()` has no upper bound, so writes complete synchronously and never wait. Unbounded channels are tempting because they look faster on a microbenchmark, but they are a memory leak waiting to happen: if your consumer falls behind by even a few seconds in a high-throughput pipeline, the channel will happily buffer gigabytes of work items before anyone notices. Use `CreateBounded` by default. Reach for `CreateUnbounded` only when you can prove the consumer is faster than the producer, or when the producer's rate is intrinsically limited by something else (for example, a webhook receiver whose throughput is bounded by the upstream sender).

`BoundedChannelFullMode` controls what happens when a bounded channel is full and a producer calls `WriteAsync`. The four options are:

- `Wait` (default): the producer's `ValueTask` does not complete until space is available. This is the direct equivalent of `BlockingCollection.Add`'s blocking behaviour and is the right default.
- `DropOldest`: the oldest item in the buffer is removed to make room. Use for telemetry where stale data is worse than missing data.
- `DropNewest`: the newest item already in the buffer is removed. Rarely useful.
- `DropWrite`: the new item is silently discarded. Use for fire-and-forget logging where dropping the new write is cheaper than backpressuring the producer.

If you choose `DropOldest` / `DropNewest` / `DropWrite`, `WriteAsync` always completes synchronously, so the producer is never throttled. Mixing those modes with a "I want backpressure" expectation is a common source of bugs. `Wait` is the only mode that actually backpressures.

## Migrating an existing BlockingCollection pipeline

Most BlockingCollection code maps mechanically. The translation table:

- `new BlockingCollection<T>(capacity)` -> `Channel.CreateBounded<T>(new BoundedChannelOptions(capacity) { FullMode = BoundedChannelFullMode.Wait })`
- `new BlockingCollection<T>()` (unbounded) -> `Channel.CreateUnbounded<T>()`
- `collection.Add(item, token)` -> `await channel.Writer.WriteAsync(item, token)`
- `collection.TryAdd(item)` -> `channel.Writer.TryWrite(item)` (returns `bool`, never blocks)
- `collection.Take(token)` -> `await channel.Reader.ReadAsync(token)`
- `collection.TryTake(out var item)` -> `channel.Reader.TryRead(out var item)`
- `collection.GetConsumingEnumerable(token)` -> `channel.Reader.ReadAllAsync(token)` (with `await foreach`)
- `collection.CompleteAdding()` -> `channel.Writer.Complete()` (or `Complete(exception)` to signal a fault)
- `collection.IsCompleted` -> `channel.Reader.Completion.IsCompleted`
- `BlockingCollection.AddToAny / TakeFromAny` -> no direct equivalent, see "gotchas" below

The non-blocking `TryWrite` and `TryRead` are critical for one specific scenario: synchronous code paths that must not introduce an `await`. They return `false` instead of waiting, and you can poll or fall back to a different code path. Most code does not need them; prefer the async forms.

If your producers run on the thread pool and your channel is hot, you may want to set `SingleWriter = true` (or `SingleReader = true`). Channels use a different, faster internal implementation when they know there is exactly one producer or consumer. The check is opportunistic only -- the runtime does not enforce it -- so set this flag honestly. If you set `SingleWriter = true` and then accidentally have two producers, `WriteAsync` will misbehave in subtle ways (lost items, broken completion).

## Backpressure, cancellation, and graceful shutdown

Backpressure works through the `WriteAsync` `ValueTask`. When the buffer is full, the producer's task is incomplete until the consumer reads an item, at which point a single waiting writer is released. This is the same shape as a semaphore but with the semantics tied to the buffer state rather than a separate counter.

Cancellation propagates the same way it does in any async API. Pass a `CancellationToken` into `WriteAsync`, `ReadAsync`, and `ReadAllAsync`. When the token fires, the in-flight `ValueTask` throws `OperationCanceledException`. The channel itself is not cancelled by the token -- other producers and consumers that did not pass that token continue normally. If you want to cancel the entire pipeline, call `channel.Writer.Complete()` (or `Complete(exception)`), which signals all current and future readers that no more data is coming. See [how to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) for the broader pattern.

Graceful shutdown looks like this in a worker service:

```csharp
// .NET 11, C# 14
public class ImportWorker : BackgroundService
{
    private readonly Channel<ImportJob> _channel =
        Channel.CreateBounded<ImportJob>(new BoundedChannelOptions(500)
        {
            FullMode = BoundedChannelFullMode.Wait
        });

    public ChannelWriter<ImportJob> Writer => _channel.Writer;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var job in _channel.Reader.ReadAllAsync(stoppingToken))
                await ProcessAsync(job, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // expected on host shutdown
        }
        finally
        {
            _channel.Writer.TryComplete();
        }
    }

    private static ValueTask ProcessAsync(ImportJob job, CancellationToken ct)
        => ValueTask.CompletedTask;
}

public record ImportJob(string Id);
```

Two notes. `TryComplete` (vs `Complete`) is idempotent and safe to call from `finally`. The `OperationCanceledException` filter only swallows the cancellation when it actually comes from `stoppingToken` -- a cancellation triggered by a different token still propagates, which is what you want.

If your producers can fault, prefer `channel.Writer.Complete(exception)`. The next consumer call to `ReadAsync` or `ReadAllAsync` will rethrow that exception, which is the channel-equivalent of `BlockingCollection.GetConsumingEnumerable` rethrowing after `CompleteAdding` was called following a fault.

## Gotchas you will hit

`Channel.Writer.WriteAsync` returns `ValueTask`, not `Task`. If you store the result and await it more than once, you trigger undefined behaviour -- `ValueTask` is documented as single-await. The 99% case is `await channel.Writer.WriteAsync(item)` inline; this is only a concern if you start passing the return value around.

`Reader.Completion` is a `Task` that completes when `Writer.Complete` is called and all items have been drained. If you want to know when the channel is fully empty and closed, await `Reader.Completion`. Do not check `Reader.Count == 0`, which exists but races against in-flight writes.

`ChannelReader<T>.WaitToReadAsync` returns `false` only when the channel is completed and empty. This is the right primitive for hand-rolled consumer loops where `await foreach` does not fit, for example because you want to batch reads:

```csharp
// .NET 11, C# 14 -- batched consumer
while (await channel.Reader.WaitToReadAsync(ct))
{
    var batch = new List<int>(capacity: 100);
    while (batch.Count < 100 && channel.Reader.TryRead(out int item))
        batch.Add(item);

    if (batch.Count > 0)
        await ProcessBatchAsync(batch, ct);
}

static ValueTask ProcessBatchAsync(IReadOnlyList<int> items, CancellationToken ct)
    => ValueTask.CompletedTask;
```

`BlockingCollection` had `AddToAny` and `TakeFromAny` that operated across multiple collections. Channels have no direct equivalent. If you genuinely need fan-in across N channels, the idiomatic pattern is to spawn one consumer task per source channel that all write into a single downstream channel; this composes cleanly with the cancellation model and stays async-friendly. If you genuinely need fan-out (one producer feeding N consumers), spawn N reader tasks against the same `Reader` -- channels are safe for multiple readers as long as you do not set `SingleReader = true`.

`System.Threading.Channels` is not a serialization channel like Go's `chan` or a distributed messaging primitive. It is in-process only. If you need cross-process or cross-machine messaging, use a real message broker (Azure Service Bus, RabbitMQ, Kafka). Channels are the right tool inside a single process; they are the wrong tool the moment a network is involved.

## When BlockingCollection is still defensible

There is one narrow case where keeping `BlockingCollection<T>` is reasonable: a synchronous, CPU-bound worker pool inside a console app or batch job, where you control the thread count and do not care about thread pool pressure because there is no thread pool pressure to worry about. The Microsoft Learn [Channels overview](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels) is explicit on this. Everywhere else (ASP.NET Core, worker services, any code that touches I/O, any code shared with async-aware consumers), prefer `System.Threading.Channels`.

## Related posts

- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [How to use IAsyncEnumerable&lt;T&gt; with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [How to read a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

## Sources

- [An Introduction to System.Threading.Channels (Microsoft .NET Blog)](https://devblogs.microsoft.com/dotnet/an-introduction-to-system-threading-channels/)
- [Channels overview (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels)
- [BoundedChannelOptions class reference](https://learn.microsoft.com/en-us/dotnet/api/system.threading.channels.boundedchanneloptions)
- [Performance Showdown of Producer/Consumer Implementations in .NET (Michael Shpilt)](https://michaelscodingspot.com/performance-of-producer-consumer/)
- [System.Threading.Channels source on GitHub](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Threading.Channels)
