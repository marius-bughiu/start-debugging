---
title: "Cómo personalizar las respuestas de error de validación de minimal APIs con IProblemDetailsService en ASP.NET Core 11"
description: "Llama a AddProblemDetails con un callback CustomizeProblemDetails para reformar el 400 que devuelve la validación integrada de minimal APIs en ASP.NET Core 11: agrega un traceId, reescribe el title, cambia el 400 a 422 o toma el control total con un IProblemDetailsWriter personalizado."
pubDate: 2026-07-03
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
  - "validation"
lang: "es"
translationOf: "2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

La validación integrada de minimal APIs te da gratis un `400 Bad Request` con un cuerpo `HttpValidationProblemDetails`, pero la forma que devuelve es la predeterminada del framework: una carga RFC 9457 con `type`, `title`, `status` y un diccionario `errors`. Si necesitas un `traceId` para los tickets de soporte, un `title` diferente, un enlace a tus documentos de errores o un `422 Unprocessable Entity` en lugar de `400`, el punto de enganche es `AddProblemDetails(options => options.CustomizeProblemDetails = ...)`. Regístralo, y el mismo callback se dispara para las fallas de validación, las excepciones no controladas y las páginas de código de estado por igual, de modo que cada error que emite tu API lleva los mismos campos. Esta es la pieza que faltaba en las primeras versiones preliminares de .NET 10 y que quedó conectada en .NET 10 GA y .NET 11: el filtro de validación integrado ahora enruta sus problem details a través de `IProblemDetailsService`, así que tu personalización realmente alcanza los errores de validación. Todo lo que sigue apunta a .NET 11 con `Microsoft.NET.Sdk.Web` y C# 14; el comportamiento es idéntico en .NET 10 GA.

## Cómo se ve la respuesta de validación predeterminada

Parte de la configuración que se cubre en [cómo validar cuerpos de solicitud en minimal APIs sin controladores](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/): llama a `AddValidation()`, anota un record de solicitud y deja que el generador de código fuente haga el trabajo.

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

Haz POST de un cuerpo inválido y obtienes la carga estándar:

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

Eso es correcto y legible por máquina, pero no dice nada sobre tu servicio. No hay un ID de correlación para pegar en un reporte de errores, el `type` apunta al RFC en lugar de a tu propio catálogo de errores, y los clientes que tratan el `422` como "semánticamente inválido, no reintentar" reciben un `400` que no pueden distinguir de una solicitud malformada. La personalización arregla todo eso en un solo lugar.

## Activa el punto de enganche de personalización

`AddProblemDetails()` registra el `IProblemDetailsService` predeterminado, y su sobrecarga toma una configuración `ProblemDetailsOptions` donde estableces `CustomizeProblemDetails`. Esa propiedad es un delegado que recibe un `ProblemDetailsContext`, que expone tanto el `HttpContext` como el `ProblemDetails` mutable que está por escribirse.

1. **Registra los problem details con el callback.** Llama a `builder.Services.AddProblemDetails(options => options.CustomizeProblemDetails = ctx => { ... })` antes de `builder.Build()`.
2. **Mantén también `AddValidation()`.** Los dos servicios son independientes: `AddValidation()` produce el `400`, `AddProblemDetails()` personaliza el cuerpo que lleva.
3. **Muta `ctx.ProblemDetails` dentro del callback.** Agrega a `Extensions`, reescribe `Title`, `Type` o `Detail`, o cambia `Status`.

Este es el cableado que agrega un ID de correlación y un puntero de soporte a cada error de validación:

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

El mismo POST inválido ahora devuelve:

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

El diccionario `errors` queda intacto, así que los clientes existentes siguen parseándolo. Agregaste campos, no rompiste el contrato. Fíjate en el `traceId`: sácalo de `Activity.Current?.Id` en lugar de un `Guid.NewGuid()` nuevo, porque ese valor es el verdadero trace id W3C que fluye por tus registros y spans de OpenTelemetry. Un GUID aleatorio parece un trace id pero no correlaciona con nada. Recurrir a `HttpContext.TraceIdentifier` cubre las solicitudes que llegan sin un contexto de traza.

## Por qué el callback alcanza cada error, no solo la validación

La razón para preferir `CustomizeProblemDetails` sobre editar a mano cada endpoint es la cobertura. Cuando `AddProblemDetails()` está registrado, el callback se ejecuta para los problem details producidos por la maquinaria de errores del framework: el `ExceptionHandlerMiddleware`, el `StatusCodePagesMiddleware`, la página de excepciones para desarrolladores y, desde .NET 10 GA, el filtro de validación integrado de minimal APIs. Un solo callback, y tu `traceId` aterriza en un `400` de validación, un `404` de una ruta sin coincidencia y un `500` de una excepción no controlada. Esa consistencia es el punto entero del contrato de problem details: un cliente debería poder leer `traceId` de cualquier error que devuelva tu API sin tener que hacer casos especiales según qué capa lo produjo.

Para obtener los casos `404` y `500` además de la validación, registra los dos middleware que llenan las respuestas de error vacías:

```csharp
// .NET 11, C# 14
app.UseExceptionHandler();   // turns unhandled exceptions into ProblemDetails
app.UseStatusCodePages();    // fills empty 4xx/5xx responses with ProblemDetails
app.Run();
```

Sin estos, un simple `Results.NotFound()` o una ruta sin coincidencia devuelve un cuerpo vacío, porque los problem details se generan solo "para respuestas que aún no tienen contenido de cuerpo". La validación es la excepción que no necesita este cableado: el filtro de validación mismo llama a `IProblemDetailsService`, así que su `400` se personaliza tanto si agregas `UseStatusCodePages()` como si no. Si además quieres que tu red de seguridad global atrape lo que la validación no atrapa, la mecánica de la ruta de excepciones se cubre en [cómo agregar un filtro global de excepciones en ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/).

## Devuelve 422 en lugar de 400 para la validación

Una elección común de diseño de API es distinguir "no pude parsear tu solicitud" (`400`) de "la parseé pero viola las reglas" (`422 Unprocessable Entity`). Como el callback puede mutar `Status`, y el middleware escribe el estado desde el `ProblemDetails`, puedes promover las fallas de validación a `422` en un solo lugar:

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

Establece tanto el campo `ProblemDetails.Status` (lo que aparece en el cuerpo JSON) como `HttpContext.Response.StatusCode` (la línea de estado HTTP real). Si te olvidas del segundo, envías un cuerpo que afirma `422` en una respuesta HTTP `400`, lo cual es peor que cualquiera de los dos por separado. La verificación de la clave `errors` acota la reescritura específicamente a las fallas de validación, así que un `400` normal de otra parte de tu app conserva su estado.

## Toma el control total con un IProblemDetailsWriter personalizado

`CustomizeProblemDetails` muta el objeto; no controla la serialización ni decide cuándo escribir. Para eso, implementa `IProblemDetailsWriter`. Un writer obtiene una compuerta `CanWrite` y un `WriteAsync` que es dueño del cuerpo de la respuesta, lo que te permite ramificar según el código de estado, la negociación de contenido o los metadatos del endpoint:

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

Regístralo en DI, y regístralo antes de `AddControllers()` o `AddRazorPages()` si usas alguno, porque esos registran sus propios writers y el orden decide cuál gana:

```csharp
// .NET 11, C# 14
builder.Services.AddTransient<IProblemDetailsWriter, ValidationProblemDetailsWriter>();
```

Recurre a un writer solo cuando el callback no es suficiente: serialización distinta para clientes distintos, XML junto a JSON, o emitir un esquema completamente diferente para un código de estado. Para agregar campos y ajustar texto, `CustomizeProblemDetails` es menos código y menos cosas que hacer mal.

## Personalizar un solo endpoint en lugar de toda la app

Todo lo anterior es global. Cuando quieres darle una forma diferente a la respuesta de validación de un solo endpoint, devuelve los problem details tú mismo desde el handler con `TypedResults.ValidationProblem`, que acepta un diccionario `extensions` directamente:

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

Hay un borde filoso aquí que vale la pena decir claramente: un `ProblemDetails` que construyes y devuelves directamente desde un handler, ya sea a través de `TypedResults.ValidationProblem`, `Results.Problem` o `TypedResults.Problem`, se serializa directo a la respuesta y **no** pasa por `IProblemDetailsService`. Tu callback global `CustomizeProblemDetails` no se ejecutará para él, así que el `traceId` que agregaste de forma centralizada faltará. Si mezclas personalización global con problemas devueltos por el handler, o agregas los campos compartidos también en el handler, o mantienes la validación en el filtro integrado, que sí enruta a través del servicio. Esta es la sorpresa más común: el callback cubre los problem details generados por el framework, no los que instancias tú mismo.

## Trampas que muerden en producción

- **El encabezado `Accept` controla si obtienes JSON siquiera.** El `DefaultProblemDetailsWriter` escribe para `application/json`, `application/problem+json` y comodines como `*/*` y `application/*`. Un cliente que envía `Accept: text/html` o `application/xml` dispara la ruta de respaldo y no obtiene cuerpo de problem details. Si tus consumidores son navegadores o clientes SOAP, tenlo en cuenta en lugar de asumir que el JSON siempre se envía.
- **`CustomizeProblemDetails` no se llamaba para la validación en las primeras versiones preliminares de .NET 10.** Esto se rastreó como [dotnet/aspnetcore#62723](https://github.com/dotnet/aspnetcore/issues/62723): el filtro de validación saltaba `IProblemDetailsService`. Está conectado a través del servicio en .NET 10 GA y .NET 11. Si tu callback se dispara para las excepciones pero omite silenciosamente los errores de validación, estás en un SDK de versión preliminar obsoleto; actualízalo.
- **El orden importa cuando también usas controladores.** MVC produce los problem details de validación a través de `ProblemDetailsFactory` e `InvalidModelStateResponseFactory`, no a través de `CustomizeProblemDetails` solamente. Una app mixta con endpoints de minimal API y controladores necesita ambas rutas configuradas, o tus controladores y tus minimal APIs no estarán de acuerdo sobre la forma del error.
- **No filtres detalles internos en `Detail`.** Es tentador meter un mensaje de excepción en `ProblemDetails.Detail` dentro del callback. En producción eso expone fragmentos de traza de pila y nombres de tipos internos. Mantén `Detail` seguro para el cliente y pon la información de diagnóstico detrás de tu `traceId` en los registros en su lugar.
- **El callback se ejecuta en la ruta caliente de cada error.** Mantenlo barato. Leer `Activity.Current` y establecer claves de diccionario está bien; abrir una conexión a la base de datos o llamar a un servicio remoto dentro de `CustomizeProblemDetails` no lo está, porque se ejecuta de forma síncrona mientras se escribe la respuesta.

El modelo que hay que recordar: `AddValidation()` decide qué es inválido, `AddProblemDetails()` decide cómo se describe la invalidez, y `CustomizeProblemDetails` es el único lugar para dar forma a esa descripción para cada error generado por el framework a la vez. Agrega tu `traceId` ahí, reescribe el `title` ahí, promueve a `422` ahí, y recurre a un `IProblemDetailsWriter` personalizado solo cuando necesites ser dueño de la serialización. Para cualquier cosa que el filtro de validación no atrape, el [filtro global de excepciones](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) lleva la misma personalización, y si todavía estás decidiendo si el validador integrado cubre tus reglas siquiera, [validación de minimal APIs vs FluentValidation](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) traza esa línea.

## Relacionado

- [Cómo validar cuerpos de solicitud en minimal APIs sin controladores en ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) para la configuración de `AddValidation()` que este post personaliza.
- [Validación de minimal APIs vs FluentValidation en ASP.NET Core 11](/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/) para saber si el validador integrado se ajusta a tus reglas antes de personalizar su salida.
- [Cómo agregar un filtro global de excepciones en ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) para atrapar lo que la validación no atrapa, con la misma forma de `ProblemDetails`.
- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para aplicar la validación y sus problem details a todo un grupo de rutas.
- [Minimal APIs vs controladores en ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) para saber en qué se diferencia el manejo de errores entre los dos modelos de endpoint.

## Fuentes

- Microsoft Learn, [Handle errors in ASP.NET Core APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling-api?view=aspnetcore-10.0) (`AddProblemDetails`, el middleware que genera problem details, `CustomizeProblemDetails`, el respaldo de `IProblemDetailsService` y los tipos de medios admitidos).
- Microsoft Learn, [Create responses in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/responses?view=aspnetcore-10.0) (personalización de las respuestas de error de validación de minimal APIs con `IProblemDetailsService`, `TypedResults.ValidationProblem`).
- Microsoft Learn, [ProblemDetailsOptions.CustomizeProblemDetails](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.problemdetailsoptions.customizeproblemdetails) (firma del callback y `ProblemDetailsContext`).
- dotnet/aspnetcore, [CustomizeProblemDetails not invoked for minimal API validation (issue #62723)](https://github.com/dotnet/aspnetcore/issues/62723) (la brecha de la era de versiones preliminares, resuelta para .NET 10 GA).
