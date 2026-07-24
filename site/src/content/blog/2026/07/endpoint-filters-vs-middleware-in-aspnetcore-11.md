---
title: "Endpoint filters vs middleware in ASP.NET Core 11: which should you use?"
description: "A decision guide for ASP.NET Core 11: middleware runs for every request before your handler binds, endpoint filters run only for the matched endpoint after binding and can see the typed arguments. Includes a feature matrix, when-to-pick-each scenarios, the ordering rules, and the gotchas that force the choice."
pubDate: 2026-07-24
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
---

Reach for middleware when the logic must run for every request, before or independent of which endpoint matched: exception handling, CORS, authentication, response compression, static files, forwarded headers. Reach for an endpoint filter when the logic needs the bound handler arguments, or should apply to only some endpoints: input validation, argument normalization, per-endpoint auditing. The single sharpest test: if your code needs the typed model the handler is about to receive, it wants a filter, because a filter runs after model binding and can read `context.GetArgument<T>(index)`. If it needs to run whether or not a route matched, it wants middleware, because middleware runs before routing resolves an endpoint. Everything below is the detail behind that call. This targets .NET 11 (Preview 6 at the time of writing, GA in November 2026) with `Microsoft.NET.Sdk.Web` and C# 14, but both features have been stable since ASP.NET Core 7, so every example here runs unchanged on .NET 8, 9, and 10.

## The feature matrix

This is the table you came for. Read it top to bottom and the decision usually makes itself.

| Feature                          | Endpoint filter                          | Middleware                               |
| -------------------------------- | ---------------------------------------- | ---------------------------------------- |
| Runs for                         | only the matched endpoint                | every request on that pipeline branch    |
| Position relative to routing     | after routing and model binding          | before, at, or after routing (placement) |
| Sees handler arguments           | yes, typed via `GetArgument<T>(index)`   | no, only the raw `HttpContext`           |
| Can mutate the bound arguments   | yes, `context.Arguments` is mutable      | no, binding has not happened yet          |
| Short-circuit mechanism          | return an `IResult` instead of `next`    | do not call `next(context)`              |
| Scope control                    | per endpoint or per `MapGroup`           | per app, or per branch via `Map`/`UseWhen` |
| Registration                     | `.AddEndpointFilter(...)`                | `app.Use(...)` / `app.UseMiddleware<T>()` |
| Return type                      | `ValueTask<object?>`                     | `Task`                                   |
| Runs when no endpoint matched    | never                                    | yes, if placed before endpoint execution |
| Reusable on MVC controllers      | yes, on controller endpoints too         | yes, pipeline-wide                       |

The rows that actually decide the choice are the first three. Middleware sits in the request pipeline and every request flowing through that segment executes it, even a request that will 404 because no endpoint matched. An endpoint filter is bound to a specific route handler and only runs when that handler is selected, which happens after `UseRouting` has matched the request and after the framework has bound the route values, query string, and request body into the handler's parameters. That timing difference is the whole story.

## What middleware sees, and when

Middleware is a chain of components, each of which receives the `HttpContext` and a `next` delegate. You register them in `Program.cs` in order, and the order is the behavior: requests flow top to bottom, responses flow back bottom to top.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.Use(async (context, next) =>
{
    // Runs for EVERY request, including ones that will 404.
    var sw = System.Diagnostics.Stopwatch.StartNew();
    await next(context);
    sw.Stop();
    app.Logger.LogInformation(
        "{Method} {Path} -> {Status} in {Elapsed}ms",
        context.Request.Method, context.Request.Path,
        context.Response.StatusCode, sw.ElapsedMilliseconds);
});

app.MapGet("/hello/{name}", (string name) => $"Hi {name}");

app.Run();
```

That timing middleware measures the whole request, including routing and any 404. It only has access to `context.Request.Path` as a string. It cannot see that `name` bound to `"world"`, because at the point the outer middleware runs, binding has not happened yet. Middleware operates one level below your handler's type system.

Placement relative to `UseRouting` matters more than people expect. In the modern minimal hosting model, `WebApplication` inserts routing automatically, but you can call `app.UseRouting()` explicitly to control where the split happens. Middleware registered before routing runs before an endpoint is even selected. Middleware registered after `UseRouting` can read the selected endpoint's metadata through `context.GetEndpoint()`, which is how `UseAuthorization` knows which policy to enforce. This is why the canonical order is `UseRouting`, then `UseAuthentication`, then `UseAuthorization`, then endpoint execution: authorization needs the endpoint metadata that routing produced.

## What an endpoint filter sees, and when

An endpoint filter wraps the invocation of a single route handler. It runs after routing and after binding, so it has the one thing middleware cannot get: the actual, typed arguments your handler is about to receive.

```csharp
// .NET 11, C# 14
app.MapPost("/orders", (Order order) => Results.Created($"/orders/{order.Id}", order))
    .AddEndpointFilter(async (context, next) =>
    {
        // The Order is already bound. Middleware could never see this.
        var order = context.GetArgument<Order>(0);
        if (order.Quantity < 1)
        {
            return Results.Problem("Quantity must be at least 1.");
        }
        return await next(context);
    });
```

The filter's return type is `ValueTask<object?>`. Returning any `IResult` (like `Results.Problem`) short-circuits and writes that result to the response without ever calling the handler. Returning `await next(context)` runs the handler and passes its result back up the chain, so a filter can also transform the response on the way out. Because the filter sees the bound `Order`, validation lives naturally here. A middleware component trying to do the same job would have to re-read and re-deserialize the request body itself, duplicating work the framework already did. The full mechanics of `AddEndpointFilter`, the class-based `IEndpointFilter` form, and filter ordering are covered in [how to add an endpoint filter to a minimal API](/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/); this post is about when to choose it over middleware in the first place.

## When to pick middleware

- **The concern is global and route-agnostic.** Exception handling (`UseExceptionHandler`), HTTPS redirection, HSTS, CORS, response compression, static files, and forwarded-headers processing all need to run for every request regardless of which endpoint (if any) matches. A filter cannot express "run for everything," because a filter is attached to endpoints, and a 404 has no endpoint. Response compression in particular belongs in the pipeline, as covered in [adding response compression to an ASP.NET Core 11 API](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/).
- **You need to run before routing.** Rewriting the path, stripping a prefix, or rejecting a request before the router even looks at it is inherently a middleware job. Endpoint filters run after the route is matched, so they are too late to influence routing.
- **You are catching exceptions across the whole app.** `UseExceptionHandler` and developer exception pages wrap the entire downstream pipeline. A filter only wraps its one endpoint, so an exception thrown during routing or in another middleware never reaches it. Global error handling is a pipeline concern, which is also why a [global exception filter setup](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) is registered at the app level rather than per endpoint.
- **The logic must see requests that will 404.** Metrics, request logging, and rate limiting frequently need to count or throttle requests that never match an endpoint. Middleware sees those; filters do not.

## When to pick an endpoint filter

- **You need the bound arguments.** Validating a `Product`, checking that a `page` query parameter is in range, or normalizing a string all require the typed value. `context.GetArgument<T>(index)` and the mutable `context.Arguments` list give you exactly that, and there is no equivalent in middleware.
- **The concern applies to some endpoints, not all.** A filter attaches to a single endpoint or, via `MapGroup`, to a group of them. If your validation only makes sense for `POST /products` and `PUT /products/{id}`, a group filter scopes it precisely without polluting the global pipeline. This composes with the per-resource modules described in [organizing minimal API endpoints with MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).
- **You want to inspect or rewrite the handler's result.** Because the filter's return value flows back through the chain, it can wrap a successful result in an envelope, add caching hints, or translate a domain result into an `IResult`. Middleware can only manipulate the raw response stream, which is far clumsier once the handler has started writing.
- **You want the same logic on minimal APIs and controllers.** `AddEndpointFilter` also works on a controller's endpoint convention builder, so one filter delegate can guard both a minimal endpoint and an MVC action that share a route.

## The one place performance actually enters the decision

It is tempting to reach for a filter "because middleware runs for everything and that is wasteful." Resist framing it as a throughput contest. Both features are thin: a filter is a `ValueTask<object?>`-returning delegate, and a middleware component is a `Task`-returning delegate, and the per-invocation overhead of either is negligible next to any real handler that touches a database or serializes JSON. The meaningful difference is not cost per call, it is how many calls happen. A middleware component placed early in the pipeline executes on every request, so expensive work there (a database lookup, a large allocation) is paid by every 404 and every health-check ping. The same work in an endpoint filter runs only when that endpoint is selected. So the performance rule is not "filters are faster," it is "scope the work to where it is needed." If a cross-cutting concern genuinely applies to every route, middleware is the correct and not-slower home for it. If it applies to a handful of endpoints, a filter avoids running it on the thousands of requests that will never touch those endpoints. That is a scoping decision dressed up as a performance one, and it is the honest version of the claim.

## The gotchas that pick for you

A few hard constraints override preference entirely.

**A filter cannot run before routing, ever.** If your requirement is "reject the request before the router sees it" or "rewrite the URL," a filter is physically incapable of it, because it lives inside endpoint execution, which is downstream of routing. This forces middleware.

**Middleware cannot see the bound model without redoing the work.** If your requirement is "validate the deserialized request body," middleware would have to buffer and deserialize the body itself, then the framework deserializes it again for the handler. That double-bind is a strong signal you wanted a filter. This forces a filter.

**Exceptions escape a filter's scope.** A filter only wraps its endpoint, so it cannot be your app-wide safety net. If you put your only exception handling in a filter, an exception thrown in another middleware, or during routing, sails past it and hits the default 500 handler. Global error handling forces middleware.

**Ordering models differ, and mixing them confuses people.** Middleware nests by registration order in `Program.cs`. Filters nest by the order you chain `.AddEndpointFilter` calls: first-in runs its pre-`next` code first and its post-`next` code last. When you stack both, the entire filter chain for an endpoint runs inside the innermost point of the middleware pipeline, after `UseRouting`, `UseAuthentication`, and `UseAuthorization` have all executed. So authorization always runs before any endpoint filter, which is usually what you want, but it means a filter is the wrong place to implement an authentication scheme. Authentication forces middleware.

**Terminal behavior is opposite.** A middleware component that does not call `next` short-circuits by simply not continuing. A filter short-circuits by returning an `IResult`. If you write a filter and forget to return something on the short-circuit path, you get a compile error or a null result rather than a silently swallowed request, which is a small but real ergonomic win for filters.

## The recommendation, restated

Default to this: cross-cutting concerns that must run for every request, or before routing, are middleware. Concerns that need the typed handler arguments, or that apply to a subset of endpoints, are endpoint filters. Authentication, CORS, exception handling, compression, and static files are middleware and always will be. Validation, argument normalization, per-endpoint auditing, and result-shaping are endpoint filters. The gray-zone case is per-endpoint authorization logic: if it only needs claims from `HttpContext.User`, either works, but prefer a filter so the policy lives next to the endpoint it guards; if it needs the bound arguments to make the decision (row-level access checks on a bound entity id), it must be a filter. When you genuinely cannot decide, ask the one question that resolves almost every case: does this code need to see the arguments my handler will receive? Yes means filter. No, and it must run regardless of the route, means middleware.

## Related

- [How to add an endpoint filter to a minimal API in ASP.NET Core 11](/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/)
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [How to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)
- [How to add response compression to an ASP.NET Core 11 API](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Sources

- [Filters in Minimal API apps (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/min-api-filters)
- [ASP.NET Core Middleware (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/)
- [ASP.NET Core Middleware order (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/#middleware-order)
- [IEndpointFilter interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.iendpointfilter)
