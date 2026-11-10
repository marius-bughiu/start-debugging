---
title: "How to initialize interdependent async singletons at startup in ASP.NET Core"
description: "Give each singleton a memoized InitializeAsync that awaits its own dependencies, then await them all from IHostedLifecycleService.StartingAsync. Registration order stops mattering, Kestrel does not accept requests until init finishes, and a failure stops the host. Compared against init before app.Run, IHostedService.StartAsync, and a BackgroundService with a readiness check on ASP.NET Core 10.0.10."
pubDate: 2026-11-10
template: how-to
tags:
  - "aspnetcore"
  - "dependency-injection"
  - "async"
  - "dotnet-10"
  - "csharp"
---

On .NET 10, the reliable way to initialize singletons that need async setup and depend on each other is to move the dependency edges out of `Program.cs` and into the services. Each service exposes a memoized `InitializeAsync` that first awaits the `InitializeAsync` of whatever it depends on, and a single `IHostedLifecycleService` awaits all of them with `Task.WhenAll` in `StartingAsync`. Every initializer runs exactly once in the right order no matter how they are registered. Kestrel does not accept a connection until it finishes, and an exception stops the host before it serves traffic. All results below come from a sample run on ASP.NET Core 10.0.10 (SDK 10.0.302, macOS arm64). Plain `IHostedService.StartAsync` also seemed to work until two common configurations broke it.

## Why a hand-ordered list of awaits rots

The question this answers comes up in [a Stack Overflow thread](https://stackoverflow.com/questions/79962857): `ServiceA` has to run `EnsureIndexesAsync` before anyone calls `Use()`, `ServiceB` takes `ServiceA` in its constructor and needs its own `InitializeAsync`, and the startup code looks like this:

```csharp
// .NET 10 -- the brittle version
var app = builder.Build();
var a = app.Services.GetRequiredService<ServiceA>();
var b = app.Services.GetRequiredService<ServiceB>();
await a.EnsureIndexesAsync(ct);   // must come first
await b.InitializeAsync(ct);      // pray nobody reorders this
app.Run();
```

It works today. The problem is that the ordering knowledge lives in one place (`Program.cs`) while the dependency it encodes lives somewhere else (`ServiceB`'s constructor). Add a `ServiceC` that needs B, or let `ServiceA` grow a dependency on a cache that also needs warming, and somebody has to remember to update the list. DI already knows the graph for construction. It cannot know it for async initialization, because constructors cannot be async, so the container finishes building `ServiceB` long before `ServiceA` is usable.

The accepted answer on that thread suggests hiding initialization inside the service and calling it lazily from every async method. That is correct, but it pushes an `await EnsureInitializedAsync()` into every public method and turns `Use()` into `UseAsync()`. Most apps would rather pay the cost once, at startup, and keep the synchronous API. That is what the pattern below does.

## Put the dependency edge inside the service

Start with a tiny contract and a base class that memoizes the initialization task:

```csharp
// .NET 10, C# 14
public interface IAsyncInitializer
{
    Task InitializeAsync(CancellationToken cancellationToken);
}

public abstract class AsyncInitialized : IAsyncInitializer
{
    private Task? _init;
    private object? _gate;

    // Every caller gets the same Task, so the work runs exactly once.
    public Task InitializeAsync(CancellationToken cancellationToken) =>
        LazyInitializer.EnsureInitialized(ref _init, ref _gate,
            () => InitializeCoreAsync(cancellationToken));

    protected abstract Task InitializeCoreAsync(CancellationToken cancellationToken);

    protected void ThrowIfNotInitialized()
    {
        if (_init is not { IsCompletedSuccessfully: true })
            throw new InvalidOperationException($"{GetType().Name} used before InitializeAsync completed.");
    }
}
```

The `LazyInitializer.EnsureInitialized(ref T, ref object, Func<T>)` overload takes a lock, so two concurrent callers never start the factory twice. The single-argument overload without the lock can run the factory more than once under a race, which would kick off two index builds. The [comparison of Lazy, LazyInitializer and double-checked locking](/2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp/) goes through why that distinction matters.

Now the services themselves. The important line is the first `await` in `ServiceB`:

```csharp
// .NET 10, C# 14
public sealed class ServiceA : AsyncInitialized
{
    protected override async Task InitializeCoreAsync(CancellationToken ct)
    {
        await CreateIndexesAsync(ct);   // 1.5 s in the sample
    }

    public string Use() { ThrowIfNotInitialized(); return "A ok"; }
}

public sealed class ServiceB(ServiceA a) : AsyncInitialized
{
    protected override async Task InitializeCoreAsync(CancellationToken ct)
    {
        await a.InitializeAsync(ct);    // the dependency edge lives here
        await WarmUpAsync(ct);          // 0.5 s in the sample
        _ = a.Use();
    }

    public string Use() { ThrowIfNotInitialized(); return "B ok"; }
}
```

`ServiceB` already declares its dependency on `ServiceA` through the constructor. Declaring the async half of that dependency in the same class keeps both halves together. When a new service appears, its author writes `await dep.InitializeAsync(ct)` for each dependency that needs it, and nobody touches `Program.cs`.

Register each service once as itself and once as an `IAsyncInitializer` that forwards to the same singleton:

```csharp
// .NET 10
builder.Services.AddSingleton<ServiceA>();
builder.Services.AddSingleton<ServiceB>();
// B before A on purpose: the order of these lines no longer matters.
builder.Services.AddSingleton<IAsyncInitializer>(sp => sp.GetRequiredService<ServiceB>());
builder.Services.AddSingleton<IAsyncInitializer>(sp => sp.GetRequiredService<ServiceA>());
```

Use the factory overload. `AddSingleton<IAsyncInitializer, ServiceA>()` would create a second `ServiceA` instance that nobody else sees, and the instance your endpoints get would never be initialized.

## Run the initializers from StartingAsync

`IHostedLifecycleService` (added in .NET 8) extends `IHostedService` with `StartingAsync`, `StartedAsync`, `StoppingAsync` and `StoppedAsync`. The host calls `StartingAsync` on every lifecycle service before it calls `StartAsync` on any hosted service, including the one that starts Kestrel:

```csharp
// .NET 10
public sealed class StartupInitializer(IEnumerable<IAsyncInitializer> initializers)
    : IHostedLifecycleService
{
    public Task StartingAsync(CancellationToken cancellationToken) =>
        Task.WhenAll(initializers.Select(i => i.InitializeAsync(cancellationToken)));

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StartedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StoppingAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StoppedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

builder.Services.AddHostedService<StartupInitializer>();
```

`Task.WhenAll` starts B's initializer and A's initializer at the same time. B immediately awaits A's memoized task, so the actual order is forced by the dependency, not by the enumeration order. The sample app logs a timestamp at each step. With B registered first:

```text
[   16 ms] StartingAsync: begin
[   16 ms] B: waiting for A
[   16 ms] A: EnsureIndexesAsync start
[ 1518 ms] A: EnsureIndexesAsync done
[ 1518 ms] B: InitializeAsync start
[ 2021 ms] B: InitializeAsync done
[ 2021 ms] StartingAsync: end
[ 2021 ms] NoisyHostedService.StartAsync
[ 2037 ms] ApplicationStarted
```

A ran once (a counter in `InitializeCoreAsync` read `1` for both services), even though both `StartupInitializer` and `ServiceB` asked for it. A `curl` loop hitting `/use` every 100 ms got "connection refused" until about 2.3 s after process start, then `200 A ok B ok`. No request ever saw an uninitialized service.

The steps, in order:

1. Add an `IAsyncInitializer` interface and an `AsyncInitialized` base class that memoizes the init task with the locking `LazyInitializer.EnsureInitialized` overload.
2. In each service's `InitializeCoreAsync`, first `await` the `InitializeAsync` of every dependency that needs async setup, then do its own work.
3. Register each service as a singleton and forward an `IAsyncInitializer` registration to the same instance with a factory lambda.
4. Add one `IHostedLifecycleService` that awaits `Task.WhenAll` over all `IAsyncInitializer` instances in `StartingAsync`.
5. Guard synchronous members with `ThrowIfNotInitialized()` so a missed edge fails loudly instead of returning half-built data.

## How the alternatives compared

The same sample has a switch for four strategies. Each ran with the 2 s init and a 100 ms `curl` poller against `/use`.

**Init in Program.cs before `app.Run()`.** Looping over `app.Services.GetServices<IAsyncInitializer>()` and awaiting each one also produced the correct order (the memoized tasks handle it) and also kept the port closed until init finished, because Kestrel only binds when the host starts. It is a fine choice for a small app. The downsides are structural. The code is outside the host, so `HostOptions.StartupTimeout` does not apply. Tests also cannot remove or replace it with `ConfigureTestServices`, since it is not a service.

**Plain `IHostedService.StartAsync`.** In a `WebApplication`, hosted services you register start before the internal service that starts Kestrel, so in the default setup this behaved exactly like `StartingAsync`. Then it broke in two ways:

- Another hosted service registered **before** the initializer that touches `ServiceA` in its own `StartAsync` runs first. In the sample that crashed startup with `InvalidOperationException: ServiceA used before InitializeAsync completed`. `StartingAsync` survived the same setup because the consumer's `StartAsync` waited for the whole `StartingAsync` batch.
- With `HostOptions.ServicesStartConcurrently = true`, all `StartAsync` calls run at once, Kestrel included. The poller got `500` responses from 199 ms until init finished at about 2.2 s. With `StartingAsync`, the same option changed nothing: the port stayed closed until 2.3 s and the first response was a `200`.

**`BackgroundService` plus a readiness check.** This mode does not block startup. `ExecuteAsync` awaits the initializers, and a health check reports `Unhealthy("initializing")` until the init task completes:

```csharp
// .NET 10
public sealed class BackgroundInitializer(IEnumerable<IAsyncInitializer> initializers) : BackgroundService
{
    private readonly TaskCompletionSource _done = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public Task Completion => _done.Task;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.WhenAll(initializers.Select(i => i.InitializeAsync(stoppingToken)));
            _done.TrySetResult();
        }
        catch (Exception ex)
        {
            _done.TrySetException(ex);
            Environment.ExitCode = 1;
            throw;
        }
    }
}

public sealed class InitializationHealthCheck(BackgroundInitializer init) : IHealthCheck
{
    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct) =>
        Task.FromResult(init.Completion.Status switch
        {
            TaskStatus.RanToCompletion => HealthCheckResult.Healthy(),
            TaskStatus.Faulted => HealthCheckResult.Unhealthy("init failed", init.Completion.Exception),
            _ => HealthCheckResult.Unhealthy("initializing"),
        });
}

builder.Services.AddSingleton<BackgroundInitializer>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<BackgroundInitializer>());
builder.Services.AddHealthChecks().AddCheck<InitializationHealthCheck>("init", tags: ["ready"]);
app.MapHealthChecks("/ready", new() { Predicate = r => r.Tags.Contains("ready") });
```

`/ready` returned `503 Unhealthy` from 199 ms and `200 Healthy` at 2.15 s, and `ApplicationStarted` fired at 24 ms. The cost is that `/use` returned `500` during the same window. Only a load balancer or Kubernetes readiness probe that actually honors `/ready` keeps traffic away. Use this when initialization takes long enough that a liveness probe would kill a pod stuck in `StartingAsync`. If you go this way, the [health check endpoint guide](/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/) covers splitting liveness and readiness so the orchestrator restarts the right thing.

## What happens when initialization fails

With `A_FAIL=1`, `ServiceA` throws after 300 ms.

In `StartingAsync` mode the host logged `Hosting failed to start`, `app.Run()` rethrew `InvalidOperationException: index creation failed`, and the process died with an unhandled exception (exit code 134 on macOS, from the abort). Kestrel never bound the port, so nothing ever served a request with broken state. A container runtime sees a crash and restarts it, which is the right behavior for missing indexes.

In `BackgroundService` mode the default `BackgroundServiceExceptionBehavior.StopHost` kicked in: the log showed `BackgroundService failed`, then the critical message about `StopHost`, then a graceful shutdown. **The process exited with code 0.** The app had already logged "Application started", served `503` from `/ready`, and then quietly shut down as if someone had pressed Ctrl+C. An orchestrator watching exit codes treats that as a clean stop. That is why the code above sets `Environment.ExitCode = 1` in the `catch` before rethrowing. With that line, the same failure exited with code 1.

## Cancellation and the startup timeout

The token passed to `StartingAsync` is the host's startup token. Setting `HostOptions.StartupTimeout` to 1 s with a 2 s init made the sample fail with `TaskCanceledException` from inside `ServiceA`, again as `Hosting failed to start`:

```csharp
// .NET 10
builder.Services.Configure<HostOptions>(o => o.StartupTimeout = TimeSpan.FromSeconds(30));
```

There is a subtlety in the memoized task: it captures the token of the **first** caller. Here that is fine, because every caller during startup passes the same host token, and a canceled startup kills the process anyway. Do not reuse this base class for lazy init driven by request tokens. One aborted request would leave a permanently canceled task in `_init`, and every later caller would get the same `TaskCanceledException`. For that case, start the work with the application's `ApplicationStopping` token and let request callers use `task.WaitAsync(requestToken)` instead.

## Gotchas worth knowing

**Do not block in constructors.** The other tempting fix, `EnsureIndexesAsync().GetAwaiter().GetResult()` in the constructor, does run in the right order, because DI constructs A before B. But the first resolution can happen on a request thread, in a hosted service, or inside `ValidateOnBuild`, and blocking a thread-pool thread for seconds during startup is how you get thread-pool starvation reports.

**Do not register with the generic two-type overload.** As noted above, `AddSingleton<IAsyncInitializer, ServiceA>()` gives you a second instance. The symptom is "init ran, but `Use()` still throws".

**Initializers that need scoped services** (a `DbContext` to create indexes, for example) should create a scope inside `InitializeCoreAsync` with `IServiceScopeFactory` rather than taking the scoped service in the constructor. A singleton capturing a scoped service is the classic [cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) error, and with `ValidateScopes` on in Development the host refuses to build.

**Options validation is a different job.** If the startup work is "check this configuration is sane", use `ValidateOnStart`, covered in [validating options at startup with IValidateOptions](/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/). It runs when the host starts, separately from your hosted services.

## WebApplicationFactory runs all of it

A common worry is that integration tests skip whatever sits between `builder.Build()` and `app.Run()`. On ASP.NET Core 10, that is not true. `WebApplicationFactory<Program>` lets the entry point run on a background thread and waits for the host the entry point starts. A test against each mode (Microsoft.AspNetCore.Mvc.Testing 10.0.14, xUnit 2.9.3) produced:

```text
[    0 ms] mode=inline
[   17 ms] Build() returned
[  721 ms] inline init done
 inline: 200 A ok B ok initA=1 initB=1
 lifecycle: 200 A ok B ok initA=2 initB=2
 startasync: 200 A ok B ok initA=3 initB=3
```

All three modes returned `200` on the first request. The counters climbing to 3 also show that each factory builds its own container and so runs every initializer again. If that is slow, share one factory across tests with a class fixture, or swap the real initializer out in `ConfigureTestServices` when a test does not need the indexes. That swap is only possible when initialization is a service, which is one more argument against the `Program.cs` loop. The [WebApplicationFactory integration testing guide](/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) covers both techniques.

## Choosing between them

Use `IHostedLifecycleService.StartingAsync` with memoized per-service initializers by default. It is the only variant that survived every configuration in this test, including an early consumer, concurrent start, a failure and a timeout. Switch to `BackgroundService` plus a readiness check when initialization is slow enough to collide with a liveness probe, and remember to set a non-zero exit code on failure. For the details of the hosted service contract itself, including why `StartingAsync` runs as a batch across all services, see [what the IHostedService contract promises](/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/).

## Sources

- [IHostedLifecycleService Interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.ihostedlifecycleservice) -- Microsoft Learn
- [HostOptions.ServicesStartConcurrently](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.servicesstartconcurrently) and [HostOptions.StartupTimeout](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.startuptimeout) -- Microsoft Learn
- [BackgroundServiceExceptionBehavior Enum](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.backgroundserviceexceptionbehavior) -- Microsoft Learn
- [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) -- Microsoft Learn
- [LazyInitializer.EnsureInitialized](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lazyinitializer.ensureinitialized) -- Microsoft Learn
- [Integration tests in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests) -- Microsoft Learn
- [How to initialize DI-registered interdependent asynchronous services?](https://stackoverflow.com/questions/79962857) -- the Stack Overflow question this post answers
