---
title: "Fix: Cannot access a disposed object. Object name: 'IServiceProvider'"
description: "Code resolved a service from a DI scope or root provider after it was disposed. Capture IServiceScopeFactory instead of IServiceProvider and create a fresh scope where the work runs."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "aspnetcore"
  - "dependency-injection"
---

The fix: something called `GetService`, `GetRequiredService`, or `CreateScope` on an `IServiceProvider` whose scope (or the whole container) had already been disposed. Usually it is a fire-and-forget task that captured `HttpContext.RequestServices`, a service that stored the scoped `IServiceProvider` for "lazy" resolution, or a background loop still running after the host shut down. Stop holding on to `IServiceProvider`. Inject `IServiceScopeFactory`, call `CreateAsyncScope()` at the point where the work actually runs, and resolve everything from that new scope.

```text
System.ObjectDisposedException: Cannot access a disposed object.
Object name: 'IServiceProvider'.
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ThrowHelper.ThrowObjectDisposedException()
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ServiceProviderEngineScope.GetService(Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService[T](IServiceProvider provider)
```

Every snippet and every output line in this post comes from a repro I ran on .NET 10 (runtime 10.0.10, `Microsoft.Extensions.DependencyInjection` as shipped in the shared framework, ASP.NET Core 10.0.10). The guard that throws this exception is identical on the `release/11.0` branch of `dotnet/runtime`, so the same analysis applies to .NET 11.

## Why the container throws instead of returning null

In `Microsoft.Extensions.DependencyInjection`, every scope is a `ServiceProviderEngineScope`. It implements `IServiceScope`, `IServiceProvider`, and `IServiceScopeFactory` at the same time, and the `IServiceProvider` you get from `scope.ServiceProvider` is the scope object itself. When the scope is disposed it disposes every `IDisposable`/`IAsyncDisposable` it created, then sets a private `_disposed` flag. From that moment on, `GetService`, `GetKeyedService`, and `GetRequiredKeyedService` all start with the same check:

```csharp
// dotnet/runtime, release/10.0
// src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs
public object? GetService(Type serviceType)
{
    if (_disposed)
    {
        ThrowHelper.ThrowObjectDisposedException();
    }

    return RootProvider.GetService(ServiceIdentifier.FromServiceType(serviceType), this);
}

// ThrowHelper.cs
internal static void ThrowObjectDisposedException()
{
    throw new ObjectDisposedException(nameof(IServiceProvider));
}
```

That `nameof(IServiceProvider)` is why the object name is always `'IServiceProvider'`, regardless of whether you hit a request scope, a scope you created by hand, or the root `ServiceProvider`. The root provider has its own `_disposed` flag and goes through the same helper, so the message alone does not tell you *which* provider died. The stack trace does: `ServiceProviderEngineScope.GetService` means a scope, while a frame in `ServiceProvider.CreateScope` or `ServiceProvider.GetService` means the root container is gone, which almost always means the host was disposed.

Two consequences of that design matter for debugging:

1. **Only resolution throws.** An instance you already resolved before the scope ended is still a normal object. If it has its own disposal guard (a `DbContext`, an `HttpClient`, a `CancellationTokenSource`), touching it gives *that* type's `ObjectDisposedException` with its own object name, not this one.
2. **The provider is not "broken", it is finished.** There is no way to revive a disposed scope. The fix is always to use a scope whose lifetime covers the work.

## The four shapes that trigger it

I reproduced each of these in one console app (`Microsoft.NET.Sdk.Web`, `net10.0`). All four printed the exact message above.

### 1. A scoped provider that escapes its `using`

The smallest possible repro. The variable outlives the scope:

```csharp
// .NET 10, C# 14
var services = new ServiceCollection();
services.AddScoped<Repo>();
using var root = services.BuildServiceProvider();

IServiceProvider leaked;
using (var scope = root.CreateScope())
{
    leaked = scope.ServiceProvider;
}

leaked.GetRequiredService<Repo>(); // ObjectDisposedException: 'IServiceProvider'
```

Nobody writes this on purpose, but it appears in disguise all the time: a helper method that does `using var scope = ...; return scope.ServiceProvider;`, or an `async` method that creates a scope with `using var` and then returns a `Task` or `IAsyncEnumerable` that keeps resolving from it after the method's synchronous part has returned.

### 2. A fire-and-forget task that captured `HttpContext.RequestServices`

This is the one most people land here with. ASP.NET Core creates the request scope lazily in `RequestServicesFeature` and registers the feature with `Response.RegisterForDisposeAsync`, so the scope is disposed as soon as the response completes. A detached task that grabbed `RequestServices` loses the race:

```csharp
// .NET 10, ASP.NET Core 10.0.10 -- wrong
app.MapPost("/orders/{id}/export", (int id, HttpContext ctx) =>
{
    var sp = ctx.RequestServices;
    _ = Task.Run(async () =>
    {
        await Task.Delay(200);                       // the response is already sent
        var exporter = sp.GetRequiredService<OrderExporter>(); // throws
        await exporter.ExportAsync(id);
    });
    return Results.Accepted();
});
```

In my repro the endpoint returned `202`, and 200 ms later the task logged `ObjectDisposedException: Cannot access a disposed object. Object name: 'IServiceProvider'.` Because the exception happens on an unobserved task, you often only see it in logs, or never, and the symptom is "the export silently doesn't happen". The same thing happens when the task captures `IServiceProvider` through constructor injection in a controller, or reads `IHttpContextAccessor.HttpContext.RequestServices` later on (where you may also get `null` because the context was recycled).

### 3. A service that stores `IServiceProvider` for later

The "service locator" variant. A transient or scoped service takes `IServiceProvider` in its constructor so it can resolve dependencies on demand:

```csharp
// .NET 10, C# 14 -- wrong
class ReportBuilder(IServiceProvider sp)
{
    public void Build() => sp.GetRequiredService<Repo>().Save();
}

ReportBuilder rb;
using (var scope = root.CreateScope())
    rb = scope.ServiceProvider.GetRequiredService<ReportBuilder>();

rb.Build(); // ObjectDisposedException: 'IServiceProvider'
```

The `IServiceProvider` injected into a scoped or transient service is the scope it was resolved from, not the root. The moment `ReportBuilder` is handed to anything that outlives the scope (a singleton cache, an event subscription on a singleton, a static field, a `Lazy<T>`, a `Func<T>` factory registered with `sp => () => sp.GetRequiredService<T>()`), the next lazy resolution throws. If you have seen the [captive dependency error, "Cannot consume scoped service from singleton"](/2026/05/fix-cannot-consume-scoped-service-from-singleton/), this is its runtime cousin: scope validation catches captive *services* at build time, but it cannot see a captured *provider*.

### 4. A background loop that outlives the host

The root provider is disposed when the host is disposed. `BackgroundService.StopAsync` cancels the stopping token and waits for `ExecuteAsync`, but only until `HostOptions.ShutdownTimeout` (30 seconds by default since .NET 6) expires. A loop that ignores the token keeps running after the host moves on and disposes the container:

```csharp
// .NET 10 -- wrong: ignores stoppingToken
class StubbornWorker(IServiceScopeFactory scopes) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (true)
        {
            using var scope = scopes.CreateScope(); // throws once the host is disposed
            scope.ServiceProvider.GetRequiredService<Repo>().Save();
            await Task.Delay(250);
        }
    }
}
```

With `ShutdownTimeout` set to 1 second, `StopAsync` returned, `host.Dispose()` ran, and the next iteration printed `ObjectDisposedException: Cannot access a disposed object. Object name: 'IServiceProvider'.`. Note that this worker does everything right about scopes. The bug is purely the ignored cancellation token. The same failure shows up with `System.Threading.Timer` callbacks, `Channel` consumers started with `Task.Run`, and message-bus handlers that keep pumping after shutdown. In tests, it shows up when a `WebApplicationFactory<T>` or a host fixture is disposed while a test (or a background task the test started) is still resolving services from `factory.Services`.

## Fix 1: capture `IServiceScopeFactory`, not `IServiceProvider`

For shapes 2 and 3, this is the fix. `IServiceScopeFactory` is special in the container: `ServiceProvider` registers it as a constant call site pointing at the **root** scope, so it does not matter where you resolve it from. Even an `IServiceScopeFactory` injected into a request-scoped endpoint is bound to the root container and keeps working after the request ends. Create the scope inside the detached work, so the scope's lifetime is exactly the work's lifetime:

```csharp
// .NET 10, ASP.NET Core 10.0.10 -- right
app.MapPost("/orders/{id}/export", (int id, IServiceScopeFactory scopes) =>
{
    _ = Task.Run(async () =>
    {
        await using var scope = scopes.CreateAsyncScope();
        var exporter = scope.ServiceProvider.GetRequiredService<OrderExporter>();
        await exporter.ExportAsync(id);
    });
    return Results.Accepted();
});
```

In the repro, the same 200 ms delay that broke the `RequestServices` version logged `good: ok` here. Prefer `CreateAsyncScope()` with `await using`: if any service in the scope implements only `IAsyncDisposable`, a synchronous `Dispose()` on the scope throws `InvalidOperationException` telling you to use `DisposeAsync`. The [`IAsyncDisposable` and `await using` guide](/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) covers why.

Do not pass request-bound *data* through the scope either. Copy what you need (IDs, the user name, a correlation ID) into locals before starting the task. `HttpContext` itself is not safe to touch after the response completes.

For the service-locator shape, inject `IServiceScopeFactory` into `ReportBuilder` and create a scope per `Build()` call, or better, inject `Repo` directly and let the container manage lifetimes. If the dependency really is optional or expensive, a keyed or factory registration that resolves from a fresh scope is cleaner than storing the provider.

## Fix 2: move the work into a real background mechanism

`Task.Run` from a request handler is the root problem in shape 2. Nothing tracks the task, nothing observes its exception, and nothing stops it on shutdown. Put the work item on a `Channel<T>` and drain it from a `BackgroundService` that creates one scope per item:

```csharp
// .NET 10, C# 14
public sealed class ExportQueue
{
    private readonly Channel<int> _channel = Channel.CreateUnbounded<int>();
    public ValueTask EnqueueAsync(int orderId) => _channel.Writer.WriteAsync(orderId);
    public IAsyncEnumerable<int> ReadAllAsync(CancellationToken ct) => _channel.Reader.ReadAllAsync(ct);
}

public sealed class ExportWorker(ExportQueue queue, IServiceScopeFactory scopes, ILogger<ExportWorker> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var id in queue.ReadAllAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<OrderExporter>().ExportAsync(id, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.LogError(ex, "Export of order {OrderId} failed", id);
            }
        }
    }
}

// Program.cs
builder.Services.AddSingleton<ExportQueue>();
builder.Services.AddHostedService<ExportWorker>();
app.MapPost("/orders/{id}/export", async (int id, ExportQueue queue) =>
{
    await queue.EnqueueAsync(id);
    return Results.Accepted();
});
```

The full pattern, including bounded channels and back-pressure, is in [how to run fire-and-forget work safely with BackgroundService](/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/). The scope-per-iteration part is covered in depth in [using scoped services inside a BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

## Fix 3: honor the stopping token so nothing runs after disposal

For shape 4, the scope code is fine and the lifetime of the loop is the bug. Pass `stoppingToken` to every await and loop condition, so the loop exits before `ShutdownTimeout` expires:

```csharp
// .NET 10 -- right
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
    while (await timer.WaitForNextTickAsync(stoppingToken))
    {
        await using var scope = scopes.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<Repo>().SaveAsync(stoppingToken);
    }
}
```

`PeriodicTimer.WaitForNextTickAsync` throws `OperationCanceledException` on cancellation, and `BackgroundService` treats a cancellation that matches the stopping token as a clean exit. If a single unit of work legitimately takes longer than 30 seconds, raise `HostOptions.ShutdownTimeout` rather than ignoring the token; otherwise the host will dispose the container under your feet. The [IHostedService contract post](/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) walks through the exact start and stop ordering.

For integration tests, make sure the test awaits every task it starts before the fixture's `DisposeAsync` runs, and resolve per-test services from `factory.Services.CreateAsyncScope()` rather than from `factory.Services` directly.

## Gotchas and lookalikes

**The race inside resolution.** `ServiceProviderEngineScope.CaptureDisposable` checks `_disposed` under a lock after constructing a disposable service. If the scope was disposed *while* your service was being created on another thread, the container disposes the freshly built instance and then throws this same exception. So you can see it on a code path that looked fine a microsecond earlier. It is still the same bug: two threads disagree about the scope's lifetime.

**`app.Services` after `app.Run` returns.** Anything in `Program.cs` that runs after `app.Run()` or `await app.RunAsync()` (cleanup code, a final flush) runs after the host has been disposed. Resolve what you need before calling `Run`, or move the logic into an `IHostApplicationLifetime.ApplicationStopping` callback.

**`IServiceProvider` in a singleton is the root.** Injecting `IServiceProvider` into a singleton gives you the root provider, which is only disposed with the host, so it will not throw this exception during normal operation. It will, however, happily hand out scoped services from the root scope if `ValidateScopes` is off, which turns them into accidental singletons. Use `IServiceScopeFactory` there too.

**"Cannot access a disposed context instance".** If the object name in your message is your `DbContext` type (`Object name: 'AppDb'`), the scope's services were disposed, not the provider, and the fix is a fresh context per operation: see [the disposed DbContext guide](/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/).

**`Object name: 'System.Net.Http.HttpClient'` or a `CancellationTokenSource`.** Same exception type, different owner. Those come from disposing an instance you resolved, not from resolving after disposal.

## Related

- [Fix: Cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) for the build-time version of captured lifetimes.
- [How to use scoped services inside a BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) for the scope-per-unit-of-work pattern.
- [How to run fire-and-forget work safely with BackgroundService](/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) for replacing `Task.Run` in handlers.
- [Fix: Cannot access a disposed context instance](/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) for the EF Core flavour of the same lifetime bug.
- [How to write integration tests with WebApplicationFactory](/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) for fixture lifetimes in tests.

## Sources

- [`ServiceProviderEngineScope.cs` on `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs) (the `_disposed` guard and `CaptureDisposable`).
- [`ThrowHelper.cs` on `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ThrowHelper.cs) (`new ObjectDisposedException(nameof(IServiceProvider))`).
- [`ServiceProvider.cs` on `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceProvider.cs) (`IServiceScopeFactory` registered as a constant bound to the root scope).
- [`RequestServicesFeature.cs` on `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Http/Http/src/Features/RequestServicesFeature.cs) (request scope disposed via `RegisterForDisposeAsync`).
- [Dependency injection guidelines](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines) on Microsoft Learn.
- [Use scoped services within a BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) on Microsoft Learn.
- [`HostOptions.ShutdownTimeout`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.shutdowntimeout) API reference.
