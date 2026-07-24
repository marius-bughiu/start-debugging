---
title: "Migrar IOperationFilter e ISchemaFilter de Swashbuckle a transformadores de OpenAPI en .NET 11"
description: "Una referencia de migración filtro por filtro para pasar el código de IOperationFilter e ISchemaFilter de Swashbuckle a los transformadores de operación y esquema integrados en .NET 11, con el mapeo de los objetos de contexto y los cambios de Microsoft.OpenApi v2 que rompen la compilación."
pubDate: 2026-07-24
updatedDate: 2026-07-24
template: migration
tags:
  - "migration"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore-11"
  - "dotnet-11"
lang: "es"
translationOf: "2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-24
---

Si ya cambiaste `AddSwaggerGen()` por `AddOpenApi()` en `net11.0`, el registro es la parte fácil. El trabajo que de verdad consume la tarde son tus filtros personalizados: cada `IOperationFilter` e `ISchemaFilter` que escribiste contra Swashbuckle deja de invocarse en cuanto cambia el generador, porque el generador integrado `Microsoft.AspNetCore.OpenApi` no tiene concepto de filtros. Tiene transformadores. Este artículo es la referencia de migración filtro por filtro: cómo se mapean las dos interfaces de filtro a `IOpenApiOperationTransformer` e `IOpenApiSchemaTransformer`, en qué se convierte cada propiedad de contexto, y los cambios de tipos de Microsoft.OpenApi v2 que no compilarán hasta que los corrijas. Apunta a .NET 11 (`net11.0`, C# 14), `Microsoft.AspNetCore.OpenApi` v11 y `Microsoft.OpenApi` v2, migrando desde Swashbuckle.AspNetCore v10.

Para un puñado de filtros esto lleva menos de una hora. Para un servicio grande con una docena de filtros, un proveedor de ejemplos y un filtro de polimorfismo, calcula media jornada. La forma mecánica de cada migración es casi idéntica, así que el costo no es la reescritura: son los dos objetos de contexto que exponen información distinta, y los cambios en el modelo de tipos de Microsoft.OpenApi v2. Si todavía no hiciste el cambio de registro que lo rodea, hazlo primero con [la guía completa de migración de Swashbuckle a la integrada](/es/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/); todo lo que sigue asume que `AddOpenApi()` y `MapOpenApi()` ya están en su lugar.

## Por qué migrar los filtros

- Los filtros son código muerto en cuanto sueltas el generador de Swashbuckle. Compilan (los tipos siguen existiendo mientras se referencie el paquete) pero nunca se ejecutan, así que tu documento pierde en silencio cada personalización que aplicaban.
- Los transformadores reutilizan los mismos metadatos de `System.Text.Json` con los que serializa el resto de tu aplicación, así que un transformador de esquema ve exactamente la forma de tipo que emite tu API, no una aproximación por reflexión.
- Los transformadores son compatibles con Native AOT. La canalización de filtros de Swashbuckle, basada en reflexión, no lo es, así que un servicio AOT no tiene ninguna opción de filtros.
- Un solo modelo de extensibilidad cubre documento, operación y esquema en lugar de tres interfaces de filtro más atributos de anotación.

## Qué se rompe

| Área | Swashbuckle | Integrado en .NET 11 | Severidad |
| --- | --- | --- | --- |
| Enganche de operación | `IOperationFilter.Apply(OpenApiOperation, OperationFilterContext)` | `IOpenApiOperationTransformer.TransformAsync(...)` | alta |
| Enganche de esquema | `ISchemaFilter.Apply(OpenApiSchema, SchemaFilterContext)` | `IOpenApiSchemaTransformer.TransformAsync(...)` | alta |
| Firma del método | `void Apply` síncrono | `Task TransformAsync(..., CancellationToken)` | media |
| Registro | `c.OperationFilter<T>(args)` / `c.SchemaFilter<T>(args)` | `options.AddOperationTransformer<T>()` / `AddSchemaTransformer<T>()` | media |
| Ejemplos de esquema | `OpenApiString` / `IOpenApiAny` | `System.Text.Json.Nodes.JsonNode` | media |
| Campo de tipo del esquema | `schema.Type = "string"` cadena + `Nullable` | enum de flags `JsonSchemaType`, flag `Null` | media |
| Miembro por reflexión | `context.MemberInfo` (`MemberInfo`) | `context.JsonPropertyInfo` (`JsonPropertyInfo`) | media |
| Generación de subesquemas | `context.SchemaGenerator.GenerateSchema(...)` | `context.GetOrCreateSchemaAsync(...)` | baja |

## Lista de verificación previa

1. Confirma que el SDK de .NET 11 está instalado en cada máquina de desarrollo y runner de CI: `dotnet --list-sdks` debería listar `11.0.x`.
2. Inventaría los filtros. Busca en la solución `IOperationFilter`, `ISchemaFilter`, `IDocumentFilter`, `OperationFilter<` y `SchemaFilter<`. Esa lista es el alcance exacto de esta migración; nada más cambia aquí.
3. Guarda un documento de referencia. Con Swashbuckle todavía conectado, solicita `/swagger/v1/swagger.json` y conserva el archivo. Compararás el documento migrado contra él, endpoint por endpoint.
4. Confirma que `AddOpenApi()` y `MapOpenApi()` ya producen un documento en `/openapi/v1.json`. Si no, migra el registro primero.
5. Haz el trabajo en una rama con un commit base limpio para que la reversión sea un solo `git checkout`.

## Los dos objetos de contexto, mapeados

Antes de las recetas, el mapeo que hace mecánica cada migración. Un filtro de Swashbuckle y un transformador integrado te entregan el mismo objeto OpenAPI para mutar (`OpenApiOperation` u `OpenApiSchema`), pero el contexto alrededor difiere.

`OperationFilterContext` a `OpenApiOperationTransformerContext`:

| Swashbuckle | Integrado | Notas |
| --- | --- | --- |
| `ApiDescription` | `Description` | El mismo tipo `ApiDescription`; propiedad renombrada. La ruta, el método y `ActionDescriptor.EndpointMetadata` se conservan. |
| `MethodInfo` | `Description.ActionDescriptor` | Lee los metadatos del descriptor en lugar del `MethodInfo` crudo. |
| `SchemaRepository` | `Document` | Registra esquemas compartidos con `Document.AddComponent(...)`. |
| `SchemaGenerator` | `GetOrCreateSchemaAsync(...)` | Ahora un método del contexto, no un objeto generador aparte. |
| `DocumentName` | `DocumentName` | Sin cambios. |

`SchemaFilterContext` a `OpenApiSchemaTransformerContext`:

| Swashbuckle | Integrado | Notas |
| --- | --- | --- |
| `Type` | `JsonTypeInfo.Type` | El `Type` de CLR está un salto más abajo, dentro de los metadatos de `System.Text.Json`. |
| `MemberInfo` | `JsonPropertyInfo` | No nulo solo para un esquema de propiedad. Lee los atributos vía `JsonPropertyInfo.AttributeProvider`. |
| `ParameterInfo` | `ParameterDescription` | Un `ApiParameterDescription`; nulo para un esquema de respuesta. |
| `SchemaGenerator` | `GetOrCreateSchemaAsync(...)` | Igual que arriba. |
| `DocumentName` | `DocumentName` | Sin cambios. |

Mantén estas dos tablas abiertas mientras migras. El noventa por ciento de cada reescritura es renombrar una propiedad de contexto y ajustar para `JsonTypeInfo`.

## Pasos de la migración

### 1. Mapea cada filtro a su interfaz de transformador y su registro

Cada `IOperationFilter` se convierte en un `IOpenApiOperationTransformer` (o un delegado inline `AddOperationTransformer`), y cada `ISchemaFilter` se convierte en un `IOpenApiSchemaTransformer`. Un `void Apply` síncrono se convierte en un `TransformAsync` asíncrono que devuelve un `Task` y toma un `CancellationToken`. El registro pasa del callback de `AddSwaggerGen` al bloque de opciones de `AddOpenApi`.

```csharp
// Before -- Swashbuckle registration, ASP.NET Core 8 style
builder.Services.AddSwaggerGen(c =>
{
    c.OperationFilter<AddCorrelationHeaderFilter>();
    c.SchemaFilter<MarkMoneyFormatFilter>();
});
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer<AddCorrelationHeaderTransformer>();
    options.AddSchemaTransformer<MarkMoneyFormatTransformer>();
});
```

**Verifica:** el proyecto todavía compila con las viejas clases de filtro eliminadas o renombradas, y `AddOpenApi` compila con los nuevos registros. Nada se ejecuta correctamente aún; los siguientes pasos rellenan los cuerpos.

### 2. Migra un IOperationFilter que agrega una respuesta o un encabezado

Este es el filtro más común y la migración más mecánica. El cuerpo apenas cambia: mutas `operation` en el sitio. Protégete contra una colección `Parameters` o `Responses` nula, que el modelo integrado deja en nulo en lugar de preasignarla.

```csharp
// Before -- Swashbuckle IOperationFilter
public class AddCorrelationHeaderFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        operation.Parameters ??= new List<OpenApiParameter>();
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Schema = new OpenApiSchema { Type = "string" }
        });
    }
}
```

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class AddCorrelationHeaderTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = "X-Correlation-Id",
            In = ParameterLocation.Header,
            Required = false,
            Schema = new OpenApiSchema { Type = JsonSchemaType.String }
        });
        return Task.CompletedTask;
    }
}
```

Dos cambios más allá de la firma: `Type = "string"` se convierte en `Type = JsonSchemaType.String` (el tipo del esquema es un enum de flags en Microsoft.OpenApi v2, no una cadena), y el espacio de nombres de `OpenApiParameter` y compañía es `Microsoft.OpenApi`, no `Microsoft.OpenApi.Models`. **Verifica:** solicita `/openapi/v1.json` y confirma que cada operación ahora lleva el parámetro de encabezado `X-Correlation-Id`.

### 3. Migra un IOperationFilter que lee el endpoint

Los filtros condicionales basados en ruta, método HTTP o metadatos son donde importaba `OperationFilterContext`. El `ApiDescription` que lees es el mismo tipo; se expone como `context.Description`. El patrón de olfatear `EndpointMetadata` en busca de un atributo se conserva textualmente.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.OpenApi;

internal sealed class ThrottleResponseTransformer : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
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
    }
}
```

Si tu viejo filtro recurría a `context.MethodInfo` para leer un atributo personalizado, prefiere `context.Description.ActionDescriptor.EndpointMetadata` en su lugar, ya que los endpoints de minimal API exponen sus metadatos ahí y pueden no tener un `MethodInfo` significativo. **Verifica:** elige un endpoint que lleve el atributo de límite de tasa y uno que no, y confirma que solo el primero muestra una respuesta `429` en el documento.

### 4. Migra un ISchemaFilter que da forma a un tipo

El cuerpo del filtro de esquema cambia en exactamente un punto: `context.Type` se convierte en `context.JsonTypeInfo.Type`. Todo lo que le hacías a `schema` permanece igual.

```csharp
// Before -- Swashbuckle ISchemaFilter
public class DescribeTodoFilter : ISchemaFilter
{
    public void Apply(OpenApiSchema schema, SchemaFilterContext context)
    {
        if (context.Type == typeof(Todo))
        {
            schema.Description = "A single task tracking item.";
        }
    }
}
```

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class DescribeTodoTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.JsonTypeInfo.Type == typeof(Todo))
        {
            schema.Description = "A single task tracking item.";
        }
        return Task.CompletedTask;
    }
}
```

**Verifica:** encuentra el esquema `Todo` bajo `components.schemas` en el documento y confirma que la descripción está presente.

### 5. Migra un ISchemaFilter que apunta a una propiedad

Swashbuckle te decía que un esquema era un esquema de propiedad entregándote un `context.MemberInfo` no nulo. El equivalente integrado es un `context.JsonPropertyInfo` no nulo. Como el generador integrado está impulsado por `System.Text.Json`, `JsonPropertyInfo.Name` es el nombre JSON serializado (ya en camelCase si esa es tu política), no el nombre del miembro CLR, lo que elimina toda una clase de errores de discordancia de mayúsculas.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class EmailFormatTransformer : IOpenApiSchemaTransformer
{
    public Task TransformAsync(
        OpenApiSchema schema,
        OpenApiSchemaTransformerContext context,
        CancellationToken cancellationToken)
    {
        if (context.JsonPropertyInfo?.Name == "email")
        {
            schema.Format = "email";
        }
        return Task.CompletedTask;
    }
}
```

Si tu viejo filtro leía un atributo personalizado del `MemberInfo`, obtenlo a través de `context.JsonPropertyInfo?.AttributeProvider?.GetCustomAttributes(...)`, que expone el `PropertyInfo` subyacente. **Verifica:** confirma que cada propiedad `email` a lo largo de tus esquemas ahora lleva `"format": "email"`.

### 6. Migra un proveedor de ejemplos

Los ejemplos de esquema son lo más probable que no compile. Microsoft.OpenApi v2 eliminó toda la jerarquía `IOpenApiAny` (`OpenApiString`, `OpenApiInteger`, `OpenApiObject`). Los ejemplos ahora son `System.Text.Json.Nodes.JsonNode`.

```csharp
// Before -- Swashbuckle, IOpenApiAny example
schema.Example = new OpenApiString("dev@example.com");
```

```csharp
// After -- .NET 11, C# 14
using System.Text.Json.Nodes;

schema.Example = JsonValue.Create("dev@example.com");
```

Para un ejemplo compuesto, construye un `JsonObject` en lugar de un `OpenApiObject`: `new JsonObject { ["id"] = 1, ["title"] = "Write" }`. **Verifica:** el campo `example` del esquema objetivo se renderiza como JSON válido en el documento y en tu interfaz.

### 7. Migra un filtro que necesitaba argumentos de constructor o servicios

Swashbuckle te dejaba pasar argumentos de constructor en el registro (`c.OperationFilter<T>(arg1, arg2)`) o resolver servicios porque los filtros se activaban desde el contenedor. El registro genérico integrado `options.AddOperationTransformer<T>()` activa el transformador desde la inyección de dependencias, así que inyecta mediante un constructor primario en lugar de pasar argumentos posicionales.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class TosLinkTransformer(IOptions<ApiInfoOptions> options)
    : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
    {
        operation.ExternalDocs = new OpenApiExternalDocs
        {
            Url = options.Value.TermsOfServiceUrl
        };
        return Task.CompletedTask;
    }
}
```

Solo la sobrecarga genérica participa en la inyección de dependencias; `AddOperationTransformer(new T(...))` y la sobrecarga de delegado no. La forma genérica se resuelve nueva por cada generación del documento y se libera después, así que un transformador `IDisposable` se limpia cada vez que se construye el documento. **Verifica:** el valor inyectado aparece en el documento, y el transformador se resuelve sin un error de "no service for type" en la primera solicitud.

### 8. Migra un filtro que generaba subesquemas

Los filtros más delicados llamaban a `context.SchemaGenerator.GenerateSchema(type, context.SchemaRepository)` para construir un esquema de un tipo que la operación no referenciaba de otro modo, por ejemplo un cuerpo de error compartido. El reemplazo integrado es `context.GetOrCreateSchemaAsync(...)` más `context.Document.AddComponent(...)`.

```csharp
// After -- .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

internal sealed class ErrorResponseTransformer : IOpenApiOperationTransformer
{
    public async Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken cancellationToken)
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
    }
}
```

Fíjate en el tipado `OpenApiSchemaReference("Error", context.Document)` en lugar de un `OpenApiReference` construido a mano. **Verifica:** el esquema `Error` aparece una vez bajo `components.schemas` y las operaciones lo referencian en lugar de incrustar una copia. La mecánica de transformador-primero de `GetOrCreateSchemaAsync` se cubre en profundidad en [personalizar OpenAPI con transformadores de operación y esquema](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Verificación

Ejecuta esto antes de eliminar las viejas clases de filtro:

- `dotnet build` está limpio, sin referencias a `Microsoft.OpenApi.Models` ni a las interfaces de filtro de `Swashbuckle.AspNetCore.SwaggerGen`.
- Compara el `/openapi/v1.json` migrado contra la referencia que guardaste en la verificación previa. Espera que la versión de la especificación y el manejo de `nullable` difieran (3.1 vs 3.0); cada respuesta, encabezado, descripción y ejemplo que producían tus filtros debería coincidir operación por operación.
- Cada propiedad a la que apuntaba un filtro de esquema todavía muestra el mismo formato, ejemplo o descripción.
- `dotnet test` pasa, incluyendo cualquier prueba de contrato que verificara la forma del documento.
- Si alimentas el documento a un generador de clientes, regenéralo y confirma que todavía compila. Ver [generar código de cliente fuertemente tipado desde una especificación OpenAPI](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## Plan de reversión

Esta migración es reversible hasta que elimines las clases de filtro. Como cada reescritura es una nueva clase de transformador junto al viejo filtro, la reversión más segura es el commit base limpio de la verificación previa: haz `git checkout` del commit y vuelve a agregar `c.OperationFilter<T>()` / `c.SchemaFilter<T>()` en el bloque de `AddSwaggerGen`. Mantén tanto los filtros como los transformadores en el árbol hasta que el documento migrado se haya ejecutado en un entorno real, luego elimina los filtros en un commit aparte.

## Escollos con los que topamos

**Los transformadores de esquema se ejecutan más de una vez para el mismo tipo.** Un transformador de esquema se dispara por cada aparición del esquema, y la pasada que deduplica esquemas idénticos hacia `components.schemas` corre después de los transformadores. Un tipo usado en tres lugares tiene su transformador invocado tres veces, así que mantén la lógica idempotente: verifica antes de agregar, y nunca agregues a una lista que podrías revisitar. El `ISchemaFilter` de Swashbuckle tenía un filo relacionado (no se invocaba para esquemas ya referenciados), así que no asumas que el conteo de invocaciones viejo se conserva.

**El orden de ejecución es esquemas, luego operaciones, luego documentos.** Los filtros en Swashbuckle corrían en orden de registro dentro de cada tipo. La canalización integrada ejecuta primero todos los transformadores de esquema, luego los de operación, luego los de documento, y corre por cada generación del documento. Un transformador de operación no puede depender de que un transformador de documento haya corrido, porque los documentos corren al final. Esto hace tropezar a quien puso un esquema de seguridad en un transformador de documento e intentó referenciarlo desde un transformador de operación en la misma pasada.

**`context.Type` ahora está a dos saltos.** El error de compilación más común tras un buscar-y-reemplazar masivo es dejar `context.Type` en un transformador de esquema. Es `context.JsonTypeInfo.Type`. Un cercano segundo es `context.MemberInfo`, que es `context.JsonPropertyInfo`.

**El documento se regenera en cada solicitud.** `MapOpenApi` ejecuta toda la canalización de transformadores cada vez que se golpea la ruta, así que mantén los transformadores baratos. Para un documento con mucho tráfico, cachéalo con `.CacheOutput()` en el endpoint o genéralo en tiempo de compilación. Swashbuckle cacheaba de forma más agresiva, así que un filtro pesado que antes estaba bien puede aparecer ahora como latencia.

**`OpenApiSchema` es un tipo concreto en el transformador, pero `IOpenApiSchema` aparece en otras partes.** El delegado del transformador te entrega un `OpenApiSchema` mutable. Otras APIs de v2 devuelven `IOpenApiSchema`, así que un método auxiliar que solía tomar `OpenApiSchema` puede necesitar la interfaz. Si conectaste un esquema de seguridad mediante un transformador de documento y el visor ignora el token, eso casi siempre es un esquema mal formado y no un error del cliente, rastreado de punta a punta en [por qué se ignora tu token Bearer en Scalar](/es/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

El modelo mental es pequeño una vez que encaja: un filtro y un transformador ambos te entregan el mismo objeto OpenAPI para mutar, así que el cuerpo apenas cambia. La migración es renombrar propiedades de contexto, cambiar a `JsonTypeInfo`, mover los ejemplos a `JsonNode` y mantener la lógica de esquema idempotente porque ahora corre más de una vez. Hazlo filtro por filtro, compara contra la referencia, y el documento que sirves es el que tus consumidores ya esperan.

## Lecturas relacionadas

- [Migrar de Swashbuckle al generador de OpenAPI integrado en .NET 11](/es/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Cómo personalizar OpenAPI con transformadores de operación y esquema en ASP.NET Core 11](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Cómo exponer OpenAPI sin Swashbuckle en ASP.NET Core 11](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Scalar en ASP.NET Core: por qué se ignora tu token Bearer](/es/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)

## Fuentes

- [Personalizar documentos OpenAPI, documentación de ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [OpenApiSchemaTransformerContext, referencia de la API de .NET](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.openapischematransformercontext)
- [IOpenApiOperationTransformer, referencia de la API de .NET](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.openapi.iopenapioperationtransformer)
- [Swashbuckle.AspNetCore, migración a v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Guía de actualización de Microsoft.OpenAPI v2](https://github.com/microsoft/OpenAPI.NET/blob/main/docs/upgrade-guide-2.md)
