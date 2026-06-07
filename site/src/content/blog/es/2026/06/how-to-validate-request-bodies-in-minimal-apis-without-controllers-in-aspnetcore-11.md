---
title: "Cómo validar cuerpos de solicitud en minimal APIs sin controladores en ASP.NET Core 11"
description: "ASP.NET Core 11 trae validación integrada para minimal APIs: llama a AddValidation, anota tu record de solicitud con DataAnnotations y un generador de código fuente valida el modelo enlazado y devuelve 400 ProblemDetails antes de que se ejecute tu handler. Sin controladores, sin FluentValidation, sin comprobaciones manuales."
pubDate: 2026-06-07
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "es"
translationOf: "2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-07
---

Durante años, la respuesta honesta a "¿cómo valido el cuerpo de una solicitud en una minimal API?" era "no lo haces, no de forma automática." Las minimal APIs nacieron sin la maquinaria de `ModelState` que los controladores obtienen gratis, así que recurrías a `FluentValidation`, al paquete `MiniValidation` o a un bloque `if` escrito a mano en cada handler. Eso cambió en .NET 10 y se mantiene sin cambios en .NET 11: llama a `builder.Services.AddValidation()`, decora tu tipo de solicitud con los mismos atributos de `System.ComponentModel.DataAnnotations` que ya conoces (`[Required]`, `[Range]`, `[EmailAddress]`) y un generador de código fuente emite un endpoint filter que valida el modelo enlazado antes de que se ejecute el cuerpo de tu handler. Las solicitudes inválidas regresan como un `400 Bad Request` con un cuerpo `ProblemDetails`, sin comprobación de `ModelState.IsValid`, sin controlador, sin paquete extra. Todo lo de abajo apunta a .NET 11 con `Microsoft.NET.Sdk.Web` y C# 14; la característica es idéntica en .NET 10, donde apareció por primera vez.

## Por qué las minimal APIs no tenían validación para empezar

Esto no fue un descuido, fue una decisión de diseño. La validación de modelos de MVC se ejecuta a través de una canalización basada en reflexión: recorre el grafo del modelo en runtime, descubre las instancias de `ValidationAttribute`, las invoca y rellena `ModelState`. Esa reflexión es exactamente el tipo de costo de arranque y por solicitud que el stack de las minimal APIs fue construido para evitar, y es hostil al trimming y a Native AOT. Así que la superficie original de las minimal APIs enlazaba tus parámetros y llamaba a tu handler, punto. Si el cuerpo era basura, tu handler veía la basura.

La solución de .NET 10 esquiva el problema de la reflexión con un generador de código fuente. En tiempo de compilación encuentra cada tipo usado como parámetro de una minimal API, lee los atributos de `DataAnnotations` en esos tipos y genera el código de validación directamente. No hay reflexión del grafo del modelo en runtime, que es lo que hace que la característica sea compatible con el modelo de endpoints liviano y amigable con AOT. Si todavía estás sopesando los dos estilos de endpoint, las concesiones más amplias están en [minimal APIs vs controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/); esta guía asume que ya te decidiste por las minimal APIs y quieres recuperar la validación.

## Tres pasos para activar la validación

1. **Registra los servicios.** Llama a `builder.Services.AddValidation()` antes de construir la app. Esto registra los servicios de validación y el endpoint filter que los ejecuta.
2. **Asegúrate de que el generador de código fuente esté activo.** Con el SDK web de .NET 10 o .NET 11 el generador de validación se conecta automáticamente en cuanto llamas a `AddValidation()`. Si tu build es anterior a la versión final o copiaste un `.csproj` recortado, el generador emite interceptores en el espacio de nombres `Microsoft.AspNetCore.Http.Validation.Generated`; asegúrate de que ese espacio de nombres esté incluido en `InterceptorsNamespaces` (el SDK lo hace por ti en los builds actuales).
3. **Anota el tipo de solicitud y hazlo `public`.** Pon atributos de `DataAnnotations` en las propiedades o parámetros posicionales de tu record o clase de solicitud. El tipo debe ser `public`, porque el generador solo puede ver y generar código para tipos accesibles.

Ese es todo el montaje. Aquí está el cableado en `Program.cs`:

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

Si el `.csproj` alguna vez necesita la propiedad de forma explícita (SDKs más antiguos), se ve así:

```xml
<!-- only needed if the generator's interceptors are not picked up automatically -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.AspNetCore.Http.Validation.Generated</InterceptorsNamespaces>
</PropertyGroup>
```

## Qué devuelve realmente una solicitud inválida

Envía con POST un cuerpo que rompa dos reglas y obtienes un `400` legible por máquina sin escribir una sola línea de manejo de errores:

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

Ese payload es un `HttpValidationProblemDetails`, la misma forma RFC 9457 / RFC 7807 que produce MVC, así que los clientes existentes que ya parsean `errors` siguen funcionando. El handler nunca se ejecuta. No hay `ModelState`, ni comprobación de `IsValid`, nada que olvidar. El diccionario de errores está indexado por nombre de propiedad, y los miembros anidados usan una ruta con puntos, lo cual importa una vez que tus modelos dejan de ser planos.

## Los objetos anidados se validan de forma recursiva

La validación entra en las propiedades complejas automáticamente. Una solicitud con un objeto de dirección valida también la dirección, y las claves de error reflejan la ruta:

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

Envía con POST un pedido con un código postal incorrecto y la clave de error es `Billing.PostalCode`, no un `PostalCode` aplanado. El generador descubrió `BillingAddress` porque `CreateOrder` lo referencia; no tuviste que registrar el tipo anidado en ningún lado. Este descubrimiento recursivo es la parte que hace que la característica sea genuinamente útil y no un juguete para cuerpos de un solo campo.

## Cuando el tipo no está directamente en la firma de un handler

El generador encuentra los tipos mirando los parámetros de los handlers de las minimal API y los miembros alcanzables desde ellos. Si un tipo solo se referencia a través de una clase base, una interfaz o polimorfismo, el generador puede no descubrirlo. Para esos casos, anota el tipo mismo con `[ValidatableType]` de `Microsoft.AspNetCore.Http.Validation` para indicarle al generador que emita lógica de validación para él de forma explícita:

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

`[ValidatableType]` es la salida de emergencia manual: recurre a él cuando la validación silenciosamente no se dispara en un tipo en el que la esperabas, lo que casi siempre significa que el generador no pudo alcanzarlo desde un parámetro de handler.

## Reglas entre propiedades con IValidatableObject

Los atributos validan un miembro a la vez. Para reglas que abarcan varios campos ("la fecha de fin debe ser posterior a la de inicio", "si se establece el descuento, el motivo es obligatorio"), implementa `IValidatableObject`. Su método `Validate` se ejecuta después de las comprobaciones de atributos y produce entradas `ValidationResult`:

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

El arreglo de strings que pasas como segundo argumento controla bajo qué clave aterriza el error en el diccionario `errors`. Pasa `[nameof(End)]` y el cliente ve `"End": ["End must be after Start."]`; omítelo y el error va bajo una clave vacía como un error a nivel de modelo. Usa el nombre del miembro para que tu UI pueda resaltar el campo correcto.

## Un ValidationAttribute personalizado cuando los integrados se quedan cortos

Cuando ni los atributos integrados ni `IValidatableObject` encajan, escribe un `ValidationAttribute`. El generador de código fuente recoge los atributos personalizados de la misma forma que recoge `[Range]`:

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

Los atributos personalizados mantienen la regla junto a los datos y reutilizable en cada endpoint que recibe un `Booking`, que es todo el punto de la validación basada en atributos frente a bloques `if` en línea dispersos por los handlers.

## Los parámetros de consulta, ruta y encabezado también se validan

La característica no se limita al cuerpo JSON. Los atributos en parámetros escalares enlazados desde la ruta, la cadena de consulta o los encabezados se validan con la misma maquinaria:

```csharp
// .NET 11, C# 14
app.MapGet("/search",
    ([Range(1, 100)] int pageSize,
     [Required, MinLength(2)] string query) =>
        TypedResults.Ok(new { pageSize, query }));
```

Una solicitud a `/search?pageSize=500&query=x` se rechaza con un `400` antes de que se ejecute el handler, con `pageSize` y `query` ambos listados en `errors`. Esto cierra el hueco de validación más común que la gente encuentra después del cuerpo: los parámetros de paginación y filtrado que antes pasaban sin comprobar.

## Desactivar la validación para un endpoint

A veces un endpoint recibe un tipo que se valida en todas partes, pero aquí quieres el valor crudo, por ejemplo una ruta de administración interna que acepta intencionadamente datos que de otro modo serían inválidos. Encadena `DisableValidation()` en ese único endpoint:

```csharp
// .NET 11, C# 14
app.MapPost("/internal/import", (CreateProduct product) =>
        TypedResults.Accepted($"/products/{product.Sku}", product))
    .DisableValidation();
```

Esto elimina el filtro de validación de ese único endpoint sin tocar el registro global `AddValidation()`, así que todos los demás endpoints que usan `CreateProduct` siguen validando.

## Detalles que conviene conocer antes de publicar

Un puñado de bordes afilados hacen tropezar a la gente la primera vez:

- **El tipo de solicitud debe ser `public`.** El generador de código fuente solo puede emitir código para tipos que pueda nombrar. Un `record` o `class` declarado sin `public`, o anidado dentro de otro tipo sin la accesibilidad correcta, silenciosamente no recibe validación. Si la validación "no funciona", revisa primero el modificador de acceso.
- **Parámetros posicionales de record: la ubicación del atributo importa.** `[Required] string Name` en un parámetro posicional de record lo lee el generador, pero si además dependes de que el atributo esté en la *propiedad* generada (para herramientas que reflexionan sobre ella en runtime), usa el target explícito: `[property: Required] string Name`. El propio generador de validación lee la forma del parámetro, así que la mayoría del código no necesita `property:`, pero mezclar expectativas es una fuente común de confusión.
- **La validación se ejecuta como un endpoint filter, así que el orden de los filtros aplica.** El filtro de validación se añade por endpoint. Si además añades tus propias llamadas `AddEndpointFilter`, ten en cuenta dónde se ubica la validación en la cadena. Para saber cómo se compone el orden de filtros entre route groups, consulta [cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).
- **Esto no reemplaza a FluentValidation en todos los casos.** `DataAnnotations` más `IValidatableObject` cubre la gran mayoría de la validación de solicitudes. Si tienes un motor de reglas, reglas asíncronas que consultan una base de datos o una gran inversión existente en FluentValidation, consérvala. La característica integrada es para "solo quiero que `[Required]` realmente haga algo" sin una dependencia.
- **El handler se omite en caso de fallo, así que tu unión de `TypedResults` no necesita un brazo `BadRequest` para la validación.** El `400` lo produce el filtro, antes de que tu handler retorne, así que un handler tipado como `Results<Created<T>, NotFound>` está bien; los fallos de validación nunca lo alcanzan. El 400 ProblemDetails se genera de forma independiente de tus tipos de retorno declarados.
- **Los errores de DI en tiempo de resolución no tienen relación.** Si un endpoint lanza al activar un servicio en lugar de al validar la entrada, eso es un fallo completamente distinto; consulta [Unable to resolve service for type while attempting to activate](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) para ese.

El modelo mental con el que quedarte: la validación de minimal API en .NET 11 son las `DataAnnotations` que ya conoces, vueltas automáticas por un generador de código fuente en tiempo de compilación y expuestas a través de un filtro por endpoint que devuelve `ProblemDetails` estándar. Anotas, llamas a `AddValidation()` y las solicitudes inválidas se detienen en la puerta. Como está basada en generador y no en reflexión, se mantiene al margen del trimming y de Native AOT, que es exactamente por qué se entrega [segura para trimming con el stack de minimal API de Native AOT](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). Para cualquier cosa que el filtro no capture, un [filtro global de excepciones](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) sigue respaldando el resto de la canalización de solicitudes.

## Relacionado

- [Minimal APIs vs controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para elegir entre los dos modelos de endpoint en primer lugar.
- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para saber dónde se ubica el filtro de validación respecto a los filtros de grupo.
- [Usar Native AOT con minimal APIs de ASP.NET Core](/es/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) para entender por qué importa un validador basado en generador bajo trimming.
- [Agregar un filtro global de excepciones en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) para capturar todo lo que la validación no captura.
- [Fix: Unable to resolve service for type while attempting to activate](/es/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) para errores de activación que parecen, pero no son, fallos de validación.

## Fuentes

- Microsoft Learn, [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0?view=aspnetcore-10.0) (soporte de validación para minimal APIs, `AddValidation`, `[ValidatableType]`, `DisableValidation`).
- Microsoft Learn, [System.ComponentModel.DataAnnotations namespace](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.dataannotations) (`ValidationAttribute`, `IValidatableObject`, `ValidationResult`).
- Tim Deschryver, [ASP.NET 10: Validating incoming models in Minimal APIs](https://timdeschryver.dev/blog/aspnet-10-validating-incoming-models-in-minimal-apis) (validación de objetos anidados, forma de la respuesta de error).
