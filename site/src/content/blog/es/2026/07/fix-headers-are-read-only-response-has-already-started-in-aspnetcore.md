---
title: "Solución: System.InvalidOperationException: Headers are read-only, response has already started"
description: "Estableciste un header, un código de estado o un content type después de que el cuerpo ya se vació. Establece todos los headers antes de la primera escritura, o protégete con HttpResponse.HasStarted y OnStarting."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "aspnetcore-11"
lang: "es"
translationOf: "2026/07/fix-headers-are-read-only-response-has-already-started-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-07-17
---

La solución: algo ya escribió en el cuerpo de la respuesta, lo que vació los headers hacia el cliente y los volvió de solo lectura, y luego tu código intentó establecer un header, un código de estado o un content type. En ASP.NET Core, `HttpResponse.StatusCode`, `HttpResponse.ContentType` y todo lo que está en `HttpResponse.Headers` deben establecerse **antes** de que se escriba el primer byte del cuerpo. Mueve todas las asignaciones de headers y de estado por delante de cualquier `WriteAsync`, `Redirect` o middleware descendente que escriba el cuerpo. Cuando no puedas controlar el orden, protege la asignación con `if (!context.Response.HasStarted)` o registra el trabajo en `HttpResponse.OnStarting` para que se ejecute justo antes de que se vacíen los headers. Esta guía está escrita contra ASP.NET Core 11 (`Microsoft.AspNetCore.App` 11.0.0-preview.4), C# 14 y Kestrel 11.0.0-preview.4; el comportamiento es idéntico hasta ASP.NET Core 3.0.

```text
System.InvalidOperationException: Headers are read-only, response has already started.
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpResponseHeaders.ThrowHeadersReadOnlyException()
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpHeaders.Microsoft.AspNetCore.Http.IHeaderDictionary.set_Item(String key, StringValues value)
   at MyApp.SecurityHeadersMiddleware.InvokeAsync(HttpContext context)
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpProtocol.ProcessRequests[TContext](IHttpApplication`1 application)
```

La traza de pila casi siempre termina en `ThrowHeadersReadOnlyException` dentro de Kestrel (o su equivalente en HTTP.sys e IIS). El frame directamente por encima es la línea que intentó la mutación. Ese frame es tu culpable: está estableciendo un header, `StatusCode`, `ContentType` o llamando a `Redirect` después de que la respuesta ya empezó.

## Por qué es imposible establecer un header después de la primera escritura

HTTP está ordenado en el cable: línea de estado, luego headers, luego una línea en blanco y luego el cuerpo. Una vez que el servidor envió el bloque de headers al cliente, no puede des-enviarlo. ASP.NET Core modela esto volviendo la colección de headers de solo lectura en el momento en que la respuesta empieza, y lanza en lugar de descartar silenciosamente tu cambio, porque un header de seguridad o un content type ignorado en silencio es un bug mucho peor que una excepción ruidosa.

Dos cosas inician la respuesta. La documentación lo dice sin rodeos: "An app can't modify headers after the response has started. Once the response starts, the headers are sent to the client. A response is started by flushing the response body or calling `HttpResponse.StartAsync(CancellationToken)`." La primera de ellas es la que muerde a la gente, porque es implícita. Escribir el cuerpo lo vacía: "Unless response buffering is enabled, all write operations (for example, `WriteAsync`) flush the response body internally and mark the response as started. Response buffering is disabled by default." Así que el primer `WriteAsync`, el primer `CopyToAsync` en `Response.Body`, el primer `FlushAsync` en `Response.BodyWriter` y devolver un resultado que transmite contenido cambian `HttpResponse.HasStarted` a `true` y congelan los headers.

Por eso `HttpResponse.StatusCode`, `HttpResponse.ContentType` y `HttpResponse.Headers` están documentados cada uno como "Must be set before writing to the response body." No son notas de aviso. Son el contrato, y la excepción es la aplicación de ese contrato.

## Un repro mínimo

La versión más pequeña escribe el cuerpo y luego intenta establecer un header:

```csharp
// ASP.NET Core 11, C# 14
using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/broken", async (HttpContext context) =>
{
    await context.Response.WriteAsync("Processing...");   // flushes: HasStarted is now true
    context.Response.Headers["X-Trace-Id"] = "abc123";     // throws: headers are read-only
});

app.Run();
```

La llamada `WriteAsync` vacía el cuerpo y envía los headers. La siguiente línea intenta agregar `X-Trace-Id`, y Kestrel lanza `InvalidOperationException: Headers are read-only, response has already started`. La misma forma aparece con un código de estado:

```csharp
// ASP.NET Core 11, C# 14
app.MapGet("/broken-status", async (HttpContext context) =>
{
    await context.Response.WriteAsync("partial output");
    context.Response.StatusCode = 500;   // throws for the same reason
});
```

Y aparece con un redirect, porque `Redirect` establece tanto el header `Location` como un estado 302:

```csharp
// ASP.NET Core 11, C# 14
app.MapGet("/broken-redirect", async (HttpContext context) =>
{
    await context.Response.WriteAsync("about to redirect");
    context.Response.Redirect("/login");   // throws: Location header is read-only
});
```

## Reordena para que los headers vayan primero

La solución principal, y la que hay que buscar siempre que el código esté bajo tu control, es establecer cada header, el código de estado y el content type antes de escribir nada en el cuerpo. En un endpoint o controlador esto suele ser un movimiento de una línea:

```csharp
// ASP.NET Core 11, C# 14 -- correct order
app.MapGet("/fixed", async (HttpContext context) =>
{
    context.Response.StatusCode = 200;
    context.Response.ContentType = "text/plain";
    context.Response.Headers["X-Trace-Id"] = "abc123";   // set before any write

    await context.Response.WriteAsync("Processing...");  // now safe to flush
});
```

Prefiere devolver un `IResult` (minimal APIs) o un `IActionResult` (MVC) antes que escribir en `Response.Body` a mano. `Results.Text`, `Results.Json`, `Results.File` y `TypedResults` construyen la respuesta completa, headers incluidos, y solo entonces escriben, por lo que nunca tropiezan con este error. Recurrir a [una unión Results tipada desde un endpoint de minimal API](/es/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) mantiene el estado y los headers de forma declarativa y elimina por completo el peligro del orden manual.

## Protege el middleware con HasStarted

El caso más difícil es el middleware que ejecuta `await next(context)` y luego quiere tocar la respuesta. Para cuando `next` retorna, un endpoint descendente normalmente ya escribió el cuerpo, así que la respuesta empezó y cualquier cambio de header lanza. Esta es la fuente más común de este error, y el clásico infractor es un middleware de "security headers" o de "correlation id" escrito así:

```csharp
// ASP.NET Core 11, C# 14 -- broken middleware
app.Use(async (context, next) =>
{
    await next(context);   // endpoint writes the body here; response starts
    context.Response.Headers["X-Frame-Options"] = "DENY";   // throws
});
```

Hay dos patrones correctos, y la elección depende de si debes establecer el header incondicionalmente.

**Registra el trabajo en `OnStarting`.** `HttpResponse.OnStarting` toma un callback que el servidor ejecuta exactamente una vez, justo antes de vaciar los headers, ya sea que el cuerpo lo escriba tu middleware o cualquier cosa descendente. Regístralo antes de llamar a `next`, y el header se escribe en el último momento seguro:

```csharp
// ASP.NET Core 11, C# 14 -- correct: set headers just before they flush
app.Use(async (context, next) =>
{
    context.Response.OnStarting(() =>
    {
        context.Response.Headers["X-Frame-Options"] = "DENY";
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        return Task.CompletedTask;
    });

    await next(context);
});
```

Esta es la herramienta correcta para headers de respuesta transversales, porque funciona incluso cuando el código descendente empieza a transmitir de inmediato. Es el mismo mecanismo que usa internamente el propio middleware de headers de ASP.NET Core.

**Protégete con `HasStarted`.** Cuando el header solo importa si la respuesta aún no se comprometió (por ejemplo, un manejador de excepciones que quiere convertir un fallo en un 500), comprueba primero `HttpResponse.HasStarted` y omite la mutación cuando sea `true`:

```csharp
// ASP.NET Core 11, C# 14 -- defensive guard
app.Use(async (context, next) =>
{
    try
    {
        await next(context);
    }
    catch (Exception)
    {
        if (!context.Response.HasStarted)
        {
            context.Response.Clear();
            context.Response.StatusCode = 500;
            await context.Response.WriteAsync("Something went wrong.");
        }
        throw;   // nothing safe to do if the response already started
    }
});
```

`HttpResponse.Clear()` reinicia el código de estado, los headers y cualquier cuerpo en búfer, pero solo funciona mientras `HasStarted` sea `false`. Una vez que el cuerpo empezó a transmitirse, realmente no hay nada que puedas hacer para cambiar el estado o los headers, y el movimiento honesto es dejar que la excepción se propague o llamar a `HttpContext.Abort()` para cortar la conexión de modo que el cliente vea una respuesta rota en lugar de una mentira. Por eso el manejador de excepciones integrado y [un filtro de excepciones global en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) comprueban ambos `HasStarted` antes de escribir un cuerpo problem-details y relanzan cuando ya es demasiado tarde.

## Almacena el cuerpo en búfer cuando el middleware deba reescribirlo

Algún middleware realmente necesita leer o transformar la respuesta descendente, minificar HTML, inyectar una etiqueta de script o comprimir contenido, y solo entonces establecer un header `Content-Length` o `Content-Encoding`. No puedes hacer eso si el cuerpo ya se vació hacia el cliente. La solución es intercambiar el cuerpo de la respuesta por un búfer, dejar que el descendente escriba en el búfer, luego establecer tus headers y copiar el búfer al cuerpo real:

```csharp
// ASP.NET Core 11, C# 14 -- buffer downstream output, then set headers
app.Use(async (context, next) =>
{
    var originalBody = context.Response.Body;
    using var buffer = new MemoryStream();
    context.Response.Body = buffer;

    await next(context);   // downstream writes into the MemoryStream, not the socket

    // Response has NOT started: the real body was never touched.
    context.Response.Headers["Content-Length"] = buffer.Length.ToString();
    buffer.Position = 0;
    context.Response.Body = originalBody;
    await buffer.CopyToAsync(originalBody);
});
```

Como la escritura descendente fue a un `MemoryStream` y no a la conexión, `HasStarted` permanece en `false` y las asignaciones de headers tienen éxito. Esta es la versión manual de lo que hace el middleware que transforma respuestas; la ruta soportada por el framework es trabajar a través de `IHttpResponseBodyFeature` en lugar de asignar `Response.Body` directamente, pero el principio del búfer es el mismo. Si tu objetivo es específicamente la compresión, no lo hagas a mano: recurre a [la compresión de respuestas en una API de ASP.NET Core 11](/es/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/), que maneja la negociación y el header `Content-Encoding` por ti sin almacenar en búfer toda la respuesta en memoria.

## Trampas y falsos parecidos

**`Response.Redirect` cuenta como una escritura de header.** Un redirect establece el header `Location` y un estado 3xx, así que llamarlo después de cualquier escritura del cuerpo lanza exactamente esta excepción. Si te encuentras redirigiendo desde dentro de una acción que ya escribió salida, el bug real es que la decisión de redirigir se tomó demasiado tarde; muévela por encima de la primera escritura.

**Los endpoints de streaming tienen una diminuta ventana de headers.** Cuando [transmites un archivo desde un endpoint sin búfer](/2026/07/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/), la respuesta empieza en el momento en que el primer chunk se vacía. Cualquier `Content-Disposition` o `Content-Type` que quieras debe establecerse antes de ese primer `WriteAsync`. Si ocurre un error a mitad del stream no puedes cambiar a un 500, porque el bloque de header 200 ya está en el cable; la conexión simplemente termina. Diseña los manejadores de streaming para validar todo y establecer todos los headers por adelantado.

**Este no es el error de I/O síncrona.** `Headers are read-only, response has already started` trata sobre el *orden*, no sobre síncrono versus asíncrono. Si tu mensaje en cambio dice `Synchronous operations are disallowed`, ese es un problema distinto con una solución distinta, cubierto en [InvalidOperationException: Synchronous operations are disallowed](/es/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed). No confundas ambos; cambiar `WriteAsync` por `Write` no ayudará aquí y reordenar no ayudará allá.

**Blazor e Identity lo exponen de forma indirecta.** Los componentes interactivos de Blazor y los flujos de ASP.NET Core Identity a veces disparan esto desde código del framework, típicamente cuando un componente intenta establecer una cookie o redirigir después de que empezó el render, o cuando un desajuste de render mode fuerza la salida antes de que se ejecute la autenticación. Si la traza de pila apunta al render de Blazor en lugar de a tu propio middleware, busca un `NavigationManager.NavigateTo` o una escritura de cookie que ocurra después del primer render, y consulta [a render mode is not supported by the parent component's render mode](/es/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor) para el problema adyacente de render mode.

**El orden del middleware decide quién gana.** Un middleware que establece headers solo funciona si registra su callback de `OnStarting`, o establece sus headers, antes de que el middleware terminal escriba el cuerpo. Si tu middleware de headers personalizado se ubica *después* de `UseStaticFiles` o del middleware de endpoints en el pipeline para las rutas que lo alcanzan, ya es demasiado tarde. Registra el middleware de respuesta transversal temprano en `Program.cs`.

**Escrituras dobles en rutas de excepción.** Un disparador frecuente en producción es código que escribe una respuesta de éxito parcial, luego alcanza una excepción y un manejador externo intenta sobrescribirla con un error. La primera escritura ya inició la respuesta. Valida y reúne todo lo que pueda fallar antes de escribir el primer byte, para que la escritura sea lo último que hace el manejador, no lo primero.

## Relacionados

- [Cómo agregar un filtro de excepciones global en ASP.NET Core 11](/es/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) muestra la protección con `HasStarted` en un manejador de excepciones real.
- [Cómo transmitir un archivo desde un endpoint de ASP.NET Core sin búfer](/2026/07/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) explica exactamente cuándo una respuesta transmitida compromete sus headers.
- [Cómo agregar compresión de respuestas a una API de ASP.NET Core 11](/es/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) es la forma soportada de transformar el cuerpo sin búfer manual.
- [Cómo devolver una unión Results tipada desde un endpoint de minimal API](/es/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) mantiene el estado y los headers de forma declarativa para que el orden no pueda salir mal.
- [Solución: InvalidOperationException: Synchronous operations are disallowed](/es/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed) es la otra InvalidOperationException que parece similar pero no lo es.

## Fuentes

- [Use HttpContext in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/use-http-context?view=aspnetcore-10.0), Microsoft Learn, para la regla de que los headers, `StatusCode` y `ContentType` deben establecerse antes de escribir, el texto exacto de la excepción y la nota de que `WriteAsync` vacía e inicia la respuesta porque el búfer está desactivado por defecto.
- [HttpResponse.HasStarted](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresponse.hasstarted), documentación de la API de .NET, sobre cómo detectar si la respuesta se comprometió.
- [HttpResponse.OnStarting](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresponse.onstarting), documentación de la API de .NET, para registrar trabajo que se ejecuta justo antes de que se vacíen los headers.
- [Write custom ASP.NET Core middleware](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/write?view=aspnetcore-10.0), Microsoft Learn, sobre el orden del pipeline que determina quién escribe el cuerpo primero.
