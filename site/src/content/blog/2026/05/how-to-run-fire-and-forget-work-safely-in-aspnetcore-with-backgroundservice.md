---
title: "How to run fire-and-forget work safely in ASP.NET Core with BackgroundService"
description: "Calling Task.Run from a controller loses work on shutdown, swallows exceptions, and captures disposed scoped services. The safe pattern is a bounded Channel queue drained by a BackgroundService that opens a fresh scope per work item and drains in-flight work on StopAsync."
pubDate: 2026-05-31
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "backgroundservice"
  - "async"
---

The moment you want an HTTP request to return immediately while some slower work (sending an email, writing an audit record, calling a webhook) keeps running, the obvious move is `_ = Task.Run(() => DoTheWorkAsync())` inside the controller. It compiles, the response is fast, and in a demo it looks like it works. In production it loses work on every deployment, swallows every exception, and reaches into scoped services that have already been disposed. The safe replacement is a bounded `Channel<T>` queue registered as a singleton, drained by a single `BackgroundService` that opens a fresh DI scope per work item, catches and logs exceptions per item, and finishes in-flight work during graceful shutdown. This guide is written against .NET 11 (preview 4 at the time of writing, general availability targeted for November 2026), `Microsoft.Extensions.Hosting` 11.0.0, and `System.Threading.Channels` from the in-box BCL. The queue and `BackgroundService` contracts have been stable since .NET Core 3.1, so every pattern here applies unchanged to .NET 6, 8, and 10.

## Why `Task.Run` in a request handler is a trap

The appeal of `Task.Run` is that it returns instantly and the framework never blocks on it. That is exactly the problem: the framework never blocks on it, never tracks it, and never waits for it.

Three concrete failures follow from that:

- **Lost work on shutdown.** When the host shuts down (a deployment, a scale-in, a crashed sibling pod triggering a rolling restart), it does not know your detached `Task` exists. It stops accepting requests, waits for the requests it knows about, and tears the process down. Any `Task.Run` work still in flight is killed mid-execution. On a busy service every deploy silently drops a handful of emails or audit rows.
- **Swallowed exceptions.** An unobserved exception in a detached `Task` does not crash the app and does not reach your logging pipeline. It surfaces, if at all, in the finalizer thread as a `TaskScheduler.UnobservedTaskException` long after the request is gone. The first time you learn the work is failing is when a customer asks where their email went.
- **Captured, disposed dependencies.** This is the subtle one. If your controller closes over an injected `DbContext` or any scoped service, that service is tied to the request scope. ASP.NET Core disposes the request scope the instant the response is written. Your `Task.Run` body, still running, now touches a disposed `DbContext` and throws `ObjectDisposedException: Cannot access a disposed context instance`, or worse, races the disposal and corrupts state.

There is also a load dimension: a controller that spins up `Task.Run` on every request competes for the same thread pool that serves your requests, so a traffic spike turns into thread pool starvation. If you want the full breakdown of how `Task.Run` differs from the other offloading primitives, the comparison in [Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/) covers when each is appropriate. For request handlers, the answer is: none of them directly.

Fire-and-forget is only ever acceptable when losing the work on a restart is genuinely fine. The pattern below does not make work durable (for that you need an external queue like Azure Storage Queues or a database-backed job store), but it does fix the other three problems and gives in-memory work a clean shutdown drain.

## The shape of the safe pattern

Microsoft's own [queued background tasks guidance](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) describes the canonical structure, and it has three parts:

1. A **work-item queue** backed by a bounded `Channel<Func<CancellationToken, ValueTask>>`, registered as a singleton so producers and the consumer share one instance.
2. A single **`BackgroundService` consumer** that loops, dequeues one work item at a time, opens a DI scope, runs it, and catches exceptions per item.
3. **Producers** (controllers, minimal API handlers, other services) that inject the queue interface and enqueue a delegate instead of running it inline.

The request handler returns the instant the work item is enqueued. The work itself runs on the consumer, completely decoupled from the request lifetime. Let me build each piece.

## Step 1: define and implement the bounded queue

The queue exposes two operations: enqueue (called by producers) and dequeue (called by the consumer). The work item is a `Func<CancellationToken, ValueTask>` so the consumer can pass its own cancellation token in at execution time.

```csharp
// .NET 11, C# 14 - IBackgroundTaskQueue.cs
public interface IBackgroundTaskQueue
{
    ValueTask QueueBackgroundWorkItemAsync(Func<CancellationToken, ValueTask> workItem);

    ValueTask<Func<CancellationToken, ValueTask>> DequeueAsync(
        CancellationToken cancellationToken);
}
```

The implementation wraps a bounded channel. Bounding the channel is not optional in a production service: an unbounded queue under a producer that outruns the consumer is a memory leak with extra steps.

```csharp
// .NET 11, C# 14 - BackgroundTaskQueue.cs
using System.Threading.Channels;

public sealed class BackgroundTaskQueue : IBackgroundTaskQueue
{
    private readonly Channel<Func<CancellationToken, ValueTask>> _queue;

    public BackgroundTaskQueue(int capacity)
    {
        // BoundedChannelFullMode.Wait makes QueueBackgroundWorkItemAsync await
        // a free slot once the queue is full, applying back pressure to producers
        // instead of dropping work or growing without bound.
        var options = new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.Wait
        };
        _queue = Channel.CreateBounded<Func<CancellationToken, ValueTask>>(options);
    }

    public async ValueTask QueueBackgroundWorkItemAsync(
        Func<CancellationToken, ValueTask> workItem)
    {
        ArgumentNullException.ThrowIfNull(workItem);
        await _queue.Writer.WriteAsync(workItem);
    }

    public async ValueTask<Func<CancellationToken, ValueTask>> DequeueAsync(
        CancellationToken cancellationToken)
    {
        var workItem = await _queue.Reader.ReadAsync(cancellationToken);
        return workItem;
    }
}
```

The choice of `BoundedChannelFullMode` is a real design decision. `Wait` (above) back-pressures the producer, which for a request handler means the enqueue call awaits until there is room. If you would rather shed load than make a request wait, use `BoundedChannelFullMode.DropWrite` and check the return value of `TryWrite`. Whichever you pick, do it deliberately. If channels are new to you, [using Channels instead of BlockingCollection](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) explains the reader/writer model and why `Channel<T>` is the right async producer-consumer primitive in modern .NET.

## Step 2: the BackgroundService that drains the queue

The consumer is a single `BackgroundService`. Its only job is to pull one work item at a time and run it inside a try/catch so a single poison work item cannot kill the loop.

```csharp
// .NET 11, C# 14 - QueuedHostedService.cs
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

public sealed class QueuedHostedService(
    IBackgroundTaskQueue taskQueue,
    ILogger<QueuedHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Queued hosted service is running.");
        await BackgroundProcessing(stoppingToken);
    }

    private async Task BackgroundProcessing(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var workItem = await taskQueue.DequeueAsync(stoppingToken);

            try
            {
                await workItem(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                // Expected during shutdown; let the loop unwind.
                break;
            }
            catch (Exception ex)
            {
                // The whole point: one failing item is logged, not lost, and the
                // loop survives to process the next item.
                logger.LogError(ex, "Error occurred executing background work item.");
            }
        }
    }

    public override async Task StopAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Queued hosted service is stopping.");
        await base.StopAsync(stoppingToken);
    }
}
```

The per-item try/catch is the difference between this and `Task.Run`. With `Task.Run`, an exception is unobserved. Here, every failure lands in `ILogger` with a stack trace, and the consumer keeps draining. This is also why the work item is a `Func` returning `ValueTask` rather than an `async void` delegate: an `async void` body throws into the void and you are back to swallowed exceptions. If the distinction between `async void` and `async Task` is fuzzy, [async void vs async Task in C#](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) lays out exactly why `async void` is reserved for event handlers and nothing else.

## Step 3: register everything

The queue is a singleton (one shared instance), the consumer is a hosted service, and you choose a capacity. The capacity should reflect how much work you are willing to hold in memory at once.

```csharp
// .NET 11, C# 14 - Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHostedService<QueuedHostedService>();
builder.Services.AddSingleton<IBackgroundTaskQueue>(_ =>
{
    // Tune to your workload. 100 means at most 100 queued items before
    // producers start waiting (with BoundedChannelFullMode.Wait).
    const int queueCapacity = 100;
    return new BackgroundTaskQueue(queueCapacity);
});

builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();
```

## Step 4: enqueue from a request handler, with a scope per work item

Now the producer. A controller injects `IBackgroundTaskQueue` and enqueues a delegate. The critical detail: the delegate must **not** close over any scoped service from the request. The request scope is gone by the time the work runs. Instead, capture only plain data (an order id, a string), and resolve scoped services from a fresh scope inside the delegate using `IServiceScopeFactory`.

```csharp
// .NET 11, C# 14 - OrdersController.cs
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

[ApiController]
[Route("orders")]
public sealed class OrdersController(
    IBackgroundTaskQueue queue,
    IServiceScopeFactory scopeFactory) : ControllerBase
{
    [HttpPost("{id:int}/confirm")]
    public async Task<IActionResult> Confirm(int id)
    {
        // Capture only the id - a value type, not a scoped service.
        await queue.QueueBackgroundWorkItemAsync(async token =>
        {
            // Fresh scope per work item: a clean DbContext, resolved and disposed here.
            await using var scope = scopeFactory.CreateAsyncScope();
            var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();
            await processor.ConfirmAsync(id, token);
        });

        // Returns immediately; the confirmation runs on the consumer.
        return Accepted();
    }
}
```

`HTTP 202 Accepted` is the honest status code here: you have accepted the request for processing, not completed it. Returning `200 OK` would imply the work is done, which it is not.

The scope-per-work-item rule is the same discipline you need anywhere a singleton touches scoped services. Opening one `CreateAsyncScope()` per unit of work, resolving inside it, and disposing it when the work finishes is covered in depth in [using scoped services inside a BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/). The reason `await using` and `CreateAsyncScope()` matter (rather than the synchronous `CreateScope()`) is that EF Core's `DbContext` implements `IAsyncDisposable` and can throw if disposed synchronously.

If you skip the scope and instead capture the request's `DbContext` directly in the delegate, you reproduce exactly the disposed-dependency bug from the top of this article, and frequently [the second-operation-on-context error](/2026/05/fix-second-operation-was-started-on-this-context-instance/) when a later request reuses a context the framework thinks it has freed. And if you try to inject the scoped service straight into a singleton consumer to "simplify" things, you hit [cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) at startup.

## Graceful shutdown: draining versus abandoning

This is where the pattern earns its keep over `Task.Run`. `BackgroundService` participates in the host's shutdown sequence. When the host stops, it signals `stoppingToken`, and the host waits up to the shutdown timeout (30 seconds by default) for `StopAsync` to return.

Two behaviours are worth being deliberate about:

**Stop accepting, finish the current item.** With the loop above, `DequeueAsync(stoppingToken)` throws `OperationCanceledException` once the token fires, the loop breaks, and any work item currently executing finishes (because we `await workItem(stoppingToken)` before looping back). Items still sitting in the channel are abandoned. For in-memory fire-and-forget, that is the accepted trade.

**Give in-flight work enough time.** If your work items can run longer than a couple of seconds, raise the shutdown timeout so the host does not kill a half-finished item:

```csharp
// .NET 11, C# 14 - Program.cs
builder.Services.Configure<HostOptions>(options =>
{
    options.ShutdownTimeout = TimeSpan.FromSeconds(60);
});
```

A producer that needs the work to be bound to the application's lifetime rather than a request can take `IHostApplicationLifetime` and enqueue against `ApplicationStopping`, but for request-originated work the consumer's `stoppingToken` is the correct signal. Whatever you do, thread the token all the way through your work item. A work item that ignores the token and blocks will hold the entire shutdown hostage for the full timeout. For work that genuinely cannot be cancelled cooperatively, [cancelling a long-running Task without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) covers the options.

## Processing items in parallel without sharing a scope

The single-consumer loop processes one item at a time. If your work items are independent and you want throughput, you can run several concurrently, but each concurrent item must get its own scope, because a `DbContext` and a DI scope are not thread-safe. Bound the concurrency with a `SemaphoreSlim` so a burst of enqueues cannot saturate the thread pool:

```csharp
// .NET 11, C# 14 - inside BackgroundProcessing
private readonly SemaphoreSlim _concurrency = new(initialCount: 4);

private async Task BackgroundProcessing(CancellationToken stoppingToken)
{
    while (!stoppingToken.IsCancellationRequested)
    {
        var workItem = await taskQueue.DequeueAsync(stoppingToken);
        await _concurrency.WaitAsync(stoppingToken);

        // Fire each item on its own task; the semaphore caps concurrency at 4.
        _ = Task.Run(async () =>
        {
            try
            {
                await workItem(stoppingToken);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error executing background work item.");
            }
            finally
            {
                _concurrency.Release();
            }
        }, stoppingToken);
    }
}
```

Note that the `Task.Run` here is acceptable in a way it was not in the controller: it is inside a tracked `BackgroundService`, every exception is caught and logged, the concurrency is bounded, and each work item already creates its own scope internally. The thing that made `Task.Run` dangerous in a request handler (no tracking, no exception handling, captured request scope) is absent here. The trade-off is that parallel processing complicates the shutdown story, because in-flight tasks are no longer awaited by the loop. If you need both parallelism and a clean drain, track the outstanding tasks in a `List<Task>` and `await Task.WhenAll` them in `StopAsync`.

## When a Channel queue is not enough

This pattern keeps everything in process memory. That is its strength (zero external infrastructure) and its limit. Reach for something heavier when:

- **The work must survive a restart.** If losing queued work on a deploy is unacceptable, you need durability the channel cannot give. Persist the job to a database table or push it to Azure Storage Queues / Amazon SQS, and have the `BackgroundService` (or a separate worker process) pull from there. The enqueue/consume shape stays identical; only the backing store changes.
- **You run multiple instances and need exactly-once.** An in-memory queue is per-instance. Three pods means three independent queues. A shared durable queue with a visibility-timeout lease is the way to coordinate.
- **You need retries, scheduling, or dashboards.** At that point a library like Hangfire or a hosted job platform earns its complexity. Do not rebuild a job scheduler on top of a channel.

For long-lived workers you keep in production, pair the queue with observability so a stuck or silently failing consumer surfaces before users notice; the approach in [monitoring background jobs without Hangfire](/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) applies directly to this consumer.

The mental model that keeps all of this correct: the request handler's job is to *accept* work and return, the singleton consumer *owns the loop and the cancellation*, and each work item *owns a fresh scope for its own state*. The instant you collapse those responsibilities (running the work inline, capturing the request's scope, or detaching an untracked `Task`), one of the three failures at the top of this article comes back.

## Sources

- Microsoft Learn, [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) (updated 2026-05-05), the canonical queued-background-task pattern this post is built on.
- Microsoft Learn, [System.Threading.Channels](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels) for `BoundedChannelOptions` and `BoundedChannelFullMode`.
- Microsoft Learn, [`HostOptions.ShutdownTimeout`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.shutdowntimeout) for tuning the graceful-shutdown window.
- Microsoft Learn, [`AsyncServiceScope` and `CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope) for scope-per-work-item disposal.
