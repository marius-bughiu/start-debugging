---
title: "Solución: no se puede generar OpenAPI 3.0 tras actualizar Swashbuckle.AspNetCore a v9"
description: "Swashbuckle 8 y posteriores emiten openapi 3.0.4, no 3.0.1, y no existe un OpenApiSpecVersion para versiones de parche. Por qué cambió y cuatro formas de fijar la cadena que espera tu herramienta."
pubDate: 2026-08-19
template: error-page
tags:
  - "errors"
  - "swashbuckle"
  - "openapi"
  - "aspnetcore"
  - "dotnet-11"
lang: "es"
translationOf: "2026/08/fix-cannot-target-openapi-3-0-after-upgrading-swashbuckle-aspnetcore"
translatedBy: "claude"
translationDate: 2026-08-19
---

Actualizaste `Swashbuckle.AspNetCore` a 9.x, tu código sigue diciendo `OpenApiSpecVersion.OpenApi3_0`, y el documento generado ahora dice `"openapi": "3.0.4"` en lugar de `"openapi": "3.0.1"`. Las herramientas que lo consumen lo rechazan, y no hay ningún miembro `OpenApi3_0_1` en el enum para seleccionar. La cadena de versión es un literal fijo dentro de `Microsoft.OpenApi`, no una opción de Swashbuckle: 1.6.22 y anteriores escriben `3.0.1`, 1.6.23 y posteriores escriben `3.0.4`. Swashbuckle 8.0.0 fue la versión que tomó la dependencia de 1.6.23, así que el cambio afecta a cualquiera que cruce el límite de 7.x. Las soluciones de abajo son, en orden: actualizar el consumidor, reescribir la propiedad tú mismo en un middleware, o fijar todo el stack de Swashbuckle en 7.2.0.

Todo lo que sigue se midió contra el SDK de .NET 10.0.201 sobre `net10.0`, con Swashbuckle.AspNetCore 6.5.0, 7.2.0, 8.1.4, 9.0.6 y 10.2.3.

## Los errores en contexto

Pedirle a la CLI la versión de parche directamente:

```text
System.NotSupportedException: The specified OpenAPI version "3.0.1" is not supported.
   at Swashbuckle.AspNetCore.Cli.Program.<>c.<Main>b__1_5(IDictionary`2 namedArgs)
   at Swashbuckle.AspNetCore.Cli.CommandRunner.Run(IEnumerable`1 args)
   at Swashbuckle.AspNetCore.Cli.Program.Main(String[] args)
```

Intentar retener `Microsoft.OpenApi` manteniendo Swashbuckle 9:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.OpenApi from 1.6.25 to 1.6.22.
  Reference the package directly from the project to select a different version.
   MyApi -> Swashbuckle.AspNetCore 9.0.6 -> Swashbuckle.AspNetCore.Swagger 9.0.6 -> Microsoft.OpenApi (>= 1.6.25)
   MyApi -> Microsoft.OpenApi (>= 1.6.22)
```

Y, si silencias NU1605 y lo intentas de todas formas:

```text
error CS1705: Assembly 'Swashbuckle.AspNetCore.SwaggerGen' with identity
'Swashbuckle.AspNetCore.SwaggerGen, Version=9.0.6.0, ...' uses 'Microsoft.OpenApi, Version=1.6.25.0, ...'
which has a higher version than referenced assembly 'Microsoft.OpenApi' with identity
'Microsoft.OpenApi, Version=1.6.22.0, ...'
```

Las versiones antiguas de Swagger UI renderizan el documento así:

```text
Unable to render this definition
The provided definition does not specify a valid version field.
Please indicate a valid Swagger or OpenAPI version field. Supported version fields are
swagger: "2.0" and those that match openapi: 3.x.y (for example, openapi: 3.1.0).
```

## Por qué la cadena de versión es 3.0.4 y no algo que yo controle

`OpenApiSpecVersion` es un enum pequeño, y ninguno de sus miembros lleva un número de parche. En `Microsoft.OpenApi` 1.6.25, que es de lo que depende Swashbuckle 9.0.6, tiene exactamente dos miembros:

```text
OpenApi2_0
OpenApi3_0
```

En `Microsoft.OpenApi` 2.7.5, del que depende Swashbuckle 10.2.3, gana uno más:

```text
OpenApi2_0
OpenApi3_0
OpenApi3_1
```

No hay miembro 3.0.1, 3.0.3 ni 3.0.4, porque la versión de parche no es una opción del serializador. `OpenApiDocument.SerializeAsV3` escribe una constante de tiempo de compilación. Puedes ver el cambio con un volcado de cadenas de los ensamblados publicados:

```text
strings -a -e l on lib/netstandard2.0/Microsoft.OpenApi.dll:
  1.2.3   -> 3.0.1
  1.6.22  -> 3.0.1
  1.6.23  -> 3.0.4
  1.6.25  -> 3.0.4
  2.7.5   -> 3.0.4 and 3.1.1
```

El cambio llegó en el [PR #2011 de OpenAPI.NET](https://github.com/microsoft/OpenAPI.NET/pull/2011), integrado el 2024-12-20, que retroportó el comportamiento de v2 a la línea v1. No es un error: OpenAPI 3.0.4 es una versión de parche real de la especificación, y emitir el parche más reciente es el valor por defecto correcto. El problema es que muchos consumidores validan el campo `openapi` contra una lista fija de valores permitidos en lugar de un patrón `3.0.x`.

## Qué versión de Swashbuckle emite qué versión de parche

El campo `openapi` sigue al ensamblado de `Microsoft.OpenApi` que realmente se resuelve, no a la versión de Swashbuckle que escribiste en el csproj:

| Swashbuckle.AspNetCore | Microsoft.OpenApi (declarado) | campo `openapi` |
| --- | --- | --- |
| 6.5.0 | 1.2.3 | `3.0.1` |
| 7.2.0 | 1.6.22 | `3.0.1` |
| 8.0.0 a 8.1.4 | 1.6.23 | `3.0.4` |
| 9.0.0 a 9.0.6 | 1.6.23 a 1.6.25 | `3.0.4` |
| 10.0.0 a 10.2.3 | 2.3.0 a 2.7.5 | `3.0.4`, o `3.1.1` con `OpenApi3_1` |

Dos detalles a tener en cuenta. Primero, el límite real es 8.0.0, no 9.0.0: si saltaste de 7.x directamente a 9.x, lo cruzaste sin verlo. Segundo, la dependencia de NuGet es un mínimo, no una fijación. Un proyecto en Swashbuckle 7.2.0 que además referencia algo que arrastra `Microsoft.OpenApi` 1.6.23 o posterior resuelve el ensamblado más nuevo y empieza a emitir `3.0.4` sin ningún cambio en Swashbuckle. Si tu documento cambió y tu versión de Swashbuckle no, ejecuta esto antes de mirar en cualquier otro sitio:

```bash
dotnet list package --include-transitive
```

## Reproducción mínima en net10.0

```csharp
// .NET SDK 10.0.201, net10.0, Swashbuckle.AspNetCore 9.0.6
using Microsoft.OpenApi;
using Microsoft.OpenApi.Models;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(o =>
    o.SwaggerDoc("v1", new OpenApiInfo { Title = "Demo", Version = "v1" }));

var app = builder.Build();
app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0);
app.MapGet("/orders/{id}", (int id) => new Order(id, "open", null)).WithName("GetOrder");
app.Run();

record Order(int Id, string Status, string? Note);
```

`GET /swagger/v1/swagger.json` devuelve:

```json
{
  "openapi": "3.0.4",
  "info": { "title": "Demo", "version": "v1" },
  "paths": { }
}
```

Establecer `OpenApiVersion` explícitamente no cambia nada aquí, porque `OpenApi3_0` ya es el valor por defecto y el enum no ofrece mayor granularidad.

## ¿Puedo pasarle una versión de parche a la CLI?

No. `dotnet swagger tofile` analiza `--openapiversion` contra un conjunto cerrado de tres cadenas. Del código fuente de v10.2.3:

```csharp
// Swashbuckle.AspNetCore.Cli/Program.cs, v10.2.3
specVersion = versionArg switch
{
    "2.0" => OpenApiSpecVersion.OpenApi2_0,
    "3.0" => OpenApiSpecVersion.OpenApi3_0,
    "3.1" => OpenApiSpecVersion.OpenApi3_1,
    _ => throw new NotSupportedException($"The specified OpenAPI version \"{versionArg}\" is not supported."),
};
```

En 9.0.6 la rama `"3.1"` tampoco existe, así que `2.0` y `3.0` son tus únicas entradas. Salida medida para cada valor aceptado en 10.2.3: `2.0` da `"swagger": "2.0"`, `3.0` da `"openapi": "3.0.4"`, `3.1` da `"openapi": "3.1.1"`. Cualquier otra cosa, incluidos `3.0.1` y `3.1.1`, lanza una excepción.

Un apunte sobre la CLI: la herramienta 9.0.6 publica un apphost de `net9.0`, así que se niega a arrancar en una máquina que solo tiene el runtime de .NET 10. Define `DOTNET_ROLL_FORWARD=Major` antes de invocarla, o instala el runtime correspondiente.

## ¿Funciona bajar Microsoft.OpenApi a 1.6.22?

No en Swashbuckle 9 ni 10, y este es el consejo que más vas a encontrar en hilos antiguos. Añadir una referencia directa dispara primero NU1605, que NuGet trata como error por defecto. Si lo silencias con `<WarningsNotAsErrors>NU1605</WarningsNotAsErrors>`, la restauración resuelve 1.6.22 y luego la compilación falla con `CS1705`, porque `Swashbuckle.AspNetCore.Swagger` 9.0.6 se compiló contra la identidad de ensamblado 1.6.25. Ambos fallos se reproducen en un proyecto `net10.0` limpio.

La vía de fijar versiones solo funciona si retrocedes todo el stack:

```xml
<!-- net10.0, verified: emits "openapi": "3.0.1" -->
<ItemGroup>
  <PackageReference Include="Swashbuckle.AspNetCore" Version="7.2.0" />
  <PackageReference Include="Microsoft.OpenApi" Version="1.6.22" />
</ItemGroup>
```

Swashbuckle 7.2.0 aún apunta a `netstandard2.0` y funciona bien en `net10.0`, y resuelve `Microsoft.OpenApi` 1.6.22. La referencia explícita a `Microsoft.OpenApi` está ahí para evitar que un ascenso transitivo te empuje hacia adelante otra vez. Trátalo como un parche temporal con fecha de caducidad, no como una solución: estás congelando un generador de OpenAPI dos versiones mayores atrás, y 8.x y 9.x contienen correcciones de generación de esquemas que acabarás queriendo.

## ¿Cómo reescribo la cadena de versión en Swashbuckle 9 o 10?

No hay ningún gancho. Los mantenedores de Swashbuckle lo han dicho en el [issue #3540](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3540): `SwaggerMiddleware` serializa directamente al flujo de respuesta sin nada intermedio. La solución alternativa que sugieren, y la que realmente aguanta, es almacenar en búfer la respuesta y editar la propiedad. Esto funciona igual en 9.0.6 y 10.2.3 porque nunca toca el modelo de objetos:

```csharp
// net10.0, Swashbuckle.AspNetCore 9.0.6 and 10.2.3, both verified
app.UseWhen(
    ctx => ctx.Request.Path.StartsWithSegments("/swagger")
        && ctx.Request.Path.Value!.EndsWith(".json"),
    branch => branch.Use(async (ctx, next) =>
    {
        var original = ctx.Response.Body;
        using var buffer = new MemoryStream();
        ctx.Response.Body = buffer;

        await next();

        ctx.Response.Body = original;
        if (ctx.Response.StatusCode != StatusCodes.Status200OK)
        {
            buffer.Position = 0;
            await buffer.CopyToAsync(original);
            return;
        }

        var json = Encoding.UTF8.GetString(buffer.ToArray())
            .Replace("\"openapi\": \"3.0.4\"", "\"openapi\": \"3.0.1\"", StringComparison.Ordinal);
        var bytes = Encoding.UTF8.GetBytes(json);
        ctx.Response.ContentLength = bytes.Length;
        await original.WriteAsync(bytes);
    }));

app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_0);
app.UseSwaggerUI();
```

Regístralo antes de `UseSwagger`. Swagger UI sigue funcionando, `/swagger/index.html` sigue devolviendo 200, y el endpoint JSON devuelve `3.0.1`. Dos detalles importan: restablecer `ctx.Response.Body` al flujo original antes de escribir, y establecer `ContentLength` después de la reescritura, ya que el reemplazo cambia el número de bytes. El filtro `.EndsWith(".json")` mantiene el búfer alejado de los recursos estáticos de la UI. Si además sirves YAML, añade una rama para él, porque allí la propiedad se escribe como `openapi: '3.0.4'` y el reemplazo de JSON no coincidirá.

Si prefieres no usar búfer, reemplaza el endpoint por completo y serializa el documento tú mismo:

```csharp
// net10.0, Swashbuckle.AspNetCore 9.0.6
app.MapGet("/swagger/v1/swagger.json", (ISwaggerProvider provider) =>
{
    var document = provider.GetSwagger("v1");
    var node = JsonNode.Parse(document.SerializeAsJson(OpenApiSpecVersion.OpenApi3_0))!;
    node["openapi"] = "3.0.1";
    return Results.Text(
        node.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
        "application/json");
}).ExcludeFromDescription();
```

`ExcludeFromDescription()` no es opcional. Sin él, el endpoint se descubre a sí mismo y `/swagger/v1/swagger.json` aparece como una ruta documentada en su propia salida. `SerializeAsJson` vive en `Microsoft.OpenApi.Extensions` en la línea 1.6.x; en Swashbuckle 10 con `Microsoft.OpenApi` 2.x esa extensión ya no está, así que ahí es preferible el middleware.

Para un documento generado en tiempo de compilación con `dotnet swagger tofile` u `OpenApiGenerateDocumentsOnBuild`, no hagas nada de esto en código. Genera con `--openapiversion 3.0` y parchea el archivo como un paso de compilación:

```bash
jq '.openapi = "3.0.1"' swagger.json > swagger.tmp && mv swagger.tmp swagger.json
```

## Swagger UI sigue rechazando la definición, ¿ahora qué?

Si el navegador muestra "The provided definition does not specify a valid version field", el documento está bien y la UI está desactualizada. swagger-ui añadió soporte para 3.0.4 en [v5.19.0](https://github.com/swagger-api/swagger-ui/releases/tag/v5.19.0), publicada el 2025-02-17, vía el [PR #10247](https://github.com/swagger-api/swagger-ui/pull/10247). Swashbuckle lo incorporó en `Swashbuckle.AspNetCore.SwaggerUI` 7.3.0. Cualquier versión anterior muestra el error contra un documento 3.0.4 perfectamente válido.

La trampa es el desfase de versiones dentro de una misma solución. `Swashbuckle.AspNetCore.SwaggerUI` es un paquete aparte, y los proyectos que referencian los tres subpaquetes por separado suelen subir `Swagger` y `SwaggerGen` dejando atrás `SwaggerUI`. Revisa los tres y luego recarga el navegador forzando la caché, porque el `swagger-ui-bundle.js` incluido se cachea de forma agresiva.

Si el problema es tu renderizador y no tu documento, este también es un buen momento para mirar [cómo servir la documentación con Scalar](/es/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/), que lee 3.0.4 y 3.1 sin quejarse.

## ¿Y si realmente quiero 3.1?

Entonces necesitas Swashbuckle 10 o posterior, porque `Microsoft.OpenApi` 1.6.x no tiene ningún miembro `OpenApi3_1`. En 10.x es opcional, así que el valor por defecto sigue siendo 3.0.4 y pides 3.1 de forma explícita:

```csharp
// net10.0, Swashbuckle.AspNetCore 10.2.3, emits "openapi": "3.1.1"
app.UseSwagger(o => o.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);
```

Reserva tiempo para la actualización. Swashbuckle 10 pasa a `Microsoft.OpenApi` v2, que aplana los espacios de nombres, así que lo primero con lo que te topas es:

```text
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'Microsoft.OpenApi'
```

Elimina `using Microsoft.OpenApi.Models;`, ya que los tipos ahora viven directamente en `Microsoft.OpenApi`. Más allá de eso, los tipos concretos del modelo pasan a ser interfaces (`OpenApiSchema` pasa a `IOpenApiSchema`), los nombres de tipo en cadena pasan a valores del enum `JsonSchemaType`, y `WithOpenApi()` ya no está soportado. La [guía de migración a v10](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md) recomienda pasar primero por 9.0.6, y es buen consejo: aísla los cambios de ruptura de 9.x (se abandona `netstandard2.0`, se eliminan miembros obsoletos, se elimina `--serializeasv2`) de los de OpenAPI.NET v2.

## ¿Qué solución debería elegir?

Ordenadas por lo que yo haría de verdad:

1. Actualiza el consumidor. `3.0.4` es OpenAPI 3.0 válido, y cualquier validador, generador o gateway actual lo acepta. La mayoría de estos reportes se reducen a una herramienta tres versiones por detrás.
2. Si el consumidor es un proveedor al que no puedes mover, añade la reescritura en middleware. Son 20 líneas, es independiente de la versión y no congela tu grafo de dependencias.
3. Parchea el archivo en CI con `jq` si el documento se genera en tiempo de compilación en lugar de servirse en tiempo de ejecución.
4. Fija Swashbuckle en 7.2.0 solo como medida temporal, con un ticket para quitarlo.

Lo que no funciona, digan lo que digan los resultados de búsqueda: bajar `Microsoft.OpenApi` bajo un Swashbuckle actual, o buscar un miembro de `OpenApiSpecVersion` que codifique la versión de parche.

## Relacionado

- [Migrar de Swashbuckle al generador de OpenAPI integrado](/es/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) cubre la dirección contraria, si prefieres dejar atrás Swashbuckle a gestionar su rotación de versiones.
- [El error de compilación 'OpenApiReference' could not be found](/es/2026/08/fix-the-type-or-namespace-name-openapireference-could-not-be-found/) es el fallo hermano del mismo aplanamiento de espacios de nombres de `Microsoft.OpenApi` v2.
- [Mapear IOperationFilter e ISchemaFilter a transformadores](/es/2026/07/migrate-swashbuckle-ioperationfilter-and-ischemafilter-to-transformers-in-dotnet-11/) es la parte de la migración que más tiempo lleva.
- [Scalar y Swagger UI comparados](/es/2026/08/scalar-vs-swagger-ui-for-openapi-documentation-in-aspnetcore-11/) vale la pena si el rechazo de versión vino del renderizador y no de un servicio consumidor.
- [Generar clientes fuertemente tipados desde una especificación OpenAPI](/es/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) importa si quien rechaza tu documento es un generador de código.

## Fuentes

- [OpenAPI.NET PR #2011: bumps v3 patch version to 3.0.4](https://github.com/microsoft/OpenAPI.NET/pull/2011)
- [Swashbuckle.AspNetCore issue #3540: changing the openapi version in swagger.json](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3540)
- [Swashbuckle.AspNetCore issue #3216: 7.2.0 json doc says openapi 3.0.4](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3216)
- [Swashbuckle.AspNetCore issue #3265: add support for OpenAPI 3.0.4](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/issues/3265)
- [Notas de la versión v9.0.0 de Swashbuckle.AspNetCore](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v9.0.0)
- [Notas de la versión v10.0.0 de Swashbuckle.AspNetCore](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v10.0.0)
- [Guía de migración a v10 de Swashbuckle.AspNetCore](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/blob/master/docs/migrating-to-v10.md)
- [Notas de la versión v5.19.0 de swagger-ui](https://github.com/swagger-api/swagger-ui/releases/tag/v5.19.0)
