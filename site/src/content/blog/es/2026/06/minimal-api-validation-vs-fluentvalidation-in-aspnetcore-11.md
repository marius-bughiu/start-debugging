---
title: "Validación de minimal API vs FluentValidation en ASP.NET Core 11: ¿cuál deberías elegir?"
description: "Usa la validación integrada generada por código fuente para reglas síncronas expresables con atributos en ASP.NET Core 11; recurre a FluentValidation cuando necesites reglas asíncronas, lógica compleja entre campos o mantener la validación fuera de tus modelos de dominio."
pubDate: 2026-06-15
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

Si vas a empezar una minimal API nueva en ASP.NET Core 11, usa la validación integrada: llama a `AddValidation()`, anota tu record de solicitud con `DataAnnotations` y un generador de código fuente devuelve un `400 ProblemDetails` antes de que se ejecute tu handler, sin dependencias y con soporte para Native AOT. Recurre a FluentValidation (actualmente 12.1.1, Apache 2.0) solo cuando necesites algo que la funcionalidad integrada realmente no puede hacer: reglas asíncronas que consultan una base de datos, lógica rica entre campos o validación mantenida por completo fuera de tus modelos de dominio. El eje decisivo son las reglas asíncronas y condicionales complejas. Si las necesitas, gana FluentValidation; si no, la funcionalidad integrada es la opción de menor fricción. Todo lo que sigue apunta a .NET 11 con `Microsoft.NET.Sdk.Web` y C# 14; la funcionalidad integrada se publicó por primera vez en .NET 10 y no cambia en 11.

## La matriz de características

Esta es la tabla por la que viniste. Cada fila refleja .NET 11 y FluentValidation 12.1.1.

| Característica                   | Integrada (`DataAnnotations`)           | FluentValidation 12                       |
| -------------------------------- | --------------------------------------- | ----------------------------------------- |
| Dependencia                      | ninguna (incluida, .NET 10+)            | paquete NuGet, Apache 2.0                 |
| Mecanismo                        | generador de código fuente en compilación | reflexión en runtime + árboles de expresión |
| Native AOT / trimming            | compatible (sin reflexión en runtime)   | requiere cuidado, soporte parcial         |
| Reglas asíncronas (consultas BD / HTTP) | no                               | sí (`MustAsync`, `ValidateAsync`)         |
| Reglas entre campos              | `IValidatableObject` (verboso)          | de primera clase (`RuleFor(...).When(...)`) |
| Dónde viven las reglas           | en el modelo, como atributos            | en una clase de validador aparte          |
| Condicional / conjuntos de reglas | limitado                               | `When`/`Unless`/`WhenAsync`, conjuntos de reglas |
| `400` automático en una minimal API | sí, endpoint filter integrado        | manual: tú escribes el endpoint filter    |
| Forma de la respuesta de error   | `ProblemDetails` (RFC 9457) gratis      | tú mapeas los fallos a una respuesta       |
| Reglas compuestas reutilizables  | `ValidationAttribute` personalizado     | `SetValidator`, encadenamiento de reglas, herencia |

La lectura corta: la funcionalidad integrada optimiza para "actívala y olvídate" en modelos simples, y FluentValidation optimiza para el poder expresivo en los complejos. Ninguna es estrictamente mejor. Las filas que deciden la mayoría de los casos son las reglas asíncronas y dónde viven las reglas.

## Cuándo elegir la validación integrada

La validación integrada, explicada paso a paso en [cómo validar cuerpos de solicitud en minimal APIs sin controladores](/es/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/), es el valor por defecto correcto en estos casos:

- **Minimal APIs nuevas en .NET 11 con reglas síncronas.** Si tu validación es "este campo es obligatorio, ese otro es un entero positivo, el correo parece un correo", `DataAnnotations` expresa todo eso y el generador de código fuente lo convierte en un endpoint filter gratis. Sin paquete, sin clases de validador, sin cableado.
- **Despliegues con Native AOT o trimming agresivo.** La funcionalidad integrada se diseñó en torno a un generador de código fuente precisamente para no cargar con reflexión del grafo de modelo en runtime. Eso es lo que la hace segura bajo trimming y Native AOT, la misma razón por la que se integra limpiamente con la [pila de minimal API con Native AOT](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). FluentValidation se apoya en reflexión y árboles de expresión compilados, que requieren cuidado adicional para hacer trimming.
- **Quieres que te entreguen el contrato `400 ProblemDetails`.** La validación integrada devuelve un cuerpo `HttpValidationProblemDetails` indexado por nombre de propiedad, la misma forma RFC 9457 que produce MVC, sin código de tu parte. Con FluentValidation tú decides cómo traducir un `ValidationResult` en una respuesta HTTP, una flexibilidad que quizá no quieras en un servicio pequeño.
- **Prefieres que las reglas vivan en el modelo.** Los atributos mantienen `[Required]` junto a la propiedad que protege. Para un equipo al que le gusta tener los datos y sus restricciones en un solo lugar, esa co-ubicación es una ventaja, no un defecto.

## Cuándo elegir FluentValidation

FluentValidation 12 se gana su dependencia cuando la funcionalidad integrada choca con un muro:

- **Reglas asíncronas.** Esta es la mayor razón para recurrir a ella. `DataAnnotations` e `IValidatableObject` son síncronos, así que "¿este nombre de usuario ya está en uso?" o "¿existe este ID de producto en el catálogo?" no se pueden expresar en la funcionalidad integrada sin filtrar acceso a datos dentro de un handler. FluentValidation soporta `MustAsync` y `WhenAsync`, y lo invocas con `ValidateAsync`. La biblioteca es explícita en que un validador que contiene reglas asíncronas debe llamarse con `ValidateAsync`, nunca con `Validate`, o lanza una excepción.
- **Lógica rica entre campos y condicional.** "Fecha de fin posterior a la de inicio" se puede hacer con `IValidatableObject`, pero en cuanto tienes "si `PaymentType` es `Invoice` entonces `PurchaseOrderNumber` es obligatorio, salvo que el cliente sea `Internal`", el enfoque de atributos más `IValidatableObject` se convierte en una maraña de bloques `if`. El `RuleFor(x => x.PurchaseOrderNumber).NotEmpty().When(x => x.PaymentType == PaymentType.Invoice)` de FluentValidation se lee como el requisito.
- **La validación debe quedar fuera del modelo de dominio.** En una base de código de arquitectura limpia o DDD, decorar un record de dominio con `[Range]` y `[EmailAddress]` acopla el modelo a una preocupación de presentación. FluentValidation mantiene cada regla en una clase `AbstractValidator<T>` aparte, así que el modelo sigue siendo un POCO sin atributos.
- **Reutilización y composición entre muchos tipos de solicitud.** `SetValidator`, la herencia de validadores y los conjuntos de reglas te permiten componer un `MoneyValidator` en cada solicitud que lleve un precio, con una fluidez que los tipos `ValidationAttribute` personalizados no igualan una vez que la regla tiene estructura.

## Cómo se ve cada una en código

La versión integrada son las anotaciones que ya conoces, más un registro de servicio:

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

Un cuerpo inválido nunca llega al handler. Vuelve como un `400` con un payload `ProblemDetails` indexado por `Sku`, `Name` y `Quantity` automáticamente.

El equivalente de FluentValidation mueve las reglas a una clase de validador y, como la pipeline de validación automática integrada está obsoleta (más sobre esto abajo), lo conecta a través de un endpoint filter que llamas explícitamente:

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

Es más código, pero también es donde vive el poder. Agrega una comprobación de unicidad asíncrona y la funcionalidad integrada simplemente no puede seguir:

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

`MustAsync` consulta la base de datos durante la validación. No hay ningún atributo de `DataAnnotations` que haga esto sin que abras un `DbContext` dentro de la regla, e `IValidatableObject.Validate` es síncrono, así que no puede esperar nada. Este es el muro que envía a los equipos a FluentValidation.

Puedes factorizar el código repetitivo del endpoint filter en una pequeña extensión genérica para que cada endpoint solo encadene `.WithValidation<CreateProduct>()`. La mecánica de componer filtros en un grupo de rutas es la misma que se describe en [organizar endpoints de minimal API con MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), así que un único `MapGroup(...).AddEndpointFilter(...)` puede validar un grupo entero.

## El benchmark: arranque, no estado estacionario

La historia honesta de rendimiento aquí no es el throughput de solicitudes. Para un puñado de propiedades, ambos enfoques validan en microsegundos y el costo queda eclipsado por la deserialización JSON y lo que haga tu handler. La diferencia medible está en los bordes: el arranque en frío y AOT.

Como la funcionalidad integrada se genera en tiempo de compilación, no agrega reflexión en el arranque. FluentValidation construye sus cadenas de reglas con árboles de expresión que se compilan en el primer uso, así que la primera validación de cada tipo paga un costo único de JIT y compilación de expresión. En un servidor caliente ese costo se amortiza a nada. En una [función serverless con arranque en frío](/es/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) que atiende una solicitud y se congela, lo pagas en una fracción significativa de invocaciones.

La distinción más marcada es la publicación. Una minimal API con Native AOT y el validador integrado se publica y se ejecuta sin advertencias de trimming, porque no hay reflexión que preservar. La misma aplicación usando FluentValidation hará surgir advertencias de trimming a menos que mantengas anclados los tipos validados y sus miembros, ya que la biblioteca usa reflexión sobre tu modelo y sobre expresiones de acceso a miembros. Eso no es "FluentValidation es lento", es "FluentValidation te cuesta trabajo de seguridad de trimming que la funcionalidad integrada no". Si tu objetivo de despliegue es AOT, trátalo como el factor decisivo en lugar de cualquier conteo de nanosegundos. Las cifras más viejas que este ciclo de .NET 11 deberían volver a medirse antes de confiar en ellas; las internas de validación cambiaron entre .NET 8 y .NET 10.

## El detalle que decide por ti: el paquete AspNetCore obsoleto

Si buscas la integración de FluentValidation con ASP.NET Core, encontrarás el paquete `FluentValidation.AspNetCore` y su antigua pipeline de validación automática. No empieces ahí. Los mantenedores la marcaron como obsoleta, y la documentación es explícita: "We no longer recommend using this approach for new projects but it is still available for legacy implementations." No ejecuta validadores asíncronos (lanza excepción), nunca soportó minimal APIs ni Blazor, y su comportamiento implícito es difícil de depurar. El camino recomendado en 2026 es el manual mostrado arriba: registra `IValidator<T>` en DI y llama tú mismo a `ValidateAsync`, desde un endpoint filter para minimal APIs o desde el handler. Si un tutorial te dice que llames a `AddFluentValidationAutoValidation()`, es anterior a esta recomendación.

Un segundo detalle apunta en sentido contrario, a favor de FluentValidation: el miedo a la licencia está mal ubicado aquí. FluentValidation sigue siendo Apache 2.0 y gratuita, incluido para uso comercial. La biblioteca que cambió a una licencia restrictiva de pago en enero de 2025 fue Fluent Assertions, un proyecto distinto con un nombre confusamente similar. No tienen relación, y elegir FluentValidation no te expone a una tarifa por puesto. Si un revisor de políticas marca "Fluent*" en tu lista de dependencias, esa es la distinción que hay que hacer.

El último es una trampa de corrección exclusiva de FluentValidation: si alguna regla de un validador es asíncrona, cada sitio de llamada debe usar `ValidateAsync`. Un `Validate()` síncrono perdido en un validador que contiene una regla `MustAsync` lanza una excepción en runtime, no en compilación, así que puede pasar pruebas que nunca ejercitan esa ruta y fallar en producción. Estandariza `ValidateAsync` en todas partes para evitar la trampa por completo.

## La recomendación, repetida

Usa por defecto la validación integrada en ASP.NET Core 11. Es gratis, es compatible con AOT, te entrega un contrato `ProblemDetails` estándar y, para las reglas síncronas y con forma de atributo que constituyen la mayoría de la validación de solicitudes, es estrictamente menos trabajo que agregar una dependencia. Elige FluentValidation de forma deliberada, cuando hayas chocado con un límite específico: reglas asíncronas que necesitan E/S, lógica condicional entre campos que `IValidatableObject` vuelve fea, o una regla arquitectónica de que la validación no debe tocar tus modelos de dominio. Muchos sistemas reales terminan con ambas, y eso está bien: deja que la funcionalidad integrada proteja los DTO simples y que FluentValidation se encargue del puñado de tipos de solicitud con reglas genuinamente complejas. El error es recurrir a una biblioteca de validación en un servicio nuevo de .NET 11 por costumbre, antes de tener una regla que el framework no pueda ya expresar gratis.

## Relacionados

- [Cómo validar cuerpos de solicitud en minimal APIs sin controladores en ASP.NET Core 11](/es/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) para la configuración completa de la funcionalidad integrada.
- [Minimal APIs vs controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para la decisión de modelo de endpoint que subyace a esta.
- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para aplicar un filtro de validación a un grupo de rutas entero.
- [Usar Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para entender por qué importa un validador basado en generador bajo trimming.
- [Cómo agregar un filtro global de excepciones en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) para respaldar todo lo que la validación no atrapa.

## Fuentes

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0) (validación integrada de minimal API, `AddValidation`, generador de código fuente, `ProblemDetails`).
- Documentación de FluentValidation, [ASP.NET Core integration](https://docs.fluentvalidation.net/en/latest/aspnet.html) (obsolescencia de la validación automática, enfoque manual recomendado con `IValidator<T>`).
- Documentación de FluentValidation, [Asynchronous Validation](https://docs.fluentvalidation.net/en/latest/async.html) (`MustAsync`, `WhenAsync`, el requisito de `ValidateAsync`).
- FluentValidation, [Deprecation of the FluentValidation.AspNetCore package (issue #1960)](https://github.com/FluentValidation/FluentValidation/issues/1960).
- NuGet, [FluentValidation 12.1.1](https://www.nuget.org/packages/fluentvalidation/) (versión actual, licencia Apache 2.0).
- DevClass, [Another open source project shifts to restrictive license: Fluent Assertions](https://www.devclass.com/development/2025/01/16/another-open-source-project-shifts-to-restrictive-license-fluent-assertions-following-xceed-partnership/) (el cambio de licencia fue de Fluent Assertions, no de FluentValidation).
</content>
