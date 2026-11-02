---
title: "MediatR vs plain service classes in 2026: should the license change move you?"
description: "Compare MediatR dispatch and pipeline behaviors with direct service calls, including DI validation, licensing criteria and how to assess performance."
pubDate: 2026-05-23
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "mediatr"
  - "dependency-injection"
  - "architecture"
  - "dotnet"
  - "dotnet-11"
---

Choose direct services when each request has one obvious destination. MediatR becomes more useful when several request types share pipeline behaviors or need notification fan-out. Check the license terms for the version you use as a separate decision.

**Correction — November 2, 2026:** Corrected the DI validation and licensing comparison and removed unsupported dispatch timing and allocation estimates.

The examples target `net11.0` and illustrate the MediatR 13/14 contracts. The DI validation check described below ran on .NET 10.

## What actually changed in July 2025

MediatR 12.5.0 was distributed under Apache 2.0. The author announced RPL-1.5 and commercial options starting with 13.0.0 in July 2025. Earlier versions retain their original terms.

[Lucky Penny Software’s Community criteria](https://luckypennysoftware.com/faq) include annual gross revenue or nonprofit budget below US$5 million and no more than US$10 million in outside capital. The vendor also sets conditions for government or quasi-government entities, higher-education use and client work. Check the conditions for your organization and use case.

## The feature matrix at a glance

| Concern | MediatR 13+ | Plain service classes |
| ------- | ----------- | --------------------- |
| Request dispatch | `ISender.Send` indirection | Direct method call on an injected interface |
| Cross-cutting concerns | First-class `IPipelineBehavior<,>` | Decorators (Scrutor) or explicit calls |
| DI validation | Depends on registrations and provider options | Depends on registrations and provider options |
| Notifications / fan-out | Built-in `INotification` publish | Hand-rolled list of handlers |

The pipeline is the main design difference: it gives many requests one place to share validation, logging, transactions or caching.

## What MediatR looks like, and the plain equivalent

Here is the canonical MediatR shape: a request, a handler, and a caller that dispatches through `ISender`.

```csharp
// .NET 11, C# 14, MediatR 13+ - request + handler
using MediatR;

public record GetOrderById(int OrderId) : IRequest<OrderDto>;

public sealed class GetOrderByIdHandler(AppDbContext db)
    : IRequestHandler<GetOrderById, OrderDto>
{
    public async Task<OrderDto> Handle(GetOrderById request, CancellationToken ct)
    {
        var order = await db.Orders.FindAsync([request.OrderId], ct)
            ?? throw new OrderNotFoundException(request.OrderId);
        return order.ToDto();
    }
}

// In an endpoint:
public async Task<OrderDto> Get(int id, ISender sender, CancellationToken ct)
    => await sender.Send(new GetOrderById(id), ct);
```

The plain version collapses the request and handler into one method on an injected service. The caller depends on the interface directly.

```csharp
// .NET 11, C# 14 - plain service class, no MediatR
public interface IOrderService
{
    Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct);
}

public sealed class OrderService(AppDbContext db) : IOrderService
{
    public async Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
    {
        var order = await db.Orders.FindAsync([orderId], ct)
            ?? throw new OrderNotFoundException(orderId);
        return order.ToDto();
    }
}

// In an endpoint:
public async Task<OrderDto> Get(int id, IOrderService orders, CancellationToken ct)
    => await orders.GetByIdAsync(id, ct);
```

From an interface call, go-to-definition leads to the interface method and the IDE can locate its implementations. From `Send`, locate the handler for the request type.

`AddScoped` records a service registration. With the built-in provider and `ValidateOnBuild` enabled, building the host can detect an unregistered constructor dependency in a registered service. With validation disabled, the build can succeed and the failure occurs when the service is resolved. [ASP.NET Core’s default validation settings](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-10.0#validatescopes-and-validateonbuild) depend on the environment. `ValidateScopes` is a separate lifetime check.

The .NET 10 check for this correction registered a scoped service with a missing constructor dependency: the default Development host failed at `Build()`, while the default Production host built and failed on resolution. An explicit `ValidateOnBuild` setting changed which phase failed.

```csharp
// .NET 11, C# 14 - registration, side by side
// MediatR: scan an assembly, register every handler reflectively
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// Plain: explicitly register the scoped service
builder.Services.AddScoped<IOrderService, OrderService>();
```

## The pipeline behavior, and how to live without it

This is where MediatR earns its keep. A pipeline behavior wraps every request, which gives you exactly one place to add validation, logging, timing, or a transaction.

```csharp
// .NET 11, C# 14, MediatR 13+ - cross-cutting validation for ALL requests
using MediatR;

public sealed class ValidationBehavior<TRequest, TResponse>(
    IEnumerable<IValidator<TRequest>> validators)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        foreach (var validator in validators)
            await validator.ValidateAndThrowAsync(request, ct);
        return await next(ct);
    }
}
```

Registered once, that behavior runs in front of every handler. Replacing this with copy-pasted validation calls in each plain service would be a regression, and it is the single best argument for keeping a mediator. But you can get the same "wrap everything" property in plain DI with the decorator pattern, using Scrutor (MIT licensed) to register a decorator around an interface:

```csharp
// .NET 11, C# 14, Scrutor 6.x - a decorator gives you the same cross-cutting hook
public sealed class LoggingOrderService(
    IOrderService inner,
    ILogger<LoggingOrderService> logger) : IOrderService
{
    public async Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
    {
        logger.LogInformation("Fetching order {OrderId}", orderId);
        return await inner.GetByIdAsync(orderId, ct);
    }
}

// Registration: decorate the real implementation
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.Decorate<IOrderService, LoggingOrderService>();
```

The trade is honest: MediatR's behavior is generic over every request with one registration, whereas a decorator is per interface. If you have one or two cross-cutting concerns and a handful of service interfaces, decorators win on clarity. If you have ten behaviors that must apply uniformly to two hundred request types, MediatR's generic pipeline is genuinely less code, and that is the scenario where staying (and paying, or qualifying for Community) is defensible. For request-level concerns that are really HTTP concerns, note that some of what people put in behaviors belongs in middleware or filters instead, the same surface covered by [adding a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/).

## What the dispatch actually costs

`Send` resolves a handler and invokes the configured pipeline. A direct call goes through the injected service instead. This article has no matched benchmark for those paths, so it reports no per-call time or allocation count.

If dispatch cost affects the choice, measure both paths with the same handler work, lifetime, runtime and behavior chain. Measure registration and cold start separately. Explicit registration can avoid handler scanning. Verify trimming and Native AOT against the published application.

## The gotcha that picks for you

A few constraints settle this before architectural taste enters the room.

An application pinned to 12.5.0 stays on that release and its existing terms. Review maintenance needs before choosing a long-lived pin.

**If you only ever call `Send`, you do not need a mediator.** The honest test: open your solution, search for `IPipelineBehavior` and `INotification`. If there are zero behaviors and you do not publish notifications, MediatR is functioning as an indirection layer over method calls, and removing it is a mechanical refactor that makes the code more navigable, removes a dependency, and erases the licensing question in one move. This is the same library-rationalization instinct behind choosing the in-box option in [System.Text.Json vs Newtonsoft.Json in 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

## The call, in one line

For a direct route from a caller to a service, choose explicit injection. Keep MediatR when its shared pipeline or notifications provide value across request types. Once you have chosen services, follow the [step-by-step migration](/2026/05/migrate-from-mediatr-to-plain-dependency-injection/).

## Related

- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/)
- [HttpClient vs HttpClientFactory vs Refit](/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [System.Text.Json vs Newtonsoft.Json in 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)

## Sources

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - the 2025-07-02 launch announcement, the v13.0 boundary, and the dual RPL-1.5 / commercial model.
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - the $5,000,000 revenue and $10,000,000 capital Community thresholds, the "programmatic access" developer count, and the log-only license check.
- [MediatR commercial version launched (Discussion #1123)](https://github.com/LuckyPennySoftware/MediatR/discussions/1123) - confirmation that older versions stay under their original open-source license.
- [LuckyPennySoftware/MediatR v13.0.0 release](https://github.com/LuckyPennySoftware/MediatR/releases/tag/v13.0.0) - the first dual-licensed release.
- [Scrutor on GitHub](https://github.com/khellang/Scrutor) - the MIT-licensed `Decorate` extension used to replace pipeline behaviors with decorators.
