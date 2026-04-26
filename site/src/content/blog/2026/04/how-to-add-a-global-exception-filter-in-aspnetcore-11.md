---
title: "How to add a global exception filter in ASP.NET Core 11"
description: "A complete guide to global exception handling in ASP.NET Core 11: why IExceptionFilter is the wrong tool, how IExceptionHandler and UseExceptionHandler work together, ProblemDetails responses, multi-handler chains, and the .NET 10 diagnostics suppression breaking change."
pubDate: 2026-04-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "error-handling"
---

To catch every unhandled exception in an ASP.NET Core 11 app and turn it into a clean HTTP response, implement `IExceptionHandler`, register it with `services.AddExceptionHandler<T>()`, and place `app.UseExceptionHandler()` early in the middleware pipeline. The old MVC `IExceptionFilter` only fires for controller actions, so it misses minimal-API endpoints, middleware exceptions, model-binding failures, and anything thrown before MVC runs. The handler-based approach replaces it across the whole pipeline, integrates with `ProblemDetails` for RFC 7807 responses, and works the same way on Native AOT, minimal APIs, and controllers. Everything in this guide targets .NET 11 (preview 3) with `Microsoft.NET.Sdk.Web` and C# 14, but the API has been stable since .NET 8 and the patterns apply unchanged on .NET 9 and .NET 10.

## "Exception filter" is the search term, but you almost never want one

When developers ask how to add a "global exception filter", the search-engine ranked result is usually a 2017 Stack Overflow answer that points to `IExceptionFilter` and `MvcOptions.Filters.Add<T>`. That code still compiles and still runs, but it has not been the right answer since ASP.NET Core 8.

`IExceptionFilter` lives in `Microsoft.AspNetCore.Mvc.Filters`. It is part of the MVC pipeline, which means three things:

1. It only catches exceptions thrown inside an MVC action, an MVC filter, or a result executor. Anything thrown earlier in the pipeline, model binding errors, authentication failures, routing 404s, never reaches it.
2. It does not see exceptions from minimal API endpoints (`app.MapGet("/", ...)`). Minimal APIs do not run through `MvcRoutedActionInvoker`, so MVC filters are silent for them.
3. It runs after model binding has already produced a `ModelState` error, so a malformed request body returns a 400 from the framework before your filter ever sees the exception you wanted to translate.

The modern equivalent is `IExceptionHandler`, introduced in `Microsoft.AspNetCore.Diagnostics` 8.0 and unchanged in .NET 11. It runs from inside the `UseExceptionHandler` middleware, which sits at the very top of the pipeline, so a single handler covers controllers, minimal APIs, gRPC, SignalR negotiation, static files, and middleware-thrown exceptions in one place. That is what people mean when they say "global".

The rest of this guide is the `IExceptionHandler` path. The last section covers the few cases where an MVC filter is still the correct tool.

## The minimal IExceptionHandler

`IExceptionHandler` is a one-method interface:

```csharp
// .NET 11, C# 14
namespace Microsoft.AspNetCore.Diagnostics;

public interface IExceptionHandler
{
    ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken);
}
```

Return `true` if you wrote the response and want the middleware to stop. Return `false` to fall through to the next handler in the chain (or, if none handle it, the framework's default error response).

A working "translate every exception into a 500 with a JSON body" handler is about 30 lines:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

internal sealed class GlobalExceptionHandler(
    ILogger<GlobalExceptionHandler> logger,
    IProblemDetailsService problemDetailsService) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        logger.LogError(exception, "Unhandled exception on {Path}", httpContext.Request.Path);

        httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;

        return await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.6.1",
                Title = "An unexpected error occurred",
                Status = StatusCodes.Status500InternalServerError,
            },
        });
    }
}
```

Two details matter here. First, the handler is `sealed` and uses primary constructor injection, which is the C# 12+ idiom. Second, we delegate the actual response body to `IProblemDetailsService` instead of calling `httpContext.Response.WriteAsJsonAsync(...)` ourselves. That single change is what makes the response respect the client's `Accept` header, the registered `IProblemDetailsWriter` set, and any `CustomizeProblemDetails` callback you have configured. We come back to that in the ProblemDetails section.

## Wiring the handler into Program.cs

Three lines add the handler. The middleware order matters:

```csharp
// .NET 11, C# 14, Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();

var app = builder.Build();

app.UseExceptionHandler();   // must come before UseAuthorization, MapControllers, etc.
app.UseStatusCodePages();    // optional, formats 4xx the same way

app.MapControllers();
app.Run();
```

`AddExceptionHandler<T>` registers the handler as a singleton, which is enforced by the framework. If your handler needs scoped services (a `DbContext`, a request-scoped logger), inject `IServiceProvider` and create a scope per call rather than taking the scoped service in the constructor:

```csharp
// .NET 11, C# 14
internal sealed class DbBackedExceptionHandler(IServiceScopeFactory scopes) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AuditDbContext>();
        db.Failures.Add(new FailureRecord(ctx.TraceIdentifier, ex.GetType().FullName!));
        await db.SaveChangesAsync(ct);
        return false; // let another handler write the response
    }
}
```

`UseExceptionHandler()` with no arguments uses the registered `IExceptionHandler` chain. The overload that takes a `string` path or an `Action<IApplicationBuilder>` is the older middleware-only model and bypasses the handler chain. Pick one or the other, not both.

## ProblemDetails for free, when you wire it up

`AddProblemDetails()` registers the default `IProblemDetailsService` and one `IProblemDetailsWriter` for `application/problem+json`. Once it is registered, three things happen automatically:

1. `UseExceptionHandler()` writes a `ProblemDetails` body for unhandled exceptions when no `IExceptionHandler` claims the response.
2. `UseStatusCodePages()` writes a `ProblemDetails` body for 4xx responses with no body.
3. Your own handler can call `problemDetailsService.TryWriteAsync(...)` to get the same content negotiation and customization for free.

The most useful customization point is `CustomizeProblemDetails`, which runs after your handler builds the object and before it is written. A typical site adds the trace identifier so support can correlate a user-visible error to a log entry:

```csharp
// .NET 11, C# 14
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        ctx.ProblemDetails.Extensions["traceId"] = ctx.HttpContext.TraceIdentifier;
        ctx.ProblemDetails.Extensions["requestId"] =
            Activity.Current?.Id ?? ctx.HttpContext.TraceIdentifier;
    };
});
```

Do not put exception messages or stack traces in the response in production. They leak internal structure (table names, file paths, third-party API URLs) that an attacker can chain into a more targeted probe. Gate any `ex.Message` echoing on `IHostEnvironment.IsDevelopment()`.

## Multiple handlers, ordered by exception type

The exception middleware iterates registered handlers in registration order until one returns `true`. That is the right place to put per-exception-type translation:

```csharp
// .NET 11, C# 14
internal sealed class ValidationExceptionHandler(IProblemDetailsService pds) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        if (ex is not FluentValidation.ValidationException ve) return false;

        ctx.Response.StatusCode = StatusCodes.Status400BadRequest;

        var errors = ve.Errors
            .GroupBy(e => e.PropertyName)
            .ToDictionary(g => g.Key, g => g.Select(e => e.ErrorMessage).ToArray());

        return await pds.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = ctx,
            Exception = ex,
            ProblemDetails = new HttpValidationProblemDetails(errors)
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.5.1",
                Title = "One or more validation errors occurred",
                Status = StatusCodes.Status400BadRequest,
            },
        });
    }
}

internal sealed class NotFoundExceptionHandler(IProblemDetailsService pds) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        if (ex is not EntityNotFoundException) return false;

        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return await pds.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = ctx,
            Exception = ex,
            ProblemDetails = new ProblemDetails
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.5.5",
                Title = "Resource not found",
                Status = StatusCodes.Status404NotFound,
            },
        });
    }
}
```

Register them in priority order. The catch-all 500 handler goes last:

```csharp
// .NET 11, C# 14
builder.Services.AddExceptionHandler<ValidationExceptionHandler>();
builder.Services.AddExceptionHandler<NotFoundExceptionHandler>();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();
```

The middleware iterates singletons in this exact order. If `ValidationExceptionHandler` returns `false`, the next handler is asked. If `GlobalExceptionHandler` returns `true`, no further handlers run.

Resist the urge to write one mega-handler with a giant `switch`. Per-exception handlers are easier to unit-test (each is a small class taking one fake), easier to delete when an exception type goes away, and easier to wire conditionally (e.g. only register `ValidationExceptionHandler` when FluentValidation is in the project).

## Middleware order that breaks the handler

The single most common mistake is putting `UseExceptionHandler()` in the wrong place. The rule is: it must come before any middleware that might throw an exception you want to catch. In practice that means it should be the very first non-environment middleware.

```csharp
// Wrong: a NullReferenceException from authentication never reaches the handler.
app.UseAuthentication();
app.UseAuthorization();
app.UseExceptionHandler();   // too late
app.MapControllers();

// Right: the handler wraps everything that follows.
app.UseExceptionHandler();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
```

The one thing that legitimately runs before `UseExceptionHandler` is the developer exception page in non-production:

```csharp
// .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
}
else
{
    app.UseExceptionHandler();
    app.UseHsts();
}
```

If you register both, the developer page wins in dev because it short-circuits the request before the handler middleware runs. You typically want this: the dev page shows the stack trace and source snippet, which is the whole reason for running locally.

## The .NET 10 diagnostics suppression breaking change

In .NET 8 and 9, `UseExceptionHandler` always logged the unhandled exception at `Error` level and emitted the `Microsoft.AspNetCore.Diagnostics.HandlerException` activity, regardless of whether your `IExceptionHandler` returned `true`. That made it easy to double-log: your handler logged, and so did the framework.

Starting in .NET 10 (and preserved in .NET 11), the framework suppresses its own diagnostics for any exception that a handler claimed by returning `true`. Your handler is now solely responsible for logging that case. Exceptions that fall through unhandled still emit the framework log.

This is a behaviour change you can hit silently. If you have a Grafana alert on `aspnetcore.diagnostics.handler.unhandled_exceptions` and you upgrade to .NET 10 or later, the metric drops to zero for handled exceptions and your dashboard goes flat. The fix is either:

```csharp
// Opt back in to the .NET 8/9 behaviour.
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    SuppressDiagnosticsCallback = _ => false,
});
```

Or, preferred, delete the dashboard and rely on the logging your handler does. Double counting was always a bug.

The callback receives an `ExceptionHandlerDiagnosticsContext` with the exception, the request, and a flag for whether a handler claimed the response, so you can suppress selectively, for example, do not log `OperationCanceledException` from a request the client aborted:

```csharp
// .NET 11, C# 14
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    SuppressDiagnosticsCallback = ctx =>
        ctx.Exception is OperationCanceledException &&
        ctx.HttpContext.RequestAborted.IsCancellationRequested,
});
```

See the [Microsoft Learn breaking change note](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/exception-handler-diagnostics-suppressed) for the exact semantics.

## When IExceptionFilter is still the right tool

There are two narrow cases where the MVC `IExceptionFilter` is still correct:

1. You want to translate an exception only for a specific controller or action, and you want the filter discoverable in the action attributes. `[TypeFilter(typeof(MyExceptionFilter))]` on the controller class scopes the behaviour without polluting the global pipeline. This is more of an action filter for one weird endpoint than a real "global" thing.
2. You need access to the MVC `ActionContext` (e.g. the `IModelMetadataProvider` for the action's parameters). `IExceptionHandler` only sees `HttpContext`, so this metadata is not available there.

Outside of those, `IExceptionHandler` wins. It works for minimal APIs, it runs before MVC, and it composes cleanly with multiple registered handlers. Treat the MVC filter as an action-scoped tool, not a global one.

## A common mistake: throwing inside a custom IProblemDetailsWriter

If you implement a custom `IProblemDetailsWriter` (for example, to emit a vendor-specific error envelope), do not throw out of `WriteAsync`. The exception middleware catches that exception too, recurses back into the same handler chain, and you get either a stack overflow or, if you are lucky, an empty 500 with no body. Wrap the body-writing logic in a try/catch and return `false` from `CanWrite` if the writer is in a bad state. The same rule applies to handler code: do not throw from inside `TryHandleAsync`. Return `false` instead.

A safe shape:

```csharp
// .NET 11, C# 14
public async ValueTask<bool> TryHandleAsync(
    HttpContext ctx, Exception ex, CancellationToken ct)
{
    try
    {
        ctx.Response.StatusCode = MapStatus(ex);
        await pds.TryWriteAsync(BuildContext(ctx, ex));
        return true;
    }
    catch
    {
        return false; // let the framework default kick in
    }
}
```

## Related

- [Custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) for serializing the `ProblemDetails.Extensions` dictionary the way your clients expect.
- [Streaming a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) covers another middleware-order subtlety in the same pipeline.
- [Cancel a long-running Task without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) for the `OperationCanceledException` patterns the diagnostics callback above relies on.
- [Generate strongly-typed clients from an OpenAPI spec in .NET 11](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) if you publish the `ProblemDetails` schema to consumers.

## Sources

- Microsoft Learn, [Handle errors in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling?view=aspnetcore-10.0).
- Microsoft Learn, [Handle errors in ASP.NET Core APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling-api?view=aspnetcore-10.0).
- Microsoft Learn breaking change, [Exception diagnostics are suppressed when IExceptionHandler.TryHandleAsync returns true](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/exception-handler-diagnostics-suppressed).
- ASP.NET Core release notes, [.NET 10 preview 7 ASP.NET Core](https://github.com/dotnet/core/blob/main/release-notes/10.0/preview/preview7/aspnetcore.md).
- GitHub discussion, [IExceptionHandler in .NET 8 for global exception handling](https://github.com/dotnet/aspnetcore/discussions/54613).
