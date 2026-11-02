---
title: "Minimal API validation vs FluentValidation in ASP.NET Core 11: which should you pick?"
description: "Compare ASP.NET Core built-in Minimal API validation with FluentValidation: asynchronous rules, endpoint filters, version differences and licensing."
pubDate: 2026-06-15
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "validation"
---

ASP.NET Core 10 introduced built-in validation for Minimal APIs through `AddValidation()`. .NET 11 expands it: Preview 6 added Minimal API support for `AsyncValidationAttribute` and `IAsyncValidatableObject`. Asynchronous validation is therefore not, by itself, a reason to require FluentValidation on .NET 11.

**Correction — November 2, 2026:** this comparison now accounts for built-in asynchronous validation in .NET 11. The runnable synchronous examples below were checked with SDK 10.0.302 and FluentValidation 12.1.1; they do not claim .NET 11 execution or benchmark results.

## Built-in validation

For straightforward request constraints, DataAnnotations keep the rules beside the model. In a Web SDK project, register validation and map the endpoint:

```csharp
// Program.cs: Microsoft.NET.Sdk.Web, net10.0 or later.
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

Invalid input produces a 400 validation-problem response before the handler runs. The positional record attributes in this example are supported; the validation generator discovers that metadata. A plain class library that declares models needs the `Microsoft.Extensions.Validation` package and the assembly-specific registration described in the official documentation.

.NET 10's built-in pipeline is synchronous. For .NET 11 asynchronous validation, use the documented async validation APIs and check your exact preview or release version. Availability of asynchronous hooks does not make remote checks free: pass cancellation, bound external calls and enforce uniqueness again where data is committed.

## FluentValidation with an endpoint filter

FluentValidation puts rules in separate validator classes. This can suit shared rule composition, rule sets, conditional rules or a project that already uses its API. Here is an explicit filter for this one endpoint:

```csharp
// Program.cs: add a PackageReference to FluentValidation 12.1.1.
using FluentValidation;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<IValidator<CreateProduct>, CreateProductValidator>();
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
    .AddEndpointFilter(async (context, next) =>
    {
        var product = context.GetArgument<CreateProduct>(0);
        var validator = context.HttpContext.RequestServices
            .GetRequiredService<IValidator<CreateProduct>>();
        var result = await validator.ValidateAsync(
            product, context.HttpContext.RequestAborted);
        if (!result.IsValid)
            return Results.ValidationProblem(result.ToDictionary());
        return await next(context);
    });

app.Run();

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

This filter assumes `CreateProduct` is argument zero. Do not attach it unchanged to a group whose handlers have different signatures. Use `ValidateAsync` when a validator can contain asynchronous rules and pass the request cancellation token. Register services required by those validators in DI.

This is separate from the older `FluentValidation.AspNetCore` MVC automatic-validation integration. That legacy pipeline is synchronous, does not provide Minimal API integration and is no longer recommended for new projects by FluentValidation's documentation. It should not be confused with ASP.NET Core's newer built-in Minimal API validation.

## Choosing and licensing

Choose based on how you maintain and reuse rules, the framework version you deploy and the failure responses your clients need. Built-in validation is a reasonable starting point for a small DataAnnotations model; FluentValidation can offer a useful organization and composition model. Neither choice guarantees better performance or automatic Native AOT compatibility for every custom validator and dependency. Check the actual publish output and deployed behavior.

FluentValidation 12.1.1, used here, is licensed under Apache License 2.0. FluentAssertions is a separate project; news about its licensing does not establish FluentValidation's license. Check the license of the exact dependency version you ship.

For endpoint organization, see [route groups with MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Sources

- [ASP.NET Core validation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/validation?view=aspnetcore-11.0)
- [.NET 11: asynchronous Minimal API validation](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11?view=aspnetcore-11.0#async-validation-for-minimal-apis)
- [FluentValidation: ASP.NET Core integration](https://docs.fluentvalidation.net/en/latest/aspnet.html)
- [FluentValidation: asynchronous rules](https://docs.fluentvalidation.net/en/latest/async.html)
- [FluentValidation 12.1.1 license](https://github.com/FluentValidation/FluentValidation/blob/12.1.1/License.txt)
