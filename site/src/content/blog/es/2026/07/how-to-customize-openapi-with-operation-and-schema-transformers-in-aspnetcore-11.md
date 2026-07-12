---
title: "Cómo personalizar el documento OpenAPI con AddOperationTransformer y AddSchemaTransformer en ASP.NET Core 11"
description: "Un análisis a fondo del pipeline de transformadores de OpenAPI integrado en .NET 11: transformadores de operación vs. de esquema, los objetos de contexto, el orden de ejecución, los transformadores activados por DI, y recetas para encabezados, respuestas, ejemplos y ajustes por propiedad."
pubDate: 2026-07-12
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
lang: "es"
translationOf: "2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

El generador integrado `Microsoft.AspNetCore.OpenApi` en .NET 11 es dueño del documento OpenAPI, y la forma de cambiar lo que emite es con transformadores. Hay tres: `AddDocumentTransformer` para todo el documento, `AddOperationTransformer` para cada operación de ruta más método, y `AddSchemaTransformer` para cada modelo de datos. Para agregar un parámetro de encabezado o una respuesta compartida a todos los endpoints, usa un transformador de operación. Para fijar un formato, ejemplo o descripción en un tipo o propiedad, usa un transformador de esquema. Este post apunta a .NET 11 (`net11.0`, C# 14) con `Microsoft.AspNetCore.OpenApi` y `Microsoft.OpenApi` v2, y va más allá de las líneas sueltas hacia los objetos de contexto, el orden de ejecución que hace tropezar a la gente, y los cambios de tipos de Microsoft.OpenApi v2 que no compilarán si copias ejemplos de .NET 8.

Si todavía no has generado un documento, empieza con [cómo exponer OpenAPI sin Swashbuckle](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/); todo lo que sigue asume que `builder.Services.AddOpenApi()` y `app.MapOpenApi()` ya están en su lugar.

## Qué puede tocar cada transformador

Los tres tipos de transformador no son intercambiables, y elegir el equivocado es el error más común. La regla tiene que ver con el alcance:

- Un **transformador de documento** ve todo el `OpenApiDocument`. Es la herramienta correcta para `Info`, `servers`, `tags` de nivel superior y esquemas de seguridad, porque esos viven en la raíz.
- Un **transformador de operación** se invoca una vez por operación, donde una operación es una ruta única más un método HTTP (`GET /todos/{id}` es una operación, `POST /todos` es otra). Recurre a él cuando quieras un cambio en cada endpoint, o en endpoints que coincidan con una condición que puedas leer desde los metadatos.
- Un **transformador de esquema** se invoca por cada esquema que produce el generador, incluidos los anidados. Es donde tocas la forma de los cuerpos de solicitud y respuesta: formatos, ejemplos, descripciones, nulabilidad, obsolescencia.

Intentar agregar una respuesta a "todas las operaciones" desde un transformador de documento significa recorrer a mano `document.Paths`; usando un transformador de operación, el framework te entrega cada operación directamente. Lo inverso también es cierto: fijar `document.Info` desde un transformador de operación se ejecutaría una vez por endpoint y se sobrescribiría a sí mismo. Ajusta el transformador a la altitud de lo que estás cambiando.

## Cuatro pasos para agregar un encabezado global y dar forma a un esquema

Aquí está el procedimiento central de principio a fin. Registra un transformador de operación que estampa un encabezado de id de correlación en cada endpoint, y un transformador de esquema que corrige el formato de un tipo.

1. **Abre el bloque de opciones de `AddOpenApi`.** Los tres métodos `Add*Transformer` cuelgan de `OpenApiOptions`, así que los registras dentro del delegado `AddOpenApi(options => { ... })`.

2. **Registra un transformador de operación para el encabezado.** La firma del delegado es `(OpenApiOperation operation, OpenApiOperationTransformerContext context, CancellationToken ct)`. Muta `operation` en su lugar y devuelve un `Task`.

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer((operation, context, cancellationToken) =>
    {
        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Description = "Client-supplied request id, echoed back in the response.",
            Schema = new OpenApiSchema { Type = JsonSchemaType.String }
        });
        return Task.CompletedTask;
    });
});
```

3. **Registra un transformador de esquema para el tipo.** Su delegado es `(OpenApiSchema schema, OpenApiSchemaTransformerContext context, CancellationToken ct)`. El ejemplo clásico es decirles a los consumidores que un `decimal` tiene precisión monetaria, no de un float:

```csharp
// .NET 11, C# 14
options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    if (context.JsonTypeInfo.Type == typeof(decimal))
    {
        schema.Format = "decimal";
    }
    return Task.CompletedTask;
});
```

4. **Regenera y verifica.** Solicita `/openapi/v1.json`. Cada operación debería llevar ahora el parámetro de encabezado `X-Correlation-Id`, y cada propiedad `decimal` debería mostrar `"format": "decimal"`. Como `MapOpenApi` regenera el documento en cada solicitud, no hay nada que reiniciar más allá de la propia app.

Ese es todo el ciclo. El resto de este post es el detalle que hace que estos transformadores sean confiables en lugar de sorprendentes.

## Los objetos de contexto, propiedad por propiedad

Cada transformador recibe un contexto, y los contextos difieren porque cada transformador conoce cosas distintas.

El contexto de **operación** (`OpenApiOperationTransformerContext`) expone `DocumentName`, `Description` (el `ApiDescription` del endpoint) y `ApplicationServices` (el `IServiceProvider`). `Description` es el importante: lleva la ruta, el método HTTP y `ActionDescriptor.EndpointMetadata`, que es como haces condicional a un transformador. Por ejemplo, agregar una respuesta `429` solo a los endpoints que efectivamente tienen una política de limitación de tasa adjunta:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.RateLimiting;

options.AddOperationTransformer((operation, context, cancellationToken) =>
{
    var isRateLimited = context.Description.ActionDescriptor.EndpointMetadata
        .OfType<EnableRateLimitingAttribute>()
        .Any();

    if (isRateLimited)
    {
        operation.Responses ??= new OpenApiResponses();
        operation.Responses["429"] = new OpenApiResponse
        {
            Description = "Too many requests. Retry after the window resets."
        };
    }

    return Task.CompletedTask;
});
```

El contexto de **esquema** (`OpenApiSchemaTransformerContext`) expone `DocumentName`, `JsonTypeInfo`, `JsonPropertyInfo` y `ApplicationServices`. `JsonTypeInfo` son los metadatos de `System.Text.Json` para el tipo que se está describiendo, así que `context.JsonTypeInfo.Type` es el `Type` de CLR. `JsonPropertyInfo` solo se rellena cuando el esquema se está generando para una propiedad específica, lo que te permite apuntar a un miembro en lugar de a un tipo entero:

```csharp
// .NET 11, C# 14
using System.Text.Json.Nodes;

options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    // Target the Email property on any type that has one.
    if (context.JsonPropertyInfo?.Name == "email")
    {
        schema.Format = "email";
        schema.Example = JsonValue.Create("dev@example.com");
    }

    return Task.CompletedTask;
});
```

El contexto de **documento** (`OpenApiDocumentTransformerContext`) expone `DocumentName`, `DescriptionGroups` (el `ApiDescriptionGroups`) y `ApplicationServices`. Recurres a los transformadores de documento cuando el objetivo es la raíz del documento, la mayoría de las veces el esquema de seguridad, que cubro más abajo.

## El orden de ejecución es esquema, luego operación, luego documento

Esta es la parte que produce reportes de bug de "mi cambio desapareció". Los transformadores no se ejecutan en el orden que podrías esperar al leer el archivo. El framework los ejecuta en este orden:

- **Los transformadores de esquema primero.** Todos los esquemas se registran en el documento antes de que se procese cualquier operación, así que cada transformador de esquema se ejecuta antes que cualquier transformador de operación. Dentro de los transformadores de esquema, se ejecutan en orden de registro, y uno posterior ve las mutaciones de uno anterior.
- **Los transformadores de operación después.** Cada uno se ejecuta cuando se agrega su operación, en orden de registro, después de que existan todos los esquemas. Para cuando se ejecuta un transformador de operación, los esquemas de los tipos de esa operación ya tienen forma.
- **Los transformadores de documento al final.** Se ejecutan en la pasada final, cuando cada operación y esquema está presente. Un transformador de documento posterior ve las ediciones del anterior.

La consecuencia práctica: si un transformador de documento necesita que un esquema ya tenga cierta forma, la tendrá, porque los esquemas se ejecutaron primero. Pero un transformador de operación no puede depender de que un transformador de documento se haya ejecutado, porque los documentos van al final. Cuando generas varios documentos, todo el pipeline se ejecuta de forma independiente por documento, así que un transformador registrado en el documento `internal` nunca toca el `public`.

## Transformadores fuertemente tipados e inyección de dependencias

Los delegados en línea están bien para ajustes sin estado. Cuando un transformador necesita un servicio, implementa la interfaz y registra el tipo para que el framework lo active desde DI. Las interfaces son `IOpenApiDocumentTransformer`, `IOpenApiOperationTransformer` e `IOpenApiSchemaTransformer`, cada una con un único `TransformAsync`. Usa un constructor primario para inyectar:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class BearerSecuritySchemeTransformer(
    IAuthenticationSchemeProvider authenticationSchemeProvider) : IOpenApiDocumentTransformer
{
    public async Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        var schemes = await authenticationSchemeProvider.GetAllSchemesAsync();
        if (schemes.Any(s => s.Name == "Bearer"))
        {
            document.Components ??= new OpenApiComponents();
            document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
            {
                Type = SecuritySchemeType.Http,
                Scheme = "bearer",
                In = ParameterLocation.Header,
                BearerFormat = "JSON Web Token"
            };
        }
    }
}

// Registration
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});
```

Registra un transformador activado por DI con la sobrecarga genérica (`AddDocumentTransformer<T>()`), una instancia ya construida (`AddDocumentTransformer(new T())`), o un delegado. Solo la forma genérica participa en la inyección de dependencias. La forma genérica se resuelve de nuevo por cada generación de documento y se desecha después, así que un transformador que implementa `IDisposable` se limpia cada vez que se produce el documento. Ese ciclo de vida por generación es por lo que deberías mantener los transformadores baratos: con un endpoint `MapOpenApi` en vivo, el pipeline se ejecuta en cada solicitud a la ruta del documento. Si el documento es costoso de construir, cachea el endpoint con `.CacheOutput()` o genéralo en [tiempo de compilación](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) en su lugar.

Registrar un esquema de seguridad es el trabajo canónico de un transformador de documento. Si has cableado un esquema pero el visor sigue ignorando el token, la causa casi siempre es un esquema mal formado en el documento en lugar de un bug del cliente, algo que rastreé de principio a fin en [por qué se ignora tu token Bearer en Scalar](/es/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/). Para el flujo equivalente por endpoint en Swagger UI, mira [cómo agregar flujos de autenticación de OpenAPI](/es/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/).

## Transformadores de operación por endpoint

No siempre quieres un cambio en cada operación. Un transformador de operación registrado en un solo endpoint se ejecuta solo para ese endpoint, vía `AddOpenApiOperationTransformer` en el builder del endpoint. Marcar una ruta como obsoleta es una sola línea:

```csharp
// .NET 11, C# 14
app.MapGet("/v1/report", GenerateReport)
   .AddOpenApiOperationTransformer((operation, context, cancellationToken) =>
   {
       operation.Deprecated = true;
       operation.Description = "Superseded by /v2/report. Removed in the next major version.";
       return Task.CompletedTask;
   });
```

Esto acota de forma limpia: sin husmear `context.Description`, sin coincidencia de rutas, solo el endpoint al que lo adjuntaste. Combina bien con agrupar endpoints, ya que un transformador adjunto a un grupo fluye a cada operación dentro de él. Mira [cómo organizar endpoints de minimal API con MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) para ese patrón.

## Generar un esquema al vuelo

A veces un transformador de operación necesita un esquema para un tipo que el endpoint no referencia de otro modo, por ejemplo un cuerpo de error compartido. Desde .NET 10, el contexto del transformador expone `GetOrCreateSchemaAsync`, que construye un esquema con la misma lógica que usa el generador, y `context.Document.AddComponent`, que lo estaciona bajo `components.schemas` para reutilizarlo:

```csharp
// .NET 11, C# 14
options.AddOperationTransformer(async (operation, context, cancellationToken) =>
{
    var errorSchema = await context.GetOrCreateSchemaAsync(
        typeof(ProblemDetails), null, cancellationToken);
    context.Document?.AddComponent("Error", errorSchema);

    operation.Responses ??= new OpenApiResponses();
    operation.Responses["4XX"] = new OpenApiResponse
    {
        Description = "Bad request.",
        Content = new Dictionary<string, OpenApiMediaType>
        {
            ["application/problem+json"] = new OpenApiMediaType
            {
                Schema = new OpenApiSchemaReference("Error", context.Document)
            }
        }
    };
});
```

Esta es la forma limpia de documentar un contrato de error consistente sin decorar cada endpoint con `Produces<ProblemDetails>`. Si estás dando forma a las respuestas de error en sí en lugar de solo documentarlas, ese es un tema aparte que maneja [IProblemDetailsService](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/).

## Cambios de tipos de Microsoft.OpenApi v2 que rompen ejemplos viejos

.NET 10 actualizó la dependencia `Microsoft.OpenApi` a v2, y el modelo de objetos cambió de maneras que no compilarán si pegas un transformador de .NET 8. Tres cambios muerden más que el resto:

**`OpenApiSchema.Type` ahora es un enum de flags, no un string.** En v1 escribías `Type = "string"` con un `Nullable = true` aparte. En v2, `Type` es un `JsonSchemaType` anulable, y la nulabilidad se expresa uniendo la flag `Null`:

```csharp
// .NET 11, Microsoft.OpenApi v2
// A nullable string:
schema.Type = JsonSchemaType.String | JsonSchemaType.Null;
```

**Los ejemplos son `JsonNode`, no `OpenApiString`.** Toda la jerarquía `IOpenApiAny` (`OpenApiString`, `OpenApiInteger`, `OpenApiObject`) fue eliminada. Asigna en su lugar un `System.Text.Json.Nodes.JsonNode`, que es por lo que el ejemplo de propiedad de arriba usó `JsonValue.Create(...)`. Para un ejemplo de objeto, construye un `JsonObject`. Esta es la única edición con más probabilidad de no compilar cuando migras filtros de esquema viejos, un punto que profundizo en la [guía de migración de Swashbuckle a la integrada](/es/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/).

**Las referencias son tipadas.** En lugar de construir a mano un `OpenApiReference`, usa `OpenApiSchemaReference("Name", document)` y `OpenApiSecuritySchemeReference("Bearer", document)`. Estas se resuelven contra el documento que pasas, lo que atrapa una referencia colgante en la construcción en lugar de en la serialización.

## Trampas que aparecen después de que el documento se ve bien

**Los transformadores de esquema pueden ejecutarse más de una vez para el mismo tipo.** Un transformador de esquema se dispara por ocurrencia de esquema, y la pasada que deduplica esquemas idénticos en `components.schemas` se ejecuta *después* de todos los transformadores. Así que un tipo usado en tres lugares puede tener su transformador de esquema invocado tres veces. Mantén la lógica idempotente: verifica antes de agregar, y nunca agregues a una lista que podrías revisitar.

**La reutilización de esquemas no es algo que controles desde un transformador.** Si un esquema se inserta en línea o se eleva a `components.schemas` lo decide el framework después de que se ejecutan los transformadores, usando `OpenApiOptions.CreateSchemaReferenceId`. Los enums siempre se referencian; para insertarlos en línea en su lugar, devuelve `null` desde ese delegado para los tipos enum:

```csharp
// .NET 11, C# 14
options.CreateSchemaReferenceId = type =>
    type.Type.IsEnum ? null : OpenApiOptions.CreateDefaultSchemaReferenceId(type);
```

**Un transformador de operación no puede ver el trabajo de un transformador de documento.** Como los documentos se ejecutan al final, no pongas un esquema en un transformador de documento e intentes referenciarlo desde un transformador de operación en la misma ejecución. Registra el esquema *y* el requisito por operación desde el mismo transformador de documento, o aplica el requisito por operación desde un transformador de documento que recorra `document.Paths` al final.

**Solo se documenta lo que ve el explorador de API.** Los transformadores dan forma a lo que existe; no pueden inventar una operación que el explorador nunca descubrió. Si un minimal API devuelve un `IResult` desnudo sin `Produces<T>`, no hay esquema de respuesta que un transformador pueda tocar. Anota el endpoint primero. Los esquemas precisos también importan aguas abajo, ya que un [generador de clientes fuertemente tipados](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) es tan bueno como el documento que le das.

El modelo mental es pequeño una vez que encaja: los esquemas se dan forma primero, las operaciones después, el documento al final, y cada transformador solo toca la capa por la que está nombrado. Elige la altitud, muta en su lugar, mantenlo idempotente, y el documento que sirves es exactamente el que tus consumidores y generadores de código esperan.

## Lecturas relacionadas

- [Cómo exponer OpenAPI sin Swashbuckle en ASP.NET Core 11](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Migra de Swashbuckle a la generación integrada de documentos OpenAPI en .NET 11](/es/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Cómo agregar flujos de autenticación de OpenAPI a Swagger UI en .NET 11](/es/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)
- [Scalar en ASP.NET Core: por qué se ignora tu token Bearer](/es/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)

## Fuentes

- [Customize OpenAPI documents, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [IOpenApiOperationTransformer, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapioperationtransformer)
- [IOpenApiSchemaTransformer, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapischematransformer)
- [Breaking change: Microsoft.OpenApi upgraded to v2, ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0)
- [Microsoft.OpenAPI v2 upgrade guide](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md)
