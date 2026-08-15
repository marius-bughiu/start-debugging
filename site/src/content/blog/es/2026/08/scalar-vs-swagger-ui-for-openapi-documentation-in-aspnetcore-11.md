---
title: "Scalar vs Swagger UI para documentación OpenAPI en ASP.NET Core 11"
description: "Scalar envía 1.02 MiB de JavaScript comprimido con gzip y un constructor de solicitudes mucho mejor. Swagger UI envía 514 KiB y renderiza OpenAPI 3.2, que es lo que .NET 11 ya emite por defecto. Payloads medidos, la brecha de 3.2, enrutamiento por endpoints en ambos lados y los detalles de autenticación que deciden."
pubDate: 2026-08-15
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "scalar"
lang: "es"
translationOf: "2026/08/scalar-vs-swagger-ui-for-openapi-documentation-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-15
---

Elige **Scalar** (`Scalar.AspNetCore` 2.16.20) para una API nueva en .NET 11 si quienes leen tu documentación son externos, porque el constructor de solicitudes, los ejemplos de código en varios lenguajes y la búsqueda son realmente mejores que cualquier cosa que haga Swagger UI. Elige **Swagger UI** (`Swashbuckle.AspNetCore.SwaggerUI` 10.2.3, que empaqueta swagger-ui 5.32.7) si quieres el payload más pequeño, si dependes del flujo de redirección OAuth2 que ya configuraste, o si necesitas renderizado confiable de OpenAPI 3.2 hoy, porque .NET 11 emite 3.2 por defecto y el trabajo de 3.2 en Scalar sigue siendo un issue abierto. Ambos tienen licencia MIT, ambos son renderizadores puros sin voz ni voto sobre tu documento OpenAPI, y la guía de Microsoft es que ninguno debería ser accesible en producción.

Todo lo medido a continuación se ejecutó contra el SDK de .NET 10.0.201 con las versiones exactas de paquetes que se nombran, el 2026-08-15. La superficie de API es idéntica en .NET 8 hasta .NET 11, porque ambos paquetes publican ensamblados `net8.0`, `net9.0` y `net10.0` y toman una referencia de framework a `Microsoft.AspNetCore.App` en lugar de fijar un runtime.

## La comparación que la gente cree estar haciendo no es la que importa

Desde .NET 9, `dotnet new webapi` no incluye Swashbuckle. `Microsoft.AspNetCore.OpenApi` genera el documento y es compatible con trimming y Native AOT. Eso significa que la decisión que tienes delante no es "Swashbuckle o Scalar", sino "qué bundle de JavaScript renderiza el documento que tu framework ya produce". Si sigues usando `SwaggerGen` de Swashbuckle para la generación, esa es una decisión aparte, cubierta en [cómo exponer OpenAPI sin Swashbuckle en ASP.NET Core 11](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

Esta distinción tiene una consecuencia práctica. `Swashbuckle.AspNetCore`, el metapaquete, arrastra `Swashbuckle.AspNetCore.Swagger`, `SwaggerGen` y `Microsoft.Extensions.ApiDescription.Server` junto con la interfaz. Si solo quieres la interfaz, referencia `Swashbuckle.AspNetCore.SwaggerUI` directamente y no viene nada más con ella.

```xml
<!-- .NET 11, C# 14: the UI only, no second document generator -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
  <PackageReference Include="Swashbuckle.AspNetCore.SwaggerUI" Version="10.2.3" />
</ItemGroup>
```

```xml
<!-- .NET 11, C# 14: the Scalar equivalent, one package, zero NuGet dependencies -->
<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
  <PackageReference Include="Scalar.AspNetCore" Version="2.16.20" />
</ItemGroup>
```

## La matriz

| | Scalar 2.16.20 | Swagger UI 5.32.7 (Swashbuckle 10.2.3) |
| --- | --- | --- |
| Bytes en red en la primera carga (gzip) | 1 071 277 | 526 322 |
| JavaScript parseado tras descomprimir | 3 711 KB | 1 794 KB |
| Registro | `app.MapScalarApiReference()` | `app.UseSwaggerUI(...)` o `app.MapSwaggerUI(...)` |
| Enrutamiento por endpoints | Sí, desde 1.x | Sí, desde 10.2.0 (mayo de 2026) |
| OpenAPI 3.2 | El parser lo maneja, soporte completo en un issue abierto | Soporte básico desde swagger-ui 5.32.0 |
| Ejemplos de código | Más de 20 destinos (curl, fetch, axios, Python, Go, Java, PHP, Ruby y más) | curl para la solicitud que acabas de enviar |
| Caché de assets | `Cache-Control: no-cache` más ETag, fijo en el código | ETag por defecto, `max-age` si configuras `CacheLifetime` |
| Credenciales persistidas | `persistAuth` escribe en local storage | `PersistAuthorization` en el objeto de configuración |
| Try It entre orígenes | `proxyUrl` opcional | fetch directo del navegador, CORS es tu problema |
| Temas | 12 temas integrados, `customCss`, plugins | `InjectStylesheet`, `InjectJavascript`, el sistema de plugins de swagger-ui |
| Licencia | MIT | MIT |

## Lo que cuesta cada uno al navegador, medido

Ambos paquetes incrustan sus assets en el ensamblado como streams gzip y entregan esos bytes directamente a un cliente que anuncia `Accept-Encoding: gzip`. La integración de Scalar con ASP.NET Core comprueba `IsGzipAccepted()` y establece `Content-Encoding` más `Vary: Accept-Encoding` a partir del asset almacenado. El middleware de la interfaz de Swashbuckle lleva la misma maquinaria (`IsGZipAccepted`, un `GZipStream` en modo descompresión para el cliente raro que se niegue). Así que los tamaños de los recursos almacenados son los tamaños de transferencia, y puedes leerlos de los paquetes sin ejecutar nada:

```csharp
// .NET SDK 10.0.201, run as a file-based app: dotnet run res.cs <dll>
using System.Reflection;

var asm = Assembly.LoadFrom(args[0]);
foreach (var name in asm.GetManifestResourceNames())
{
    using var s = asm.GetManifestResourceStream(name);
    Console.WriteLine($"{s?.Length,10}  {name}");
}
```

Scalar sirve tres assets, y solo dos de ellos son código:

```text
   1070166  ScalarStaticAssets.scalar.js
      1111  ScalarStaticAssets.scalar.aspnetcore.js
       533  ScalarStaticAssets.favicon.svg
```

El `index.html` de Swashbuckle carga el bundle, el preset standalone, la hoja de estilos y su propio inicializador:

```text
    421507  swagger-ui-bundle.js
     77731  swagger-ui-standalone-preset.js
     26499  swagger-ui.css
       433  index.js
       152  index.css
       739  index.html
```

Eso es 1 071 277 bytes para Scalar frente a 526 322 bytes para Swagger UI, una diferencia de 2.0x en la red. Descomprimido, `scalar.js` son 3 708 228 bytes de JavaScript que el navegador tiene que parsear, frente a 1 793 552 bytes para el bundle más el preset de Swagger UI. La opción de aspecto moderno es la pesada, que es lo contrario de lo que insinúan la mayoría de los artículos.

Dos advertencias antes de darle demasiado peso a esto. Primero, es una herramienta de desarrollo: los bytes aterrizan en tu máquina, sobre loopback, una vez por carga en frío. Segundo, `swagger-ui.js` de Swashbuckle (92 466 bytes) queda en el paquete sin usarse en la página por defecto, así que el número de arriba es lo que realmente carga, no lo que se distribuye. Si sirves cualquiera de las dos interfaces sobre una red real, la [comparación de compresión de respuestas](/es/2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11/) no te ayuda aquí: ambos paquetes ya comprimieron estos assets por su cuenta, y recomprimir una respuesta con `Content-Encoding: gzip` no es algo que el middleware vaya a hacer.

El caché es la parte que molesta a diario. `SwaggerUIOptions.CacheLifetime` documenta su valor por defecto como "0 days (ETags are used to check if resources have been updated)", así que de fábrica ambas interfaces revalidan. La diferencia es que Swashbuckle te deja optar por caché real y Scalar no: su handler de assets estáticos fija `Cache-Control: no-cache` en el código y responde a un `If-None-Match` coincidente con un 304. Pagas un viaje de ida y vuelta por asset por carga de página, para siempre.

```csharp
// Program.cs -- .NET 11, C# 14, Swashbuckle.AspNetCore.SwaggerUI 10.2.3
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/openapi/v1.json", "v1");
    options.CacheLifetime = TimeSpan.FromDays(7); // 304s become cache hits
});
```

## El detalle de .NET 11: tu documento ahora es 3.2

Este es el hecho que debería impulsar la decisión en agosto de 2026, y casi nadie lo ha escrito. Microsoft Learn es explícito: "Starting in .NET 11, the default OpenAPI version for generated documents is 3.2. In .NET 10, the default is 3.1." Actualiza una API de .NET 10 a .NET 11, sin cambiar nada más, y el documento que tu interfaz tiene que renderizar cambia de versión de especificación.

Del lado de Swagger UI, swagger-ui 5.32.0 (27 de febrero de 2026) incorporó "basic OpenAPI 3.2.0 support", y Swashbuckle 10.2.3 empaqueta 5.32.7, así que el renderizador al menos sabe qué está mirando. Del lado de Scalar, `@scalar/openapi-parser` entiende 3.2, pero el issue de seguimiento [scalar/scalar#6715](https://github.com/scalar/scalar/issues/6715) sigue abierto, con "set OpenAPI 3.2 as the default version" y el renderizado de etiquetas profundamente anidadas en la barra lateral listados como trabajo pendiente en su última actualización del 30 de junio de 2026.

En la práctica un documento generado a partir de endpoints de minimal API cambia muy poco entre 3.1 y 3.2, así que la mayoría de las aplicaciones no verán ninguna diferencia. Si ves una barra lateral que agrupa mal o un esquema que se renderiza vacío, fija la versión en lugar de abrir un bug contra la interfaz:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOpenApi(options =>
{
    // .NET 11 defaults to OpenApi3_2; pin 3.1 while a renderer catches up
    options.OpenApiVersion = Microsoft.OpenApi.OpenApiSpecVersion.OpenApi3_1;
});
```

La misma palanca existe para la generación en tiempo de compilación mediante la propiedad MSBuild `OpenApiGenerateDocumentsOptions` con `--openapi-version OpenApi3_1`. Fijarla no te cuesta nada hoy: todavía nada en un documento generado por ASP.NET Core depende de características de 3.2.

## Middleware o endpoint, ahora en ambos lados

El argumento arquitectónico más fuerte a favor de Scalar solía ser que `MapScalarApiReference` registra un endpoint mientras que `UseSwaggerUI` registra middleware, y el middleware termina la solicitud antes de que el enrutamiento por endpoints tenga algo que decir. Ese argumento expiró en mayo de 2026. Swashbuckle 10.2.0 agregó `MapSwaggerUI` y `MapReDoc` "to support endpoint routing". Ambas interfaces ahora pueden llevar metadatos de endpoint, aparecer en `EndpointDataSource` y aceptar convenciones de enrutamiento directamente:

```csharp
// Program.cs -- .NET 11, C# 14
// Scalar: MapScalarApiReference returns an IEndpointConventionBuilder
app.MapScalarApiReference()
   .RequireAuthorization("ApiDocsPolicy");

// Swashbuckle 10.2.0+: same shape
app.MapSwaggerUI()
   .RequireAuthorization("ApiDocsPolicy");
```

Si estás detrás de un proxy inverso, ten en cuenta que el endpoint HTML de Scalar redirige una solicitud a `/scalar` hacia `/scalar/` con un 301 para que sus rutas relativas de assets resuelvan, y el middleware de Swashbuckle hace un 301 de una solicitud a su prefijo de ruta desnudo hacia `index.html`. Una prueba de integración que afirme un 200 en la ruta desnuda falla contra cualquiera de los dos.

## Authorize, y qué pasa después de hacer clic

Ambas interfaces leen los esquemas de seguridad del documento, y ninguna los inventa. La propia documentación de Scalar es tajante: tu documento OpenAPI ya debe incluir los esquemas para que Scalar pueda trabajar con ellos. Si no los pusiste ahí, el [recorrido por los transformadores de operación y esquema](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) es el mecanismo que necesitas.

Lo que difiere es la ergonomía a partir de ahí. Scalar rellena previamente las credenciales desde la configuración del servidor y puede persistirlas entre recargas:

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.20
app.MapScalarApiReference(options =>
{
    options.AddPreferredSecuritySchemes("Bearer")
           .AddHttpAuthentication("Bearer", auth => auth.WithToken(devToken));
    options.PersistentAuthentication = true;
});
```

El equivalente de Swagger UI vive en el objeto de configuración y, para OAuth2, en la página `oauth2-redirect.html` que Swashbuckle incrusta por ti (664 bytes de script de redirección que llevan una década en circulación):

```csharp
// Program.cs -- .NET 11, C# 14, Swashbuckle.AspNetCore.SwaggerUI 10.2.3
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/openapi/v1.json", "v1");
    options.OAuthClientId("dev-client");
    options.OAuthUsePkce();
    options.EnablePersistAuthorization();
});
```

La única capacidad que Scalar tiene y Swagger UI no es `proxyUrl`. El Try It de Swagger UI dispara un `fetch` desde el origen de la documentación, así que una API entre orígenes sin CORS permisivo produce un error de navegador que parece un fallo del servidor. Scalar puede enrutar la solicitud a través de un proxy en su lugar. Si tu documentación se aloja aparte de la API, esa única opción lo decide.

## Los ejemplos de código son la diferencia real de producto

Swagger UI te muestra el comando curl de la solicitud que acabas de ejecutar. Scalar renderiza la solicitud en cada cliente que conoce antes de que envíes nada: shell (curl, httpie), JavaScript (fetch, axios, jquery), Node, Python, Go, Java, Ruby, PHP y más, controlado por `hiddenClients` y `defaultHttpClient`. Para una API interna donde quienes leen son las mismas personas que la escribieron, eso es decoración. Para una API pública donde quien lee está decidiendo si tu producto es fácil de integrar, es la página entera.

Scalar además te da `searchHotKey` (CMD/CTRL+K por defecto), doce temas integrados, `customCss` y un hook `/scalar/config.js` para configuración arbitraria del cliente. La personalización de Swagger UI pasa por `InjectStylesheet`, `InjectJavascript` y el sistema de plugins de swagger-ui, que es más potente y mucho menos agradable, y ese es el resumen honesto de toda la comparación.

## Cuándo elegir cada uno

Elige Scalar cuando la documentación sea una superficie de producto, cuando quienes leen estén fuera de tu equipo, cuando quieras el constructor de solicitudes y los ejemplos de código, o cuando la documentación esté alojada en un origen distinto al de la API y necesites el proxy.

Elige Swagger UI cuando quieras el payload más pequeño y un `max-age` real, cuando tengas una configuración OAuth2 existente que ya funciona, cuando alguien del equipo dependa de un plugin de swagger-ui, o cuando quieras el renderizador con soporte explícito de 3.2 mientras .NET 11 emite 3.2 por defecto.

No elijas ninguno, y usa `Swashbuckle.AspNetCore.ReDoc` o una extensión del editor, cuando el documento lo consuman clientes generados en lugar de personas. No hay ninguna regla que diga que una API necesita una referencia renderizada.

Elijas lo que elijas, Microsoft Learn expone la postura de seguridad con claridad: las interfaces de usuario de OpenAPI solo deberían habilitarse en entornos de desarrollo. Ambos paquetes convierten eso en una guarda de entorno de una línea, y la versión paso a paso de esa configuración, incluyendo el bloqueo en producción y los assets offline, está en el [recorrido de Scalar](/es/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/).

## Los detalles que deciden por ti

- **El metapaquete.** `Swashbuckle.AspNetCore` 10.2.3 arrastra `SwaggerGen` y `Microsoft.Extensions.ApiDescription.Server`. Si migraste al generador integrado, ahora tienes dos generadores y uno de ellos está obsoleto. Referencia `Swashbuckle.AspNetCore.SwaggerUI` por su cuenta. La ruta completa de eliminación está en [migrar de Swashbuckle al generador OpenAPI integrado](/es/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/).
- **Ninguno de los dos paquetes apunta a `net11.0`.** Ambos publican ensamblados `net8.0`, `net9.0` y `net10.0` con una referencia de framework. El asset `net10.0` corre en .NET 11 por roll-forward, lo cual está bien, pero significa que una corrección específica para `net11.0` en cualquiera de los dos proyectos no es algo que puedas esperar.
- **Los assets de Scalar nunca se cachean.** `Cache-Control: no-cache` no es configurable mediante opciones. En un enlace lento hacia un entorno de desarrollo compartido, pagas una revalidación por asset por carga.
- **La barra final.** Ambas interfaces hacen un 301 de la ruta desnuda. Los proxies estrictos y las pruebas de integración lo notan.
- **La cabecera de versión de Swagger UI.** Swashbuckle agrega `x-swagger-ui-version` a las respuestas de assets, lo cual es útil para confirmar qué se distribuyó realmente y lo cual algunos escáneres marcarán como divulgación de información. Otra razón para la guarda de entorno.

Entre dos renderizadores con licencia MIT del mismo documento, esta es una decisión reversible: cambiar una línea de `Program.cs` y una referencia de paquete te mueve en cualquier dirección en unos cinco minutos. Elige según quien lee, no según el framework.

## Relacionado

- [Cómo servir documentación OpenAPI con Scalar en lugar de Swagger UI en ASP.NET Core 11](/es/2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11/) es la configuración completa: enrutamiento, múltiples documentos, autenticación y bloqueo en producción.
- [Cómo exponer OpenAPI sin Swashbuckle en ASP.NET Core 11](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/) cubre la mitad del generador de esta división.
- [Migrar de Swashbuckle a la generación de documentos OpenAPI integrada en .NET 11](/es/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/) es la lista de comprobación para eliminarlo.
- [Cómo personalizar el documento OpenAPI con AddOperationTransformer y AddSchemaTransformer](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/) es cómo los esquemas de seguridad llegan al documento en primer lugar.
- [Zstandard vs Brotli vs Gzip para compresión de respuestas en .NET 11](/es/2026/08/zstandard-vs-brotli-vs-gzip-response-compression-in-dotnet-11/) explica por qué los assets estáticos precomprimidos evitan por completo el middleware de compresión.

## Fuentes

- [Use the generated OpenAPI documents (Microsoft Learn, ASP.NET Core 11)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-11.0)
- [Generate OpenAPI documents, default version 3.2 in .NET 11 (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-11.0)
- [OpenApiSpecVersion enum, including OpenApi3_2 (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.openapi.openapispecversion)
- [Swashbuckle.AspNetCore v10.2.0 release notes, MapSwaggerUI and MapReDoc](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/releases/tag/v10.2.0)
- [Swashbuckle.AspNetCore.SwaggerUI 10.2.3 on NuGet](https://www.nuget.org/packages/Swashbuckle.AspNetCore.SwaggerUI/10.2.3)
- [swagger-ui v5.32.0 release, basic OpenAPI 3.2.0 support](https://github.com/swagger-api/swagger-ui/releases/tag/v5.32.0)
- [Scalar.AspNetCore 2.16.20 on NuGet](https://www.nuget.org/packages/Scalar.AspNetCore/2.16.20)
- [Scalar .NET integration documentation](https://scalar.com/scalar/scalar-api-references/net-integration)
- [Scalar API reference configuration options](https://scalar.com/scalar/scalar-api-references/configuration)
- [OpenAPI 3.2 support tracking issue (scalar/scalar#6715)](https://github.com/scalar/scalar/issues/6715)
