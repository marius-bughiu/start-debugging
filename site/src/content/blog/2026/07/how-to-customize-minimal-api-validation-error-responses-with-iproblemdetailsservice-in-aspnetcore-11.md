---
title: "How to customize minimal API validation error responses with IProblemDetailsService in ASP.NET Core 11"
description: "Call AddProblemDetails with a CustomizeProblemDetails callback to reshape the 400 that built-in minimal API validation returns in ASP.NET Core 11: add a traceId, rewrite the title, switch 400 to 422, or take full control with a custom IProblemDetailsWriter."
pubDate: 2026-07-03
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
  - "validation"
---

Built-in minimal API validation gives you a `400 Bad Request` with an `HttpValidationProblemDetails` body for free, but the shape it returns is the framework default: an RFC 9457 payload with `type`, `title`, `status`, and an `errors` dictionary. If you need a `traceId` for support tickets, a different `title`, a link to your error docs, or a `422 Unprocessable Entity` instead of `400`, the hook is `AddProblemDetails(options => options.CustomizeProblemDetails = ...)`. Register it, and the same callback fires for validation failures, unhandled exceptions, and status-code pages alike, so every error your API emits carries the same fields. This is the piece that was missing in the early .NET 10 previews and is wired up in .NET 10 GA and .NET 11: the built-in validation filter now routes its problem details through `IProblemDetailsService`, so your customization actually reaches validation errors. Everything below targets .NET 11 with `Microsoft.NET.Sdk.Web` and C# 14; the behavior is identical on .NET 10 GA.

## What the default validation response looks like

Start from the setup covered in [how to validate request bodies in minimal APIs without controllers](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/): call `AddValidation()`, annotate a request record, and let the source generator do the work.

```csharp
// .NET 11, C# 14 -- Program.cs
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

POST an invalid body and you get the stock payload:

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."]
  }
}
```

That is correct and machine-readable, but it says nothing about your service. There is no correlation ID to paste into a bug report, the `type` points at the RFC rather than your own error catalog, and clients that treat `422` as "semantically invalid, do not retry" get a `400` they cannot distinguish from a malformed request. Customization fixes all of that in one place.

## Turn on the customization hook

`AddProblemDetails()` registers the default `IProblemDetailsService`, and its overload takes a `ProblemDetailsOptions` configuration where you set `CustomizeProblemDetails`. That property is a delegate receiving a `ProblemDetailsContext`, which exposes both the `HttpContext` and the mutable `ProblemDetails` about to be written.

1. **Register problem details with the callback.** Call `builder.Services.AddProblemDetails(options => options.CustomizeProblemDetails = ctx => { ... })` before `builder.Build()`.
2. **Keep `AddValidation()` too.** The two services are independent: `AddValidation()` produces the `400`, `AddProblemDetails()` customizes the body it carries.
3. **Mutate `ctx.ProblemDetails` inside the callback.** Add to `Extensions`, rewrite `Title`, `Type`, or `Detail`, or change `Status`.

Here is the wiring that adds a correlation ID and a support pointer to every validation error:

```csharp
// .NET 11, C# 14 -- Program.cs
using System.Diagnostics;
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        // Correlate with distributed tracing; fall back to the request id.
        ctx.ProblemDetails.Extensions["traceId"] =
            Activity.Current?.Id ?? ctx.HttpContext.TraceIdentifier;

        if (ctx.ProblemDetails.Status == StatusCodes.Status400BadRequest)
        {
            ctx.ProblemDetails.Title = "Your request failed validation.";
            ctx.ProblemDetails.Type = "https://api.example.com/errors/validation";
            ctx.ProblemDetails.Extensions["support"] = "support@example.com";
        }
    };
});
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

The same invalid POST now returns:

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://api.example.com/errors/validation",
  "title": "Your request failed validation.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."]
  },
  "traceId": "00-2f0e...-b7ad...-01",
  "support": "support@example.com"
}
```

The `errors` dictionary is untouched, so existing clients keep parsing it. You added fields, you did not break the contract. Note the `traceId`: pull it from `Activity.Current?.Id` rather than a fresh `Guid.NewGuid()`, because that value is the actual W3C trace id flowing through your logs and OpenTelemetry spans. A random GUID looks like a trace id but correlates with nothing. Falling back to `HttpContext.TraceIdentifier` covers requests that arrive without a trace context.

## Why the callback reaches every error, not just validation

The reason to prefer `CustomizeProblemDetails` over hand-editing each endpoint is coverage. When `AddProblemDetails()` is registered, the callback runs for problem details produced by the framework's error machinery: the `ExceptionHandlerMiddleware`, the `StatusCodePagesMiddleware`, the developer exception page, and, since .NET 10 GA, the built-in minimal API validation filter. One callback, and your `traceId` lands on a `400` from validation, a `404` from an unmatched route, and a `500` from an unhandled exception. That consistency is the entire point of the problem details contract: a client should be able to read `traceId` off any error your API returns without special-casing which layer produced it.

To get the `404` and `500` cases as well as validation, register the two middleware that fill empty error responses:

```csharp
// .NET 11, C# 14
app.UseExceptionHandler();   // turns unhandled exceptions into ProblemDetails
app.UseStatusCodePages();    // fills empty 4xx/5xx responses with ProblemDetails
app.Run();
```

Without these, a bare `Results.NotFound()` or an unmatched route returns an empty body, because problem details are generated only "for responses that do not have body content yet." Validation is the exception that does not need this wiring: the validation filter itself calls into `IProblemDetailsService`, so its `400` is customized whether or not you add `UseStatusCodePages()`. If you also want your global backstop to catch what validation does not, the mechanics of the exception path are covered in [how to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/).

## Return 422 instead of 400 for validation

A common API-design choice is to distinguish "I could not parse your request" (`400`) from "I parsed it but it violates the rules" (`422 Unprocessable Entity`). Since the callback can mutate `Status`, and the middleware writes the status from the `ProblemDetails`, you can promote validation failures to `422` in one place:

```csharp
// .NET 11, C# 14
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        // Built-in validation always produces a 400 with an errors dictionary.
        if (ctx.ProblemDetails.Status == StatusCodes.Status400BadRequest
            && ctx.ProblemDetails.Extensions.ContainsKey("errors"))
        {
            ctx.ProblemDetails.Status = StatusCodes.Status422UnprocessableEntity;
            ctx.HttpContext.Response.StatusCode =
                StatusCodes.Status422UnprocessableEntity;
        }
    };
});
```

Set both the `ProblemDetails.Status` field (what appears in the JSON body) and `HttpContext.Response.StatusCode` (the actual HTTP status line). Miss the second and you ship a body claiming `422` on an HTTP `400` response, which is worse than either alone. The `errors` key check narrows the rewrite to validation failures specifically, so a plain `400` from elsewhere in your app keeps its status.

## Take full control with a custom IProblemDetailsWriter

`CustomizeProblemDetails` mutates the object; it does not control serialization or decide when to write. For that, implement `IProblemDetailsWriter`. A writer gets a `CanWrite` gate and a `WriteAsync` that owns the response body, which lets you branch on status code, content negotiation, or endpoint metadata:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http;

public sealed class ValidationProblemDetailsWriter : IProblemDetailsWriter
{
    public bool CanWrite(ProblemDetailsContext context)
        => context.ProblemDetails.Status is 400 or 422;

    public ValueTask WriteAsync(ProblemDetailsContext context)
    {
        context.ProblemDetails.Extensions["apiVersion"] = "2026-07";
        return new ValueTask(
            context.HttpContext.Response.WriteAsJsonAsync(
                context.ProblemDetails,
                context.ProblemDetails.GetType(),
                options: null,
                contentType: "application/problem+json"));
    }
}
```

Register it in DI, and register it before `AddControllers()` or `AddRazorPages()` if you use either, because those register their own writers and order decides which one wins:

```csharp
// .NET 11, C# 14
builder.Services.AddTransient<IProblemDetailsWriter, ValidationProblemDetailsWriter>();
```

Reach for a writer only when the callback is not enough: different serialization for different clients, XML alongside JSON, or emitting a completely different schema for one status code. For adding fields and tweaking text, `CustomizeProblemDetails` is less code and less to get wrong.

## Customizing one endpoint instead of the whole app

Everything above is global. When you want a single endpoint's validation response shaped differently, return the problem details yourself from the handler with `TypedResults.ValidationProblem`, which accepts an `extensions` dictionary directly:

```csharp
// .NET 11, C# 14
app.MapPost("/legacy/products", (CreateProduct product) =>
{
    var errors = new Dictionary<string, string[]>();
    if (product.Quantity <= 0)
        errors["Quantity"] = ["Quantity must be positive on the legacy endpoint."];

    if (errors.Count > 0)
        return TypedResults.ValidationProblem(
            errors,
            extensions: new Dictionary<string, object?>
            {
                ["legacy"] = true
            });

    return TypedResults.Created($"/products/{product.Sku}", product);
});
```

There is a sharp edge here worth stating plainly: a `ProblemDetails` you construct and return directly from a handler, whether through `TypedResults.ValidationProblem`, `Results.Problem`, or `TypedResults.Problem`, is serialized straight to the response and does **not** pass through `IProblemDetailsService`. Your global `CustomizeProblemDetails` callback will not run for it, so the `traceId` you added centrally will be missing. If you mix global customization with handler-returned problems, either add the shared fields in the handler too or keep validation on the built-in filter, which does route through the service. This is the single most common surprise: the callback covers framework-generated problem details, not the ones you new up yourself.

## Gotchas that bite in production

- **The `Accept` header controls whether you get JSON at all.** The `DefaultProblemDetailsWriter` writes for `application/json`, `application/problem+json`, and wildcards like `*/*` and `application/*`. A client sending `Accept: text/html` or `application/xml` triggers the fallback path and gets no problem details body. If your consumers are browsers or SOAP clients, account for this rather than assuming the JSON always ships.
- **`CustomizeProblemDetails` was not called for validation in early .NET 10 previews.** This was tracked as [dotnet/aspnetcore#62723](https://github.com/dotnet/aspnetcore/issues/62723): the validation filter bypassed `IProblemDetailsService`. It is wired through the service in .NET 10 GA and .NET 11. If your callback fires for exceptions but silently skips validation errors, you are on a stale preview SDK; update it.
- **Order matters when you also use controllers.** MVC produces validation problem details through `ProblemDetailsFactory` and `InvalidModelStateResponseFactory`, not through `CustomizeProblemDetails` alone. A mixed app with both minimal API endpoints and controllers needs both paths configured, or your controllers and your minimal APIs will disagree on error shape.
- **Do not leak internals into `Detail`.** It is tempting to stuff an exception message into `ProblemDetails.Detail` inside the callback. In production that exposes stack-trace fragments and internal type names. Keep `Detail` client-safe and put the diagnostic information behind your `traceId` in the logs instead.
- **The callback runs on the hot path of every error.** Keep it cheap. Reading `Activity.Current` and setting dictionary keys is fine; opening a database connection or calling a remote service inside `CustomizeProblemDetails` is not, because it runs synchronously while writing the response.

The model to keep: `AddValidation()` decides what is invalid, `AddProblemDetails()` decides how the invalidity is described, and `CustomizeProblemDetails` is the one place to shape that description for every framework-generated error at once. Add your `traceId` there, rewrite the `title` there, promote to `422` there, and reach for a custom `IProblemDetailsWriter` only when you need to own serialization. For anything the validation filter does not catch, the [global exception filter](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) carries the same customization through, and if you are still deciding whether the built-in validator covers your rules at all, [minimal API validation vs FluentValidation](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) draws that line.

## Related

- [How to validate request bodies in minimal APIs without controllers in ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) for the `AddValidation()` setup this post customizes.
- [Minimal API validation vs FluentValidation in ASP.NET Core 11](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) for whether the built-in validator fits your rules before you customize its output.
- [How to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) for catching what validation does not, with the same `ProblemDetails` shape.
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) for applying validation and its problem details across a whole route group.
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) for how error handling differs between the two endpoint models.

## Sources

- Microsoft Learn, [Handle errors in ASP.NET Core APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling-api?view=aspnetcore-10.0) (`AddProblemDetails`, the middleware that generate problem details, `CustomizeProblemDetails`, `IProblemDetailsService` fallback and supported media types).
- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0) (customizing minimal API validation error responses with `IProblemDetailsService`, `TypedResults.ValidationProblem`).
- Microsoft Learn, [ProblemDetailsOptions.CustomizeProblemDetails](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.problemdetailsoptions.customizeproblemdetails) (callback signature and `ProblemDetailsContext`).
- dotnet/aspnetcore, [CustomizeProblemDetails not invoked for minimal API validation (issue #62723)](https://github.com/dotnet/aspnetcore/issues/62723) (the preview-era gap, resolved for .NET 10 GA).
</content>
</invoke>
