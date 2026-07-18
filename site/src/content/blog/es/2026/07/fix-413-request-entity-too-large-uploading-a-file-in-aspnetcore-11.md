---
title: "Solución: \"413 Request Entity Too Large\" al subir un archivo a un endpoint de ASP.NET Core"
description: "Kestrel limita el cuerpo de las solicitudes a 30.000.000 de bytes por defecto y devuelve 413 cuando lo superas. Sube MaxRequestBodySize globalmente, por endpoint o en web.config detrás de IIS."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "file-upload"
lang: "es"
translationOf: "2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-17
---

Una subida devuelve `413 Request Entity Too Large` porque Kestrel limita cada cuerpo de solicitud a 30.000.000 de bytes (unos 28,6 MiB) por defecto, y tu archivo es más grande. Sube el límite donde realmente aplica: asigna `MaxRequestBodySize` en Kestrel de forma global, aplica `[RequestSizeLimit]` o `[DisableRequestSizeLimit]` en una acción de controlador, aumenta `FormOptions.MultipartBodyLengthLimit` para los envíos de formularios y, detrás de IIS, sube `maxAllowedContentLength` en `web.config`. Verificado con ASP.NET Core 11 en .NET 11 con C# 14; los límites y valores por defecto son idénticos de .NET 8 a .NET 11.

## El error en contexto

Hay dos formas en que aparece. La primera es la respuesta HTTP que ve el cliente:

```
HTTP/1.1 413 Request Entity Too Large
Content-Length: 0
Connection: close
Date: Fri, 17 Jul 2026 10:04:11 GMT
```

La segunda es la línea de registro que Kestrel escribe en el servidor, que es la que te dice exactamente qué límite se disparó:

```
Microsoft.AspNetCore.Server.Kestrel.Core.BadHttpRequestException:
Request body too large. The max request body size is 30000000 bytes.
```

Ese `30000000` es la pista. Si no has cambiado nada, el número del mensaje es el valor por defecto del framework, y la solución es subir o eliminar el límite en la capa que lo controla. Si el número es otro, alguien ya configuró un límite y lo estás alcanzando. En cualquier caso la causa es la misma: el cuerpo de la solicitud superó un máximo configurado, y el servidor rechazó la conexión antes de que tu handler pudiera terminar de leerlo.

## Por qué ocurre

Una subida puede ser bloqueada por cuatro límites distintos, y viven en lugares distintos. Acertar con la solución significa saber cuál produjo tu `413`.

- **`MaxRequestBodySize` de Kestrel** limita el cuerpo total de la solicitud a 30.000.000 de bytes por defecto. Si lo superas, Kestrel lanza `BadHttpRequestException` y devuelve `413`. Este es el que produce el mensaje exacto de arriba.
- **`FormOptions.MultipartBodyLengthLimit`** limita la longitud de un cuerpo de formulario multipart a 134.217.728 de bytes (128 MiB) por defecto. Si lo superas, el lector de formularios lanza `InvalidDataException`, que aparece como un `400 Bad Request`, no un `413`. La gente confunde ambos constantemente.
- **`maxAllowedContentLength` de IIS** (cuando alojas detrás de IIS) limita la solicitud en la capa de filtrado de solicitudes de IIS, por defecto 30.000.000 de bytes, antes de que la solicitud llegue a tu aplicación. IIS devuelve su propio error para esto, así que subir solo el límite de Kestrel no hace nada detrás de IIS.
- **Un proxy inverso** (nginx, YARP, una API gateway, un balanceador de carga en la nube) puede imponer su propio límite de cuerpo y devolver `413` antes de que Kestrel vea siquiera la solicitud.

Si la solicitud funciona directamente contra Kestrel pero falla detrás de un proxy o de IIS, el límite que necesitas cambiar no está en tu código C#. Revisa primero la capa más externa.

## Reproducción mínima

El endpoint más pequeño que reproduce el `413` por defecto. Sin límites personalizados, solo los valores por defecto del framework:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapPost("/upload", async (HttpRequest request) =>
{
    // Reading the body is what trips the limit
    using var reader = new StreamReader(request.Body);
    var content = await reader.ReadToEndAsync();
    return Results.Ok(new { bytes = content.Length });
});

app.Run();
```

Envía cualquier cosa mayor de 30.000.000 de bytes y la lectura lanza la excepción:

```bash
# .NET 11 -- generate a 40 MB file and POST it
head -c 40000000 /dev/urandom > big.bin
curl -i -X POST http://localhost:5000/upload \
  -H "Content-Type: application/octet-stream" \
  --data-binary @big.bin
# -> HTTP/1.1 413 Request Entity Too Large
```

La carga de 40 MB pasa el límite multipart de 128 MiB (de todos modos no es multipart), pero supera el tope de 30 MB del cuerpo de Kestrel, así que obtienes `413`, no `400`.

## Sube el límite donde aplica

Recórrelos según de dónde venga tu `413`. La mayoría de las aplicaciones Kestrel autoalojadas solo necesitan el primero.

### 1. Sube o elimina el límite global de Kestrel

Configura `KestrelServerOptions.Limits.MaxRequestBodySize` al inicio. Asígnale un número concreto de bytes, o `null` para eliminar el tope por completo:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(options =>
{
    // 200 MB ceiling for the whole app
    options.Limits.MaxRequestBodySize = 200 * 1024 * 1024;
});

var app = builder.Build();
```

Prefiere un tope real antes que `null`. Un tamaño de cuerpo sin límite es un vector de denegación de servicio: un solo cliente puede transmitir gigabytes a tu proceso y agotar la memoria o el disco. Elige la subida legítima más grande que esperes y añade margen, en vez de desactivar la protección.

### 2. Fija un límite por endpoint en controladores con atributos

Si solo un endpoint acepta subidas grandes, no subas el límite global de toda la aplicación. En una acción de controlador o una Razor Page, usa `[RequestSizeLimit(bytes)]` para fijar un tope concreto, o `[DisableRequestSizeLimit]` para eliminarlo solo en esa acción. Ambos atributos implementan `IRequestSizeLimitMetadata`, que el pipeline de MVC lee en cada solicitud:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
[ApiController]
[Route("api/[controller]")]
public sealed class FilesController : ControllerBase
{
    [HttpPost("upload")]
    [RequestSizeLimit(200 * 1024 * 1024)]   // 200 MB, this action only
    public async Task<IResult> Upload(IFormFile file)
    {
        await using var stream = System.IO.File.Create(
            Path.Combine("uploads", file.FileName));
        await file.CopyToAsync(stream);
        return Results.Ok(new { file.FileName, file.Length });
    }
}
```

Cambia `[RequestSizeLimit(...)]` por `[DisableRequestSizeLimit]` cuando la acción deba aceptar cuerpos arbitrariamente grandes y tengas otra protección (streaming, una comprobación de cuota) en su lugar.

### 3. Fija el límite por solicitud en las minimal APIs

Las minimal APIs no respetan `[RequestSizeLimit]` como lo hacen los controladores, porque no hay ningún resource filter de MVC en el pipeline que lo lea. Fija el límite de forma imperativa mediante `IHttpMaxRequestBodySizeFeature`, antes de que nada lea el cuerpo:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/upload", async (HttpContext context) =>
{
    var sizeFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
    if (sizeFeature is not null && !sizeFeature.IsReadOnly)
    {
        sizeFeature.MaxRequestBodySize = 200 * 1024 * 1024;   // 200 MB
    }

    using var reader = new StreamReader(context.Request.Body);
    var content = await reader.ReadToEndAsync();
    return Results.Ok(new { bytes = content.Length });
});
```

Comprueba `IsReadOnly` primero. Una vez que el servidor ha empezado a leer el cuerpo, el límite queda bloqueado y asignarle un valor lanza `InvalidOperationException`. Por eso también esta técnica no funciona con un parámetro `IFormFile` en una minimal API: el model binding lee el cuerpo multipart antes de que se ejecute tu handler, así que cuando puedes tocar la feature ya es de solo lectura (esta es la raíz de la incidencia dotnet/aspnetcore #50871, donde las subidas multipart grandes a una minimal API devolvían `200` en silencio con un archivo truncado). Para subidas en minimal API, enlaza `HttpContext` o `HttpRequest`, sube el límite y luego lee el formulario tú mismo con `request.ReadFormAsync()`, o fija un límite para todo un grupo con un pequeño middleware sobre un `MapGroup`.

### 4. Sube el límite del formulario multipart para envíos de formularios

Si tu `413` es en realidad un `400` con una `InvalidDataException` sobre la longitud de un cuerpo multipart, el límite que se disparó es `FormOptions.MultipartBodyLengthLimit`, no el de Kestrel. Súbelo globalmente mediante options, o por acción de controlador con `[RequestFormLimits]`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- global, in Program.cs
builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = 200 * 1024 * 1024;   // 200 MB
});
```

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- per action
[HttpPost("upload")]
[RequestSizeLimit(200 * 1024 * 1024)]
[RequestFormLimits(MultipartBodyLengthLimit = 200 * 1024 * 1024)]
public async Task<IResult> Upload(IFormFile file) { /* ... */ }
```

Para una subida grande normalmente necesitas subir ambos: `MaxRequestBodySize` gobierna toda la solicitud, y `MultipartBodyLengthLimit` gobierna el cuerpo del formulario dentro de ella. Asígnales el mismo valor.

### 5. Detrás de IIS, sube maxAllowedContentLength en web.config

Cuando alojas detrás de IIS (in-process o out-of-process), el módulo de filtrado de solicitudes de IIS impone `maxAllowedContentLength`, por defecto 30.000.000 de bytes, antes de que la solicitud llegue a Kestrel. Subir el límite de Kestrel no hace nada hasta que también subes este. Añádelo a `web.config`:

```xml
<!-- web.config -- value is in bytes; 200 MB here -->
<system.webServer>
  <security>
    <requestFiltering>
      <requestLimits maxAllowedContentLength="209715200" />
    </requestFiltering>
  </security>
</system.webServer>
```

El módulo de hosting in-process tiene un segundo límite, independiente, que puedes fijar en código mediante `IISServerOptions`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- in-process IIS hosting
builder.Services.Configure<IISServerOptions>(options =>
{
    options.MaxRequestBodySize = 200 * 1024 * 1024;   // 200 MB
});
```

Detrás de IIS puedes necesitar alinear los tres: `maxAllowedContentLength` en `web.config`, `IISServerOptions.MaxRequestBodySize` y el `MaxRequestBodySize` de Kestrel. La solicitud se rechaza según el que sea más pequeño.

### 6. Sube el tope en tu proxy inverso

Si hay un proxy delante de la aplicación, tiene su propio límite y devuelve `413` antes de que tu aplicación intervenga. En nginx, la directiva es `client_max_body_size` (por defecto 1 MiB, mucho más pequeño que el valor por defecto de Kestrel y una sorpresa habitual):

```nginx
# nginx.conf -- allow 200 MB uploads through the proxy
client_max_body_size 200M;
```

Para YARP, una API gateway o un balanceador de carga en la nube, busca el ajuste equivalente de tamaño de solicitud en la configuración de esa capa. Subir los límites del lado de la aplicación no ayudará hasta que el proxy deje pasar el cuerpo.

## Trampas y variantes

- **`413` no es `400`.** Un `413 Request Entity Too Large` viene de `MaxRequestBodySize` de Kestrel. Un `400 Bad Request` con `InvalidDataException: Multipart body length limit ... exceeded` viene de `FormOptions.MultipartBodyLengthLimit`. Son límites distintos con valores por defecto distintos (30 MB frente a 128 MiB). Lee el tipo de excepción, no solo el código de estado.
- **HttpSys devuelve `500`, no `413`.** Si alojas en `HttpSys` en vez de en Kestrel, superar `HttpSysOptions.MaxRequestBodySize` produce un `500 Internal Server Error`, no un `413`. Misma causa raíz, superficie distinta.
- **Bytes, no mebibytes.** El valor por defecto es `30000000` (treinta millones) de bytes, que son unos 28,6 MiB, no 30 MiB. Si calculas un límite a partir de "megabytes", decide si te refieres a `1024 * 1024` o `1000 * 1000` y sé consistente, para que un archivo de 30 MB no falle contra un límite de "30 MB".
- **No recurras a `null` en producción.** Eliminar el límite por completo convierte cada endpoint de subida en un objetivo de agotamiento de memoria o disco. Combina un límite generoso con streaming para no bufferizar nunca el archivo entero. Consulta [cómo transmitir un archivo desde un endpoint de ASP.NET Core sin bufferizar](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) y [cómo subir un archivo grande con streaming a Azure Blob Storage](/es/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/).
- **Blazor Server y SignalR tienen su propio límite.** Una subida grande sobre un circuito de SignalR o Blazor Server está acotada por `HubOptions.MaximumReceiveMessageSize` (por defecto 32 KB), no por `MaxRequestBodySize`. Esa es una solución distinta en un lugar distinto.
- **El cliente puede cerrar la conexión primero.** Un `413` a menudo llega con `Connection: close`, y algunos clientes HTTP lo reportan como un error de socket en vez de un `413` limpio. Registra la `BadHttpRequestException` del lado del servidor para confirmar la causa real en vez de fiarte de la cadena de error del cliente.

El modelo mental: una subida pasa por una pila de puertas de tamaño (proxy, IIS, tamaño de cuerpo de Kestrel, tamaño de formulario multipart), y la rechaza la primera que supera. Encuentra la capa que produjo tu `413`, sube ese límite a un valor real y acotado, y combínalo con streaming para que un límite mayor no se convierta en una responsabilidad mayor.

## Relacionado

- [Cómo transmitir un archivo desde un endpoint de ASP.NET Core sin bufferizar](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) para servir archivos grandes sin cargarlos en memoria.
- [Cómo subir un archivo grande con streaming a Azure Blob Storage](/es/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) para enviar subidas grandes directamente a blob storage.
- [Solución: "415 Unsupported Media Type" desde un endpoint de minimal API en ASP.NET Core 11](/es/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/) para el error hermano cuando el Content-Type de la solicitud es incorrecto.
- [Cómo personalizar las respuestas de error de validación de minimal API con IProblemDetailsService en ASP.NET Core 11](/es/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) para convertir un código de estado desnudo en un cuerpo de error útil.
- [Cómo añadir compresión de respuestas a una API de ASP.NET Core 11](/es/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) para la contraparte de salida de los límites de cuerpo de entrada.

## Fuentes

- ASP.NET Announcements, [New default 30 MB (~28.6 MiB) max request body size limit](https://github.com/aspnet/Announcements/issues/267) (valor por defecto de 30.000.000 de bytes en Kestrel y HttpSys, `413` en Kestrel y `500` en HttpSys, `MaxRequestBodySize`, `IHttpMaxRequestBodySizeFeature`, `[RequestSizeLimit]` / `[DisableRequestSizeLimit]`, comportamiento en IIS).
- Microsoft Learn, [Upload files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/mvc/models/file-uploads?view=aspnetcore-10.0) (valor por defecto de 134.217.728 de bytes de `FormOptions.MultipartBodyLengthLimit`, `[RequestFormLimits]`, `IISServerOptions.MaxRequestBodySize`, `maxAllowedContentLength` en `web.config`).
- Microsoft Learn, [IRequestSizeLimitMetadata.MaxRequestBodySize](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.metadata.irequestsizelimitmetadata.maxrequestbodysize?view=aspnetcore-10.0) (la interfaz de metadata que implementan los atributos de límite de tamaño).
- dotnet/aspnetcore, [Minimal API endpoints accepting IFormFile terminating with HTTP 200 for large files](https://github.com/dotnet/aspnetcore/issues/50871) (por qué `IHttpMaxRequestBodySizeFeature` no puede fijarse después de que el cuerpo multipart se enlace en una minimal API).
