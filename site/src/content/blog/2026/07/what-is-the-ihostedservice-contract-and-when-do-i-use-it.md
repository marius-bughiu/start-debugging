---
title: "What is the IHostedService contract and when do I use it?"
description: "IHostedService is the two-method interface (StartAsync/StopAsync) the .NET generic host calls on startup and graceful shutdown. Here is exactly what the contract promises, when to implement it directly, and the .NET 10 and 11 behavior changes that catch people out."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "aspnetcore"
  - "csharp"
---

`IHostedService` is the two-method interface the .NET generic host uses to start and stop long-lived work alongside your application. It has exactly two members, `StartAsync(CancellationToken)` and `StopAsync(CancellationToken)`, and the host calls them at well-defined points: `StartAsync` before the app begins serving requests, `StopAsync` during graceful shutdown. You implement it directly when you need precise control over ordered startup or shutdown steps. For continuous loops you almost always want `BackgroundService`, which is a small abstract class that implements `IHostedService` for you. This post explains what the contract actually guarantees, when to reach for the raw interface, and the .NET 10 and .NET 11 behavior changes that trip people up.

Everything here targets .NET 11 and C# 14, with `Microsoft.Extensions.Hosting` 11.0.x. Where behavior changed in a specific version, I call it out.

## The contract is two methods and a sequencing promise

Here is the entire interface:

```csharp
// .NET 11, C# 14 -- Microsoft.Extensions.Hosting.Abstractions
public interface IHostedService
{
    Task StartAsync(CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}
```

That is the whole surface. What makes it useful is not the shape of the methods but the guarantees the host wraps around them:

- The host awaits `StartAsync` on every registered hosted service **before** the application is considered started. In an ASP.NET Core app, that means before Kestrel accepts the first request.
- By default, services start **sequentially, in registration order**. The host does not call the next service's `StartAsync` until the current one's returned `Task` completes.
- On shutdown, the host calls `StopAsync` on every service, in **reverse** registration order, and waits up to `HostOptions.ShutdownTimeout` (30 seconds by default) for them to finish.

The sequencing promise is the reason to care. If you need "warm this cache before any request can hit a cold path" or "open this connection before the queue consumer starts," `StartAsync` is the correct hook, because the host will not proceed until it returns.

## Why StartAsync must be fast

Because startup is sequential by default, a slow `StartAsync` delays every service registered after it and delays the whole application coming online. This is the single most common mistake with the raw interface: putting a long-running loop directly inside `StartAsync` and never returning.

```csharp
// .NET 11, C# 14 -- WRONG: the host never finishes starting
public sealed class BrokenWorker : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        // This loop never returns, so StartAsync never completes,
        // so the host never starts, so no requests are served.
        while (!ct.IsCancellationRequested)
        {
            await DoWorkAsync();
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

The fix is to treat `StartAsync` as "kick off the work and return." Start the loop as a background `Task`, keep a handle to it, and await that handle in `StopAsync`:

```csharp
// .NET 11, C# 14 -- correct raw IHostedService with a background loop
public sealed class QueueDrainService(ILogger<QueueDrainService> logger) : IHostedService
{
    private readonly CancellationTokenSource _stopping = new();
    private Task? _loop;

    public Task StartAsync(CancellationToken ct)
    {
        // Return quickly. Capture the loop task; do not await it here.
        _loop = RunAsync(_stopping.Token);
        return Task.CompletedTask;
    }

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await DrainOnceAsync(ct); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { logger.LogError(ex, "Drain failed; retrying"); }
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _stopping.Cancel();
        // Wait for the loop to unwind, but respect the shutdown deadline.
        if (_loop is not null)
            await _loop.WaitAsync(ct).ConfigureAwait(false);
    }

    private static Task DrainOnceAsync(CancellationToken ct) => Task.CompletedTask;
}
```

If that pattern looks like boilerplate, that is exactly the point: it is the boilerplate `BackgroundService` exists to remove.

## Where BackgroundService fits

`BackgroundService` is an abstract class in the same namespace that implements `IHostedService` and gives you a single method to override:

```csharp
// .NET 11, C# 14 -- the shape BackgroundService hands you
public sealed class QueueDrainService(ILogger<QueueDrainService> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await DrainOnceAsync(stoppingToken); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { logger.LogError(ex, "Drain failed; retrying"); }
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }

    private static Task DrainOnceAsync(CancellationToken ct) => Task.CompletedTask;
}
```

The base class stores the task returned by `ExecuteAsync`, cancels the `stoppingToken` when the host stops, and awaits your loop in its own `StopAsync`. It is the same lifecycle as the raw example above, minus the plumbing.

So the practical rule is: **implement `IHostedService` directly only when you need work to complete inside `StartAsync` before the app comes up, or ordered shutdown work inside `StopAsync`.** For a continuous loop that just needs to run while the app runs, use `BackgroundService`. If you want the deeper comparison including durable job systems, see [the decision matrix for BackgroundService, IHostedService, and Hangfire](/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/).

## The .NET 10 change that moved ExecuteAsync off the main thread

Before .NET 10 there was a subtle trap in `BackgroundService`: the synchronous portion of `ExecuteAsync`, meaning everything before the first `await`, ran on the main thread during startup and blocked other services from starting. Only the code after the first `await` moved to a background thread.

Starting in .NET 10, [`BackgroundService` runs the entirety of `ExecuteAsync` on a background thread](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/backgroundservice-executeasync-task), so no part of it blocks other services from starting. That is a welcome fix, but it changes an assumption some code relied on. If you were deliberately doing setup work before the first `await` to make it run during startup, that work is now off the startup path.

If you need something to run synchronously during startup again, the docs spell out the options: do it in the constructor, override `StartAsync` and run before `base.StartAsync`, implement `IHostedLifecycleService` (below), or drop to a raw `IHostedService`. The raw interface never had this ambiguity, which is one more reason to use it when startup ordering genuinely matters.

## IHostedLifecycleService for finer-grained hooks

When two `StartAsync` hooks are not enough, .NET 8 added `IHostedLifecycleService`, which extends `IHostedService` with four more callbacks:

```csharp
// .NET 11, C# 14 -- extends IHostedService with pre/post hooks
public interface IHostedLifecycleService : IHostedService
{
    Task StartingAsync(CancellationToken cancellationToken);
    Task StartedAsync(CancellationToken cancellationToken);
    Task StoppingAsync(CancellationToken cancellationToken);
    Task StoppedAsync(CancellationToken cancellationToken);
}
```

The host invokes them around the core two methods in this order: `StartingAsync` on all services, then `StartAsync` on all services, then `StartedAsync` on all services. Shutdown mirrors it: `StoppingAsync`, then `StopAsync`, then `StoppedAsync`. The distinction from plain `IHostedService` is that these phases run as *batches* across every service, so `StartingAsync` is the place to run work that must happen before **any** service's `StartAsync`, not just before its own.

You rarely need this. Reach for it when you have cross-service ordering constraints, such as "every service must have finished its pre-start work before any of them opens a network listener." For the common case, plain `IHostedService` or `BackgroundService` is enough.

## Registering hosted services

Registration is a one-liner, and the DI lifetime is fixed:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHostedService<QueueDrainService>();
builder.Services.AddHostedService<CacheWarmer>();

var app = builder.Build();
app.Run();
```

`AddHostedService<T>` registers the type as a **singleton** `IHostedService`. That has a consequence people hit constantly: you cannot inject a scoped service (like a pooled `DbContext`) directly into a hosted service constructor, because a singleton cannot depend on a scoped service. Inject `IServiceScopeFactory` and create a scope per unit of work instead. That specific pitfall, and its exact exception message, is covered in [why you cannot consume a scoped service from a singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/), and the correct scoping pattern is in [how to use scoped services inside a BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

Order of registration is the order of `StartAsync` calls and the reverse order of `StopAsync` calls, so register services whose startup others depend on first.

## Honoring the cancellation tokens

Both methods receive a `CancellationToken`, and they mean different things.

The token passed to `StartAsync` signals that startup is being aborted. In practice it is rarely triggered, but you should still thread it through any async calls you make so a Ctrl+C during a slow startup actually cancels.

The token passed to `StopAsync` is the one that matters. It is cancelled when the graceful shutdown deadline (`HostOptions.ShutdownTimeout`, 30 seconds by default) elapses. If your `StopAsync` ignores it and keeps waiting, the host will eventually tear the process down anyway, and in-flight work is lost. So your shutdown logic should stop *promptly* when that token fires, flushing or checkpointing what it can rather than trying to finish everything.

```csharp
// .NET 11, C# 14 -- extend the shutdown window when your drain is slow
builder.Services.Configure<HostOptions>(o =>
    o.ShutdownTimeout = TimeSpan.FromSeconds(60));
```

Raise the timeout only if your work genuinely needs longer to drain cleanly. Cancelling correctly on the token is the more important habit, and it pairs with getting cancellation right everywhere else in your async code, which is its own topic in [cancelling a long-running Task without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## The .NET 11 change to failure exit codes

Here is the behavior change most likely to surprise you when you upgrade. When a `BackgroundService` throws an unhandled exception from `ExecuteAsync`, and `HostOptions.BackgroundServiceExceptionBehavior` is left at its default of `StopHost`, the host stops. That default has been in place since .NET 6 (before that, the default was `Ignore`, which silently left you with a zombie host that looked alive but did no work).

What changed in .NET 11 Preview 3 is the exit code. Previously, the task returned from `RunAsync`, `StopAsync`, or `WaitForShutdownAsync` completed *successfully* even though a service had crashed, so the process usually exited with code zero and your orchestrator thought everything was fine. Starting in .NET 11, [those methods now fail with an exception](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/11/ihost-runasync-stopasync-throw-backgroundservice-failure) so the process exits non-zero. A single failing service rethrows its exception; multiple failures come back as an `AggregateException`.

This is almost always the behavior you want: a crashed background worker should not report success. But if you had code that relied on the old silent-success behavior, you will now see a non-zero exit and possibly an unhandled exception at the top of `Program.cs`. The recommended action from Microsoft is to do nothing and let it fail loudly. If you truly need the old behavior, wrap the `await host.RunAsync()` in a try/catch, or set the exception behavior back to `Ignore` and accept the tradeoff:

```csharp
// .NET 11, C# 14 -- opt back into the old, quieter behavior (usually a mistake)
builder.Services.Configure<HostOptions>(o =>
    o.BackgroundServiceExceptionBehavior =
        BackgroundServiceExceptionBehavior.Ignore);
```

I would not reach for `Ignore`. A hosted service that can crash and leave the host running but idle is far harder to diagnose than one that takes the process down and gets restarted by your orchestrator. The better fix is to catch and log inside your loop, as the earlier examples do, so a single failed iteration never becomes an unhandled exception in the first place.

## When the raw interface is the right call

Pulling it together, implement `IHostedService` directly when:

- You have startup work that **must complete before the app serves traffic**: warming a cache, running a schema or migration check, establishing a connection pool. Put it in `StartAsync` and let the sequential-startup guarantee do its job.
- You have shutdown work that must run in a **specific order**: flushing a buffer, deregistering from a service discovery endpoint, sending a final metric. Put it in `StopAsync`.
- You want the plumbing to be explicit because the lifecycle is unusual and you would rather read it than trust the base class.

Use `BackgroundService` for the far more common case of a loop that runs for the app's lifetime. Use `IHostedLifecycleService` only when you need batched pre-start or post-stop phases across multiple services. And whichever you pick, honor the cancellation tokens, keep `StartAsync` fast, and let failures surface. For related patterns, see [running fire-and-forget work safely with BackgroundService](/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Sources

- [IHostedService Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.ihostedservice)
- [IHostedLifecycleService Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.ihostedlifecycleservice)
- [Breaking change: BackgroundService runs all of ExecuteAsync as a Task (.NET 10)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/backgroundservice-executeasync-task)
- [Breaking change: IHost.RunAsync and IHost.StopAsync throw when a BackgroundService fails (.NET 11)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/11/ihost-runasync-stopasync-throw-backgroundservice-failure)
- [BackgroundServiceExceptionBehavior Enum -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.backgroundserviceexceptionbehavior)
