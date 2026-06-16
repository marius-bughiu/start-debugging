---
title: "Migrar de Swashbuckle al generador de OpenAPI integrado en .NET 11"
description: "Una migración paso a paso de Swashbuckle.AspNetCore a Microsoft.AspNetCore.OpenApi en .NET 11: cambiar AddSwaggerGen por AddOpenApi, convertir los filtros de operación, esquema y documento en transformadores, mantener una UI y los cambios incompatibles de Microsoft.OpenApi v2 que muerden."
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "migration"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore-11"
  - "dotnet-11"
lang: "es"
translationOf: "2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-16
---

Si tu proyecto de ASP.NET Core todavía llama a `builder.Services.AddSwaggerGen()` y `app.UseSwagger()`, estás usando Swashbuckle.AspNetCore, el paquete que sostuvo la historia de OpenAPI en .NET durante casi una década. Desde .NET 9 las plantillas de Web API ya no lo incluyen: un proyecto nuevo usa en su lugar el paquete propio de Microsoft, `Microsoft.AspNetCore.OpenApi`. Este artículo migra un código existente con Swashbuckle al generador integrado sobre `net11.0` con C# 14, cubriendo la parte que las guías para proyectos nuevos omiten: qué eliminar, cómo cada `IOperationFilter`, `ISchemaFilter` e `IDocumentFilter` se traduce a un transformador, cómo mantener viva una UI donde se pueda hacer clic y los cambios incompatibles de Microsoft.OpenApi v2 que no compilarán hasta que los corrijas.

Para una API pequeña con un par de filtros, esto es una tarde. Para un servicio grande con una docena de filtros personalizados, proveedores de ejemplos y varias versiones con `SwaggerDoc`, calcula un día. Swashbuckle no está obsoleto, así que esto es una decisión y no una marcha forzada. La razón para hacerlo es que el generador integrado viene en la caja, sigue el ritmo del runtime versión a versión, admite Native AOT y emite OpenAPI 3.1 de forma predeterminada. La razón para esperar es si dependes de características de la UI de Swashbuckle o de filtros de la comunidad que aún no tienen un equivalente como transformador. Decide eso antes de empezar, no a mitad de camino.

## Por qué migrar ahora

- El generador viene con el framework. Ningún paquete de terceros fijado en tu compilación que vaya por detrás de un lanzamiento de .NET, que es exactamente el dolor de .NET 6 que empujó a Microsoft a hacerse cargo de esto.
- Reutiliza el soporte de esquemas de `System.Text.Json` que el resto de tu app ya usa, de modo que los esquemas del documento coinciden con lo que tu API serializa realmente.
- Es compatible con Native AOT. La generación de Swashbuckle, cargada de reflexión, no lo es, así que un servicio de minimal API con AOT tenía que abandonar Swashbuckle de todos modos.
- OpenAPI 3.1 y JSON Schema draft 2020-12 son los valores predeterminados, no una opción que haya que activar.

## Qué se rompe

| Área | Cambio | Severidad |
| --- | --- | --- |
| `AddSwaggerGen` / `UseSwagger` | Reemplazados por `AddOpenApi` / `MapOpenApi`; ruta distinta (`/openapi/v1.json`, no `/swagger/v1/swagger.json`) | alta |
| `IOperationFilter` / `ISchemaFilter` / `IDocumentFilter` | Ya no se invocan; reescribir como `AddOperationTransformer` / `AddSchemaTransformer` / `AddDocumentTransformer` | alta |
| Swagger UI incluida | El framework genera solo JSON; tú agregas una UI (Scalar o el paquete independiente de Swagger UI) | alta |
| Namespace `Microsoft.OpenApi` | v2 mueve los tipos de `Microsoft.OpenApi.Models` a `Microsoft.OpenApi`; `OpenApiSchema` pasa a ser `IOpenApiSchema` | media |
| Ejemplos de esquema | `OpenApiString`/`IOpenApiAny` desaparecen; los ejemplos ahora son `System.Text.Json.Nodes.JsonNode` | media |
| Versión de spec predeterminada | Swashbuckle usaba OpenAPI 3.0 por defecto; el generador integrado usa 3.1 | media |
| `SwaggerDoc("v1", ...)` | Reemplazado por `AddOpenApi("v1")` más un transformador de documento para `Info` | baja |
| `[SwaggerOperation]` / `EnableAnnotations` | Reemplazados por metadatos de minimal API (`WithSummary`, `WithDescription`, `WithTags`) | baja |

## Lista de verificación previa

1. Instala el SDK de .NET 11 en cada máquina de desarrollo y runner de CI. Verifícalo con `dotnet --list-sdks` y confirma que aparece `11.0.x`.
2. Inventaría tu superficie de Swashbuckle. Busca en la solución `AddSwaggerGen`, `OperationFilter<`, `SchemaFilter<`, `DocumentFilter<`, `SwaggerDoc`, `EnableAnnotations` y `[SwaggerOperation`. La lista de filtros es el alcance real de la migración.
3. Captura un documento de referencia. Ejecuta la app y guarda `/swagger/v1/swagger.json` en un archivo. Compararás el nuevo documento contra él al final.
4. Anota cualquier consumidor atado a OpenAPI 3.0. Un generador de cliente que falla con 3.1 es la sorpresa más común, y se resuelve con una línea, más abajo.
5. Haz un commit de una base limpia para que la reversión sea un solo comando.

## Pasos de la migración

### 1. Cambia los paquetes

Elimina el paquete del generador y agrega el del framework. Si quieres conservar el aspecto de Swagger UI, mantén solo su paquete de recursos de UI, que es independiente del generador.

```dotnetcli
# .NET 11
dotnet remove package Swashbuckle.AspNetCore
dotnet add package Microsoft.AspNetCore.OpenApi
```

Si usabas `Swashbuckle.AspNetCore.Filters` (el paquete de filtros de ejemplo/auth de la comunidad), elimínalo también; sus funciones se vuelven transformadores. **Verifica:** `dotnet build` tiene éxito o falla solo por los símbolos `AddSwaggerGen`/de filtros que ahora faltan y que estás a punto de reemplazar. Una compilación limpia aquí significaría que en realidad nunca usaste Swashbuckle.

### 2. Reemplaza las dos llamadas de registro

Este es el cambio central. Swashbuckle registraba un generador y dos middlewares; la versión integrada registra un servicio y mapea un endpoint.

```csharp
// Before -- Swashbuckle, ASP.NET Core 8 style
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo { Title = "Todo API", Version = "v1" });
});

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI();
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}
```

El documento se mueve de `/swagger/v1/swagger.json` a `/openapi/v1.json`. El nombre de documento predeterminado es `v1`, de donde sale el nombre de la ruta. Fíjate en el filtro `IsDevelopment()`: un documento OpenAPI es un mapa completo de tu superficie de ataque, así que no lo sirvas a la internet pública por defecto. **Verifica:** ejecuta la app y solicita `/openapi/v1.json`. Deberías obtener un documento 3.1 que lista cada endpoint. El bloque `Info` es genérico por ahora; el paso 4 lo arregla.

### 3. Recupera una UI

Swashbuckle incluía Swagger UI, así que `/swagger` simplemente funcionaba. El generador integrado produce solo JSON. Elige un visor y apúntalo al documento. El valor predeterminado de la plantilla desde .NET 9 es Scalar:

```csharp
// .NET 11, C# 14
using Scalar.AspNetCore;

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Si tu equipo está apegado a Swagger UI, todavía funciona. Instala `Swashbuckle.AspNetCore.SwaggerUi` (solo los recursos de UI, no el generador) y apúntalo a la nueva ruta:

```csharp
// .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/openapi/v1.json", "v1");
    });
}
```

**Verifica:** navega a `/scalar` (o `/swagger`) y confirma que las operaciones se renderizan y que "Try it out" llega a tu API. Los detalles para un proyecto nuevo de cada visor están en [exponer OpenAPI sin Swashbuckle en ASP.NET Core 11](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

### 4. Mueve los metadatos del documento a un transformador

`SwaggerDoc("v1", new OpenApiInfo { ... })` establecía el título, la versión y la descripción. En el modelo integrado eso es un transformador de documento, que se ejecuta sobre el `OpenApiDocument` antes de serializarlo.

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, cancellationToken) =>
    {
        document.Info = new OpenApiInfo
        {
            Title = "Todo API",
            Version = "v1",
            Description = "Task tracking endpoints."
        };
        return Task.CompletedTask;
    });
});
```

Atención al `using`. Con Microsoft.OpenApi v2 (del que ahora dependen tanto Swashbuckle v10 como `Microsoft.AspNetCore.OpenApi`) los tipos del modelo se movieron de `Microsoft.OpenApi.Models` a `Microsoft.OpenApi`. Si copias código antiguo de `OpenApiInfo` tal cual, no resolverá. **Verifica:** recarga el documento y confirma que el bloque `info` muestra tu título y descripción.

### 5. Convierte los filtros de operación en transformadores de operación

Un `IOperationFilter` se ejecutaba una vez por operación para agregar una respuesta, un encabezado o una descripción. La firma del transformador es distinta, pero el cuerpo es casi idéntico.

```csharp
// Before -- Swashbuckle IOperationFilter
public class AddThrottleResponseFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        operation.Responses.TryAdd("429",
            new OpenApiResponse { Description = "Too Many Requests" });
    }
}
// registered: c.OperationFilter<AddThrottleResponseFilter>();
```

```csharp
// After -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    options.AddOperationTransformer((operation, context, cancellationToken) =>
    {
        operation.Responses ??= new OpenApiResponses();
        operation.Responses["429"] = new OpenApiResponse
        {
            Description = "Too Many Requests"
        };
        return Task.CompletedTask;
    });
});
```

El `OperationFilterContext` tenía `ApiDescription`; el `context` del transformador expone el mismo `ApiDescription`, así que cualquier lógica condicional basada en la ruta, el método HTTP o los metadatos se traslada igual. **Verifica:** busca un endpoint al que apuntara tu filtro y confirma que la respuesta `429` (o lo que hayas agregado) aparece en él en el documento.

### 6. Convierte los filtros de esquema y de documento

`ISchemaFilter` se vuelve `AddSchemaTransformer`. El contexto ahora te entrega un `JsonTypeInfo` en lugar de un `Type`, así que lees `context.JsonTypeInfo.Type`:

```csharp
// After -- .NET 11, C# 14
options.AddSchemaTransformer((schema, context, cancellationToken) =>
{
    if (context.JsonTypeInfo.Type == typeof(Todo))
    {
        schema.Description = "A single task tracking item.";
    }
    return Task.CompletedTask;
});
```

`IDocumentFilter` se vuelve `AddDocumentTransformer`, el mismo hook usado para `Info` en el paso 4. Úsalo para `servers`, etiquetas de nivel superior y esquemas de seguridad. Uno común es declarar un esquema Bearer para que la UI muestre un botón Authorize; puedes hacerlo en línea o con un `IOpenApiDocumentTransformer` fuertemente tipado cuando necesites inyectar servicios. **Verifica:** comprueba que la descripción del esquema (o el esquema de seguridad) aparece donde lo ponía el filtro antiguo. Si además condicionas el botón Authorize a un esquema de seguridad y el visor ignora el token en silencio, casi siempre es un esquema mal formado, algo que analicé en [por qué tu token Bearer se ignora en Scalar](/es/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

### 7. Reemplaza las anotaciones por metadatos de minimal API

Si usabas `EnableAnnotations()` y `[SwaggerOperation(Summary = "...", Description = "...")]`, quita los atributos y expresa los mismos metadatos con convenciones de endpoint. Fluyen directamente a la operación:

```csharp
// .NET 11, C# 14
app.MapGet("/todos/{id}", (int id) => Results.Ok(new Todo(id, "Write", false)))
   .WithSummary("Get a todo by id")
   .WithDescription("Returns a single todo item, or 404 if it does not exist.")
   .WithTags("Todos")
   .Produces<Todo>(StatusCodes.Status200OK)
   .Produces(StatusCodes.Status404NotFound);
```

Para controladores, los comentarios de documentación XML y los atributos `[ProducesResponseType]` que ya tienes los lee el explorador de API, así que mucho de esto es gratis. Mantener los endpoints agrupados con [MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) permite que un solo `WithTags` en el grupo etiquete cada operación de él. **Verifica:** los resúmenes y las etiquetas se renderizan en la UI, y `EnableAnnotations` ya no aparece en ninguna parte del proyecto.

### 8. Maneja varios documentos y el versionado

El `SwaggerDoc("v1", ...)` / `SwaggerDoc("v2", ...)` repetido de Swashbuckle se vuelve llamadas repetidas a `AddOpenApi`, cada una con su propio nombre y opciones. Qué endpoints van a qué documento lo decide `ShouldInclude`:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public", options =>
{
    options.ShouldInclude = description =>
        description.GroupName is null || description.GroupName == "public";
});
builder.Services.AddOpenApi("internal");
```

Cada nombre obtiene su propia ruta: `/openapi/public.json` y `/openapi/internal.json`. Si usas `Asp.Versioning`, se integra con este modelo de documentos en lugar de pelear contra él. **Verifica:** solicita cada ruta de documento y confirma que en cada una aparecen los endpoints correctos.

## Verificación

Ejecuta esta lista antes de eliminar la ruta de código antigua:

- `dotnet build` está limpio, con cero advertencias, incluidas referencias residuales a `Microsoft.OpenApi.Models`.
- `dotnet test` pasa, en especial cualquier prueba de contrato que fijara la ruta antigua `/swagger/v1/swagger.json`; actualízalas a `/openapi/v1.json`.
- Compara el nuevo `/openapi/v1.json` con la referencia que guardaste en la verificación previa. Espera que la línea de versión cambie de `3.0.x` a `3.1.x` y que el manejo de `nullable` en los esquemas difiera; todo lo demás debería coincidir operación por operación.
- Cada endpoint que tocaban tus filtros antiguos sigue teniendo las mismas respuestas, encabezados y descripciones.
- La UI carga y "Try it out" llega a un endpoint real.
- Si generas un cliente a partir del spec, regéneralo y confirma que sigue compilando. Consulta [generar un cliente fuertemente tipado a partir de un spec de OpenAPI](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/).

## Plan de reversión

Esta migración es reversible hasta que empieces a eliminar las clases de filtro. Para revertir, `dotnet remove package Microsoft.AspNetCore.OpenApi`, vuelve a agregar `Swashbuckle.AspNetCore` y restaura `AddSwaggerGen` / `UseSwagger` / `UseSwaggerUI`. Como las reescrituras de filtro a transformador son ediciones en el lugar, el commit limpio de la verificación previa es tu verdadera reversión: haz `git checkout` del commit y vuelves a Swashbuckle en un paso. Haz la migración en una rama y conserva el commit de referencia hasta que el nuevo documento haya corrido en un entorno real.

## Tropiezos que tuvimos

**El valor predeterminado de OpenAPI 3.1 rompe el tooling que solo entiende 3.0.** Este es el ticket posmigración más común. Si un generador descendente rechaza el documento, baja la versión explícitamente en lugar de revertir toda la migración:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0;
});
```

**Los ejemplos de esquema ahora son `JsonNode`, no `OpenApiString`.** Microsoft.OpenApi v2 eliminó la jerarquía `IOpenApiAny`. Si un filtro de esquema establecía `schema.Example = new OpenApiString("...")`, el equivalente del transformador asigna un `System.Text.Json.Nodes.JsonNode`, por ejemplo `JsonValue.Create("...")` o un `JsonObject`. Esta es la edición que más probablemente no compile durante la reescritura.

**El documento se regenera en cada solicitud.** `MapOpenApi` ejecuta el pipeline completo cada vez que se golpea el endpoint, a propósito, para que los transformadores puedan reaccionar al estado en vivo. Para un documento muy solicitado, cachéalo con `.CacheOutput()` en el endpoint, o genéralo en tiempo de compilación con `Microsoft.Extensions.ApiDescription.Server` y sirve un archivo estático. La generación en tiempo de compilación ejecuta tu `Program.cs`, así que protege el código de arranque (como abrir una conexión a la base de datos) según el nombre del ensamblado de entrada cuando no deba ejecutarse durante la compilación.

**Los esquemas inferidos son más estrictos que los de Swashbuckle.** El generador integrado solo documenta lo que ve el explorador de API. Si un endpoint mínimo devuelve `IResult` sin una sobrecarga tipada o una llamada a `Produces<T>`, el esquema de respuesta falta. Swashbuckle a veces tapaba esto con reflexión; el nuevo generador quiere la anotación. Agrega `Produces<T>` y `Accepts<T>` donde el esquema desaparezca.

**`OpenApiSchema` ahora es una interfaz.** El código que declaraba `OpenApiSchema schema` como parámetro o variable local puede necesitar `IOpenApiSchema`, y la propiedad `Nullable` desapareció en favor de `JsonSchemaType.Null`. Si escribiste filtros de esquema elaborados, aquí es donde aterrizan la mayoría de los errores de compilación.

El modelo mental es pequeño una vez que encaja: el framework es dueño del documento, los transformadores reemplazan a los filtros y la UI es una preocupación aparte e intercambiable. El grueso del trabajo son las reescrituras de filtro a transformador y los cambios de namespace y tipos de Microsoft.OpenApi v2; el cambio de registro en sí son dos líneas.

## Lecturas relacionadas

- [Cómo exponer OpenAPI sin Swashbuckle en ASP.NET Core 11](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Cómo generar código de cliente fuertemente tipado a partir de un spec de OpenAPI en .NET 11](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Scalar en ASP.NET Core: por qué tu token Bearer se ignora](/es/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Migrar de .NET 8 a .NET 11: la lista completa](/es/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Fuentes

- [Generate OpenAPI documents, documentación de ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- [Customize OpenAPI documents, documentación de ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [Swashbuckle.AspNetCore migrating to v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Microsoft.AspNetCore.OpenApi en NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.OpenApi/)
- [Microsoft.Extensions.ApiDescription.Server en NuGet](https://www.nuget.org/packages/Microsoft.Extensions.ApiDescription.Server)
</content>
