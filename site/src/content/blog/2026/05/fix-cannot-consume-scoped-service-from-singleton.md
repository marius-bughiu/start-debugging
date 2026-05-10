---
title: "Fix: Cannot consume scoped service 'X' from singleton 'Y'"
description: "ASP.NET Core's scope validation throws this when a singleton would capture a scoped dependency for the rest of the process. Make the consumer scoped, or take IServiceScopeFactory and create a scope on demand."
pubDate: 2026-05-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
---

The fix: ASP.NET Core's scope validator blocked a captive dependency. Singleton `Y` asked the root provider for scoped service `X`, which would pin `X` to the whole process and bypass per-request lifetime entirely. Either change `Y` to scoped (preferred when `Y` is consumed inside a request scope), or keep `Y` singleton and inject `IServiceScopeFactory`, creating a fresh scope each time you need `X`. For `DbContext` specifically, use `IDbContextFactory<T>`.

```text
System.InvalidOperationException: Cannot consume scoped service 'MyApp.Data.AppDbContext' from singleton 'MyApp.Workers.OrderProcessor'.
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.CallSiteValidator.ValidateCallSite(ServiceCallSite callSite)
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ServiceProviderEngineScope.GetService(Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProvider.GetService(Type serviceType, ServiceProviderEngineScope serviceProviderEngineScope)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.Hosting.Internal.Host.StartAsync(CancellationToken cancellationToken)
```

This guide is written against .NET 11 preview 4, `Microsoft.Extensions.DependencyInjection` 11.0.0-preview.4, and `Microsoft.Extensions.Hosting` 11.0.0-preview.4. The exception text and the validator that throws it have been stable since .NET Core 2.0, so every fix below applies to .NET Core 3.1, .NET 5, 6, 8, 10, and 11 without changes.

The two type names in the message are the part to read first: the **first** name is the **scoped** service, and the **second** name is the **singleton** consumer that asked for it. The error always names them in that order, even though search engines tend to land you on the wrong half of the message half the time.

## Why scope validation rejects this combination

A singleton lives once per process. A scoped service lives once per request scope (or once per `IServiceScopeFactory.CreateScope()` call). If a singleton stores a reference to a scoped service in a field, that scoped instance survives every subsequent request, defeating the entire point of scoped lifetime: per-request state, connection pooling per scope, change-tracking per scope, tenant isolation per scope.

ASP.NET Core's `ValidateScopes` option catches this at resolve time by walking the call site graph before the constructor ever runs. In `Development`, `WebApplication.CreateBuilder` enables `ValidateScopes` automatically; in `Production` it does not, which is why some teams only see the exception locally and ship the captive bug to prod where it manifests as stale data, leaked connections, or `ObjectDisposedException` on a `DbContext` that was disposed with the original request scope.

There are exactly four shapes this bug takes:

1. **Singleton constructor parameter is scoped.** The most common case. `BackgroundService` (singleton) constructor asks for `IUserRepository` (scoped).
2. **Singleton constructor parameter is itself a singleton, but transitively depends on scoped.** A singleton `IFooFactory` takes a singleton `IFooDeps`, which takes a scoped `IUnitOfWork`. The validator follows the graph.
3. **Singleton resolves scoped from `IServiceProvider` directly.** `_provider.GetRequiredService<IUserRepository>()` from inside a singleton, where `_provider` is the **root** provider. The provider has no scope, so the validator throws.
4. **Hosted service / queue worker / timer callback running outside any request.** The host calls into the singleton from a thread that has no ambient scope, so any scoped resolve goes against the root.

The first three fail at startup or at the first call. The fourth fails the moment the timer fires. Same exception, different debug paths.

## Minimal repro

The smallest .NET 11 console app that throws the exception:

```csharp
// .NET 11 preview 4, Microsoft.Extensions.Hosting 11.0.0-preview.4
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddScoped<IUserRepository, UserRepository>();
builder.Services.AddHostedService<OrderProcessor>();

var host = builder.Build();
await host.RunAsync();

public interface IUserRepository
{
    string GetName(int id);
}

public sealed class UserRepository : IUserRepository
{
    public string GetName(int id) => $"user-{id}";
}

public sealed class OrderProcessor(IUserRepository repo) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            Console.WriteLine(repo.GetName(1));
            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

`AddHostedService<T>` registers `OrderProcessor` as a singleton. The constructor demands `IUserRepository`, which is scoped. The host builder calls `GetRequiredService` on the root provider during `StartAsync`, the validator walks the call site, sees the scoped-into-singleton edge, and throws the exception.

## Fix one: make the consumer scoped, when the consumer fits in a request

The cleanest fix when the consumer is reached **per request**. A controller, a minimal API endpoint handler, an MVC filter, a SignalR hub method: all of these run inside an existing scope. If you accidentally registered them as singleton, change the registration:

```csharp
// .NET 11 preview 4
// Wrong: pulls AppDbContext into a process-wide singleton
builder.Services.AddSingleton<IOrderService, OrderService>();

// Right: scoped matches DbContext lifetime
builder.Services.AddScoped<IOrderService, OrderService>();
```

This fix does not work for hosted services, timers, or background queues. They have no surrounding scope, so making them scoped is a no-op (the host still resolves them from the root). Use fix two for those.

When you change a registration from singleton to scoped, audit the call sites for any field-stored references. Any other singleton that took `IOrderService` in its constructor will now fail scope validation in turn, and the chain unwinds upward until you reach a service that fits in a request scope.

## Fix two: inject IServiceScopeFactory and open a scope per unit of work

When the consumer **must** stay singleton, take `IServiceScopeFactory` and create a fresh scope each time you do work. This is the canonical pattern for `BackgroundService` and any process-wide consumer:

```csharp
// .NET 11 preview 4
public sealed class OrderProcessor(IServiceScopeFactory scopeFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            using var scope = scopeFactory.CreateScope();
            var repo = scope.ServiceProvider.GetRequiredService<IUserRepository>();

            Console.WriteLine(repo.GetName(1));

            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

Three rules to apply this pattern correctly:

- **One scope per unit of work**, not one scope per process. The whole point is that each iteration gets a fresh `DbContext`, fresh change tracker, fresh connection. Disposing the scope at the end of the iteration releases the scoped services.
- **Resolve from the scope's `ServiceProvider`**, not from the captured root provider. `scope.ServiceProvider.GetRequiredService<T>()` is correct; `_rootProvider.GetRequiredService<T>()` is the original bug.
- **Do not store scoped services in fields** of the singleton. The instance you resolve inside the scope must not outlive the scope. If you need to hand it to another method, pass it as a parameter and let it go out of scope with the `using`.

For `IAsyncDisposable` services in .NET 11 (most modern `DbContext` configurations), prefer the async-disposable form:

```csharp
// .NET 11 preview 4
await using var scope = scopeFactory.CreateAsyncScope();
var repo = scope.ServiceProvider.GetRequiredService<IUserRepository>();
```

`CreateAsyncScope` returns an `AsyncServiceScope`, which disposes scoped services through `DisposeAsync` if they implement it. For pooled `DbContext` instances, this matters: synchronous disposal of an async-only resource throws on .NET 11 by default.

## Fix three: use IDbContextFactory for DbContext specifically

EF Core ships a typed factory for exactly this scenario. Register it instead of (or alongside) the scoped `DbContext`:

```csharp
// .NET 11 preview 4, Microsoft.EntityFrameworkCore 11.0.0-preview.4
builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default")));
```

```csharp
// .NET 11 preview 4
public sealed class OrderProcessor(IDbContextFactory<AppDbContext> dbFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);

            var pending = await db.Orders
                .Where(o => o.Status == OrderStatus.Pending)
                .ToListAsync(stoppingToken);

            // process pending...

            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

`AddDbContextFactory` registers `IDbContextFactory<AppDbContext>` as a **singleton**, and the factory hands out fresh `DbContext` instances on demand. No scope mismatch, no captive `DbContext`, no scope ceremony in your worker. This is the pattern Microsoft recommends for Blazor Server, hosted services, and any non-request-bound code that talks to EF Core. See the [DbContext factory documentation](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor) for the full guidance.

You can register both `AddDbContext` and `AddDbContextFactory` if you have a mix of request-bound and non-request-bound consumers. Use `AddDbContextFactory<T>(..., ServiceLifetime.Scoped)` to make the factory itself scoped if you need pooling alongside scoping, but verify the lifetimes line up at the consumer.

## Fix four: ValidateOnBuild catches this at startup, not at first request

Once you have applied a real fix above, turn on build-time validation so the next captive bug fails fast:

```csharp
// .NET 11 preview 4
builder.Host.UseDefaultServiceProvider(options =>
{
    options.ValidateScopes = true;
    options.ValidateOnBuild = true;
});
```

`ValidateScopes = true` forces the runtime to walk every resolve through the call-site validator, even in production. `ValidateOnBuild = true` does this **once** at `host.Build()` time for every registration in the container. The host refuses to start if any registration would throw at first resolve.

The cost is a one-time validation pass at boot. The benefit is that the next developer who introduces a captive dependency sees the failure during local startup or in CI, not in production traffic.

What you should **not** do, even though search results suggest it: turn `ValidateScopes` off to silence the exception. Disabling the check does not fix the bug. It hides it. The scoped service still gets pinned to the singleton's lifetime; you just stop being told. Stale data, leaked connections, and `ObjectDisposedException` later in the process are guaranteed.

## Variants that look like the same error but resolve differently

A few error messages share family resemblance and waste time when treated identically:

- **`Unable to resolve service for type 'X' while attempting to activate 'Y'`**: registration is missing, not a lifetime mismatch. Different cause, different fix. Covered in [the unable-to-resolve-service post](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- **`Cannot resolve scoped service 'X' from root provider`**: the consumer asked the **root** `IServiceProvider` directly (`app.Services.GetRequiredService<X>()` for a scoped `X`). The fix is the same as for the singleton case: open a scope first.
- **`A circular dependency was detected for the service of type 'X'`**: lifetime is fine, but the call site graph contains a cycle. Look for a service that takes itself or a cousin in its constructor.
- **`Cannot access a disposed object. Object name: 'AppDbContext'`**: a captive scoped service that **already** escaped scope validation (because validation was off, or the service was resolved through a non-validated path) and is now used after the original scope was disposed. The fix is to open a fresh scope at the call site.

## Why this hits hosted services more than anything else

`AddHostedService<T>` and `AddSingleton<IHostedService, T>` are the same registration: every hosted service is a singleton. The host resolves them from the root provider during `StartAsync`. If your hosted service's constructor takes anything that touches the database, talks to a tenant resolver, or wraps `HttpContext`, it will be scoped, and the validator will throw.

The same trap exists for:

- **`IHttpClientFactory` consumers that resolve scoped delegating handlers from a singleton.** `IHttpClientFactory` itself is singleton, but per-request handlers can be registered scoped. Resolving the named client from a singleton triggers the validator.
- **Polly resilience pipelines** registered scoped (which they are by default in .NET 11) and consumed from a singleton.
- **`IOptionsSnapshot<T>`**, which is **scoped**. A singleton that depends on `IOptionsSnapshot<T>` will fail validation. Use `IOptionsMonitor<T>` (singleton) instead. The change is a one-line edit at the constructor.
- **MediatR / `ISender` registered scoped.** `Mediator.Send` from a hosted service must run through a scope.
- **EF Core interceptors** that hold a captured `IServiceProvider`. Use the scope-friendly registration overloads, not a captured root provider.

## Edge cases worth naming

- **`IServiceProvider` injected into a singleton**. Legal, but the provider you receive is the **root** provider. Resolving anything scoped from it triggers the same exception. If you need to resolve scoped, ask for `IServiceScopeFactory` instead and call `CreateScope()`.
- **`Func<T>` factories registered manually**. If `T` is scoped and the factory is captured by a singleton, the factory looks fine on inspection but blows up the first time it is invoked from outside a scope. Replace the manual factory with `IServiceScopeFactory` plus `GetRequiredService<T>()`.
- **Test hosts that disable scope validation**. `WebApplicationFactory<T>` keeps validation on by default in .NET 8+. If your tests pass and production fails, check that you have not added `ValidateScopes = false` to the test host.
- **Native AOT and trimmed builds**. Scope validation runs on the same default container, so AOT does not change this rule. The trimmer can remove a type used only via reflection in a captured factory; the symptom there is `Unable to resolve`, not the captive exception.
- **Generic hosted services**. `AddHostedService<MyHostedService<MyArg>>()` is still singleton. The closed generic constructor is what the validator inspects, so a constructor parameter of `IRepo<MyArg>` registered scoped triggers the same error path.

## Related

- The complementary registration error to this one: [unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- A worked example of the singleton-with-scope-factory pattern: [running a Semantic Kernel plugin from a BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- The next EF Core exception you hit when a `DbContext` accidentally outlives its scope: [a second operation was started on this context instance](/2026/05/fix-second-operation-was-started-on-this-context-instance/).
- Test-time DI swaps without breaking scope validation: [integration tests against a real SQL Server with Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- A configuration failure mode that frequently sits adjacent to lifetime bugs: [no connection string named 'DefaultConnection' could be found](/2026/05/fix-no-connection-string-named-defaultconnection/).

## Sources

- Microsoft Learn, [Dependency injection guidelines: scope validation](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines#scope-validation).
- Microsoft Learn, [Dependency injection in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection).
- Microsoft Learn, [Using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- ASP.NET Core source, [`CallSiteValidator.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/CallSiteValidator.cs) where the captive-dependency check fires.
- ASP.NET Core source, [`ServiceProviderEngineScope.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs) where the root-vs-scope distinction is enforced.
