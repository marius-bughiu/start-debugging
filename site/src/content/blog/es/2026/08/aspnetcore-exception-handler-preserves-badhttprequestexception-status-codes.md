---
title: "ASP.NET Core deja de convertir 413 en 500 en UseExceptionHandler"
description: "Un PR fusionado en main de dotnet/aspnetcore el 2026-08-19 hace que ExceptionHandlerMiddleware respete BadHttpRequestException.StatusCode en lugar de sobrescribirlo con 500."
pubDate: 2026-08-20
tags:
  - "aspnetcore"
  - "dotnet"
  - "error-handling"
  - "dotnet-11"
lang: "es"
translationOf: "2026/08/aspnetcore-exception-handler-preserves-badhttprequestexception-status-codes"
translatedBy: "claude"
translationDate: 2026-08-20
---

Si usas `app.UseExceptionHandler()` en producción, cada solicitud que Kestrel rechaza por ser demasiado grande viene apareciendo en tu telemetría como una falla del servidor. El [PR #68632](https://github.com/dotnet/aspnetcore/pull/68632) llegó a `main` de `dotnet/aspnetcore` el 2026-08-19 y corrige eso. Cierra el [issue #43831](https://github.com/dotnet/aspnetcore/issues/43831), abierto en septiembre de 2022.

## El 500 que en realidad era un 413

`ExceptionHandlerMiddleware` establece el código de estado de la respuesta antes de invocar tu manejador, y hasta este PR fijaba 500 de forma rígida cuando `ExceptionHandlerOptions.StatusCodeSelector` era null. `BadHttpRequestException` lleva su propio `StatusCode`, y ese valor se descartaba.

Así se ve, verificado contra ASP.NET Core 10.0.0 sobre el SDK 10.0.201:

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 100);

var app = builder.Build();
app.UseExceptionHandler();

app.MapPost("/upload", async (HttpContext ctx) =>
{
    using var ms = new MemoryStream();
    await ctx.Request.Body.CopyToAsync(ms);   // throws when the body exceeds 100 bytes
    return Results.Ok(ms.Length);
});

app.Run();
```

Envía 500 bytes con `POST` a `/upload`. La excepción que llega al middleware es `BadHttpRequestException` con `StatusCode = 413` y el mensaje "Request body too large. The max request body size is 100 bytes." La respuesta que en realidad recibes es:

```
HTTP/1.1 500 Internal Server Error
Content-Type: application/problem+json

{"type":"https://tools.ietf.org/html/rfc9110#section-15.6.1",
 "title":"An error occurred while processing your request.","status":500,...}
```

Al cliente se le dice que rompió el servidor. Tus paneles de 5xx opinan lo mismo. Es la misma clase de confusión detrás de [413 Request Entity Too Large al subir un archivo](/es/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/), salvo que aquí el estado correcto nunca llega a la red.

## Qué cambió

Ahora el middleware hace coincidencia de patrones sobre la excepción antes de recurrir a 500:

```csharp
context.Response.StatusCode = _options.StatusCodeSelector?.Invoke(edi.SourceException)
    ?? (edi.SourceException switch
    {
        BadHttpRequestException badHttpRequestException => badHttpRequestException.StatusCode,
        _ => DefaultStatusCode,
    });
```

Tres detalles que conviene conocer. `StatusCodeSelector` sigue teniendo prioridad si defines uno, así que las sobrescrituras existentes conservan su comportamiento. Los delegados `ExceptionHandler` personalizados y los servicios `IExceptionHandler` todavía pueden cambiar el código después. Y un 404 transportado por una `BadHttpRequestException` ahora se trata como deliberado y no como un manejador mal configurado, por lo que ya no necesita `AllowStatusCode404Response = true` para sobrevivir.

El alcance es estrecho a propósito: solo se reasigna `BadHttpRequestException`. Llamar a `Request.ReadFormAsync()` con un cuerpo `text/plain` lanza `InvalidOperationException` ("Incorrect Content-Type"), y eso sigue devolviendo 500 antes y después. El enlace de modelos de las minimal APIs tampoco se ve afectado, porque un cuerpo JSON mal formado se convierte en un 400 escueto por el request delegate antes de que escape ninguna excepción.

Al momento de escribir esto el commit está solo en `main`. No está en la rama `release/11.0-rc1`, así que espéralo en una compilación posterior de .NET 11 y no en RC1. Si hoy estás en .NET 8 a 11, la solución alternativa sigue siendo un `StatusCodeSelector` que desempaquete la excepción por tu cuenta.
