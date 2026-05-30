---
title: "Migrate from MediatR to plain dependency injection in .NET 11"
description: "A step-by-step checklist to remove MediatR 12-14 and replace IRequest handlers, ISender, pipeline behaviors, and INotification with plain service classes and constructor injection."
pubDate: 2026-05-30
updatedDate: 2026-05-30
template: migration
tags:
  - "migration"
  - "mediatr"
  - "dependency-injection"
  - "dotnet"
  - "dotnet-11"
---

Removing MediatR from a .NET 11 codebase is a mechanical refactor, not a rewrite. For a typical service with 50-150 handlers, budget half a day to a day: most handlers collapse one-to-one into methods on plain service classes, `ISender.Send` calls become direct interface calls, and the only part that needs design thought is the pipeline. What breaks is anything that relied on runtime handler resolution or `IPipelineBehavior<,>` wrapping every request; those become constructor injection and decorators. It is worth doing if you only ever call `Send`, if you are above MediatR's $5,000,000 Community-edition revenue line and do not want to buy a commercial license, or if you want Native AOT and trim-friendliness. It is not worth doing if your pipeline behaviors are load-bearing across hundreds of request types.

Versions referenced: this guide covers removing MediatR 12.5.0 (the last Apache 2.0 release), 13.0 (released 2025-07-02, the first dual Reciprocal Public License 1.5 / commercial release from Lucky Penny Software), and the current 14.x line. The replacement code targets `<TargetFramework>net11.0</TargetFramework>` with the .NET 11 SDK and C# 14, plus Scrutor 6.x for decorators. If you are still deciding *whether* to leave, read [MediatR vs plain service classes in 2026](/2026/05/mediatr-vs-plain-service-classes-in-2026/) first; this post assumes the decision is made.

## Why teams are removing MediatR specifically now

- **The license forces a decision above $5M.** MediatR 13+ free open-source use is under the RPL-1.5, a reciprocal copyleft license designed to close the SaaS loophole. If you ship closed-source commercial software above the Community revenue threshold, that license is not usable for you, so it is buy-or-leave.
- **Go-to-definition lands on the handler, not on `Send`.** Direct interface calls restore navigability that the mediator indirection costs you on every jump.
- **Startup gets cheaper and AOT gets easier.** Removing assembly scanning for handler registration cuts cold-start milliseconds and removes the reflection that fights trimming, which matters when [reducing cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).
- **Wiring fails at startup, not at first request.** Explicit `AddScoped` registration turns a missing dependency into a boot-time error instead of a runtime `InvalidOperationException`.

## What breaks

| Area | Change | Severity |
| --- | --- | --- |
| `ISender` / `IMediator` injection | Replaced by the concrete service interface injected directly | high |
| `IRequest<T>` + `IRequestHandler<,>` | Collapse into one interface + implementation method | high |
| `IPipelineBehavior<,>` | No generic wrap point; replaced per interface by decorators or by middleware | high |
| `INotification` + `INotificationHandler<>` | Replaced by an injected `IEnumerable<IHandler>` fan-out or an event aggregator | medium |
| `AddMediatR(...)` registration | Replaced by explicit `AddScoped` calls (or one Scrutor scan) | medium |
| `RequestHandlerDelegate<T>` in behaviors | No equivalent; the "next" chain is gone | medium |
| `ISender.CreateStream` (`IStreamRequest`) | Replaced by a method returning `IAsyncEnumerable<T>` | low |
| Unit tests mocking `ISender` | Re-pointed to mock the concrete interface | low |

## Pre-flight checklist

- The .NET 11 SDK is installed: confirm with `dotnet --version` (expect `11.x`).
- You have a clean git branch and a green test suite *before* you start. Verify with `dotnet test` and confirm zero failures.
- Inventory the surface area. Run a search and record the counts, because they tell you how big the job is:

```bash
# .NET 11 - inventory MediatR usage before touching anything
grep -rn "IRequestHandler\|IRequest<\|: IRequest" src/      # handlers + requests
grep -rn "IPipelineBehavior" src/                            # the hard part
grep -rn "INotification" src/                                # fan-out
grep -rn "ISender\|IMediator\|\.Send(\|\.Publish(" src/      # call sites
```

- Decide the replacement shape for behaviors *first*. If you have zero `IPipelineBehavior` hits, this is a pure find-and-replace. If you have several, plan whether each becomes a decorator, ASP.NET Core middleware, or an endpoint filter.
- Add Scrutor if you will use decorators: `dotnet add package Scrutor` (6.x, MIT licensed).

## Migration steps

1. **Convert each request and handler into a service interface and method.**

A MediatR request is a message type plus a separate handler. Replace both with one interface and one implementation. Group related requests onto a single service rather than creating one interface per old request.

```csharp
// .NET 11, C# 14, MediatR 14.x - BEFORE
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
```

```csharp
// .NET 11, C# 14 - AFTER: plain service, no MediatR reference
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
```

**Verify:** the new file has no `using MediatR;` and the handler body is byte-identical apart from the method signature. The request `record` parameters become method parameters in the same order.

2. **Replace `ISender.Send` call sites with direct interface calls.**

Every caller that injected `ISender` or `IMediator` now injects the specific service interface and calls the method.

```csharp
// .NET 11, C# 14 - BEFORE
public async Task<OrderDto> Get(int id, ISender sender, CancellationToken ct)
    => await sender.Send(new GetOrderById(id), ct);

// AFTER
public async Task<OrderDto> Get(int id, IOrderService orders, CancellationToken ct)
    => await orders.GetByIdAsync(id, ct);
```

**Verify:** after this step, `grep -rn "ISender\|IMediator" src/` returns only lines you have deliberately not migrated yet. The count should march toward zero.

3. **Register the services explicitly.**

Delete `AddMediatR(...)` and register each service. Explicit registration is trim-safe and fails fast at startup, which is exactly the failure mode behind [Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).

```csharp
// .NET 11, C# 14 - BEFORE
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// AFTER - explicit, or one Scrutor scan if you prefer convention
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddScoped<ICustomerService, CustomerService>();
```

If you want convention-based registration without MediatR's reflection model, Scrutor scans by interface naming:

```csharp
// .NET 11, C# 14, Scrutor 6.x - register every *Service against its interface
builder.Services.Scan(scan => scan
    .FromAssemblyOf<OrderService>()
    .AddClasses(c => c.Where(t => t.Name.EndsWith("Service")))
    .AsImplementedInterfaces()
    .WithScopedLifetime());
```

**Verify:** the app boots. Run it and hit one migrated endpoint; a missing registration now throws at startup, not on first request. Confirm no scoped-from-singleton mistakes have crept in, the class of bug covered in [Cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

4. **Replace pipeline behaviors with decorators or middleware.**

This is the only step that needs judgment. A `IPipelineBehavior<,>` wrapped every request in one place. You have two honest replacements.

For concerns that are genuinely per-service (logging, caching, retries), use a Scrutor decorator:

```csharp
// .NET 11, C# 14, Scrutor 6.x - BEFORE was a generic ValidationBehavior<TRequest,TResponse>
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

// Registration: wrap the real implementation
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.Decorate<IOrderService, LoggingOrderService>();
```

For concerns that are really HTTP concerns (request logging, exception-to-ProblemDetails mapping, auth), move them out of the application layer entirely into ASP.NET Core middleware or an endpoint filter. A behavior that caught exceptions and shaped responses belongs in the same place as [a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/), not in a decorator.

If you used FluentValidation inside a `ValidationBehavior`, keep the validators and call them from a single decorator or from a minimal-API endpoint filter:

```csharp
// .NET 11, C# 14 - a validation decorator replacing ValidationBehavior for one interface
public sealed class ValidatingOrderService(
    IOrderService inner,
    IValidator<CreateOrder> validator) : IOrderService
{
    public async Task<OrderDto> CreateAsync(CreateOrder cmd, CancellationToken ct)
    {
        await validator.ValidateAndThrowAsync(cmd, ct);
        return await inner.CreateAsync(cmd, ct);
    }

    public Task<OrderDto> GetByIdAsync(int orderId, CancellationToken ct)
        => inner.GetByIdAsync(orderId, ct);
}
```

**Verify:** write or keep a test that asserts the cross-cutting concern still runs, for example that an invalid command throws `ValidationException` before touching the database. Run `dotnet test` and confirm the behavior tests pass.

5. **Replace `INotification` fan-out.**

MediatR's `Publish` invoked every `INotificationHandler<T>`. Replace it with an injected `IEnumerable<T>` of a small handler interface you define, and a thin publisher.

```csharp
// .NET 11, C# 14 - BEFORE: INotification + handlers, AFTER: explicit fan-out
public interface IOrderPlacedHandler
{
    Task HandleAsync(OrderPlaced evt, CancellationToken ct);
}

public sealed class OrderEventPublisher(IEnumerable<IOrderPlacedHandler> handlers)
{
    public async Task PublishAsync(OrderPlaced evt, CancellationToken ct)
    {
        foreach (var handler in handlers)
            await handler.HandleAsync(evt, ct);
    }
}

// Registration - each handler registered against the interface
builder.Services.AddScoped<IOrderPlacedHandler, SendConfirmationEmail>();
builder.Services.AddScoped<IOrderPlacedHandler, UpdateInventory>();
builder.Services.AddScoped<OrderEventPublisher>();
```

The container hands you every registered handler in `IEnumerable<IOrderPlacedHandler>`, so adding a handler is one registration line, the same ergonomics MediatR gave you. If you publish many event types, generate the publisher with a generic `IEventPublisher<T>` instead of one per event.

**Verify:** assert that publishing an event invokes all registered handlers. A test with two fake handlers that both record a call is enough.

6. **Remove the package and the last references.**

Once the call sites are gone, drop the dependency.

```bash
# .NET 11 - remove the package from every project that referenced it
dotnet remove package MediatR
grep -rn "MediatR" src/ || echo "clean"
```

**Verify:** `grep -rn "MediatR" src/` prints `clean`. The build has no unresolved `using MediatR;` and `dotnet build -c Release` succeeds with zero warnings about a missing package.

## Verification: the smoke test after the migration

Run this checklist top to bottom and do not skip the perf line:

- `dotnet build -c Release` succeeds with no warnings.
- `dotnet test` passes with zero failures, including the behavior and fan-out tests you added in steps 4 and 5.
- The app starts and every previously MediatR-dispatched endpoint returns the same response it did before. A missing registration now surfaces here, at startup.
- `grep -rn "MediatR" src/` returns nothing.
- No license warning appears in the logs (the MediatR 13+ license check logged a warning on an unregistered key; it should now be gone).
- Cold start is the same or better. If the app is serverless, measure boot time before and after; removing assembly scanning should not regress it.

## Rollback plan

This migration is reversible per commit but tedious to undo wholesale, so stage it. Keep each of the six steps as a separate commit, and migrate one vertical slice (one service interface and its callers) at a time rather than the whole solution at once. MediatR and plain services can coexist during the transition: leave `AddMediatR` registered for the un-migrated handlers while you convert the rest. If a slice misbehaves, revert that slice's commits and the rest of the app is unaffected. There is no data or schema change here, so rollback is purely a code revert with no migration to reverse.

## Gotchas we hit

**`IPipelineBehavior` order does not map cleanly to decorators.** MediatR runs behaviors in registration order around one handler. Scrutor decorators nest in the order you call `Decorate`, and the *last* registered decorator is the *outermost* wrapper. Get the order wrong and your logging decorator runs inside your validation decorator instead of around it. Write one ordering test per decorated interface.

**`ISender` inside a handler calling another handler becomes a direct service call, and that can expose a cycle.** MediatR's indirection hid handler-to-handler dependencies. When `OrderService` injects `ICustomerService` and `CustomerService` injects `IOrderService`, the container throws at startup with a circular dependency. That is the migration surfacing a design problem MediatR was masking; break the cycle by extracting the shared logic into a third service.

**Streaming requests need `IAsyncEnumerable<T>`, not `Task<T>`.** If you used `IStreamRequest<T>` and `CreateStream`, the replacement method returns `IAsyncEnumerable<T>` and uses `yield return`. Do not collapse it into a `Task<List<T>>`; that changes the streaming semantics and can blow memory on large results, the same trap described in [reading a large CSV in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/).

**Tests that mocked `ISender` silently pass against nothing.** A test that set up `sender.Send(...)` to return a value will compile-error once `ISender` is gone, which is good. But a test that injected a real `IMediator` and asserted behavior through it needs re-pointing at the concrete interface. Re-run the full suite, do not trust a green build alone.

This is the kind of dependency rationalization that pays off the same way choosing the in-box serializer does in [System.Text.Json vs Newtonsoft.Json in 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/): one fewer third-party library on the hot path, one fewer licensing question, and code that a new teammate can navigate without learning a dispatch convention first.

## Related

- [MediatR vs plain service classes in 2026: should the license change move you?](/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [Migrate from Newtonsoft.Json to System.Text.Json in a large codebase](/2026/05/migrate-from-newtonsoft-json-to-system-text-json-in-a-large-codebase/)
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [Fix: Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)
- [Fix: Cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/)

## Sources

- [AutoMapper and MediatR Commercial Editions Launch Today](https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/) - the 2025-07-02 relicensing, the v13.0 boundary, and the dual RPL-1.5 / commercial model.
- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - the $5,000,000 revenue and $10,000,000 capital Community thresholds and the log-only license check.
- [LuckyPennySoftware/MediatR on GitHub](https://github.com/LuckyPennySoftware/MediatR) - current 14.x source, the `IPipelineBehavior` and `INotification` contracts being replaced.
- [Scrutor on GitHub](https://github.com/khellang/Scrutor) - the MIT-licensed `Decorate` and `Scan` extensions used to replace behaviors and convention-register services.
- [Dependency injection in .NET - Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection) - service lifetimes and `IEnumerable<T>` resolution used for the notification fan-out.
