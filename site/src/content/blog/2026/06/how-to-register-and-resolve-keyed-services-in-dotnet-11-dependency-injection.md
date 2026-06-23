---
title: "How to register and resolve keyed services in .NET 11 dependency injection"
description: "Register more than one implementation of the same interface under a key with AddKeyedSingleton/Scoped/Transient, then resolve them with [FromKeyedServices], GetRequiredKeyedService, or KeyedService.AnyKey. The keyed and non-keyed registries are separate, which is the gotcha that bites most people."
pubDate: 2026-06-23
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "dependency-injection"
  - "aspnetcore"
---

The built-in .NET dependency injection container can hold several implementations of the same service type and tell them apart by a key. You register each one with `AddKeyedSingleton`, `AddKeyedScoped`, or `AddKeyedTransient`, passing an `object` key (a string or an enum is typical), and you pull a specific one back out with `[FromKeyedServices("key")]` on a constructor or handler parameter, or with `provider.GetRequiredKeyedService<T>("key")`. The single fact that trips everyone up: keyed and non-keyed registrations live in two separate tables. A plain `GetService<T>()` will never see a keyed registration, and `[FromKeyedServices]` will never see a plain one. This guide is written against .NET 11 (preview 5 at the time of writing, general availability targeted for November 2026) and `Microsoft.Extensions.DependencyInjection` 11.0.0. Keyed services shipped in .NET 8 and the API has been stable since, so every pattern here also works unchanged on .NET 8 and .NET 10.

## Why you would key a service instead of just making a new interface

The old way to register two implementations of `IPaymentGateway` was to invent two interfaces (`IStripeGateway`, `IPayPalGateway`) or to register a factory delegate that switched on a string. Both leak the selection mechanism into your type system. Keyed services let the interface stay singular and move the discriminator to the registration, which is exactly where a deployment-time or configuration-time choice belongs.

The canonical cases:

- **Multiple providers behind one contract.** Two payment gateways, three notification channels, a primary and a fallback HTTP client, each registered under a key and selected per call site.
- **Named caches or connections.** A short-lived cache and a long-lived cache, both `IMemoryCache`-shaped, keyed `"short"` and `"long"`.
- **Strategy lookup at runtime.** A dictionary of strategies where the key is computed from a request, resolved through `IKeyedServiceProvider` rather than a hand-rolled `switch`.

If you only ever have one implementation, do not reach for a key. Keyed registration adds a discriminator that you then have to keep in sync between the registration site and every resolution site. Use it when the multiplicity is real.

## Registering keyed services

Every non-keyed registration method has a keyed twin that takes a `serviceKey` as its first argument. Here is the whole surface in one block.

```csharp
// .NET 11, C# 14 - Program.cs
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);

// Two implementations of the same interface, told apart by a string key.
builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");
builder.Services.AddKeyedSingleton<IPaymentGateway, PayPalGateway>("paypal");

// Lifetimes work exactly as their non-keyed counterparts.
builder.Services.AddKeyedScoped<IReportBuilder, PdfReportBuilder>("pdf");
builder.Services.AddKeyedTransient<IReportBuilder, CsvReportBuilder>("csv");

// A factory overload gives you the key and the provider, useful when the
// implementation needs to read its own key or build from config.
builder.Services.AddKeyedSingleton<IClock>("utc", (sp, key) => new SystemClock(DateTimeKind.Utc));

var app = builder.Build();
```

The key is an `object`, compared with `Equals`. Strings are the common choice because they survive a `appsettings.json` round-trip, but an enum is cleaner when the set is closed and known at compile time:

```csharp
// .NET 11, C# 14 - enum keys avoid stringly-typed lookups
public enum Channel { Email, Sms, Push }

builder.Services.AddKeyedScoped<INotifier, EmailNotifier>(Channel.Email);
builder.Services.AddKeyedScoped<INotifier, SmsNotifier>(Channel.Sms);
builder.Services.AddKeyedScoped<INotifier, PushNotifier>(Channel.Push);
```

You can register the same implementation type under several keys, and you can register more than one implementation under the **same** key. The second case turns into an `IEnumerable<T>` resolve, covered below.

## Resolving a keyed service three ways

### Constructor injection with `[FromKeyedServices]`

The attribute lives in `Microsoft.Extensions.DependencyInjection` and marks a single constructor parameter so the container resolves it from the keyed table. This is the form you want in ordinary services and controllers because it keeps the consumer free of any `IServiceProvider` reference.

```csharp
// .NET 11, C# 14
public sealed class CheckoutService(
    [FromKeyedServices("stripe")] IPaymentGateway gateway)
{
    public Task<string> ChargeAsync(decimal amount) => gateway.ChargeAsync(amount);
}
```

The same attribute works on a minimal API handler parameter, which is the cleanest way to bind a keyed dependency to an endpoint:

```csharp
// .NET 11, C# 14 - keyed dependency straight into a minimal API handler
app.MapPost("/charge/{provider}",
    ([FromKeyedServices("stripe")] IPaymentGateway gateway, decimal amount)
        => gateway.ChargeAsync(amount));
```

It also works on an MVC controller action parameter and on a constructor parameter of a controller, in both cases without any extra registration.

### Imperative resolution with `GetRequiredKeyedService`

When the key is only known at runtime (computed from a request, read from config), you cannot use a compile-time attribute. Inject `IServiceProvider` and call the keyed extension methods. The provider produced by `Build()` implements `IKeyedServiceProvider`, so these always work against the default container.

```csharp
// .NET 11, C# 14 - the key is decided at runtime
public sealed class PaymentRouter(IServiceProvider services)
{
    public Task<string> ChargeAsync(string providerKey, decimal amount)
    {
        // Throws InvalidOperationException if nothing is registered under the key.
        var gateway = services.GetRequiredKeyedService<IPaymentGateway>(providerKey);
        return gateway.ChargeAsync(amount);
    }
}
```

Use `GetKeyedService<T>(key)` (no "Required") when a missing registration is a normal, non-exceptional outcome; it returns `null` instead of throwing. Inside a scoped consumer, resolve from the scoped provider so the keyed scoped instance is scoped correctly. If you are reaching for a scope inside a singleton such as a `BackgroundService`, the same `IServiceScopeFactory` discipline applies as for any [scoped service inside a BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/): the keyed-ness of the registration does not change the lifetime rules.

### Resolving every implementation under a key

Register more than one implementation under the same key and resolve them as a set:

```csharp
// .NET 11, C# 14
builder.Services.AddKeyedSingleton<IValidationRule, NotEmptyRule>("order");
builder.Services.AddKeyedSingleton<IValidationRule, PositiveAmountRule>("order");

public sealed class OrderValidator(
    [FromKeyedServices("order")] IEnumerable<IValidationRule> rules)
{
    public bool IsValid(Order o) => rules.All(r => r.Check(o));
}
```

`GetKeyedServices<IValidationRule>("order")` is the imperative equivalent and returns both implementations in registration order.

## Matching any key with `KeyedService.AnyKey`

Sometimes you want one registration that answers for *every* key, with the implementation reading the key it was resolved under. That is what `KeyedService.AnyKey` is for. Pair it with a `[ServiceKey]` parameter so the implementation receives the actual key at construction time.

```csharp
// .NET 11, C# 14 - one registration that serves any key
builder.Services.AddKeyedSingleton<ITenantStore>(
    KeyedService.AnyKey,
    (sp, key) => new TenantStore((string)key!));

public sealed class TenantStore : ITenantStore
{
    public TenantStore(string tenantId) => TenantId = tenantId;
    public string TenantId { get; }
}

// A consumer can ask for any tenant; the key flows into the factory.
var acme = app.Services.GetRequiredKeyedService<ITenantStore>("acme");
var globex = app.Services.GetRequiredKeyedService<ITenantStore>("globex");
```

The `[ServiceKey]` attribute on a constructor parameter works without the factory overload too. The container injects the key that was used to resolve the instance:

```csharp
// .NET 11, C# 14 - the implementation discovers its own key
public sealed class TenantStore(
    [ServiceKey] string tenantId,
    AppDbContext db) : ITenantStore
{
    public string TenantId => tenantId;
}

builder.Services.AddKeyedScoped<ITenantStore, TenantStore>(KeyedService.AnyKey);
```

Two rules govern `AnyKey`. First, an exact-key registration wins over the `AnyKey` registration when both exist. Second, you cannot *resolve* with `KeyedService.AnyKey` as the key; it is a registration-side sentinel only. Asking `GetRequiredKeyedService<T>(KeyedService.AnyKey)` throws.

## The separation that causes the most confusion

Keyed and non-keyed registrations are two distinct tables inside the container. This single fact explains almost every "but I registered it" bug report:

```csharp
// .NET 11, C# 14
builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");

var sp = builder.Services.BuildServiceProvider();

sp.GetService<IPaymentGateway>();                 // null - no NON-keyed registration
sp.GetKeyedService<IPaymentGateway>("stripe");    // the StripeGateway
sp.GetKeyedService<IPaymentGateway>("paypal");    // null - nothing under that key
```

A plain constructor parameter `IPaymentGateway gateway` (no attribute) resolves only from the non-keyed table and will fail to find a keyed registration. If you want a service to be reachable both ways, register it twice, once keyed and once not. The reverse trap is just as common: `[FromKeyedServices("stripe")]` against a service registered with plain `AddSingleton` resolves to nothing, because the attribute reads only the keyed table.

This separation is also why `GetServices<T>()` (the non-keyed enumerable) does not include keyed registrations. If you depend on enumerating "all implementations," decide up front whether they are keyed or not and stay consistent.

## Gotchas worth knowing before you ship

**`ActivatorUtilities.CreateInstance` honours `[FromKeyedServices]`, but only for types it activates.** A type created by the container (or by `ActivatorUtilities`) gets its keyed parameters filled. A type you `new` up yourself gets nothing injected, keyed or otherwise. This matters for factory code and for anything outside the DI graph.

**The key's `Equals` and `GetHashCode` must be stable.** Strings and enums are fine. A mutable reference-type key, or one with value-based equality that changes over time, will silently fail to match. Prefer immutable keys.

**`ServiceKey` injection requires the right type.** If you register under a `string` key and declare `[ServiceKey] int id`, construction throws at resolve time. Keep the declared parameter type assignable from the key you registered with.

**Validation runs per registration, not per key.** When `ValidateOnBuild` is on (the default in `Development` under `WebApplication.CreateBuilder`), the call-site validator checks each keyed registration's graph the same as a non-keyed one. A keyed scoped service captured by a singleton still throws `Cannot consume scoped service from singleton`; keying does not exempt you from lifetime rules. If you do hit a resolution failure, the message reads the same as the non-keyed case, and the [unable to resolve service while attempting to activate fix](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) walks through reading it; just remember the keyed table is separate when you check whether the registration exists.

**Native AOT and trimming are supported.** Keyed services were designed to be AOT-friendly: the resolution does not rely on runtime reflection over your types, so they survive trimming without extra `DynamicallyAccessedMembers` annotations. If you are weighing the deployment model, the trade-offs in [Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) apply unchanged with keyed registrations in the graph.

**Not every third-party container supports keys.** The built-in container does. If you have swapped in an older Autofac, Lamar, or DryIoc version, confirm its keyed-service bridge before relying on `[FromKeyedServices]`; the feature is a `Microsoft.Extensions.DependencyInjection.Abstractions` contract that each container has to implement.

## A complete worked example

Here is the end-to-end shape: two gateways keyed by name, a router that picks one at runtime from the route, and a default injected straight into a handler.

```csharp
// .NET 11, C# 14 - Program.cs
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddKeyedSingleton<IPaymentGateway, StripeGateway>("stripe");
builder.Services.AddKeyedSingleton<IPaymentGateway, PayPalGateway>("paypal");
builder.Services.AddScoped<PaymentRouter>();

var app = builder.Build();

// Runtime selection: the provider name comes from the URL.
app.MapPost("/charge/{provider}",
    (string provider, decimal amount, PaymentRouter router)
        => router.ChargeAsync(provider, amount));

// Compile-time selection: this endpoint always uses Stripe.
app.MapPost("/charge-stripe",
    ([FromKeyedServices("stripe")] IPaymentGateway gateway, decimal amount)
        => gateway.ChargeAsync(amount));

app.Run();

public interface IPaymentGateway { Task<string> ChargeAsync(decimal amount); }

public sealed class PaymentRouter(IServiceProvider services)
{
    public Task<string> ChargeAsync(string key, decimal amount)
    {
        var gateway = services.GetKeyedService<IPaymentGateway>(key)
            ?? throw new ArgumentException($"Unknown gateway '{key}'", nameof(key));
        return gateway.ChargeAsync(amount);
    }
}
```

The split is intentional: the `/charge/{provider}` endpoint needs `IServiceProvider` because the key is data, while `/charge-stripe` uses the attribute because the key is a constant. Reach for `[FromKeyedServices]` whenever the key is known at compile time, and fall back to `GetKeyedService`/`GetRequiredKeyedService` only when it genuinely is not.

## Where keyed services fit next

Keyed DI is the right tool when one contract has several real implementations selected by configuration or per request. It is the wrong tool for a single implementation, for cross-cutting concerns better handled by the options pattern, or for selection logic complex enough to deserve its own factory abstraction. When you reach for it, keep the keys immutable, register once per intended resolution path, and remember the keyed and non-keyed tables never see each other.

For adjacent patterns: deciding where endpoints get their dependencies is part of the larger [minimal APIs vs controllers](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) choice, and keyed registration pairs well with [HybridCache in ASP.NET Core 11](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) when you want named cache instances behind one interface.

## Sources

- [Dependency injection in .NET - keyed services](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#keyed-services), MS Learn.
- [`ServiceCollectionServiceExtensions` keyed methods](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.servicecollectionserviceextensions), .NET API reference.
- [`FromKeyedServicesAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.fromkeyedservicesattribute) and [`ServiceKeyAttribute`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.servicekeyattribute), .NET API reference.
- [`IKeyedServiceProvider`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.ikeyedserviceprovider) and [`KeyedService.AnyKey`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.keyedservice.anykey), .NET API reference.
