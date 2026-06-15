---
title: "Minimal API validation vs FluentValidation in ASP.NET Core 11: which should you pick?"
description: "Use the built-in source-generated validation for synchronous, attribute-expressible rules in ASP.NET Core 11; reach for FluentValidation when you need async rules, complex cross-field logic, or validation kept out of your domain models."
pubDate: 2026-06-15
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "validation"
---

If you are starting a fresh ASP.NET Core 11 minimal API, use the built-in validation: call `AddValidation()`, annotate your request record with `DataAnnotations`, and a source generator returns a `400 ProblemDetails` before your handler runs, with zero dependencies and Native AOT support. Reach for FluentValidation (currently 12.1.1, Apache 2.0) only when you need something the built-in feature genuinely cannot do: asynchronous rules that hit a database, rich cross-field logic, or validation kept entirely out of your domain models. The decisive axis is async and complex conditional rules. If you need those, FluentValidation wins; if you do not, the in-box feature is the lower-friction choice. Everything below targets .NET 11 with `Microsoft.NET.Sdk.Web` and C# 14; the built-in feature first shipped in .NET 10 and is unchanged in 11.

## The feature matrix

This is the table you came for. Every row reflects .NET 11 and FluentValidation 12.1.1.

| Feature                          | Built-in (`DataAnnotations`)            | FluentValidation 12                       |
| -------------------------------- | --------------------------------------- | ----------------------------------------- |
| Dependency                       | none (in-box, .NET 10+)                 | NuGet package, Apache 2.0                 |
| Mechanism                        | compile-time source generator           | runtime reflection + expression trees     |
| Native AOT / trimming            | friendly (no runtime reflection)        | needs care, partial support               |
| Async rules (DB / HTTP lookups)  | no                                      | yes (`MustAsync`, `ValidateAsync`)        |
| Cross-field rules                | `IValidatableObject` (verbose)          | first-class (`RuleFor(...).When(...)`)    |
| Where rules live                 | on the model, as attributes             | in a separate validator class             |
| Conditional / rule sets          | limited                                 | `When`/`Unless`/`WhenAsync`, rule sets    |
| Auto `400` in a minimal API      | yes, built-in endpoint filter           | manual: you write the endpoint filter     |
| Error response shape             | `ProblemDetails` (RFC 9457) for free    | you map failures to a response yourself   |
| Reusable composite rules         | custom `ValidationAttribute`            | `SetValidator`, rule chaining, inheritance|

The short read: the built-in feature optimizes for "turn it on and forget about it" on simple models, and FluentValidation optimizes for expressive power on complex ones. Neither is strictly better. The rows that flip most decisions are async rules and where the rules live.

## When to pick the built-in validation

The in-box validation, covered step by step in [how to validate request bodies in minimal APIs without controllers](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), is the right default in these cases:

- **Greenfield .NET 11 minimal APIs with synchronous rules.** If your validation is "this field is required, that one is a positive integer, the email looks like an email," `DataAnnotations` expresses all of it and the source generator turns it into a per-endpoint filter for free. No package, no validator classes, no wiring.
- **Native AOT or aggressively trimmed deployments.** The built-in feature was designed around a source generator precisely so it carries no runtime model-graph reflection. That is what makes it safe under trimming and Native AOT, the same reason it ships cleanly with the [Native AOT minimal API stack](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). FluentValidation leans on reflection and compiled expression trees, which need extra care to trim.
- **You want the `400 ProblemDetails` contract handed to you.** Built-in validation returns an `HttpValidationProblemDetails` body keyed by property name, the same RFC 9457 shape MVC produces, with no code from you. With FluentValidation you decide how to translate a `ValidationResult` into an HTTP response, which is flexibility you may not want on a small service.
- **You prefer rules to live on the model.** Attributes keep `[Required]` next to the property it guards. For a team that likes the data and its constraints in one place, that co-location is a feature, not a smell.

## When to pick FluentValidation

FluentValidation 12 earns its dependency when the built-in feature hits a wall:

- **Asynchronous rules.** This is the single biggest reason to reach for it. `DataAnnotations` and `IValidatableObject` are synchronous, so "is this username already taken" or "does this product ID exist in the catalog" cannot be expressed in the built-in feature without leaking data access into a handler. FluentValidation supports `MustAsync` and `WhenAsync`, and you invoke it with `ValidateAsync`. The library is explicit that a validator containing async rules must be called with `ValidateAsync`, never `Validate`, or it throws.
- **Rich cross-field and conditional logic.** "End date after start date" is doable with `IValidatableObject`, but once you have "if `PaymentType` is `Invoice` then `PurchaseOrderNumber` is required, unless the customer is `Internal`," the attribute-plus-`IValidatableObject` approach turns into a tangle of `if` blocks. FluentValidation's `RuleFor(x => x.PurchaseOrderNumber).NotEmpty().When(x => x.PaymentType == PaymentType.Invoice)` reads like the requirement.
- **Validation must stay out of the domain model.** In a clean-architecture or DDD codebase, decorating a domain record with `[Range]` and `[EmailAddress]` couples the model to a presentation concern. FluentValidation keeps every rule in a separate `AbstractValidator<T>` class, so the model stays an attribute-free POCO.
- **Reuse and composition across many request types.** `SetValidator`, validator inheritance, and rule sets let you compose a `MoneyValidator` into every request that carries a price, with a fluency that custom `ValidationAttribute` types do not match once the rule has structure.

## What each one looks like in code

The built-in version is whatever annotations you already know, plus one service registration:

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

An invalid body never reaches the handler. It comes back as a `400` with a `ProblemDetails` payload keyed by `Sku`, `Name`, and `Quantity` automatically.

The FluentValidation equivalent moves the rules into a validator class and, because the in-box auto-validation pipeline is deprecated (more on that below), wires it up through an endpoint filter you call explicitly:

```csharp
// .NET 11, C# 14 -- FluentValidation 12.1.1
using FluentValidation;
using FluentValidation.Results;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<IValidator<CreateProduct>, CreateProductValidator>();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
   .AddEndpointFilter(async (ctx, next) =>
   {
       var product = ctx.GetArgument<CreateProduct>(0);
       var validator = ctx.HttpContext.RequestServices
           .GetRequiredService<IValidator<CreateProduct>>();

       ValidationResult result = await validator.ValidateAsync(product);
       if (!result.IsValid)
           return Results.ValidationProblem(result.ToDictionary());

       return await next(ctx);
   });

public record CreateProduct(string Sku, string Name, int Quantity);

public sealed class CreateProductValidator : AbstractValidator<CreateProduct>
{
    public CreateProductValidator()
    {
        RuleFor(x => x.Sku).NotEmpty().Length(3, 20);
        RuleFor(x => x.Name).NotEmpty().MinimumLength(2);
        RuleFor(x => x.Quantity).InclusiveBetween(1, 10_000);
    }
}
```

That is more code, but it is also where the power lives. Add an async uniqueness check and the built-in feature simply cannot follow:

```csharp
// .NET 11, C# 14 -- FluentValidation 12.1.1
public sealed class CreateProductValidator : AbstractValidator<CreateProduct>
{
    public CreateProductValidator(IProductRepository repo)
    {
        RuleFor(x => x.Sku)
            .NotEmpty()
            .Length(3, 20)
            .MustAsync(async (sku, ct) => !await repo.SkuExistsAsync(sku, ct))
            .WithMessage("A product with this SKU already exists.");
    }
}
```

`MustAsync` hits the database during validation. There is no `DataAnnotations` attribute that does this without you opening a `DbContext` inside the rule, and `IValidatableObject.Validate` is synchronous, so it cannot await anything. This is the wall that sends teams to FluentValidation.

You can factor the endpoint-filter boilerplate into a small generic extension so each endpoint just chains `.WithValidation<CreateProduct>()`. The mechanics of composing filters across a route group are the same ones described in [organizing minimal API endpoints with MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), so a single `MapGroup(...).AddEndpointFilter(...)` can validate an entire group.

## The benchmark: startup, not steady state

The honest performance story here is not request throughput. For a handful of properties, both approaches validate in microseconds and the cost is dwarfed by JSON deserialization and whatever your handler does. The measurable difference is at the edges: cold start and AOT.

Because the built-in feature is generated at compile time, it adds no startup reflection. FluentValidation builds its rule chains with expression trees that compile on first use, so the first validation of each type pays a one-time JIT and expression-compile cost. On a warm server that cost is amortized to nothing. On a [cold-starting serverless function](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) that handles one request and freezes, you pay it on a meaningful fraction of invocations.

The sharper distinction is publishing. A Native AOT minimal API with the built-in validator publishes and runs with no trim warnings, because there is no reflection to preserve. The same app using FluentValidation will surface trimming warnings unless you keep the validated types and their members rooted, since the library reflects over your model and member-access expressions. That is not "FluentValidation is slow," it is "FluentValidation costs you trim-safety work that the in-box feature does not." If your deployment target is AOT, treat that as the deciding factor rather than any nanosecond count. Numbers older than this .NET 11 cycle should be re-measured before you trust them; validation internals moved between .NET 8 and .NET 10.

## The gotcha that picks for you: the deprecated AspNetCore package

If you go looking for FluentValidation's ASP.NET Core integration, you will find the `FluentValidation.AspNetCore` package and its old automatic-validation pipeline. Do not start there. The maintainers deprecated it, and the documentation is explicit: "We no longer recommend using this approach for new projects but it is still available for legacy implementations." It does not run async validators (it throws), it never supported minimal APIs or Blazor, and its implicit behavior is hard to debug. The recommended path in 2026 is the manual one shown above: register `IValidator<T>` in DI and call `ValidateAsync` yourself, from an endpoint filter for minimal APIs or from the handler. If a tutorial tells you to call `AddFluentValidationAutoValidation()`, it predates this guidance.

A second gotcha cuts the other way, in FluentValidation's favor: licensing fear is misplaced here. FluentValidation remains Apache 2.0 and free, including for commercial use. The library that changed to a restrictive paid license in January 2025 was Fluent Assertions, a different project with a confusingly similar name. They are unrelated, and choosing FluentValidation does not expose you to a per-seat fee. If a policy reviewer flags "Fluent*" on your dependency list, that is the distinction to make.

The last one is a correctness trap unique to FluentValidation: if any rule in a validator is async, every call site must use `ValidateAsync`. A stray synchronous `Validate()` on a validator that contains a `MustAsync` rule throws at runtime, not at compile time, so it can pass tests that never exercise that path and fail in production. Standardize on `ValidateAsync` everywhere to avoid the trap entirely.

## The recommendation, restated

Default to the built-in validation in ASP.NET Core 11. It is free, it is AOT-friendly, it hands you a standard `ProblemDetails` contract, and for the synchronous, attribute-shaped rules that make up most request validation it is strictly less work than adding a dependency. Choose FluentValidation deliberately, when you have hit a specific limit: asynchronous rules that need I/O, conditional cross-field logic that `IValidatableObject` makes ugly, or an architectural rule that validation must not touch your domain models. Many real systems end up with both, and that is fine: let the in-box feature guard the simple DTOs and let FluentValidation own the handful of request types with genuinely complex rules. The mistake is reaching for a validation library on a greenfield .NET 11 service out of habit, before you have a rule the framework cannot already express for free.

## Related

- [How to validate request bodies in minimal APIs without controllers in ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) for the full setup of the built-in feature.
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) for the endpoint-model decision that sits underneath this one.
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) for applying a validation filter to a whole route group.
- [Use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) for why a generator-based validator matters under trimming.
- [How to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) for backstopping everything validation does not catch.

## Sources

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0) (built-in minimal API validation, `AddValidation`, source generator, `ProblemDetails`).
- FluentValidation documentation, [ASP.NET Core integration](https://docs.fluentvalidation.net/en/latest/aspnet.html) (deprecation of automatic validation, recommended manual `IValidator<T>` approach).
- FluentValidation documentation, [Asynchronous Validation](https://docs.fluentvalidation.net/en/latest/async.html) (`MustAsync`, `WhenAsync`, the `ValidateAsync` requirement).
- FluentValidation, [Deprecation of the FluentValidation.AspNetCore package (issue #1960)](https://github.com/FluentValidation/FluentValidation/issues/1960).
- NuGet, [FluentValidation 12.1.1](https://www.nuget.org/packages/fluentvalidation/) (current version, Apache 2.0 license).
- DevClass, [Another open source project shifts to restrictive license: Fluent Assertions](https://www.devclass.com/development/2025/01/16/another-open-source-project-shifts-to-restrictive-license-fluent-assertions-following-xceed-partnership/) (the license change was Fluent Assertions, not FluentValidation).
</content>
</invoke>
