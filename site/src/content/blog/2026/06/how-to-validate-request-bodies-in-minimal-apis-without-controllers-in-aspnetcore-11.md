---
title: "How to validate request bodies in minimal APIs without controllers in ASP.NET Core 11"
description: "ASP.NET Core 11 has built-in validation for minimal APIs: call AddValidation, annotate your request record with DataAnnotations, and a source generator validates the bound model and returns 400 ProblemDetails before your handler runs. No controllers, no FluentValidation, no manual checks."
pubDate: 2026-06-07
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
---

For years the honest answer to "how do I validate a request body in a minimal API" was "you don't, not automatically." Minimal APIs shipped without the `ModelState` machinery that controllers get for free, so you reached for `FluentValidation`, the `MiniValidation` package, or a hand-rolled `if` block in every handler. That changed in .NET 10 and carries forward unchanged in .NET 11: call `builder.Services.AddValidation()`, decorate your request type with the same `System.ComponentModel.DataAnnotations` attributes you already know (`[Required]`, `[Range]`, `[EmailAddress]`), and a source generator emits an endpoint filter that validates the bound model before your handler body runs. Invalid requests come back as a `400 Bad Request` with a `ProblemDetails` body, no `ModelState.IsValid` check, no controller, no extra package. Everything below targets .NET 11 with `Microsoft.NET.Sdk.Web` and C# 14; the feature is identical on .NET 10, where it first shipped.

## Why minimal APIs had no validation to begin with

This was not an oversight, it was a design decision. MVC's model validation runs through a reflection-based pipeline: it walks the model graph at runtime, discovers `ValidationAttribute` instances, invokes them, and populates `ModelState`. That reflection is exactly the kind of startup and per-request cost the minimal API stack was built to avoid, and it is hostile to trimming and Native AOT. So the original minimal API surface bound your parameters and called your handler, full stop. If the body was nonsense, your handler saw the nonsense.

The .NET 10 solution sidesteps the reflection problem with a source generator. At compile time it finds every type used as a minimal API parameter, reads the `DataAnnotations` attributes on those types, and generates the validation code directly. There is no runtime model-graph reflection, which is what makes the feature compatible with the lean, AOT-friendly endpoint model. If you are still weighing the two endpoint styles, the broader trade-offs are in [minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/); this guide assumes you have committed to minimal APIs and want validation back.

## Three steps to turn on validation

1. **Register the services.** Call `builder.Services.AddValidation()` before you build the app. This registers the validation services and the endpoint filter that runs them.
2. **Make sure the source generator is active.** With the .NET 10 or .NET 11 web SDK the validation generator is wired up automatically once you call `AddValidation()`. If your build predates GA or you copied a trimmed `.csproj`, the generator emits interceptors in the `Microsoft.AspNetCore.Http.Validation.Generated` namespace; ensure that namespace is included in `InterceptorsNamespaces` (the SDK does this for you in current builds).
3. **Annotate the request type and make it `public`.** Put `DataAnnotations` attributes on the properties or positional parameters of your request record or class. The type must be `public`, because the generator can only see and generate code for accessible types.

That is the whole setup. Here is the wiring in `Program.cs`:

```csharp
// .NET 11, C# 14 -- Program.cs
using System.ComponentModel.DataAnnotations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddValidation();          // step 1
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(
    [Required, Length(3, 20)] string Sku,
    [Required, MinLength(2)] string Name,
    [Range(1, 10_000)] int Quantity);
```

If the `.csproj` ever needs the property explicitly (older SDKs), it looks like this:

```xml
<!-- only needed if the generator's interceptors are not picked up automatically -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.AspNetCore.Http.Validation.Generated</InterceptorsNamespaces>
</PropertyGroup>
```

## What an invalid request actually returns

POST a body that breaks two rules and you get a machine-readable `400` without writing a single line of error handling:

```bash
# .NET 11
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/json" \
  -d '{"sku":"x","name":"","quantity":0}'
```

```json
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Sku": ["The field Sku must be a string with a minimum length of 3 and a maximum length of 20."],
    "Name": ["The Name field is required."],
    "Quantity": ["The field Quantity must be between 1 and 10000."]
  }
}
```

That payload is an `HttpValidationProblemDetails`, the same RFC 9457 / RFC 7807 shape MVC produces, so existing clients that already parse `errors` keep working. The handler never runs. There is no `ModelState`, no `IsValid` check, nothing to forget. The errors dictionary is keyed by property name, and nested members use a dotted path, which matters once your models stop being flat.

## Nested objects validate recursively

Validation walks into complex properties automatically. A request with an address object validates the address too, and the error keys reflect the path:

```csharp
// .NET 11, C# 14
public record CreateOrder(
    [Required, EmailAddress] string CustomerEmail,
    [Required] BillingAddress Billing);

public record BillingAddress(
    [Required, MinLength(2)] string Street,
    [Required, Length(2, 10)] string PostalCode,
    [Required, RegularExpression("^[A-Z]{2}$")] string CountryCode);
```

Post an order with a bad postal code and the error key is `Billing.PostalCode`, not a flattened `PostalCode`. The generator discovered `BillingAddress` because `CreateOrder` references it; you did not have to register the nested type anywhere. This recursive discovery is the part that makes the feature genuinely useful rather than a toy for single-field bodies.

## When the type is not directly in a handler signature

The generator finds types by looking at minimal API handler parameters and the members reachable from them. If a type is only ever referenced through a base class, an interface, or polymorphism, the generator may not discover it. For those cases, annotate the type itself with `[ValidatableType]` from `Microsoft.AspNetCore.Http.Validation` so the generator is told to emit validation logic for it explicitly:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Http.Validation;
using System.ComponentModel.DataAnnotations;

[ValidatableType]
public abstract record PaymentMethod
{
    [Required, Length(2, 40)] public string Holder { get; init; } = "";
}

public sealed record CardPayment : PaymentMethod
{
    [Required, CreditCard] public string Number { get; init; } = "";
}
```

`[ValidatableType]` is the manual escape hatch: reach for it when validation silently does not fire on a type you expected it to, which almost always means the generator could not reach it from a handler parameter.

## Cross-property rules with IValidatableObject

Attributes validate one member at a time. For rules that span fields ("end date must be after start date", "if the discount is set, the reason is required"), implement `IValidatableObject`. Its `Validate` method runs after the attribute checks and yields `ValidationResult` entries:

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public record DateRange(
    [Required] DateOnly Start,
    [Required] DateOnly End) : IValidatableObject
{
    public IEnumerable<ValidationResult> Validate(ValidationContext context)
    {
        if (End <= Start)
        {
            yield return new ValidationResult(
                "End must be after Start.",
                [nameof(End)]);   // attaches the error to the End member
        }
    }
}
```

The string array you pass as the second argument controls which key the error lands under in the `errors` dictionary. Pass `[nameof(End)]` and the client sees `"End": ["End must be after Start."]`; omit it and the error goes under an empty key as a model-level error. Use the member name so your UI can highlight the right field.

## A custom ValidationAttribute when the built-ins fall short

When neither the built-in attributes nor `IValidatableObject` fit, write a `ValidationAttribute`. The source generator picks up custom attributes the same way it picks up `[Range]`:

```csharp
// .NET 11, C# 14
using System.ComponentModel.DataAnnotations;

public sealed class NotInPastAttribute : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is DateOnly date && date < DateOnly.FromDateTime(DateTime.UtcNow.Date))
        {
            return new ValidationResult(
                ErrorMessage ?? "Date cannot be in the past.",
                [context.MemberName!]);
        }
        return ValidationResult.Success;
    }
}

public record Booking([Required, NotInPast] DateOnly When);
```

Custom attributes keep the rule next to the data and reusable across every endpoint that takes a `Booking`, which is the whole point of attribute-based validation over inline `if` blocks scattered through handlers.

## Query, route, and header parameters validate too

The feature is not limited to the JSON body. Attributes on scalar parameters bound from the route, query string, or headers are validated with the same machinery:

```csharp
// .NET 11, C# 14
app.MapGet("/search",
    ([Range(1, 100)] int pageSize,
     [Required, MinLength(2)] string query) =>
        TypedResults.Ok(new { pageSize, query }));
```

A request to `/search?pageSize=500&query=x` is rejected with a `400` before the handler runs, with `pageSize` and `query` both listed in `errors`. This closes the most common validation gap people hit after the body: paging and filter parameters that previously sailed through unchecked.

## Turning validation off for one endpoint

Sometimes an endpoint takes a type that is validated everywhere else but here you want the raw value, for example an internal admin route that intentionally accepts otherwise-invalid data. Chain `DisableValidation()` on that single endpoint:

```csharp
// .NET 11, C# 14
app.MapPost("/internal/import", (CreateProduct product) =>
        TypedResults.Accepted($"/products/{product.Sku}", product))
    .DisableValidation();
```

This removes the validation filter from that one endpoint without touching the global `AddValidation()` registration, so every other endpoint that uses `CreateProduct` still validates.

## Gotchas worth knowing before you ship

A handful of sharp edges trip people up the first time:

- **The request type must be `public`.** The source generator can only emit code for types it can name. A `record` or `class` declared without `public`, or nested inside another type without the right accessibility, silently gets no validation. If validation "isn't working," check the access modifier first.
- **Positional record parameters: attribute placement matters.** `[Required] string Name` on a positional record parameter is read by the generator, but if you also rely on the attribute being on the generated *property* (for tooling that reflects over it at runtime), use the explicit target: `[property: Required] string Name`. The validation generator itself reads the parameter form, so most code does not need `property:`, but mixing expectations is a common source of confusion.
- **Validation runs as an endpoint filter, so filter order applies.** The validation filter is added per endpoint. If you also add your own `AddEndpointFilter` calls, be aware of where validation sits in the chain. For how filter ordering composes across route groups, see [how to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).
- **This is not a replacement for FluentValidation in every case.** `DataAnnotations` plus `IValidatableObject` covers the large majority of request validation. If you have a rule engine, async rules that hit a database, or a large existing FluentValidation investment, keep it. The built-in feature is for "I just want `[Required]` to actually do something" without a dependency.
- **The handler is skipped on failure, so your `TypedResults` union does not need a `BadRequest` arm for validation.** The `400` is produced by the filter, before your handler returns, so a handler typed as `Results<Created<T>, NotFound>` is fine; validation failures never reach it. The 400 ProblemDetails is generated independently of your declared return types.
- **Resolve-time DI errors are unrelated.** If an endpoint throws while activating a service rather than validating input, that is a different failure entirely; see [Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) for that one.

The mental model to leave with: minimal API validation in .NET 11 is `DataAnnotations` you already know, made automatic by a compile-time source generator and surfaced through a per-endpoint filter that returns standard `ProblemDetails`. You annotate, you call `AddValidation()`, and invalid requests stop at the door. Because it is generator-based rather than reflection-based, it stays out of the way of trimming and Native AOT, which is exactly why it ships [trim-safe with the Native AOT minimal API stack](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). For anything the filter does not catch, a [global exception filter](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) still backstops the rest of the request pipeline.

## Related

- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) for choosing between the two endpoint models in the first place.
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) for where the validation filter sits relative to group filters.
- [Use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) for why a generator-based validator matters under trimming.
- [Add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) for catching everything validation does not.
- [Fix: Unable to resolve service for type while attempting to activate](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) for activation errors that look like, but are not, validation failures.

## Sources

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0) (validation support for minimal APIs, `AddValidation`, `[ValidatableType]`, `DisableValidation`).
- Microsoft Learn, [System.ComponentModel.DataAnnotations namespace](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.dataannotations) (`ValidationAttribute`, `IValidatableObject`, `ValidationResult`).
- Tim Deschryver, [ASP.NET 10: Validating incoming models in Minimal APIs](https://timdeschryver.dev/blog/aspnet-10-validating-incoming-models-in-minimal-apis) (nested object validation, error response shape).
