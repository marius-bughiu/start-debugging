---
title: "Solución: HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR'"
description: "Un peer envió RST_STREAM con PROTOCOL_ERROR para una solicitud. HttpClient nunca la reintenta. Encuentra qué salto reinició el stream, corrige la solicitud que rechazó, reintenta solo las llamadas idempotentes o baja ese salto a HTTP/1.1."
pubDate: 2026-10-21
template: error-page
tags:
  - "errors"
  - "httpclient"
  - "http2"
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2026/10/fix-the-http2-server-reset-the-stream-protocol-error-httpclient"
translatedBy: "claude"
translationDate: 2026-10-21
---

`HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1)` significa que el otro extremo de la conexión HTTP/2 envió un frame `RST_STREAM` para tu solicitud con el código de error 1. `HttpClient` no rompió nada, solo informa lo que dijo el peer, y nunca reintenta un `PROTOCOL_ERROR` por su cuenta. La solución es encontrar qué salto envió el reinicio (tu app Kestrel o un proxy, balanceador de carga o sidecar delante de ella), corregir lo que ese salto rechazó de esa solicitud en particular, reintentar las solicitudes idempotentes con un resilience handler y, como último recurso, hablar HTTP/1.1 con el salto que se comporta mal.

Todo lo que sigue se reprodujo en .NET 10.0.10 (SDK 10.0.302, ASP.NET Core 10.0.10) con Kestrel y `HttpClient` en una sola app basada en un archivo, más `Microsoft.Extensions.Http.Resilience` 10.0.0 para la sección de reintentos. Las rutas de código relevantes son las mismas en .NET 8, 9 y 11.

## El error en contexto

Cuando el reinicio llega antes de los encabezados de la respuesta, `SendAsync` (o `GetAsync`, `PostAsync`) lanza una `HttpRequestException` que envuelve la `HttpProtocolException`:

```text
System.Net.Http.HttpRequestException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
 ---> System.Net.Http.HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
   at System.Net.Http.Http2Connection.ThrowRequestAborted(Exception innerException)
   at System.Net.Http.Http2Connection.Http2Stream.CheckResponseBodyState()
   at System.Net.Http.Http2Connection.Http2Stream.TryEnsureHeaders()
   at System.Net.Http.Http2Connection.Http2Stream.ReadResponseHeadersAsync(CancellationToken cancellationToken)
   at System.Net.Http.Http2Connection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at System.Net.Http.Http2Connection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(HttpRequestMessage request, Boolean async, Boolean doRequestAuth, CancellationToken cancellationToken)
   at System.Net.Http.RedirectHandler.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
```

Si el servidor ya envió un código de estado y el reinicio llega mientras se lee el cuerpo, el mensaje externo cambia pero la excepción interna es idéntica:

```text
System.Net.Http.HttpRequestException: Error while copying content to a stream.
 ---> System.Net.Http.HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
```

En ambos casos `HttpRequestException.HttpRequestError` es `HttpRequestError.HttpProtocolError` y `HttpProtocolException.ErrorCode` es `1`. Comprueba esas dos propiedades en el código en lugar del texto del mensaje.

La redacción "the HTTP/2 server reset the stream" también es importante, porque `SocketsHttpHandler` tiene tres mensajes de fallo HTTP/2 distintos y cada uno apunta a un problema diferente:

| Mensaje | Frame que recibió el cliente | Alcance |
| --- | --- | --- |
| `The HTTP/2 server reset the stream. HTTP/2 error code '...'` | `RST_STREAM` | Solo esta solicitud |
| `The HTTP/2 server closed the connection. HTTP/2 error code '...'` | `GOAWAY` con un error | Todos los streams de esa conexión |
| `The HTTP/2 server sent invalid data on the connection. HTTP/2 error code '...'` | ninguno, el cliente detectó la violación por sí mismo | Toda la conexión |

Este artículo cubre la primera fila. Si ves la segunda o la tercera, la conexión en sí no está sana y el diagnóstico es distinto.

## Por qué ocurre

`PROTOCOL_ERROR` es el código más genérico de la [sección 7 del RFC 9113](https://www.rfc-editor.org/rfc/rfc9113#section-7). Un peer lo envía como error de stream cuando una solicitud (sus encabezados, su cuerpo o su entramado) rompe una regla, y quiere rechazar esa solicitud sin derribar la conexión compartida. Ese diseño explica por qué el error parece aleatorio "bajo carga": una conexión HTTP/2 transporta cientos de solicitudes concurrentes, el reinicio afecta solo a la solicitud que activó una comprobación y el resto tiene éxito. Más tráfico significa más solicitudes con la rara propiedad que activa la comprobación, así que la tasa de fallos sube con la carga aunque la carga no sea la causa.

Las causas, ordenadas por la frecuencia con la que aparecen en un cliente .NET:

1. **Un proxy intermedio rechazó algo de esa solicitud.** Los proxies inversos, las mallas de servicios, los ingress controllers y los balanceadores de carga en la nube terminan HTTP/2 y validan las solicitudes con sus propias reglas: caracteres de encabezado que consideran inválidos, valores de encabezado de varias líneas, encabezados específicos de la conexión, límites de tamaño en encabezados o cuerpos. Ejemplos reales: Envoy reiniciando streams que llevan [caracteres de encabezado mal formados](https://github.com/envoyproxy/envoy/issues/7061), nginx fallando con un [valor de encabezado de varias líneas](https://github.com/nginx/nginx/issues/540) sin registrar nada, y el propio Kestrel rechazando [pseudo-encabezados después de encabezados normales](https://github.com/dotnet/aspnetcore/issues/12190) enviados por un salto de Envoy.
2. **El cuerpo de la solicitud no coincidía con su `Content-Length`.** Kestrel reinicia el stream con `PROTOCOL_ERROR` cuando recibe más o menos bytes DATA que la longitud declarada (`Http2StreamErrorMoreDataThanLength` y `Http2StreamErrorLessDataThanLength` en [`Http2Stream.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Http2/Http2Stream.cs)). Un `HttpClient` de .NET detecta su propia discrepancia antes que el servidor (obtienes `Sent 5 request content bytes, but Content-Length promised 50.`), así que cuando Kestrel registra esto suele ser un cliente que no es .NET, o un proxy que reescribió el cuerpo sin corregir el encabezado.
3. **Kestrel rechazó los pseudo-encabezados de la solicitud.** Un `:method` o `:path` inválido, un `:scheme` que no coincide, un `Host`/`:authority` incorrecto o un CONNECT extendido mal formado terminan en `ResetAndAbort(..., Http2ErrorCode.PROTOCOL_ERROR)` en Kestrel. `HttpClient` construye estos encabezados por sí mismo, así que solo llegas a esto a través de un proxy o de un cliente hecho a mano.
4. **El código de la aplicación reinició el stream.** Cualquier middleware o handler que llame a `IHttpResetFeature.Reset(1)` produce exactamente este error en el cliente. Es raro, pero algunos gateways e interceptores de gRPC lo hacen a propósito para señalar una "solicitud mal formada".

Algo que *no* suele ser la causa: que el cliente .NET envíe encabezados incorrectos directamente a Kestrel. En mi repro, `TE: gzip`, `Connection: keep-alive` y un encabezado personalizado de 300 KB enviados por h2c a Kestrel 10.0.10 volvieron como un `400 Bad Request` normal, no como un reinicio. Si ves `PROTOCOL_ERROR` contra un backend Kestrel, sospecha primero de lo que esté entre el cliente y Kestrel.

## Repro mínimo

La forma más pequeña de reproducir la excepción exacta es un endpoint de Kestrel que reinicia su propio stream mediante `IHttpResetFeature`, que desde el lado del cliente es byte por byte lo mismo que un `RST_STREAM` de un proxy.

```csharp
// .NET 10.0.10, C# 14. Run with: dotnet run repro.cs
#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=false
using System.Net;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;

var hits = 0;
var builder = WebApplication.CreateBuilder();
builder.Logging.ClearProviders();
// h2c (HTTP/2 without TLS) needs an HTTP/2-only endpoint
builder.WebHost.ConfigureKestrel(k => k.ListenLocalhost(5199, o => o.Protocols = HttpProtocols.Http2));
var app = builder.Build();
app.MapGet("/reset/{code:int}", (HttpContext ctx, int code) =>
{
    Interlocked.Increment(ref hits);
    ctx.Features.Get<IHttpResetFeature>()!.Reset(code); // 1 = PROTOCOL_ERROR, 7 = REFUSED_STREAM
    return Results.Empty;
});
await app.StartAsync();

var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version20,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact,
};

foreach (var code in new[] { 1, 7 })
{
    hits = 0;
    try { await client.GetAsync($"http://localhost:5199/reset/{code}"); }
    catch (HttpRequestException e) when (e.InnerException is HttpProtocolException p)
    {
        Console.WriteLine($"code {code}: {e.HttpRequestError}, ErrorCode={p.ErrorCode}, server hits={hits}");
        Console.WriteLine($"  outer: {e.Message}");
    }
}
await app.StopAsync();
```

Salida:

```text
code 1: HttpProtocolError, ErrorCode=1, server hits=1
  outer: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
code 7: HttpProtocolError, ErrorCode=7, server hits=4
  outer: The request was aborted.
```

La columna `server hits` es la parte útil. Un reinicio `PROTOCOL_ERROR` llega al servidor una vez y se te lanza. Un reinicio `REFUSED_STREAM` lo reintenta el propio `SocketsHttpHandler`, porque el RFC 9113 garantiza que el peer no procesó un stream rechazado. El pool se rinde tras `MaxConnectionFailureRetries = 3` reintentos, así que el servidor vio 4 intentos. El código fuente es [`Http2Stream.OnReset`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/Http2Stream.cs), donde `canRetry` es verdadero solo para `REFUSED_STREAM` y para los streams que un `GOAWAY` marcó como no procesados.

## La solución, en detalle

### 1. Averigua qué salto envió el reinicio

El cliente no puede decirte quién envió el `RST_STREAM`. Solo sabe que el frame vino del peer al que está conectado, que es el primer salto HTTP/2: a menudo un proxy, no tu servicio. Resuelve esto antes de cambiar código:

- **Activa los registros de depuración HTTP/2 de Kestrel en el backend.** Kestrel registra cada stream que reinicia bajo la categoría `Microsoft.AspNetCore.Server.Kestrel.Http2` en el nivel `Debug`, con mensajes como `HTTP/2 stream error "PROTOCOL_ERROR". A Reset is being sent to the stream.` (evento 35) y `HTTP/2 stream error.` (evento 30, que lleva la `Http2StreamErrorException` con el motivo exacto, por ejemplo `More data received than specified in the Content-Length header.`).

```json
// appsettings.Development.json, ASP.NET Core 10
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore.Server.Kestrel.Http2": "Debug",
      "Microsoft.AspNetCore.Server.Kestrel.BadRequests": "Debug"
    }
  }
}
```

- **Si Kestrel no registra nada para la solicitud fallida, el reinicio vino de un intermediario.** Busca en el registro de acceso del proxy en esa ventana de tiempo. Envoy marca los reinicios en sus response flags y en los detalles de `upstream_reset_before_response_started`, nginx registra los problemas de encabezados en el nivel `info` de su registro de errores (sube `error_log` a `info` para verlos) y los balanceadores de carga en la nube suelen exponer un código de motivo por solicitud.
- **Evita el proxy una vez.** Llama directamente al backend (port-forward, dirección interna) con la misma solicitud. Si el error desaparece, has demostrado qué salto es el responsable.

### 2. Corrige la solicitud que el salto rechazó

Una vez que sabes qué salto y qué regla, la solución suele estar en la solicitud, no en el transporte. Registra el método, la ruta, los nombres de los encabezados, las longitudes de sus valores y el tamaño del cuerpo de las solicitudes fallidas (nunca los valores de los encabezados de autenticación) y compáralos con los de las exitosas. Los sospechosos habituales:

- Valores de encabezado con caracteres fuera del ASCII visible, saltos de línea incrustados o espacios al principio o al final, a menudo entrada de usuario copiada en un encabezado personalizado. `HttpClient` bloquea CR, LF y NUL, pero los proxies estrictos rechazan más que eso.
- Encabezados que solo tienen sentido en HTTP/1.1 (`Connection`, `Keep-Alive`, `Proxy-Connection`, `Transfer-Encoding`, `Upgrade` y `TE` con cualquier valor distinto de `trailers`). `HttpClient` te permite agregarlos con `TryAddWithoutValidation`, y los intermediarios pueden reiniciar un stream que los lleva.
- Una solicitud más grande que los límites del proxy: cookies grandes, JWT con muchos claims, cuerpos grandes en un proxy configurado con búferes pequeños. Son los clásicos fallos de "solo algunos usuarios".
- Un `HttpContent` personalizado que establece `Headers.ContentLength` y luego escribe una cantidad de bytes distinta, o un filtro de proxy que comprime o reescribe el cuerpo. El equivalente no .NET de esto es un `PROTOCOL_ERROR` directo de Kestrel.

### 3. Reintenta, pero solo las solicitudes que son seguras de repetir

Cuando el reinicio viene de una infraestructura que no controlas, agrega un reintento. Un reinicio `PROTOCOL_ERROR` no te dice si el servidor procesó la solicitud (un proxy puede reiniciar después de reenviarla), así que limita los reintentos a métodos idempotentes. Con `Microsoft.Extensions.Http.Resilience`:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.0.0
using System.Net;
using Microsoft.Extensions.Http.Resilience;
using Polly;

builder.Services.AddHttpClient("api", c =>
    {
        c.BaseAddress = new Uri("https://api.internal");
        c.DefaultRequestVersion = HttpVersion.Version20;
    })
    .AddResilienceHandler("h2-reset", pipeline =>
    {
        var retry = new HttpRetryStrategyOptions
        {
            MaxRetryAttempts = 2,
            Delay = TimeSpan.FromMilliseconds(50),
            ShouldHandle = args => ValueTask.FromResult(
                args.Outcome.Exception is HttpRequestException { HttpRequestError: HttpRequestError.HttpProtocolError }),
        };
        retry.DisableForUnsafeHttpMethods(); // never replay POST, PUT, PATCH, DELETE, CONNECT
        pipeline.AddRetry(retry);
    });
```

Contra un endpoint que reinicia el primer intento y tiene éxito en el segundo, un `GET` a través de este cliente devolvió `ok on attempt 2 via HTTP/2`, mientras que un `POST` siguió lanzando el `PROTOCOL_ERROR` original tras un solo acceso al servidor. Si ya usas `AddStandardResilienceHandler`, su `ShouldHandle` por defecto trata `HttpRequestException` como transitoria y también cubre este caso, pero reintenta todos los métodos a menos que llames a `DisableForUnsafeHttpMethods()` en `options.Retry`. Ten en cuenta que `DisableForUnsafeHttpMethods` devuelve `void`, así que llámalo sobre el objeto de opciones antes de pasarlo a `AddRetry`, no en una cadena fluida.

### 4. Baja el salto defectuoso a HTTP/1.1

Si el reinicio viene de un intermediario con una implementación HTTP/2 defectuosa o demasiado estricta, y no puedes corregirlo ni actualizarlo, saca HTTP/2 de ese salto. En el cliente:

```csharp
// .NET 10: ask for HTTP/1.1 for this client only
var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version11,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionOrLower,
};
```

En HTTP/1.1 no hay ningún stream que reiniciar: el mismo endpoint que reinició el stream por HTTP/2 respondió `ok on attempt 2 via HTTP/1.1` en el repro. Pierdes la multiplexación, así que espera más conexiones bajo carga, y gRPC no puede hacer esto en absoluto porque requiere HTTP/2. Trátalo como una solución temporal con un issue abierto contra el proxy, no como la solución definitiva.

## Casos límite y variantes

- **`REFUSED_STREAM` se parece pero es un problema distinto.** El mensaje externo es `The request was aborted.` con la `HttpProtocolException` de `REFUSED_STREAM` dentro, y solo lo ves después de que el handler ya reintentó 3 veces. Significa que el servidor o el proxy está rechazando nuevos streams, normalmente porque alcanzó su límite de streams concurrentes o se está apagando. Revisa `SETTINGS_MAX_CONCURRENT_STREAMS` en el servidor y considera `SocketsHttpHandler.EnableMultipleHttp2Connections = true`.
- **`HTTP_1_1_REQUIRED` en un endpoint h2c local.** Si configuras Kestrel con `HttpProtocols.Http1AndHttp2` sobre `http://` sin cifrar y fuerzas HTTP/2 en el cliente, obtienes `The HTTP/2 server closed the connection. HTTP/2 error code 'HTTP_1_1_REQUIRED' (0xd).` Sin TLS no hay ALPN para negociar el protocolo, así que h2c necesita un endpoint solo `Http2`.
- **Reinicios a mitad del cuerpo con `ResponseHeadersRead`.** Cuando lees la respuesta como stream tú mismo, el código de estado (a menudo `200`) ya se devolvió cuando llega el reinicio. No trates un estado exitoso como prueba de que el cuerpo está completo. La lectura lanza `Error while copying content to a stream.`, o directamente la `HttpProtocolException` (sin el wrapper `HttpRequestException`) desde `ReadAsync` en el stream de la respuesta.
- **Los resilience handlers no pueden reintentar un reinicio a mitad del cuerpo.** El pipeline del handler retorna en cuanto llegan los encabezados de la respuesta, y `HttpClient` almacena el cuerpo en búfer después. Por lo tanto, un reinicio durante el cuerpo evita el reintento del paso 3, incluso con el `ResponseContentRead` por defecto. Si el cuerpo importa, envuelve toda la operación de "enviar y leer" en tu propio reintento para las llamadas idempotentes.
- **El peer cerró la conexión en lugar de reiniciar.** Si la excepción interna es `HttpIOException` con `ResponseEnded` en lugar de `HttpProtocolException`, la conexión murió sin un frame HTTP/2. Esa es la familia de keep-alive y tiempo de espera por inactividad que cubre [la solución de response ended prematurely](/es/2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient/).
- **Los timeouts no son reinicios.** Si la llamada se queda colgada y luego falla con `TaskCanceledException`, nada reinició el stream. Empieza con [por qué HttpClient lanza "A task was canceled"](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

## Relacionado

- [Fix: HttpIOException "The response ended prematurely" in HttpClient](/es/2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient/) cubre el hermano a nivel de conexión de este error.
- [Polly vs resilience handlers in .NET 11](/es/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) explica dónde encaja el reintento anterior y cómo se compone el handler estándar.
- [HttpClient vs IHttpClientFactory vs Refit](/es/2026/05/httpclient-vs-httpclientfactory-vs-refit/) muestra cómo configurar el cliente con nombre que usa este artículo.
- [Fix: The SSL connection could not be established](/es/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/) ayuda cuando el fallo ocurre antes de que se negocie siquiera HTTP/2.
- [gRPC in containers: 4 traps you can fix](/es/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/) cubre los problemas de transporte solo HTTP/2 que gRPC agrega encima.

## Fuentes

- [RFC 9113, HTTP/2: error codes (section 7) and stream errors (section 5.4.2)](https://www.rfc-editor.org/rfc/rfc9113#section-7)
- [`HttpProtocolException` class, Microsoft Learn](https://learn.microsoft.com/dotnet/api/system.net.http.httpprotocolexception)
- [`HttpProtocolException.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/HttpProtocolException.cs) y [`Http2Stream.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/Http2Stream.cs) en dotnet/runtime v10.0.0
- [Kestrel `Http2Stream.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Http2/Http2Stream.cs) y [`KestrelTrace.Http2.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Infrastructure/KestrelTrace.Http2.cs) en dotnet/aspnetcore v10.0.0
- [Build resilient HTTP apps, Microsoft Learn](https://learn.microsoft.com/dotnet/core/resilience/http-resilience)
- [envoyproxy/envoy#7061](https://github.com/envoyproxy/envoy/issues/7061), [nginx/nginx#540](https://github.com/nginx/nginx/issues/540), [dotnet/aspnetcore#12190](https://github.com/dotnet/aspnetcore/issues/12190)
