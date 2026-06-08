---
title: "Cómo exponer OpenAPI sin Swashbuckle en ASP.NET Core 11"
description: "Swashbuckle ya no está en las plantillas de ASP.NET Core. Así se genera y se sirve un documento OpenAPI en .NET 11 con el paquete integrado Microsoft.AspNetCore.OpenApi: AddOpenApi, MapOpenApi, transformadores, varios documentos, generación en tiempo de compilación y una interfaz encima."
pubDate: 2026-06-08
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
lang: "es"
translationOf: "2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-08
---

Si creaste una Web API de ASP.NET Core hace poco y fuiste a buscar `AddSwaggerGen` y `UseSwagger`, no estaban ahí. Desde .NET 9, las plantillas de Web API incluyen el generador de OpenAPI propio de Microsoft en lugar de Swashbuckle. Para exponer un documento OpenAPI en .NET 11 instalas `Microsoft.AspNetCore.OpenApi`, llamas a `builder.Services.AddOpenApi()` y llamas a `app.MapOpenApi()`. Eso sirve el documento en `/openapi/v1.json`. No hay interfaz incluida: si quieres una página interactiva, agregas Scalar o Swagger UI por separado y lo apuntas a ese endpoint JSON. Todo lo de abajo apunta a .NET 11 con `Microsoft.NET.Sdk.Web` y C# 14, pero la misma API existe en .NET 9 y 10.

## Por qué Swashbuckle salió de la plantilla

Swashbuckle.AspNetCore fue durante años la historia predeterminada de OpenAPI, pero era un paquete de terceros fijado en las plantillas oficiales, y se retrasaba mucho respecto a las versiones de .NET. La era de .NET 6 es el ejemplo de advertencia: el mantenimiento de Swashbuckle se estancó, el paquete se quedó sin una versión estable que apuntara al runtime más reciente, y los equipos que actualizaban a una nueva versión de .NET quedaban esperando una dependencia que no controlaban. Microsoft decidió que la generación de OpenAPI era lo bastante esencial como para incluirla en la caja, igual que el serializador JSON y el contenedor de inyección de dependencias.

El resultado es `Microsoft.AspNetCore.OpenApi`. Genera documentos [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.1.html) de forma predeterminada, usa [JSON Schema draft 2020-12](https://json-schema.org/specification-links#2020-12), reutiliza el soporte de esquemas de `System.Text.Json` en el que ya se apoya el resto del framework y es compatible con Native AOT. Lo único que deliberadamente no hace es renderizar una interfaz. Swashbuckle empaquetaba a la vez el generador de documentos y los recursos web de Swagger UI; Microsoft separó esas responsabilidades. El framework produce la especificación y tú eliges el visor.

## Las dos llamadas que generan el documento

Agrega el paquete:

```dotnetcli
dotnet add package Microsoft.AspNetCore.OpenApi
```

Luego registra los servicios y mapea el endpoint:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.MapGet("/todos/{id}", (int id) => new Todo(id, "Write the spec", false));

app.Run();

record Todo(int Id, string Title, bool Done);
```

Ejecuta la aplicación y solicita `https://localhost:{port}/openapi/v1.json`. Obtienes un documento OpenAPI 3.1 completo que describe cada endpoint que el explorador de API puede ver, con esquemas inferidos a partir de los tipos de tus parámetros y de retorno. `AddOpenApi()` registra los servicios del documento y `MapOpenApi()` agrega el route handler que serializa el documento bajo demanda.

El nombre de documento predeterminado es `v1`, por eso la ruta es `/openapi/v1.json`. La plantilla de ruta de `MapOpenApi` es `/openapi/{documentName}.json`. Dos cosas merecen atención en el fragmento de arriba. Primero, el endpoint del documento está protegido detrás de `IsDevelopment()`. Esa es la propia recomendación del framework: un documento OpenAPI es un mapa completo de tu superficie de ataque, así que no lo sirvas a la internet pública de forma predeterminada. Segundo, todavía no hay interfaz. Acceder a `/openapi/v1.json` te da JSON crudo, que es exactamente lo que quieren las herramientas pero no lo que un humano quiere recorrer haciendo clic.

## Trae tu propia interfaz

Esta es la parte que confunde a quienes vienen de Swashbuckle, donde `/swagger` simplemente funcionaba. En .NET 11 eliges un visor y lo conectas a la ruta del documento.

La plantilla predeterminada desde .NET 9 se inclina por Scalar. Instala `Scalar.AspNetCore` y mapéalo:

```csharp
// .NET 11, C# 14
using Scalar.AspNetCore;

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Navega a `https://localhost:{port}/scalar` y obtienes una interfaz de referencia interactiva que lee el documento `/openapi/v1.json`. Scalar detecta automáticamente la ruta estándar, así que no hay nada más que configurar para el caso común.

Si tu equipo está apegado a Swagger UI, sigue funcionando. Instala `Swashbuckle.AspNetCore.SwaggerUi` (solo los recursos de la interfaz, no el generador) y apúntalo al documento:

```csharp
// .NET 11, C# 14
var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();

    app.UseSwaggerUI(options =>
    {
        options.SwaggerEndpoint("/openapi/v1.json", "v1");
    });
}
```

Eso sirve Swagger UI en `/swagger`, leyendo el documento generado por el framework en lugar de uno generado por Swashbuckle. ReDoc funciona de la misma forma: sirve la interfaz estática y dale la URL `/openapi/v1.json`. Al framework no le importa qué visor uses porque solo es dueño del JSON. Como nota de seguridad, mantén las tres interfaces detrás de una comprobación de solo desarrollo por la misma razón por la que proteges el propio documento.

## Agrega títulos, descripciones y metadatos

Un documento básico tiene un título genérico y ninguna descripción. Lo enriqueces en dos lugares: metadatos por endpoint y transformadores a nivel de documento.

Los metadatos por endpoint usan las mismas convenciones de minimal API que ya usas para el enrutamiento. `WithSummary`, `WithDescription` y `WithTags` fluyen directamente a la operación:

```csharp
// .NET 11, C# 14
app.MapGet("/todos/{id}", (int id) => Results.Ok(new Todo(id, "Write", false)))
   .WithSummary("Get a todo by id")
   .WithDescription("Returns a single todo item, or 404 if it does not exist.")
   .WithTags("Todos")
   .Produces<Todo>(StatusCodes.Status200OK)
   .Produces(StatusCodes.Status404NotFound);
```

Para información a nivel de documento como el título de la API, la versión y el contacto, registra un transformador de documento. Un transformador se ejecuta sobre el `OpenApiDocument` generado antes de que se serialice, así que puedes establecer o reescribir cualquier cosa:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi.Models;

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, context, cancellationToken) =>
    {
        document.Info = new OpenApiInfo
        {
            Title = "Todo API",
            Version = "v1",
            Description = "Task tracking endpoints for the Start Debugging sample.",
            Contact = new OpenApiContact { Name = "API team", Email = "api@example.com" }
        };
        return Task.CompletedTask;
    });
});
```

Los transformadores son el punto de extensión que reemplaza la mayoría de lo que hacías con los filtros de Swashbuckle. Hay tres tipos, y se ejecutan en el orden en que los registras:

- `AddDocumentTransformer` modifica el documento completo. Úsalo para `Info`, `servers`, esquemas de seguridad de nivel superior y etiquetas.
- `AddOperationTransformer` se ejecuta una vez por operación. Úsalo para agregar una respuesta común, un parámetro de encabezado o una descripción a cada endpoint.
- `AddSchemaTransformer` se ejecuta una vez por esquema generado. Úsalo para agregar ejemplos, ajustar formatos o marcar propiedades.

Una tarea real común es declarar un esquema de seguridad Bearer para que la interfaz muestre un botón de Authorize. Eso es un transformador de documento que agrega el esquema y un requisito global. Si te has topado con el caso en que el visor ignora el token de forma silenciosa, la causa casi siempre es un esquema de seguridad ausente o mal formado en el documento, lo cual cubrí en detalle en [por qué se ignora tu token Bearer en Scalar](/es/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

Para un transformador fuertemente tipado implementas `IOpenApiDocumentTransformer` (o los equivalentes de operación y esquema) y registras el tipo. Eso te permite inyectar servicios, por ejemplo para leer los esquemas de autenticación registrados y emitir definiciones de seguridad coincidentes:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi.Models;

internal sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken cancellationToken)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header
        };
        return Task.CompletedTask;
    }
}

// Registration
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});
```

## Genera más de un documento

Swashbuckle manejaba "v1 y v2" o "público e interno" con varias llamadas a `SwaggerDoc`. El generador integrado lo hace con varias llamadas a `AddOpenApi`, cada una con su propio nombre y opciones:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public");
builder.Services.AddOpenApi("internal");
```

Cada documento con nombre obtiene su propia ruta: `/openapi/public.json` y `/openapi/internal.json`. Qué endpoints caen en qué documento lo decide el delegado `ShouldInclude` en `OpenApiOptions`. De forma predeterminada usa el nombre de grupo del endpoint, establecido con `WithGroupName` o el atributo `[EndpointGroupName]`, y cualquier endpoint sin nombre de grupo se incluye en todos los documentos. Puedes reemplazar `ShouldInclude` con cualquier predicado sobre el `ApiDescription`:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("public", options =>
{
    options.ShouldInclude = description =>
        description.GroupName is null || description.GroupName == "public";
});
```

Si tienes en marcha el versionado de API, las bibliotecas de versionado se integran con este mismo modelo de documento en lugar de pelear contra él, lo cual es una mejora real respecto a la configuración anterior. Consulta [Asp.Versioning con OpenAPI integrado](/es/2026/04/api-versioning-openapi-dotnet-10/) para el patrón de un documento por versión.

## Genera el documento en tiempo de compilación

Servir el documento sobre HTTP está bien para desarrollo, pero a veces quieres el archivo JSON como artefacto de compilación: para confirmarlo en el control de versiones, para ejecutar pruebas de contrato contra él, para alimentar un [generador de código de cliente](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/), o para servirlo como archivo estático en producción en lugar de exponer un endpoint en vivo. Para eso, agrega el paquete de tiempo de compilación:

```dotnetcli
dotnet add package Microsoft.Extensions.ApiDescription.Server
```

Con el paquete instalado, `dotnet build` emite el documento en `obj/` con el nombre del proyecto. Para controlar dónde aterriza y si se genera, establece propiedades de MSBuild en el `.csproj`:

```xml
<PropertyGroup>
  <OpenApiGenerateDocuments>true</OpenApiGenerateDocuments>
  <OpenApiDocumentsDirectory>$(MSBuildProjectDirectory)</OpenApiDocumentsDirectory>
</PropertyGroup>
```

`OpenApiDocumentsDirectory` se resuelve relativo al archivo de proyecto, así que el valor de arriba deja el JSON junto al `.csproj`. Para renombrar el archivo o seleccionar un solo documento cuando generas varios, usa `OpenApiGenerateDocumentsOptions`:

```xml
<PropertyGroup>
  <OpenApiGenerateDocumentsOptions>--file-name my-api --document-name public</OpenApiGenerateDocumentsOptions>
</PropertyGroup>
```

La generación en tiempo de compilación funciona lanzando el punto de entrada de tu aplicación contra un servidor simulado, así que tu `Program.cs` realmente se ejecuta. Eso significa que el código de inicio, las lecturas de configuración y los registros de inyección de dependencias se ejecutan durante la compilación. Si algo en el inicio no debería ejecutarse en ese contexto, por ejemplo conectarse a una base de datos, protégelo según el nombre del ensamblado de entrada:

```csharp
// .NET 11, C# 14
using System.Reflection;

if (Assembly.GetEntryAssembly()?.GetName().Name != "GetDocument.Insider")
{
    builder.Services.AddDbContext<AppDbContext>(/* ... */);
}
```

Una limitación actual: la generación en tiempo de compilación produce solo JSON. La salida YAML está soportada en tiempo de ejecución (dale a `MapOpenApi` una ruta `.yaml`) pero todavía no en tiempo de compilación.

## Detalles que conviene conocer antes de publicar

**El documento se regenera en cada solicitud.** `MapOpenApi` ejecuta toda la canalización de generación cada vez que se accede al endpoint, a propósito, para que los transformadores puedan reaccionar al estado en vivo. Para un documento muy solicitado puedes cachearlo con caché de salida y `.CacheOutput()` en el endpoint, o simplemente apoyarte en la generación en tiempo de compilación y servir un archivo estático.

**La versión de especificación predeterminada es 3.1, y eso puede romper herramientas antiguas.** Algunos consumidores todavía solo entienden OpenAPI 3.0. Si un generador descendente se atraganta con un documento 3.1, baja la versión explícitamente:

```csharp
// .NET 11, C# 14
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0;
});
```

En tiempo de compilación el equivalente es `<OpenApiGenerateDocumentsOptions>--openapi-version OpenApi3_1</OpenApiGenerateDocumentsOptions>`.

**El endpoint no tiene autorización de forma predeterminada.** Si expones el documento fuera de desarrollo, protégelo. `MapOpenApi()` devuelve un endpoint convention builder, así que `app.MapOpenApi().RequireAuthorization("SomePolicy")` funciona igual que en cualquier minimal endpoint.

**Solo documenta lo que el explorador de API ve.** Los endpoints de minimal API se descubren automáticamente, pero si devuelves `IResult` sin una sobrecarga tipada o una llamada a `Produces`, el generador no puede inferir el esquema de respuesta. Anota con `Produces<T>` y `Accepts<T>` para que el documento sea preciso. Esta es la misma disciplina que las minimal API premian en otros lugares, y combina bien con mantener los endpoints organizados mediante [MapGroup](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), ya que las convenciones a nivel de grupo como `WithTags` fluyen a cada operación del grupo.

El cambio mental respecto a Swashbuckle es pequeño una vez que lo interiorizas: el framework es dueño del documento, los transformadores reemplazan a los filtros, y la interfaz es una responsabilidad separada e intercambiable. Escribes dos líneas para obtener JSON, una línea más para obtener un visor, y un puñado de transformadores para dejar el documento presentable. Nada está fijado a un paquete que se publica según el calendario de otra persona.

## Lecturas relacionadas

- [Cómo organizar endpoints de minimal API con MapGroup en ASP.NET Core 11](/es/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Cómo agregar flujos de autenticación OpenAPI a Swagger UI en .NET 11](/es/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)
- [Cómo generar código de cliente fuertemente tipado a partir de una especificación OpenAPI en .NET 11](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [Scalar en ASP.NET Core: por qué se ignora tu token Bearer](/es/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Minimal APIs vs controladores en ASP.NET Core 11](/es/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Fuentes

- [Generate OpenAPI documents, documentación de ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- [Use the generated OpenAPI documents, documentación de ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-10.0)
- [Customize OpenAPI documents, documentación de ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/customize-openapi?view=aspnetcore-10.0)
- [Microsoft.AspNetCore.OpenApi en NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.OpenApi/)
- [Microsoft.Extensions.ApiDescription.Server en NuGet](https://www.nuget.org/packages/Microsoft.Extensions.ApiDescription.Server)
</content>
