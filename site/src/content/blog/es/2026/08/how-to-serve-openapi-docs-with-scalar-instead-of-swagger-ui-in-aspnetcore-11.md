---
title: "Cómo servir documentación OpenAPI con Scalar en lugar de Swagger UI en ASP.NET Core 11"
description: "Reemplaza UseSwaggerUI por MapScalarApiReference en ASP.NET Core 11: enrutamiento, múltiples documentos, autenticación precargada, control en producción, recursos sin CDN y las extensiones de OpenAPI exclusivas de Scalar."
pubDate: 2026-08-09
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "scalar"
lang: "es"
translationOf: "2026/08/how-to-serve-openapi-docs-with-scalar-instead-of-swagger-ui-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-08-09
---

Para cambiar Swagger UI por Scalar en una API de ASP.NET Core 11, instala `Scalar.AspNetCore`, elimina la llamada a `app.UseSwaggerUI(...)` y agrega `app.MapScalarApiReference()` junto a tu `app.MapOpenApi()` existente. La interfaz queda entonces en `/scalar` y lee el documento desde `/openapi/v1.json`, que es exactamente lo que ya sirve `MapOpenApi`. Ese es el noventa por ciento de los casos. El otro diez por ciento es todo lo que viene abajo: un documento en una ruta que no es la predeterminada, más de un documento, un botón Authorize que realmente adjunta un token y mantener todo esto fuera de tu hostname de producción.

Todo lo de aquí apunta a .NET 11 (probado con Preview 6, SDK `11.0.100-preview.6.26359.118`) con `Microsoft.NET.Sdk.Web` y C# 14, usando `Scalar.AspNetCore` 2.16.18, publicado el 2026-08-07. La superficie de API de abajo es idéntica en .NET 8, 9 y 10, porque el paquete apunta a `net8.0` en adelante.

## Los seis pasos, de principio a fin

1. Instala `Scalar.AspNetCore` con `dotnet add package Scalar.AspNetCore` y agrega `using Scalar.AspNetCore;` a `Program.cs`.
2. Elimina la llamada al middleware `app.UseSwaggerUI(...)`, y elimina la referencia al paquete `Swashbuckle.AspNetCore.SwaggerUI` si nada más lo usa.
3. Llama a `app.MapScalarApiReference()` dentro de la misma guarda de entorno que ya envuelve a `app.MapOpenApi()`.
4. Apunta Scalar al documento correcto con `WithOpenApiRoutePattern` o `AddDocument` si tu JSON de OpenAPI no está en `/openapi/{documentName}.json`.
5. Precarga credenciales con `AddPreferredSecuritySchemes` y `AddHttpAuthentication` para que el botón Authorize envíe un token real en desarrollo.
6. Decide la estrategia para producción: o dejas el endpoint fuera de producción por completo, o lo mapeas y encadenas `RequireAuthorization()` sobre el constructor de endpoints devuelto.

## Qué cambia realmente cuando desaparece Swagger UI

La diferencia más importante no es visual. `UseSwaggerUI` registra middleware. `MapScalarApiReference` registra un endpoint. Ese único cambio mueve la interfaz desde el pipeline hacia la tabla de enrutamiento, y todo lo demás se deriva de ahí.

El middleware se ejecuta en orden de registro y termina la solicitud antes de que el enrutamiento de endpoints tenga algo que decir, y por eso Swagger UI históricamente ignoraba tus políticas de autorización salvo que construyeras un middleware personalizado a su alrededor. Un endpoint participa en el enrutamiento como cualquier otro, así que lleva metadatos, aparece en `EndpointDataSource` y las convenciones que ya conoces se le aplican directamente.

```csharp
// Program.cs -- .NET 11, C# 14
// Before: Swashbuckle's UI middleware over the built-in OpenAPI document
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseSwaggerUI(options => options.SwaggerEndpoint("/openapi/v1.json", "v1"));
}
```

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.18
// After: an endpoint, not middleware
using Scalar.AspNetCore;

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Fíjate en lo que falta en el segundo bloque: no hay equivalente de `SwaggerEndpoint`. Scalar usa como ruta predeterminada del documento `/openapi/{documentName}.json`, que es precisamente la ruta que registra `MapOpenApi`, así que ambas coinciden sin configuración. Si ya reemplazaste el generador de Swashbuckle por el integrado, este es el último paquete de Swashbuckle que te quedaba. El lado del generador de ese cambio está cubierto en [exponer OpenAPI sin Swashbuckle en ASP.NET Core 11](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/).

Hay un detalle de comportamiento que conviene conocer antes de reportar un bug. Navegar a `/scalar` emite una redirección a `/scalar/` para que las rutas de los recursos del lado del cliente se resuelvan correctamente. Si tienes una política de redirecciones estricta, un proxy que reescribe barras finales o una prueba de integración que espera un 200 en `/scalar`, ese 301 es lo que estás viendo.

## Apuntar Scalar a un documento que no está en la ruta predeterminada

`MapOpenApi` acepta un patrón de ruta, y muchísimos proyectos lo cambiaron hace años para mantener contentos a generadores de clientes antiguos. Si tu documento está en `/swagger/v1/swagger.json`, o si .NET 10 agregó una variante YAML que prefieres servir, dile a Scalar dónde buscar:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapOpenApi("/swagger/{documentName}/swagger.json");

app.MapScalarApiReference(options =>
{
    options
        .WithTitle("Orders API")
        .WithOpenApiRoutePattern("/swagger/{documentName}/swagger.json");
});
```

`WithOpenApiRoutePattern` también acepta una URL absoluta, que es la forma de apuntar un host de documentación a una especificación generada por otro servicio. La ruta puede ser igualmente la de un archivo producido en tiempo de compilación por `Microsoft.Extensions.ApiDescription.Server` y servido como archivo estático, si prefieres no ejecutar el generador en tiempo de ejecución.

La ruta de la interfaz en sí es el primer argumento de `MapScalarApiReference`. Hay seis sobrecargas: con o sin prefijo de ruta, con o sin delegado de opciones, y con o sin un `HttpContext` en ese delegado.

```csharp
// Program.cs -- .NET 11, C# 14
// Mount the reference at /api-docs and vary options per request
app.MapScalarApiReference("/api-docs", (options, httpContext) =>
{
    options.WithTitle($"Orders API ({httpContext.Request.Host})");
});
```

La sobrecarga con `HttpContext` importa más de lo que parece. Es la manera soportada de calcular opciones a partir de la solicitud entrante: elegir un tema desde una cookie, escoger una lista de servidores según el encabezado host, u ocultar documentos que quien llama no tiene derecho a ver.

Si vienes de un código base con Scalar 1.x, ten en cuenta que `ScalarOptions.EndpointPathPrefix` está obsoleto. El prefijo de ruta se movió a ese primer parámetro, y el valor predeterminado cambió de `/scalar/{documentName}` a simplemente `/scalar`. Los viejos apaños para sub-rutas, donde reescribías manualmente `OpenApiRoutePattern` en aplicaciones alojadas bajo una path base, ya no hacen falta y deberían eliminarse, porque la resolución relativa ahora se maneja por ti.

## Múltiples documentos y versiones de API en una sola barra lateral

Swagger UI expresaba esto con llamadas repetidas a `SwaggerEndpoint` y un desplegable. Scalar lo expresa como documentos registrados:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOpenApi("v1");
builder.Services.AddOpenApi("v2");

// ...

app.MapOpenApi();
app.MapScalarApiReference(options =>
{
    options
        .AddDocument("v1", "Orders API v1")
        .AddDocument("v2", "Orders API v2 (beta)", isDefault: true);
});
```

Cada sobrecarga de `AddDocument` acepta un nombre, un título de visualización opcional y un patrón de ruta opcional, así que documentos que viven en rutas distintas conviven en una sola referencia. `AddDocuments(["v1", "v2", "v3"])` es la forma breve cuando los nombres bastan. Si generas un documento por versión de API con `Asp.Versioning`, aquí es donde aterrizan esos nombres; la plomería específica del versionado está en [versionado de API con OpenAPI en .NET](/es/2026/04/api-versioning-openapi-dotnet-10/).

Los nombres de documento se reenvían al generador exactamente como los escribes, incluidas las mayúsculas. Un documento registrado como `V1` y solicitado como `v1` produce una referencia vacía en lugar de un error, porque la petición del documento simplemente devuelve 404 y la interfaz no tiene nada que renderizar. Mantén todos los nombres de documento en minúsculas y esto nunca aparecerá.

## Hacer que el botón Authorize envíe un token real

Esta es la parte que más confusión genera, y la regla es simple: Scalar precarga únicamente los esquemas de seguridad que tu documento OpenAPI ya declara. No lee tu middleware de autenticación, y no puede inventar un esquema que el documento no describe. Si el documento no tiene una entrada `securitySchemes`, ninguna configuración del cliente adjuntará un encabezado `Authorization`. Escribí sobre ese fallo exacto con detalle en [por qué tu token Bearer se ignora en Scalar](/es/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/), y el diagnóstico no ha cambiado.

Suponiendo que el documento declara un esquema HTTP bearer llamado `BearerAuth`, esto lo preselecciona y precarga un token de desarrollo:

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore 2.16.18
app.MapScalarApiReference(options =>
{
    options
        .AddPreferredSecuritySchemes("BearerAuth")
        .AddHttpAuthentication("BearerAuth", auth =>
        {
            auth.Token = builder.Configuration["Scalar:DevToken"]!;
        });
});
```

Los flujos de OAuth2 tienen helpers de primera clase en lugar de la configuración plana clave-valor que usaba Swagger UI. `AddAuthorizationCodeFlow`, `AddClientCredentialsFlow`, `AddPasswordFlow` y `AddImplicitFlow` reciben cada uno un delegado de configuración, y PKCE es una propiedad y no una casilla que esperas que la interfaz respete:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference(options =>
{
    options
        .AddPreferredSecuritySchemes("OAuth2")
        .AddAuthorizationCodeFlow("OAuth2", flow =>
        {
            flow.ClientId = builder.Configuration["Scalar:ClientId"]!;
            flow.Pkce = Pkce.Sha256;
            flow.SelectedScopes = ["orders.read", "orders.write"];
        });
});
```

Dos cosas que conviene retener. Primero, cualquier valor que pases aquí se serializa dentro de la página que descarga el navegador, así que un client secret configurado de esta forma es público. La propia documentación de Scalar dice que los datos de autenticación precargados nunca deben usarse en producción, y eso no es cautela de formulario: trata esos valores como si los hubieras pegado en un archivo HTML público, porque eso hiciste. Segundo, `EnablePersistentAuthentication()` guarda lo que el usuario escribe en el almacenamiento del navegador entre recargas, lo cual es genuinamente cómodo en una laptop y genuinamente incorrecto en una máquina compartida.

Si estás montando el lado del servidor de esto al mismo tiempo, [autenticación JWT bearer en una minimal API](/es/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/) cubre la mitad de validación del token, y la declaración del esquema en sí es un transformador de documento, descrito en [personalizar OpenAPI con transformadores de operación y de esquema](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/).

## Mantener la referencia fuera de producción sin perderla

La guía de Microsoft es explícita en que las interfaces de usuario de OpenAPI, Scalar incluida, pertenecen solo a entornos de desarrollo. La guarda predeterminada de la plantilla se encarga de eso:

```csharp
// Program.cs -- .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

Los equipos que quieren la referencia en un host interno de staging tienen una opción mejor que una comprobación de entorno, y existe precisamente porque Scalar es un endpoint. `MapScalarApiReference` devuelve un `IEndpointConventionBuilder`, así que todas las convenciones de enrutamiento se aplican:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference()
   .RequireAuthorization("InternalOnly")
   .ExcludeFromDescription();

app.MapOpenApi()
   .RequireAuthorization("InternalOnly");
```

Protege ambos. Proteger la interfaz mientras dejas `/openapi/v1.json` anónimo no protege nada: el documento es la divulgación de información, y la interfaz es solo un renderizador de él. `ExcludeFromDescription()` evita que el endpoint de documentación aparezca dentro de la documentación, lo cual es prolijo más que importante.

## Recursos, alojamiento sin conexión y las fuentes que llaman a casa

Scalar empaqueta su JavaScript y su CSS dentro del paquete NuGet y los sirve desde tu propio origen, así que un entorno aislado o sin conexión funciona sin configuración alguna. Esto no era cierto en las primeras versiones 1.x, de donde viene la creencia persistente de que Scalar requiere una CDN.

La única solicitud externa que queda es la fuente web predeterminada. Elimínala con una sola llamada:

```csharp
// Program.cs -- .NET 11, C# 14
app.MapScalarApiReference(options =>
{
    options.DisableDefaultFonts();
});
```

`WithBundleUrl("https://cdn.jsdelivr.net/npm/@scalar/api-reference")` va en la dirección contraria, tomando el bundle desde una CDN si prefieres seguir la interfaz más nueva sin actualizar el paquete. Si aplicas una Content Security Policy estricta, `DisableDefaultFonts` más los recursos empaquetados significa que la referencia no necesita nada más allá de `'self'` y el script de configuración en línea.

Las opciones también pueden enlazarse desde la configuración en lugar del código, que es la forma más limpia de mantener los ajustes específicos de cada entorno fuera de `Program.cs`:

```csharp
// Program.cs -- .NET 11, C# 14
builder.Services.AddOptions<ScalarOptions>().BindConfiguration("Scalar");
```

Cualquier cosa establecida en el delegado de `MapScalarApiReference` sobrescribe los valores enlazados.

## Metadatos exclusivos de Scalar: estabilidad, endpoints ocultos y ejemplos de código

Las funcionalidades sin equivalente en Swagger UI viven en un paquete complementario, `Scalar.AspNetCore.Microsoft` (2.16.18, que apunta a `net9.0` y `net10.0`, y depende de `Microsoft.AspNetCore.OpenApi` y de `Microsoft.OpenApi` 2.7.5 o superior). Registra transformadores de documento que escriben las extensiones de proveedor de Scalar dentro del documento generado. Si sigues con el generador de Swashbuckle, `Scalar.AspNetCore.Swashbuckle` hace el mismo trabajo mediante filtros.

```csharp
// Program.cs -- .NET 11, C# 14, Scalar.AspNetCore.Microsoft 2.16.18
builder.Services.AddOpenApi(options => options.AddScalarTransformers());

// ...

app.MapGet("/orders", GetOrders).Stable();
app.MapGet("/orders/forecast", GetForecast).Experimental();
app.MapGet("/internal/metrics", GetMetrics).ExcludeFromApiReference();
```

`ExcludeFromApiReference()` merece una mención aparte. Oculta la operación en la referencia renderizada pero la deja en el documento OpenAPI y totalmente enrutable, lo cual es distinto de `ExcludeFromDescription()`, que la quita del documento por completo. Elige según si tus generadores de clientes todavía necesitan ver el endpoint. `CodeSample()` adjunta un fragmento escrito a mano para un `ScalarTarget` dado, y `WithBadge()` coloca una etiqueta de color junto a una operación; ambos existen como atributos sobre acciones de controlador si no usas minimal APIs.

## Trampas que cuestan una tarde

**El paquete no tiene un target framework `net11.0`.** A partir de la 2.16.18 la lista de TFM se detiene en `net10.0`, y un proyecto `net11.0` consume los recursos de `net10.0` mediante las reglas normales de compatibilidad. Esto está bien y es esperable durante la ventana de versión preliminar, pero si tu compilación falla por una política interna que exige coincidencia exacta de TFM, esa es la razón.

**Una referencia en blanco casi siempre significa un documento faltante, no una interfaz rota.** Abre `/openapi/v1.json` directamente. Si devuelve 404, `MapOpenApi` no está mapeado, está detrás de una guarda de entorno distinta a la de la interfaz, o está en una ruta que nunca le indicaste a Scalar. La referencia renderiza una cáscara vacía en lugar de un error en todos esos casos.

**La generación de documentos en tiempo de compilación no alimenta la interfaz.** Configurar `OpenApiGenerateDocuments` en tu `.csproj` escribe un archivo JSON al compilar; no sirve uno en tiempo de ejecución. Si eliminas `MapOpenApi` porque ahora generas en tiempo de compilación, sirve el archivo generado como archivo estático y apunta `WithOpenApiRoutePattern` a él.

**`launchUrl` sigue diciendo `swagger`.** Después de eliminar el middleware de Swagger UI, `Properties/launchSettings.json` seguirá abriendo un 404 en cada `dotnet run` hasta que cambies `"launchUrl": "swagger"` por `"launchUrl": "scalar"`.

**Native AOT no cambia nada aquí.** El generador integrado es compatible con AOT y Scalar sirve recursos estáticos, así que la pareja sobrevive intacta a `PublishAot`. Lo que suele romperse bajo AOT es algún transformador basado en reflexión que escribiste tú, no la interfaz de referencia.

Swagger UI no está obsoleto y `Swashbuckle.AspNetCore.SwaggerUI` sigue funcionando perfectamente sobre un documento producido por `Microsoft.AspNetCore.OpenApi`. La razón para migrar es que Scalar es un endpoint y no middleware, envía sus recursos dentro del paquete y precarga la autenticación mediante una API tipada en lugar de un saco de cadenas. Si nada de eso te importa, quedarte donde estás es una respuesta defendible.

## Relacionado

- [Cómo exponer OpenAPI sin Swashbuckle en ASP.NET Core 11](/es/2026/06/how-to-expose-openapi-without-swashbuckle-in-aspnetcore-11/)
- [Scalar en ASP.NET Core: por qué tu token Bearer se ignora](/es/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Migrar de Swashbuckle al generador de OpenAPI integrado en .NET 11](/es/2026/06/migrate-from-swashbuckle-to-built-in-openapi-in-dotnet-11/)
- [Cómo personalizar el documento OpenAPI con transformadores de operación y de esquema](/es/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Cómo agregar flujos de autenticación de OpenAPI a Swagger UI en .NET 11](/es/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/)

## Fuentes

- [Usar los documentos OpenAPI generados](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/using-openapi-documents?view=aspnetcore-10.0) en Microsoft Learn
- [Documentación de la integración de Scalar con ASP.NET Core](https://scalar.com/products/api-references/integrations/aspnetcore/integration)
- [Extensiones OpenAPI de Scalar para .NET](https://scalar.com/products/api-references/integrations/aspnetcore/openapi-extensions)
- [Guía de migración a Scalar.AspNetCore 2.0.0](https://github.com/scalar/scalar/issues/4362)
- [Scalar.AspNetCore en NuGet](https://www.nuget.org/packages/Scalar.AspNetCore)
