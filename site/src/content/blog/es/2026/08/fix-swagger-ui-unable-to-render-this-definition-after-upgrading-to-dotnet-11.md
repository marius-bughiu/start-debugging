---
title: "Solución: Swagger UI muestra Unable to render this definition tras actualizar a .NET 11"
description: "ASP.NET Core 11 emite openapi 3.2.0 por defecto y Swagger UI por debajo de 10.1.5 lo rechaza. Actualiza Swashbuckle.AspNetCore.SwaggerUI o fija OpenApiVersion en OpenApi3_1."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "openapi"
  - "swagger"
  - "swashbuckle"
  - "aspnetcore"
  - "dotnet-11"
lang: "es"
translationOf: "2026/08/fix-swagger-ui-unable-to-render-this-definition-after-upgrading-to-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-19
---

Tu API sigue arrancando, `/openapi/v1.json` sigue devolviendo 200, pero la página de Swagger UI muestra un recuadro gris que dice que la definición no especifica un campo de versión válido. La causa es un cambio de valor por defecto en .NET 11: `AddOpenApi` ahora escribe `"openapi": "3.2.0"` en lugar de `"openapi": "3.1.1"`, y el bundle de Swagger UI que se distribuye en `Swashbuckle.AspNetCore.SwaggerUI` 10.1.4 y anteriores solo acepta `3.0.x` y `3.1.x`. Actualiza ese paquete a 10.1.5 o posterior, o establece `options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1` y sigue adelante. Nada de tus endpoints, transformadores o esquemas está roto.

Todo lo que sigue se midió con el SDK de .NET `11.0.100-preview.7.26381.103` y `Microsoft.AspNetCore.OpenApi` `11.0.0-preview.7.26381.103` (que resuelve `Microsoft.OpenApi` 3.9.0), comparado con el SDK de .NET 10.0.201 y `Microsoft.AspNetCore.OpenApi` 10.0.10.

## El error en contexto

Swagger UI reemplaza toda la lista de operaciones por este panel:

```text
Unable to render this definition

The provided definition does not specify a valid version field.

Please indicate a valid Swagger or OpenAPI version field. Supported version
fields are swagger: "2.0" and those that match openapi: 3.x.y (for example,
openapi: 3.1.0).
```

La redacción confunde por dos motivos. El documento sí tiene un campo de versión, y `3.2.0` sí encaja con la forma `3.x.y` que describe el mensaje. Lo que hace realmente el bundle es comparar los componentes mayor y menor contra una lista blanca fija, y `3.2` no está en ella en las compilaciones antiguas.

No hay ninguna excepción del lado del servidor que encontrar. El endpoint del documento está sano:

```bash
curl -s http://localhost:5331/openapi/v1.json | head -3
```

```json
{
  "openapi": "3.2.0",
  "info": {
```

Esa primera línea es todo el problema. Si ves `3.2.0` ahí y un recuadro gris en el navegador, estás en la página correcta.

## Por qué .NET 11 emite openapi 3.2.0

`OpenApiOptions.OpenApiVersion` cambió su valor por defecto de `OpenApiSpecVersion.OpenApi3_1` a `OpenApiSpecVersion.OpenApi3_2` en .NET 11 Preview 6. Microsoft lo documenta como un cambio de comportamiento intencionado para que las aplicaciones adopten la especificación más reciente sin configuración adicional ([OpenApiVersion pasa a OpenApi3_2 por defecto](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/openapi-version-default-3-2?view=aspnetcore-10.0)).

Ese valor por defecto se volvió alcanzable por un segundo cambio, una preview antes: en .NET 11 Preview 3, `Microsoft.AspNetCore.OpenApi` pasó de `Microsoft.OpenApi` 2.x a 3.x, y la línea 3.x es la que añadió los serializadores para OpenAPI 3.2.0 ([Microsoft.OpenApi actualizado a 3.x](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0)). La fijación de la dependencia se ve en el propio paquete: `Microsoft.AspNetCore.OpenApi` 11.0.0-preview.7 declara `Microsoft.OpenApi` `[3.9.0, 4.0.0)`, mientras que 10.0.10 declaraba `2.0.0`.

La consecuencia importante es que la cadena de versión cambió, pero el documento no. Más sobre esto abajo.

## Reproducción mínima

Bastan tres líneas de API y un registro de Swagger UI.

```xml
<!-- net11.0, .NET SDK 11.0.100-preview.7.26381.103 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0-preview.7.26381.103" />
    <PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="9.0.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 11, C# 14, Microsoft.AspNetCore.OpenApi 11.0.0-preview.7.26381.103
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddOpenApi();

var app = builder.Build();
app.MapOpenApi();
app.UseSwaggerUI(o => o.SwaggerEndpoint("/openapi/v1.json", "v1"));

app.MapGet("/todos/{id:int}", (int id) => new Todo(id, "write post", Status.Open, null));
app.MapPost("/todos", (Todo todo) => Results.Created($"/todos/{todo.Id}", todo));
app.Run();

internal enum Status { Open, Done }
internal record Todo(int Id, string Title, Status Status, DateTimeOffset? DueAt);
```

Carga `/swagger` y obtienes el recuadro gris. Nada en la consola, nada en los logs, HTTP 200 tanto en la página como en el documento.

Ten en cuenta que `Swashbuckle.AspNetCore.SwaggerUI` es un paquete independiente. No necesitas el generador de Swashbuckle para toparte con esto: el documento aquí viene del generador integrado, y solo los recursos de la interfaz vienen de Swashbuckle. Si seguiste una guía sobre [exponer OpenAPI sin Swashbuckle](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) pero conservaste la página familiar `/swagger`, esta es exactamente la configuración que estás ejecutando.

## Qué versión de Swagger UI renderiza por primera vez un documento 3.2.0

Hice una bisección del paquete contra el mismo documento 3.2.0. El límite es `Swashbuckle.AspNetCore.SwaggerUI` 10.1.5:

| Paquete SwaggerUI | swagger-ui incluido | Renderiza `openapi: 3.2.0` |
| --- | --- | --- |
| 9.0.6 | 5.29.1 | No |
| 10.0.0 | 5.30.2 | No |
| 10.1.0 | 5.31.0 | No |
| 10.1.4 | 5.31.1 | No |
| 10.1.5 | 5.32.0 | Sí |
| 10.1.7 | 5.32.1 | Sí |
| 10.2.3 | 5.32.7 | Sí |

En 10.1.5 y posteriores la insignia de la cabecera dice `OAS 3.2` y todas las operaciones y esquemas se renderizan con normalidad. Así que la primera solución es subir una línea de paquete:

```xml
<!-- first version whose bundled swagger-ui accepts 3.2.0 -->
<PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="10.1.5" />
```

Prefiere esta. Mantiene tu documento en la especificación más reciente y no cuesta nada, porque `Swashbuckle.AspNetCore.SwaggerUI` solo distribuye recursos estáticos y una extensión de middleware. Si en cambio referencias el metapaquete completo `Swashbuckle.AspNetCore`, subirlo a 10.2.x trae los mismos recursos de interfaz pero arrastra también el generador; lee las notas sobre [fijar la cadena de versión de OpenAPI que emite Swashbuckle](/es/2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore/) antes de cruzar ese límite.

## Cómo volver a fijar el documento en OpenAPI 3.1

Si no puedes mover el paquete de la interfaz, o si algo más aguas abajo también rechaza 3.2, establece la versión explícitamente en el generador:

```csharp
// .NET 11, C# 14. Microsoft.OpenApi 3.9.0 supplies OpenApiSpecVersion.
using Microsoft.OpenApi;

builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1;
});
```

El `using Microsoft.OpenApi;` importa: `OpenApiSpecVersion` vive en el espacio de nombres raíz plano, no en `Microsoft.OpenApi.Models`, que se eliminó ya en la línea 2.x que vino con .NET 10.

Con esa opción activada, .NET 11 escribe `"openapi": "3.1.2"`, y `Swashbuckle.AspNetCore.SwaggerUI` 9.0.6 lo renderiza con una insignia `OAS 3.1`. Fíjate en el componente de parche: .NET 10 escribía `3.1.1` y .NET 11, con el mismo valor de enumeración, escribe `3.1.2`. Los consumidores que comparan la cadena de versión completa en lugar del mayor y el menor seguirán tropezando. `OpenApiSpecVersion.OpenApi3_0` también se sigue aceptando y produce `3.0.4`.

Puedes registrar más de un documento con nombre si distintos consumidores necesitan versiones distintas:

```csharp
// .NET 11, C# 14
builder.Services.AddOpenApi("v1");                                   // 3.2.0
builder.Services.AddOpenApi("v1-31", o =>
    o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);               // 3.1.2
```

Eso te da `/openapi/v1.json` y `/openapi/v1-31.json` a partir de los mismos metadatos de endpoint, de modo que un generador de clientes heredado puede seguir consumiendo 3.1 mientras la interfaz y los clientes más nuevos leen 3.2.

## Qué hay realmente dentro del documento 3.2.0

Esta es la parte que conviene interiorizar antes de dedicar una tarde a auditar transformadores: para una minimal API normal, el documento 3.2.0 y el documento 3.1.2 son idénticos salvo por la cadena de versión.

Generé las tres versiones desde una misma aplicación (un record con un int, un string, un enum, un `DateTimeOffset` anulable, más una subida con `IFormFile`) y las comparé. La diferencia entre 3.1 y 3.2 fueron dos líneas, ambas el campo `openapi` y el título del documento. No cambió ni un esquema, parámetro, respuesta o componente.

La diferencia entre 3.0 y 3.1, en cambio, es real, porque ahí es donde aterrizó la alineación con JSON Schema:

```json
// OpenAPI 3.0.4
"dueAt": { "type": "string", "format": "date-time", "nullable": true }
```

```json
// OpenAPI 3.1.2 and 3.2.0
"dueAt": { "type": ["null", "string"], "format": "date-time" }
```

Así que si un generador de clientes se rompe tras actualizar a .NET 11 y lo "arreglas" bajando a `OpenApi3_0`, has cambiado la codificación de nulabilidad de todas las propiedades opcionales de tu contrato. Baja a `OpenApi3_1` en su lugar: esa es la versión cuya carga útil es byte por byte lo que ya venías publicando en .NET 10.

## Scalar tiene el mismo problema

Si sirves tu referencia con [Scalar en lugar de Swagger UI](/es/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/), este error no te alcanza. Ejecuté la misma aplicación de .NET 11 contra `Scalar.AspNetCore` 2.16.20 y 2.14.14, y ambas renderizaron el documento 3.2.0, mostrando `OpenAPI 3.2.0` en la cabecera.

Eso se cumple aunque el grafo de NuGet parezca alarmante. `Scalar.AspNetCore.Microsoft` 2.16.20 no tiene ningún grupo de destino `net11.0`, así que un proyecto `net11.0` resuelve sus recursos `net10.0`, que se compilaron contra `Microsoft.OpenApi` 2.7.5 y luego se cargan contra el ensamblado unificado 3.9.0 en tiempo de ejecución. Ese es justo el riesgo de compatibilidad binaria del que advierte la nota de cambio disruptivo de Microsoft.OpenApi 3.x, y aquí resulta ser inofensivo: `AddScalarTransformers()` y `ExcludeFromApiReference()` funcionaron y emitieron la extensión `x-scalar-ignore` esperada.

Lo mismo vale para los transformadores escritos a mano. Un transformador de documento que registra un esquema de seguridad bearer y un transformador de esquema que estampa `x-schema-id`, ambos escritos para .NET 10 contra `Microsoft.OpenApi` 2.x, compilaron y se ejecutaron sin cambios en .NET 11 con 3.9.0. Si tus transformadores solo leen, o solo establecen extensiones y esquemas de seguridad, presupuesta cero para la migración de 2.x a 3.x. Si recorren esquemas anidados, construyen referencias o usaban la infraestructura de análisis `ParseNode` ya eliminada, lee primero la [referencia del pipeline de transformadores](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) y las notas de migración de OpenAPI.NET.

## Qué fallos parecidos no son este error

**Una página en blanco sin recuadro gris alguno.** Ese es otro fallo: la interfaz nunca recibió un documento. Revisa la ruta. `MapOpenApi` sirve `/openapi/{documentName}.json`, y si cambiaste el patrón debes indicárselo a la interfaz, ya sea con `SwaggerEndpoint` o con `WithOpenApiRoutePattern` de Scalar. Haz curl a la URL del JSON que la página realmente está pidiendo antes de culpar a las versiones.

**HTTP 500 en la URL del documento.** Entonces un transformador lanzó una excepción y no había nada que renderizar. El caso más común no es en absoluto una regresión de .NET 11: `OpenApiSchema.Extensions` es `null` hasta que le asignas algo, tanto en `Microsoft.OpenApi` 2.x como en 3.x, así que `schema.Extensions["x-foo"] = ...` lanza una `NullReferenceException` igual en .NET 10 que en .NET 11. Protégelo:

```csharp
// .NET 11, C# 14, Microsoft.OpenApi 3.9.0
options.AddSchemaTransformer((schema, context, ct) =>
{
    schema.Extensions ??= new Dictionary<string, IOpenApiExtension>();
    schema.Extensions["x-schema-id"] =
        new JsonNodeExtension(JsonValue.Create(context.JsonTypeInfo.Type.Name));
    return Task.CompletedTask;
});
```

**`error CS0200: Property or indexer 'IOpenApiMediaType.Example' cannot be assigned to -- it is read only`.** Este sí es un efecto colateral genuino de .NET 11, y aparece en soluciones mixtas. Si un proyecto `net10.0` acaba resolviendo `Microsoft.OpenApi` 3.9.0, ya sea por gestión centralizada de paquetes, por una versión flotante o por una referencia compartida desde una aplicación `net11.0`, el generador de código fuente de comentarios XML de OpenAPI del SDK de .NET 10 falla al compilar contra el modelo de objetos 3.x. Mantén los proyectos `net10.0` en `Microsoft.OpenApi` 2.x en lugar de hacer flotar toda la solución a una única versión.

**`System.MissingMethodException: Method not found: '... Microsoft.OpenApi.OpenApiOperation.get_Extensions()'`.** Este es el modo de fallo de compatibilidad binaria, y significa que alguna biblioteca de tu grafo se compiló contra una superficie de `Microsoft.OpenApi` que ya no existe en tiempo de ejecución. La actualización a .NET 11 no lo provoca por sí sola; busca un paquete fijado muy por detrás del resto, o una referencia explícita a `Microsoft.OpenApi` en tu propio csproj peleando con la transitiva.

## Relacionado

- [Cómo exponer OpenAPI sin Swashbuckle en ASP.NET Core 11](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Solución: no se puede apuntar a OpenAPI 3.0 tras actualizar Swashbuckle.AspNetCore a v9](/es/2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore/)
- [Cómo personalizar el documento OpenAPI con AddOperationTransformer y AddSchemaTransformer](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Cómo servir documentación OpenAPI con Scalar en lugar de Swagger UI](/es/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/)
- [Migrar de Swashbuckle al generador OpenAPI integrado en .NET 11](/es/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)

## Fuentes

- [Cambio disruptivo: OpenApiVersion pasa a OpenApi3_2 por defecto](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/openapi-version-default-3-2?view=aspnetcore-10.0), Microsoft Learn
- [Cambio disruptivo: Microsoft.OpenApi actualizado a 3.x](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/11/microsoft-openapi-3x?view=aspnetcore-10.0), Microsoft Learn
- [Generar documentos OpenAPI](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0), Microsoft Learn
- [Notas de versión de OpenAPI.NET](https://github.com/microsoft/OpenAPI.NET/releases), microsoft/OpenAPI.NET en GitHub
- [Scalar.AspNetCore.Microsoft falla con los transformadores](https://github.com/scalar/scalar/issues/6020), incidencia 6020 de scalar/scalar
