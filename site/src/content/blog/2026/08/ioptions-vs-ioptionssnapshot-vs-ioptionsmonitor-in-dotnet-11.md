---
title: "IOptions<T> vs IOptionsSnapshot<T> vs IOptionsMonitor<T> in .NET 11"
description: "Default to IOptions<T>. Use IOptionsMonitor<T> when a singleton has to see config reloads, and IOptionsSnapshot<T> only when a scoped consumer wants a value that is stable for one request. The deciding axis is the lifetime of the consumer, not the shape of the settings."
pubDate: 2026-08-01
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
---

Inject `IOptions<T>` unless you have a concrete reason not to. It is a singleton, it binds your settings class exactly once for the life of the process, and it is the cheapest of the three to resolve. Reach for `IOptionsMonitor<T>` when a long-lived service has to observe configuration changes without a restart, and for `IOptionsSnapshot<T>` in one narrow case: a scoped or transient consumer that wants a value which is stable for the duration of a single request but is allowed to differ between requests. The axis that decides this is the lifetime of the class doing the injecting, not the shape of the settings being injected. Everything below targets .NET 11 (tested against Preview 6, SDK `11.0.100-preview.6.26359.118`) and C# 14, with `Microsoft.Extensions.Options` 11.0.0. The three interfaces have behaved this way since .NET Core 2.0, so all of it runs unchanged on .NET 10 GA; the only genuinely new material is the .NET 11 validation work at the end.

## The feature matrix

| Feature | `IOptions<T>` | `IOptionsSnapshot<T>` | `IOptionsMonitor<T>` |
| --- | --- | --- | --- |
| Concrete implementation | `UnnamedOptionsManager<T>` | `OptionsManager<T>` | `OptionsMonitor<T>` |
| DI lifetime | Singleton | **Scoped** | Singleton |
| Injectable into a singleton | Yes | No, captive dependency | Yes |
| Sees a config reload | No, ever | Yes, on the next scope | Yes, immediately |
| Named options | No | Yes, `Get(name)` | Yes, `Get(name)` |
| Change callbacks | No | No | Yes, `OnChange` |
| Value accessor | `.Value` | `.Value`, `.Get(name)` | `.CurrentValue`, `.Get(name)` |
| How often the binder runs | Once per process | Once per scope, per name | Once per change, per name |
| Where the instance is cached | Field on the singleton | `OptionsCache<T>` inside the scoped manager | Singleton `IOptionsMonitorCache<T>` |

Two rows carry most of the weight. The lifetime row is the one that produces startup exceptions, and the "how often the binder runs" row is the one that produces surprise CPU on a hot path. Everything else follows from those two.

All three are registered by `AddOptions()`, which the host calls for you. From [OptionsServiceCollectionExtensions](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsServiceCollectionExtensions.cs):

```csharp
// Microsoft.Extensions.Options 11.0.0 -- what AddOptions() actually registers
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptions<>), typeof(UnnamedOptionsManager<>)));
services.TryAdd(ServiceDescriptor.Scoped(typeof(IOptionsSnapshot<>), typeof(OptionsManager<>)));
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptionsMonitor<>), typeof(OptionsMonitor<>)));
services.TryAdd(ServiceDescriptor.Transient(typeof(IOptionsFactory<>), typeof(OptionsFactory<>)));
services.TryAdd(ServiceDescriptor.Singleton(typeof(IOptionsMonitorCache<>), typeof(OptionsCache<>)));
```

Note that `IOptionsFactory<T>` is transient and does the real work: it runs every registered `IConfigureOptions<T>` in order, then every `IPostConfigureOptions<T>`, then validation. The three accessor interfaces differ only in how aggressively they cache the factory's output. That is the whole story, and it is why the choice is about lifetime.

The settings class and registration are identical for all three:

```csharp
// .NET 11, C# 14
public sealed class PaymentOptions
{
    public string ApiKey { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 30;
}

// Program.cs
builder.Services.Configure<PaymentOptions>(
    builder.Configuration.GetSection("Payment"));
```

## When to pick IOptions

Make this the default. You give up reload support, and in most services that is not a real loss.

- **Anything read at startup.** Connection strings, a base URL, a queue name, a feature flag you would redeploy to change. `IOptions<T>` is a singleton, so injecting it into a singleton, a scoped service, or a transient one all work. If you get a `Cannot consume scoped service` error while wiring settings, `IOptions<T>` is usually the fix and not the cause. See [why that exception happens and how to unwind it](/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- **Hot paths.** `UnnamedOptionsManager<T>` caches the bound instance in a field. After the first access, `.Value` is a field read. There is no dictionary lookup, no name comparison, and no allocation.
- **Constructor capture is safe.** Because the value can never change, `options.Value` in a constructor is correct rather than a latent bug.

```csharp
// .NET 11, C# 14
public sealed class PaymentClient(IOptions<PaymentOptions> options)
{
    // Safe: the value is fixed for the life of the process.
    private readonly PaymentOptions _settings = options.Value;

    public TimeSpan Timeout => TimeSpan.FromSeconds(_settings.TimeoutSeconds);
}
```

The cost of `IOptions<T>` is exactly one thing: it does not support named options, so `Configure<Features>("Personalize", ...)` is invisible to it. If you need two configurations of the same class, you have already ruled `IOptions<T>` out. That is also the moment to check whether [keyed services in .NET 11 dependency injection](/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) are a better fit than named options for what you are actually modelling.

## When to pick IOptionsSnapshot

Reach for it when a **scoped** consumer needs a value that stays consistent for one unit of work but is allowed to move between units of work.

- **A per-request value that must not shift mid-request.** A controller and three services it calls all resolve the same scoped `OptionsManager<T>` instance, so all four see the identical `PaymentOptions` instance even if `appsettings.json` is rewritten halfway through the request. `IOptionsMonitor<T>` gives no such guarantee: two `CurrentValue` reads in the same request can return two different instances.
- **Named options in a request-scoped consumer.** `Get(name)` is supported, and the per-scope `OptionsCache<T>` means the second `Get("Personalize")` in a request is a cache hit.

```csharp
// .NET 11, C# 14 -- scoped service, values stable for this request
public sealed class CheckoutService(IOptionsSnapshot<PaymentOptions> snapshot)
{
    private readonly PaymentOptions _settings = snapshot.Value;

    public string Key => _settings.ApiKey;
}
```

Two hard limits. First, `IOptionsSnapshot<T>` is registered `Scoped`, so injecting it into a singleton fails, including into an `IHostedService` or `BackgroundService`, which are singletons. The host turns on `ValidateScopes` and `ValidateOnBuild` in the Development environment, so you get a clear `Cannot consume scoped service` at startup there; outside Development those checks are off by default, and the same code resolves a captive dependency that quietly never refreshes. Turn scope validation on everywhere if you want the failure to be loud. The workaround is [creating a scope inside the BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) and resolving from there, but if all you wanted was fresh values, `IOptionsMonitor<T>` is the simpler answer. Second, there is no ambient scope in a console app or a raw `IHost` unless you make one, so `IOptionsSnapshot<T>` in a non-web host almost always means you actually wanted `IOptionsMonitor<T>`.

## When to pick IOptionsMonitor

Reach for it when a **singleton** has to see changes, or when you need a callback.

- **A singleton that must not be restarted to pick up a new value.** A rate limiter, a cache policy, a sampling percentage, a log level.
- **You need to react, not just read.** `OnChange` is the only push notification of the three.
- **Selective invalidation.** `IOptionsMonitorCache<T>.TryRemove(name)` forces a single named instance to be rebuilt on next access, which is useful when your own code, and not a file watcher, knows the value went stale.

`OptionsMonitor<T>` subscribes to every registered `IOptionsChangeTokenSource<T>`. When one fires, `InvokeChanged` runs `_cache.TryRemove(name)`, immediately rebuilds with `TOptions options = Get(name)`, and then invokes the listeners with the new instance. `CurrentValue` is a thin wrapper over `Get(Options.DefaultName)`, which is `_cache.GetOrAdd(localName, () => localFactory.Create(localName))`.

```csharp
// .NET 11, C# 14 -- singleton, always current
public sealed class RateLimiter : IDisposable
{
    private readonly IDisposable? _subscription;
    private volatile PaymentOptions _current;

    public RateLimiter(IOptionsMonitor<PaymentOptions> monitor)
    {
        _current = monitor.CurrentValue;
        _subscription = monitor.OnChange(updated => _current = updated);
    }

    public int TimeoutSeconds => _current.TimeoutSeconds;

    public void Dispose() => _subscription?.Dispose();
}
```

That `IDisposable` matters. `OnChange` returns a `ChangeTrackerDisposable` whose `Dispose` runs `_monitor._onChange -= OnChange`. Register a callback from a scoped or transient service and throw the return value away, and every request adds a listener to a singleton's multicast delegate that never comes off. The result is a slow leak plus a callback storm, and it is one of the most common ways an `IOptionsMonitor<T>` goes wrong.

Change notifications only exist for file-system configuration providers such as `Microsoft.Extensions.Configuration.Json`, `.Ini`, `.Xml`, `.KeyPerFile`, and `.UserSecrets`, and only when the provider was added with `reloadOnChange: true`. An environment-variable or command-line provider never fires, so on those sources `IOptionsMonitor<T>` degrades silently into a slightly more expensive `IOptions<T>`.

## The measurement that matters is a count, not a nanosecond figure

I am deliberately not publishing ns/op numbers here, because the resolve cost of all three is dominated by whatever your own `IConfigureOptions<T>` delegates and validators do, which means my machine's numbers would tell you nothing about yours. The number that is portable is **how many times your binder runs**, and you can measure that in about fifteen lines.

```csharp
// .NET 11 Preview 6, C# 14 -- counts how often the options are actually built
public sealed class CountingConfigure : IConfigureOptions<PaymentOptions>
{
    public static int Count;
    public void Configure(PaymentOptions options) => Interlocked.Increment(ref Count);
}

builder.Services.AddSingleton<IConfigureOptions<PaymentOptions>, CountingConfigure>();

app.MapGet("/probe", (
    IOptions<PaymentOptions> o,
    IOptionsSnapshot<PaymentOptions> s,
    IOptionsMonitor<PaymentOptions> m) =>
{
    _ = o.Value; _ = s.Value; _ = m.CurrentValue;
    return CountingConfigure.Count;
});
```

Hit `/probe` repeatedly and the counter climbs by exactly one per request, and that one is the `IOptionsSnapshot<T>`. `IOptions<T>` contributes on the first request only, `IOptionsMonitor<T>` contributes on the first request and then once per reload, and `IOptionsSnapshot<T>` contributes on every single request because a fresh scope means a fresh `OptionsManager<T>` with an empty `OptionsCache<T>`. Add `.ValidateDataAnnotations()` to that registration and the validators re-run on every request too. On an endpoint doing 5,000 requests per second, that is 5,000 rebinds and 5,000 validation passes per second for a value that changes roughly never. This is the concrete reason `IOptionsSnapshot<T>` should not be your default, and it is a claim you can verify in your own app rather than take from a chart.

## The gotchas that pick for you

**`OnChange` fires for configuration you do not care about.** Callbacks are wired to the configuration root's change token, not to your section. Any write anywhere in `IConfiguration` invokes every `IOptionsMonitor<T>` listener in the app. The .NET team tracked this as [dotnet/runtime#109445](https://github.com/dotnet/runtime/issues/109445) and closed it as not planned, so the behaviour is permanent: as long as any part of configuration changes, all `IOptionsMonitor` instances can trigger their callbacks. If your callback rebuilds an expensive resource, cache the previous value and compare before acting.

**`OnChange` also fires more than once per save.** Editors write files in several operations, and the underlying `IFileProvider.Watch` reports each one, so a single Ctrl+S commonly produces two callbacks and sometimes more. This is [dotnet/aspnetcore#2542](https://github.com/dotnet/aspnetcore/issues/2542), and it is a file-watcher artifact, not a bug in the options stack. Make your callback idempotent or debounce it.

**File watching is unreliable on Docker volumes and network shares.** Set `DOTNET_USE_POLLING_FILE_WATCHER=1` to poll instead. The poll interval is four seconds and is not configurable, which is a real constraint if you were counting on faster propagation.

**`IOptions<T>` really does mean forever.** The value is bound the first time `.Value` is read and cached for the process lifetime. If your team's mental model is "the settings object refreshes", `IOptions<T>` will look broken during an incident when a config push does nothing. Decide this per settings class and write it down.

**Configuring options with scoped services is a trap regardless of accessor.** `IConfigureOptions<T>` is resolved through the root provider for `IOptions<T>`, so a scoped dependency injected into your configure delegate becomes a captive dependency. Resolve an `IServiceProvider` and create a scope inside `Configure` instead, and remember that scope is not the request's scope.

## What .NET 11 adds

Two things worth knowing, both in the validation layer rather than the accessor layer.

`OptionsBuilder<TOptions>` gains a generic `Validate` overload that takes a type parameter instead of a delegate. The type must implement `IValidateOptions<TOptions>` and be registered in DI, which lines options validation up with the normal DI pattern:

```csharp
// .NET 11, C# 14
services.AddSingleton<IValidateOptions<MyOptions>, MyOptionsValidator>();
services.AddOptions<MyOptions>()
    .Bind(configuration.GetSection("MyOptions"))
    .Validate<MyOptionsValidator>();
```

`System.ComponentModel.DataAnnotations` also learned asynchronous validation in .NET 11, via `AsyncValidationAttribute`, `IAsyncValidatableObject`, and `Validator.ValidateObjectAsync`. `Microsoft.Extensions.Options` picks that up through a new `IAsyncStartupValidator`, so an option whose validity depends on a network call can fail the app at startup rather than on first use. Neither change alters which accessor you should inject; both make `ValidateOnStart` a stronger default than it was in .NET 10.

## The recommendation, restated

Start every settings class with `IOptions<T>`. Move to `IOptionsMonitor<T>` when a specific singleton has a documented need to observe changes, and dispose the `OnChange` subscription. Use `IOptionsSnapshot<T>` only when a scoped consumer needs per-request stability of a value that genuinely changes, and accept that you are paying a full rebind plus revalidation on every request to get it. If you catch yourself reaching for `IOptionsSnapshot<T>` because a compiler error went away, you have solved a lifetime problem with a performance problem.

## Related

- [Fix: Cannot consume scoped service 'X' from singleton 'Y'](/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [How to use scoped services inside a BackgroundService in ASP.NET Core 11](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)
- [How to register and resolve keyed services in .NET 11 dependency injection](/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/)
- [Fix: No connection string named 'DefaultConnection' could be found](/2026/05/fix-no-connection-string-named-defaultconnection/)
- [How to write integration tests with WebApplicationFactory in ASP.NET Core 11](/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)

## Sources

- [Options pattern in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/options), Microsoft Learn
- [What's new in the .NET 11 libraries](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries), Microsoft Learn
- [OptionsServiceCollectionExtensions.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsServiceCollectionExtensions.cs), dotnet/runtime
- [OptionsMonitor.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Options/src/OptionsMonitor.cs), dotnet/runtime
- [IOptionsMonitor OnChange is fired whenever anything changes in IConfiguration](https://github.com/dotnet/runtime/issues/109445), dotnet/runtime issue 109445
- [ChangeToken.OnChange fires twice when listening for configuration changes](https://github.com/dotnet/aspnetcore/issues/2542), dotnet/aspnetcore issue 2542
- [The dangers and gotchas of using scoped services when configuring options](https://andrewlock.net/the-dangers-and-gotchas-of-using-scoped-services-when-configuring-options-in-asp-net-core/), Andrew Lock
