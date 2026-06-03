---
title: "BackgroundService vs IHostedService vs Hangfire for background jobs in .NET 11"
description: "Pick BackgroundService for in-process loops, raw IHostedService when you need fine lifecycle control, and Hangfire when jobs must survive a restart. A decision matrix with code and the one gotcha that picks for you."
pubDate: 2026-06-03
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
---

For background work in a .NET 11 app, the short answer is: use `BackgroundService` for continuous in-process loops and queue consumers, drop down to a raw `IHostedService` only when you need explicit ordered startup or shutdown hooks, and reach for Hangfire the moment a job has to survive a process restart or be scheduled for "next Tuesday at 2am." The first two are the same hosting primitive at different altitudes and cost you nothing extra. Hangfire is a separate dependency with a database behind it, and that database is exactly what you are paying for. This post builds the decision matrix, shows the minimal code for each, and points at the single requirement -- durability -- that usually makes the call for you.

All examples target .NET 11 and C# 14. Hangfire examples use Hangfire 1.8.x (`Hangfire.AspNetCore` plus `Hangfire.SqlServer`).

## The feature matrix

This is the table you came for. Read the "Durable across restart" row first; it is the one that splits the field.

| Feature                          | IHostedService          | BackgroundService        | Hangfire                       |
| -------------------------------- | ----------------------- | ------------------------ | ------------------------------ |
| Built into .NET 11               | yes                     | yes                      | no (NuGet + storage)           |
| Extra infrastructure             | none                    | none                     | SQL Server / Redis / Postgres  |
| Lifecycle surface                | `StartAsync`/`StopAsync`| one `ExecuteAsync`       | none (you enqueue jobs)        |
| Best for                         | startup/shutdown steps  | long-running loops       | one-off and scheduled jobs     |
| Survives a process restart       | no                      | no                       | yes                            |
| Retries on failure               | you write them          | you write them           | automatic, configurable        |
| Scheduling (cron, delay)         | you write it            | you write it             | built in                       |
| Runs across multiple instances   | runs on every instance  | runs on every instance   | one worker picks each job      |
| Dashboard / visibility           | none                    | none                     | built-in web dashboard         |
| Cost                             | free                    | free                     | OSS core; Pro license for some |

`BackgroundService` is not an alternative to `IHostedService`; it is an abstract class that implements it. So the real choice is two-way: in-process hosted service (in one of its two forms) versus an external durable job system. Let me take them in order.

## IHostedService: the raw lifecycle contract

`IHostedService` is the low-level interface the .NET generic host calls during startup and shutdown. It has exactly two methods:

```csharp
// .NET 11, C# 14
public interface IHostedService
{
    Task StartAsync(CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}
```

The host awaits every registered service's `StartAsync` in registration order before it serves the first request, and it awaits `StopAsync` (up to `HostOptions.ShutdownTimeout`, 30 seconds by default) before the process exits. That ordering guarantee is the reason to use the raw interface: it is the right place for work that must complete before traffic arrives -- warming a cache, running a one-time migration check, opening a long-lived connection.

```csharp
// .NET 11, C# 14
public sealed class CacheWarmer(IMemoryCache cache, IProductRepository repo) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        // Runs to completion BEFORE the app starts serving requests.
        var hot = await repo.GetHotProductsAsync(ct);
        cache.Set("hot-products", hot);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

The trap with raw `IHostedService` is doing long-running work inside `StartAsync`. If you start an infinite loop there and `await` it, the host never finishes starting. You have to fire the loop without awaiting it and track the `Task` yourself, then cancel and await it in `StopAsync`. That bookkeeping is exactly what `BackgroundService` exists to remove.

If you need even finer control -- a hook that runs *after every* hosted service has started, or just before shutdown begins -- .NET 8 added `IHostedLifecycleService`, which extends `IHostedService` with `StartingAsync`/`StartedAsync` and `StoppingAsync`/`StoppedAsync`. It is still current in .NET 11 and is the documented place for cross-service "everything is up now" validation, as Steve Gordon's [walkthrough of the interface](https://www.stevejgordon.co.uk/introducing-the-new-ihostedlifecycleservice-interface-in-dotnet-8) describes.

## BackgroundService: the loop you actually want

`BackgroundService` is the abstract base class that implements `IHostedService` for you using the template-method pattern. You override one method:

```csharp
// .NET 11, C# 14
public sealed class QueuePump(IServiceScopeFactory scopeFactory, ILogger<QueuePump> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();
                await processor.DrainOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break; // normal shutdown
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Order pump iteration failed; retrying");
            }

            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }
}
```

The framework calls `ExecuteAsync` from inside its own `StartAsync`, signals the `stoppingToken` when the host stops, and awaits your returned `Task` during shutdown. Two details bite people often enough to call out:

- **A `BackgroundService` is a singleton.** You cannot inject a scoped service such as a `DbContext` directly; you take `IServiceScopeFactory` and open a scope per unit of work, exactly as above. I wrote a dedicated walkthrough of [using scoped services inside a BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).
- **An unhandled exception in `ExecuteAsync` stops the service silently** (and since .NET 6, by default, stops the whole host through `BackgroundServiceExceptionBehavior.StopHost`). Wrap the loop body in try/catch if a single bad iteration should not kill the service, as shown.

Register either form the same way:

```csharp
// .NET 11, C# 14 -- Program.cs
builder.Services.AddHostedService<QueuePump>();      // BackgroundService
builder.Services.AddHostedService<CacheWarmer>();    // raw IHostedService
```

A `BackgroundService` paired with a bounded `System.Threading.Channel` is the canonical in-process job queue: producers write work items, the service drains them. If you have ever reached for `Task.Run` from a controller, that is the pattern you actually wanted -- see [running fire-and-forget work safely with a BackgroundService](/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) and the broader case for [Channels over BlockingCollection](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

## When to pick the in-process options

**Pick `BackgroundService` when:**

- You have a continuous loop: a queue consumer, a poller, a heartbeat, a metrics flusher. This is its home turf.
- The work is acceptable to lose on shutdown, or you drain in-flight items in the brief `StopAsync` window. Email retries that will be re-driven from a queue anyway, cache refreshes, log shipping.
- You want zero new infrastructure. It ships in `Microsoft.Extensions.Hosting`; there is nothing to install or provision.

**Pick raw `IHostedService` (or `IHostedLifecycleService`) when:**

- You need work to finish *before* the first request is served (cache warm, schema check, feature-flag prefetch).
- You need ordered startup or shutdown across several services, or a post-startup "all green" validation hook.
- The work is a discrete start/stop step, not a perpetual loop, so the single-`ExecuteAsync` shape of `BackgroundService` does not fit.

Both run on *every* instance of your app. If you scale to three replicas, your `BackgroundService` runs three times, in parallel, with no coordination. For a stateless poller that is fine. For "send the nightly invoice email once," it is a bug.

## When to pick Hangfire

**Pick Hangfire when any of these is true:**

- **A job must survive a restart or crash.** Hangfire writes the job to storage (SQL Server, Redis, or PostgreSQL) before running it, so a deploy mid-job does not lose it. The job is picked up again. This is the headline feature.
- **You need scheduling.** "Run in 10 minutes," "every weekday at 6am" (cron), "this exact UTC time." Built in, no timer math.
- **You need automatic retries with backoff.** Hangfire retries failed jobs a configurable number of times by default, with the attempt history visible in its dashboard.
- **You need a single execution across N instances.** Hangfire servers compete for jobs from shared storage, so each job runs once regardless of how many app instances are up. That solves the "nightly email three times" problem cleanly.
- **You want operational visibility.** The bundled dashboard shows enqueued, processing, succeeded, and failed jobs with stack traces -- something you would otherwise build yourself.

Minimal setup in .NET 11:

```csharp
// .NET 11, C# 14 -- Program.cs
builder.Services.AddHangfire(cfg => cfg
    .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
    .UseSimpleAssemblyNameTypeSerializer()
    .UseRecommendedSerializerSettings()
    .UseSqlServerStorage(builder.Configuration.GetConnectionString("HangfireDb")));

builder.Services.AddHangfireServer();

var app = builder.Build();
app.UseHangfireDashboard("/jobs");  // lock this down in production

// Fire-and-forget, durable:
BackgroundJob.Enqueue<IInvoiceService>(s => s.SendAsync(orderId, CancellationToken.None));

// Recurring (cron):
RecurringJob.AddOrUpdate<IReportService>(
    "nightly-report",
    s => s.BuildAsync(CancellationToken.None),
    Cron.Daily(2));
```

Note what just changed: you now own a database table set Hangfire manages, a connection string, migrations of that schema across Hangfire upgrades, and a dashboard endpoint you must authorize. That is real operational weight. You take it on deliberately, in exchange for durability and scheduling you would otherwise hand-roll badly.

## The throughput picture, with real numbers

Performance is rarely the deciding axis here, but it is worth being honest about the cost of durability. An in-process `BackgroundService` draining a `Channel` does no I/O per item beyond your own work; the dispatch overhead is effectively a method call and is not measurable against the work itself. Hangfire, by contrast, does at least one storage round-trip to dequeue and one to mark completion per job.

Hangfire's own documentation quantifies the storage choice: switching from SQL Server to Redis yields **more than 4x throughput** on empty jobs, per the [Using Redis guide](https://docs.hangfire.io/en/latest/configuration/using-redis.html). The absolute numbers depend on your storage latency, but the shape is fixed: Hangfire's floor is "round-trips to a database," and an in-process queue's floor is "nothing." If you are processing tens of thousands of trivial items per second, that gap matters and an in-process `Channel` wins outright. If you are processing thousands of jobs per minute that each do real work (call an API, render a PDF), the per-job storage cost disappears into the noise and durability is free in practice.

The rule that falls out: do not put high-frequency, loss-tolerant work through Hangfire just because it is there. A poller checking a queue every second is a `BackgroundService`, not 86,400 Hangfire jobs a day.

## The gotcha that picks for you

Two requirements end the debate before preference enters:

1. **"This must not be lost if the app restarts."** If a job is dropped on deploy and that is a real bug -- a payment capture, a confirmation email, a webhook delivery -- you need durable storage, and that means Hangfire (or a real message broker). No amount of `StopAsync` draining makes a `BackgroundService` survive `kill -9` or a node failure. The in-process options keep work in memory; memory dies with the process.

2. **"This must run exactly once across my replicas."** A `BackgroundService` runs on every instance. If you scale out and the job is not idempotent, you get duplicate work. Hangfire's shared-storage worker model gives you single execution for free. The in-process equivalent is a distributed lock you have to build and get right.

If neither requirement applies -- the work is in-process, loss-tolerant, and either runs once because you run one instance or is naturally idempotent -- then adding Hangfire is paying a database tax for nothing. Use `BackgroundService`.

A common and correct hybrid: keep the durable *schedule and retry* in Hangfire, but let the recurring job's body simply enqueue into an in-process `Channel` that a `BackgroundService` drains. Hangfire guarantees the job fires once and survives restarts; the `Channel` gives you fast, backpressure-aware in-process throughput. You get both properties without forcing every item through storage.

## The recommendation, restated

Default to `BackgroundService` for anything that loops in-process. Reach for raw `IHostedService` or `IHostedLifecycleService` only when you specifically need startup ordering or pre/post-shutdown hooks. Adopt Hangfire the moment a job must survive a restart, run on a schedule, retry automatically, or execute exactly once across multiple instances -- and accept the database it brings as the price of those guarantees. The instinct to reach for Hangfire "to be safe" is usually backwards: start in-process, and let a concrete durability or scheduling requirement pull you toward the heavier tool. When you are running on the built-in primitives, [monitor those background jobs with health checks and metrics](/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) so you are not flying blind, and make sure your loops [cancel cleanly without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) on shutdown.

## Sources

- [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) -- Microsoft Learn
- [Implement background tasks with IHostedService and BackgroundService](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/multi-container-microservice-net-applications/background-tasks-with-ihostedservice) -- Microsoft Learn
- [Introducing the new IHostedLifecycleService interface in .NET 8](https://www.stevejgordon.co.uk/introducing-the-new-ihostedlifecycleservice-interface-in-dotnet-8) -- Steve Gordon
- [Hangfire overview and supported storage](https://www.hangfire.io/) -- Hangfire
- [Using Redis storage (throughput note)](https://docs.hangfire.io/en/latest/configuration/using-redis.html) -- Hangfire Documentation
- [Using SQL Server storage](https://docs.hangfire.io/en/latest/configuration/using-sql-server.html) -- Hangfire Documentation
