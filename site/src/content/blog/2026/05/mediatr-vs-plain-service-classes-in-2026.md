---
title: "MediatR vs plain service classes in 2026: should the license change move you?"
description: "For new code, plain service classes are the better default. MediatR's July 2025 license change matters only if you sit above the $5M Community threshold or refuse the RPL-1.5 copyleft. Keep MediatR when pipeline behaviors are load-bearing."
pubDate: 2026-05-23
template: vs
tags:
  - "comparison"
  - "mediatr"
  - "dependency-injection"
  - "architecture"
  - "dotnet"
  - "dotnet-11"
---

The short version: for new .NET 11 code in 2026, default to **plain service classes** and reach for MediatR only when you actually lean on its pipeline behaviors. The July 2025 license change is a real reason to re-evaluate, but it is not the cliff some people made it out to be. If your company is under $5,000,000 in gross annual revenue you can keep using the latest MediatR for free under the Community edition, so the licensing question only forces a decision for larger teams or for anyone unwilling to accept the RPL-1.5 copyleft on the free open-source license. The technical question (do you need a mediator at all?) is the one that should actually drive the choice, and for most request-dispatch use it is the indirection, not the library, that you can drop.

Versions referenced throughout: MediatR 12.5.0 is the last release under the plain Apache 2.0 license; MediatR 13.0 (released 2025-07-02) and the later 14.x line ship under a dual Reciprocal Public License 1.5 / commercial model from Lucky Penny Software. Code targets `<TargetFramework>net11.0</TargetFramework>` with the .NET 11 SDK and C# 14.

## What actually changed in July 2025

MediatR and AutoMapper were maintained for years by Jimmy Bogard as permissively licensed open source. On 2025-07-02 he moved both to a new company, Lucky Penny Software, and switched the licensing model. The mechanics that matter for your decision:

- **Old versions stay free forever.** MediatR 12.x and earlier remain under Apache 2.0 (MIT for some older artifacts) and are not retroactively relicensed. You can pin `12.5.0` and never pay. The catch is that you get no security updates, no fixes, and no support for that line.
- **New versions are dual-licensed.** MediatR 13.0 and later are offered under the Reciprocal Public License 1.5 (RPL-1.5) for open-source use, or a paid commercial license.
- **There is a free Community edition.** Companies and individuals under $5,000,000 USD gross annual revenue (and who have not taken more than $10,000,000 in outside capital), non-profits under the same budget, educational use, and non-production environments all qualify to use the latest MediatR for free under the commercial agreement's Community tier.
- **Paid tiers are team-sized.** Standard (1-10 developers), Professional (11-50), and Enterprise (unlimited), billed monthly or annually, counting only developers with "programmatic access" who write or compile code that calls MediatR.
- **The license check only logs.** An expired or missing key produces log warnings, not a runtime failure. No feature lockout, no degraded performance, no license server or network call.

So the practical fork is this. Small shop under $5M? You can stay on current MediatR for free, and the only friction is the warning log until you register a Community key. Larger or well-funded? You either pay, accept RPL-1.5's reciprocal obligations, or leave. That third group is exactly who should be reading a "vs plain service classes" comparison.

## The feature matrix at a glance

| Concern | MediatR 13+ | Plain service classes |
| ------- | ----------- | --------------------- |
| Request dispatch | `ISender.Send` indirection | Direct method call on an injected interface |
| Cross-cutting concerns | First-class `IPipelineBehavior<,>` | Decorators (Scrutor) or explicit calls |
| Go-to-definition from caller | Lands on `Send`, not the handler | Lands on the implementation |
| Compile-time wiring safety | Runtime resolution, can fail at first call | Constructor injection, fails at startup |
| Notifications / fan-out | Built-in `INotification` publish | Hand-rolled list of handlers |
| Startup cost | Assembly scanning to register handlers | None beyond normal DI registration |
| Per-call overhead | Wrapper allocation + dictionary lookup + virtual dispatch | Near-zero, JIT can devirtualize |
| Native AOT / trimming | Needs care, reflection-based registration | Clean |
| License (above $5M revenue) | Commercial purchase or RPL-1.5 | None, your own code |
| New code in 2026 | Only if behaviors are load-bearing | The default |

The row that decides most arguments is "cross-cutting concerns." Almost everything else in that table favors plain services. MediatR's genuine, hard-to-replace value is the pipeline: a single place to wrap every request with validation, logging, transactions, and caching. If you do not use that pipeline, you are paying indirection and licensing cost for a glorified service locator.

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

The plain version is shorter, and crucially, pressing go-to-definition on `orders.GetByIdAsync` lands you in the method that runs. With `sender.Send(new GetOrderById(id))` it lands on MediatR's `Send`, and you navigate to the handler by guessing or by a "find implementations" detour. On a small team that difference is mild. On a large codebase with hundreds of handlers, the loss of direct navigability is a real, daily tax that the MediatR model imposes in exchange for decoupling the caller from the handler type. Whether that decoupling buys you anything depends on whether anyone ever swaps a handler without touching the caller, which in practice is rare.

Registration is also worth comparing. MediatR scans assemblies at startup; plain services register explicitly, and you get a startup-time failure (not a first-request failure) if you forget one, which interacts directly with the kind of mistakes behind [Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).

```csharp
// .NET 11, C# 14 - registration, side by side
// MediatR: scan an assembly, register every handler reflectively
builder.Services.AddMediatR(cfg =>
    cfg.RegisterServicesFromAssemblyContaining<GetOrderById>());

// Plain: explicit, trim-friendly, fails fast at startup if a dep is missing
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

Performance is the weakest argument in either direction, and you should not pick on it alone, but it is worth knowing where the cost lives so nobody hand-waves. A plain interface call is a single virtual dispatch that the JIT can often devirtualize and inline; it allocates nothing and costs on the order of a nanosecond. A MediatR `Send` does more work per call: it looks the request type up in a handler cache, constructs or retrieves a `RequestHandlerWrapper`, walks the behavior chain via delegates, and resolves the handler from the container. That is on the order of tens of nanoseconds plus a small allocation per send, before your handler body runs.

| Aspect | MediatR `Send` | Plain interface call |
| ------ | -------------- | -------------------- |
| Type-to-handler resolution | Dictionary lookup per call | None, bound at injection |
| Wrapper / delegate chain | Allocated per send | None |
| Devirtualization by JIT | No | Often yes |
| Startup assembly scan | Yes, grows with handler count | None |
| Order of magnitude per call | Tens of ns + small alloc | ~1 ns, zero alloc |

The methodological honesty here: against a handler that touches a database or the network, tens of nanoseconds is invisible, and you should measure your own object shapes with BenchmarkDotNet rather than trust a generic figure. The cost that does show up in practice is startup. Assembly scanning to register hundreds of handlers adds measurable milliseconds to cold start, which matters for serverless and is the kind of thing you fight when [reducing cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/). Plain explicit registration sidesteps it entirely and is friendlier to trimming and Native AOT, because there is no reflective discovery to keep trim-safe.

## The gotcha that picks for you

A few constraints settle this before architectural taste enters the room.

**The RPL-1.5 is the real forcing function, not the price.** The free open-source option on MediatR 13+ is the Reciprocal Public License 1.5, which carries copyleft, reciprocal obligations: it is designed to close the SaaS loophole, so deploying a network service built on RPL-licensed code can obligate you to make your source available. If you ship closed-source commercial software and you are above the Community threshold, the free OSS license is not actually usable for you, and "MediatR is still open source" is misleading in your case. You either buy the commercial license or you leave. For a thin dispatcher you were not really using, leaving is easy.

**The $5M revenue and $10M capital line is generous.** Most small product teams, consultancies, and startups fall under it and can keep using the newest MediatR for free under the Community edition. If that is you, the license is not a reason to rip anything out; register a Community key, silence the warning, and move on. Spending a sprint removing MediatR to avoid a bill you do not owe is the wrong trade.

**Pinning 12.5.0 is a real option with a real cost.** Apache 2.0 on the last free version does not expire. But you freeze on a version that gets no security patches, and you inherit the maintenance risk yourself. That is fine for a stable internal app and dangerous for anything internet-facing.

**If you only ever call `Send`, you do not need a mediator.** The honest test: open your solution, search for `IPipelineBehavior` and `INotification`. If there are zero behaviors and you do not publish notifications, MediatR is functioning as an indirection layer over method calls, and removing it is a mechanical refactor that makes the code more navigable, removes a dependency, and erases the licensing question in one move. This is the same library-rationalization instinct behind choosing the in-box option in [System.Text.Json vs Newtonsoft.Json in 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/).

## The call, in one line

For new .NET 11 code in 2026, write plain service classes and inject the interfaces directly: you get go-to-definition, fail-fast startup wiring, no per-call overhead, trim-friendliness, and zero licensing exposure. Keep MediatR only when its pipeline behaviors are doing real, uniform work across many request types, and in that case decide deliberately: stay free under the Community edition if you are under $5M, pay if you are above it and the pipeline earns the bill, and pin 12.5.0 only as a stopgap. The mistake is treating "MediatR went commercial" as either a non-event or a five-alarm fire. It is neither. It is a prompt to ask whether you needed the mediator in the first place, and for most request-dispatch code the answer was always no.

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
</content>
</invoke>
