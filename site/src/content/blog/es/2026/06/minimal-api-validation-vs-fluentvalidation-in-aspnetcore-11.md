---
title: "Validación de minimal API vs FluentValidation en ASP.NET Core 11: ¿cuál deberías elegir?"
description: "Compara la validación integrada de Minimal APIs con FluentValidation: reglas asíncronas, filtros de endpoints, versiones y licencia."
pubDate: 2026-06-15
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "validation"
lang: "es"
translationOf: "2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-15
---

ASP.NET Core 10 introdujo la validación integrada de Minimal APIs mediante `AddValidation()`. .NET 11 la amplía: Preview 6 incorporó soporte para `AsyncValidationAttribute` e `IAsyncValidatableObject` en Minimal APIs. Por tanto, necesitar reglas asíncronas no basta, por sí solo, para exigir FluentValidation en .NET 11.

**Corrección — 2 de noviembre de 2026:** la comparación contempla ahora la validación asíncrona integrada de .NET 11. Los ejemplos síncronos siguientes se comprobaron con SDK 10.0.302 y FluentValidation 12.1.1. No se afirma haberlos ejecutado en .NET 11 ni haber medido su rendimiento.

## Validación integrada

DataAnnotations permite mantener restricciones sencillas junto al modelo. En un proyecto con Web SDK, registra la validación y asigna el endpoint:

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

Los datos inválidos producen una respuesta 400 de problemas de validación antes de ejecutar el handler. El generador admite los atributos de los parámetros de este record posicional. Una biblioteca de clases convencional que declare modelos necesita el paquete `Microsoft.Extensions.Validation` y el registro por ensamblado explicado en la documentación.

La canalización integrada de .NET 10 es síncrona. Para validación asíncrona en .NET 11, utiliza las API documentadas y comprueba la versión concreta desplegada. Las consultas remotas siguen necesitando cancelación y límites de tiempo; la unicidad también debe garantizarse al guardar los datos.

## FluentValidation con un filtro de endpoint

FluentValidation coloca las reglas en clases separadas. Puede encajar con composición de reglas, conjuntos de reglas, condiciones o proyectos que ya usan su API. Este filtro corresponde a un único endpoint:

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

El filtro presupone que `CreateProduct` es el argumento cero. No lo asignes sin cambios a un grupo con distintas firmas. Usa `ValidateAsync` cuando pueda haber reglas asíncronas y pasa el token de cancelación de la petición. Registra en DI los servicios que necesiten los validadores.

Esta integración es distinta de la antigua validación automática MVC de `FluentValidation.AspNetCore`. Esa canalización es síncrona, no integra Minimal APIs y la documentación de FluentValidation ya no la recomienda para proyectos nuevos. No debe confundirse con la validación integrada reciente de ASP.NET Core.

## Elección y licencia

Decide según el mantenimiento y la reutilización de reglas, la versión desplegada y las respuestas de error que necesiten los clientes. La solución integrada es un buen punto de partida para modelos sencillos con DataAnnotations; FluentValidation ofrece otra organización y composición. Ninguna opción garantiza más rendimiento ni compatibilidad Native AOT para cualquier validador personalizado o dependencia. Comprueba la publicación y el comportamiento real.

FluentValidation 12.1.1, la versión usada aquí, utiliza Apache License 2.0. FluentAssertions es otro proyecto: las noticias sobre su licencia no determinan la de FluentValidation. Revisa la versión exacta que distribuyas.

Para organizar endpoints, consulta [grupos de rutas con MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Fuentes

- [ASP.NET Core validation](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/validation?view=aspnetcore-11.0)
- [.NET 11: asynchronous Minimal API validation](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11?view=aspnetcore-11.0#async-validation-for-minimal-apis)
- [FluentValidation: ASP.NET Core integration](https://docs.fluentvalidation.net/en/latest/aspnet.html)
- [FluentValidation: asynchronous rules](https://docs.fluentvalidation.net/en/latest/async.html)
- [FluentValidation 12.1.1 license](https://github.com/FluentValidation/FluentValidation/blob/12.1.1/License.txt)
