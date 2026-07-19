---
title: "How to add an endpoint filter to a minimal API in ASP.NET Core 11"
description: "A complete, working guide to endpoint filters in an ASP.NET Core 11 minimal API: AddEndpointFilter with an inline delegate, IEndpointFilter classes with DI, GetArgument and the Arguments list, short-circuiting with Results.Problem, FIFO/FILO ordering across multiple filters, group-level filters on MapGroup, and AddEndpointFilterFactory for signature-aware filters."
pubDate: 2026-07-19
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "validation"
---

To add an endpoint filter to a minimal API in ASP.NET Core 11 you call `.AddEndpointFilter()` on the endpoint (or the route group) and pass either an inline `async (context, next) => ...` delegate or a class that implements `IEndpointFilter`. The filter runs after model binding and before your handler, it sees the bound arguments through `context.GetArgument<T>(index)`, and it either calls `await next(context)` to continue or returns a value like `Results.Problem(...)` to short-circuit the request. That is the whole model. This post walks it end to end: the inline form, the class form with dependency injection, ordering when you stack several filters, applying one filter to a whole `MapGroup`, and the filter-factory escape hatch. It targets .NET 11 (Preview 6 at the time of writing, GA in November 2026) with `Microsoft.NET.Sdk.Web` and C# 14, but endpoint filters have been stable since ASP.NET Core 7, so every example here runs unchanged on .NET 8, 9, and 10.

## What an endpoint filter actually wraps

An endpoint filter is a piece of code that wraps the invocation of a single route handler. Unlike middleware, which runs for every request that flows through that point in the pipeline whether a route matched or not, a filter runs only when its endpoint is selected. And unlike middleware, a filter runs after routing and after parameter binding, so by the time it executes, the framework has already parsed the route values, bound the request body, and resolved the handler's arguments. That timing is the entire reason filters exist: you get to inspect and even mutate the exact arguments your handler is about to receive, and you get to inspect or replace the result it produced, all without touching the handler itself.

Concretely, a filter can do three things:

- Run code before the handler (validate arguments, log, start a stopwatch).
- Short-circuit: return a result instead of calling the handler at all.
- Run code after the handler, including inspecting or replacing its return value.

That maps cleanly onto validation, per-endpoint logging, request-shaping, and lightweight cross-cutting concerns that do not deserve their own middleware.

## Steps to add an endpoint filter

1. Register your services and build the app as usual with `WebApplication.CreateBuilder(args)`.
2. Map an endpoint with `MapGet`, `MapPost`, or a `MapGroup`.
3. Chain `.AddEndpointFilter(...)` onto the returned builder, passing an inline delegate or an `IEndpointFilter` type.
4. Inside the filter, read arguments with `context.GetArgument<T>(index)` and decide whether to continue.
5. Call `await next(context)` to run the handler, or return a value (for example `Results.Problem(...)`) to short-circuit.

The rest of this article expands each of those into working code.

## The inline delegate form

The fastest way to add a filter is an inline delegate. It takes two parameters: the `EndpointFilterInvocationContext` (which exposes `HttpContext` and the bound `Arguments`) and `next`, an `EndpointFilterDelegate` you invoke to continue the pipeline.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

string ColorName(string color) => $"Color specified: {color}";

app.MapGet("/color/{color}", ColorName)
    .AddEndpointFilter(async (context, next) =>
    {
        var color = context.GetArgument<string>(0);

        if (color == "Red")
        {
            // Short-circuit: the handler never runs.
            return Results.Problem("Red is not allowed.");
        }

        // Continue to the next filter, or the handler if this is the last one.
        return await next(context);
    });

app.Run();
```

`context.GetArgument<string>(0)` pulls the first argument passed to `ColorName`, which is `color`. The index is positional: it matches the order the parameters appear in the handler's declaration, not the order of route template segments. If you would rather not count positions, `context.Arguments` is an `IList<object?>` you can iterate, and `GetArguments()` returns the same list.

The return type of a filter is `ValueTask<object?>`. Returning `Results.Problem(...)` (or any `IResult`) short-circuits and that result is written to the response. Returning `await next(context)` runs the handler and passes its result back up the chain. Because the return value flows back through every filter, you can also transform it on the way out.

## The IEndpointFilter class form, with DI

Inline delegates are perfect for one-off logic, but a filter you want to reuse across endpoints belongs in a class. Implement `IEndpointFilter`, which has a single method:

```csharp
// .NET 11, C# 14
public class ValidationFilter<T> : IEndpointFilter where T : class
{
    private readonly ILogger<ValidationFilter<T>> _logger;

    public ValidationFilter(ILogger<ValidationFilter<T>> logger)
    {
        _logger = logger;
    }

    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var model = context.Arguments.OfType<T>().FirstOrDefault();

        if (model is null)
        {
            return Results.Problem($"No {typeof(T).Name} argument found.");
        }

        var errors = Validate(model);
        if (errors.Count > 0)
        {
            _logger.LogWarning("Validation failed for {Type}", typeof(T).Name);
            return Results.ValidationProblem(errors);
        }

        return await next(context);
    }

    private static Dictionary<string, string[]> Validate(T model) => new();
}
```

Register it with the generic overload:

```csharp
// .NET 11, C# 14
app.MapPost("/products", (Product product) => Results.Created($"/products/{product.Id}", product))
    .AddEndpointFilter<ValidationFilter<Product>>();
```

Two things about how this class is constructed matter. First, the filter's constructor dependencies (`ILogger<T>` above) are resolved from the DI container, so you can inject loggers, options, or any registered service. Second, and this catches people out: the filter type itself is not resolved as a service. You do not register `ValidationFilter<Product>` in `builder.Services`. The framework activates it for you and satisfies its constructor from DI, but it is not a DI-managed singleton or scoped service. If you try `builder.Services.AddScoped<ValidationFilter<Product>>()` expecting `AddEndpointFilter<T>()` to pull from the container, that registration is simply ignored.

Using `Results.ValidationProblem` here produces an RFC 9457 problem-details body with a `422`-style errors dictionary. If you want to control that shape centrally rather than per filter, that is exactly what an [IProblemDetailsService setup](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) is for.

## When you stack filters, order is FIFO in and FILO out

You can attach more than one filter to an endpoint, and the ordering is the single most confusing part of the feature until you have seen it once. The rule: code before `next` runs in the order you registered the filters (first in, first out); code after `next` runs in reverse (first in, last out). It nests like a stack.

```csharp
// .NET 11, C# 14
app.MapGet("/demo", () =>
    {
        app.Logger.LogInformation("        Handler");
        return "done";
    })
    .AddEndpointFilter(async (context, next) =>
    {
        app.Logger.LogInformation("Before A");
        var result = await next(context);
        app.Logger.LogInformation("After A");
        return result;
    })
    .AddEndpointFilter(async (context, next) =>
    {
        app.Logger.LogInformation("    Before B");
        var result = await next(context);
        app.Logger.LogInformation("    After B");
        return result;
    });
```

That logs:

```dotnetcli
Before A
    Before B
        Handler
    After B
After A
```

So the first filter you add is the outermost wrapper. If you want an authentication-style gate to run before a logging filter, add the gate first. If a filter short-circuits by returning without calling `next`, every filter registered after it is skipped, and the ones before it still get their after-`next` code because their `await next(context)` returns the short-circuit result. This is why an early validation filter can safely reject a request: everything downstream, including the handler, never runs.

## Mutating arguments before the handler sees them

Because a filter runs after binding, it can change the arguments in place and the handler receives the modified values. The `Arguments` list is mutable. This is genuinely useful for normalization: trim strings, uppercase a code, clamp a page size.

```csharp
// .NET 11, C# 14
app.MapGet("/search", (string q, int pageSize) => new { q, pageSize })
    .AddEndpointFilter(async (context, next) =>
    {
        // Normalize the query and clamp the page size before the handler runs.
        if (context.Arguments[0] is string q)
        {
            context.Arguments[0] = q.Trim();
        }
        if (context.Arguments[1] is int size)
        {
            context.Arguments[1] = Math.Clamp(size, 1, 100);
        }

        return await next(context);
    });
```

Keep a caution in mind: mutating by positional index couples the filter to the handler's parameter order. A generic reusable filter is better off matching by type (`context.Arguments.OfType<T>()`) or reading from `HttpContext` directly, which is what makes the class-based `ValidationFilter<T>` above endpoint-agnostic.

## Apply one filter to a whole route group

Repeating `.AddEndpointFilter<...>()` on every endpoint is noise. Because `MapGroup` returns a `RouteGroupBuilder` that carries conventions to its children, a filter added to the group runs for every endpoint inside it. This composes with the per-resource endpoint modules from [organizing minimal API endpoints with MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/):

```csharp
// .NET 11, C# 14
var products = app.MapGroup("/products")
    .AddEndpointFilter<ValidationFilter<Product>>();

products.MapPost("/", (Product p) => Results.Created($"/products/{p.Id}", p));
products.MapPut("/{id:int}", (int id, Product p) => Results.NoContent());
```

Group filters and endpoint filters combine, and the ordering follows the same nesting rule with the group's filters on the outside. A filter on the group wraps a filter added to an individual endpoint within it. You can also nest groups, and each level adds another layer.

If you want a filter to apply to the entire application rather than a named group, add it to a group that covers the root: `app.MapGroup("").AddEndpointFilter(...)`. There is no separate "global filter" registration, but a root group is the idiomatic equivalent, and it keeps filters scoped to routed endpoints rather than turning them into middleware.

## The factory form for signature-aware filters

`AddEndpointFilterFactory` is the advanced door. Instead of a filter instance, you provide a factory that runs once per endpoint at startup, receives an `EndpointFilterFactoryContext` with the handler's `MethodInfo`, and returns the actual filter delegate. This lets you inspect the handler's signature and build a specialized filter, or cache reflection results so they are computed once rather than per request.

```csharp
// .NET 11, C# 14 -- only attach the validation logic when the handler takes a Product first
app.MapPost("/products", (Product product) =>
        Results.Created($"/products/{product.Id}", product))
    .AddEndpointFilterFactory((factoryContext, next) =>
    {
        var parameters = factoryContext.MethodInfo.GetParameters();
        var isProductFirst = parameters.Length >= 1
            && parameters[0].ParameterType == typeof(Product);

        if (!isProductFirst)
        {
            // Pass-through: no per-request cost for endpoints that do not match.
            return context => next(context);
        }

        return async context =>
        {
            var product = context.GetArgument<Product>(0);
            if (string.IsNullOrWhiteSpace(product.Name))
            {
                return Results.Problem("Name is required.");
            }
            return await next(context);
        };
    });
```

The win here is that the `MethodInfo` inspection happens once at build time, not on every request, and endpoints whose signature does not match pay nothing beyond a delegate pass-through. Reach for the factory only when a plain filter cannot express what you need; for the common validate-and-continue case, the class form is simpler and reads better.

## Filters are not middleware, and not action filters

Two comparisons clear up most of the remaining confusion. Against middleware: an endpoint filter runs only for its endpoint and only after binding, so it can see typed arguments; middleware runs for a whole branch of the pipeline and only sees the raw `HttpContext`. If your logic needs the bound model, it wants a filter. If it needs to run before routing or across many unrelated endpoints, it wants middleware. Against MVC action filters (`IActionFilter`, `IAsyncActionFilter`): endpoint filters are the minimal-API equivalent, but they are a different type in a different namespace. You cannot reuse an MVC action filter on a minimal API endpoint. The one bridge Microsoft provides is that `AddEndpointFilter` also works on a controller's `ControllerActionEndpointConventionBuilder`, so a single endpoint-filter delegate can be shared across both minimal API endpoints and controller actions if you route both.

One more practical note: because a filter can short-circuit with an `IResult`, it pairs naturally with typed results. If your handler returns a [typed Results union](/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/), a filter that returns `Results.Problem` still slots in cleanly, since the filter's return type is `object?` and any `IResult` is written to the response. And for genuinely heavyweight validation, weigh a filter against the [built-in request validation](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) that ASP.NET Core 11 can run from data annotations without any filter at all.

## The shape to remember

Adding an endpoint filter comes down to `.AddEndpointFilter(...)` on an endpoint or a `MapGroup`, an inline delegate for one-offs or an `IEndpointFilter` class for reuse, `context.GetArgument<T>(index)` (or `context.Arguments`) to read the bound values, and `await next(context)` to continue versus returning an `IResult` to short-circuit. Remember that constructor dependencies come from DI but the filter type itself is not a registered service, that stacked filters nest FIFO going in and FILO coming out, that group filters wrap endpoint filters, and that `AddEndpointFilterFactory` exists for the rare case where you need to inspect the handler's signature. That is the complete surface, and every line above runs on .NET 8 through .NET 11 unchanged.

## Related

- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [How to validate request bodies in minimal APIs without controllers in ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)
- [How to customize minimal API validation error responses with IProblemDetailsService in ASP.NET Core 11](/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)
- [How to return a typed Results union from a minimal API endpoint in ASP.NET Core 11](/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/)
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Sources

- [Filters in Minimal API apps (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters)
- [IEndpointFilter interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.iendpointfilter)
- [EndpointFilterInvocationContext (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.endpointfilterinvocationcontext)
- [RouteHandlerBuilderExtensions.AddEndpointFilter (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.endpointfilterextensions)
