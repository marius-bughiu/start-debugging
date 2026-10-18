---
title: "Refit 16.4 incluye HttpRetryHandler, y lee los encabezados de límite de tasa de GitHub, Azure y AWS"
description: "Refit 16.4.0 agrega un HttpRetryHandler opcional que reintenta solicitudes idempotentes, respeta Retry-After y encabezados específicos de cada proveedor como x-ratelimit-reset y x-ms-retry-after-ms, y no necesita Polly ni ningún paquete de resiliencia."
pubDate: 2026-10-18
tags:
  - "dotnet"
  - "refit"
  - "httpclient"
  - "resilience"
lang: "es"
translationOf: "2026/10/refit-16-4-httpretryhandler-honors-retry-after-and-rate-limit-headers"
translatedBy: "claude"
translationDate: 2026-10-18
---

[Refit 16.4.0](https://github.com/reactiveui/refit/releases/tag/v16.4.0) salió el 17 de octubre de 2026, y la funcionalidad principal es un manejador de reintentos que vive en el paquete principal `Refit`. `HttpRetryHandler` es un `DelegatingHandler` común, así que funciona con clientes de Refit y con cualquier `HttpClient` ordinario, sin traer Polly ni `Microsoft.Extensions.Http.Resilience`.

No es solo otro bucle de backoff exponencial. Lo interesante es cómo decide cuánto esperar.

## Las indicaciones del servidor ganan sobre el backoff

De forma predeterminada, el manejador permite tres reintentos después del primer envío, pero solo para `GET`, `HEAD`, `OPTIONS` y `TRACE`. Reintenta HTTP 408, 429, 500, 502, 503 y 504, además de `HttpRequestException`. Un 403 se reintenta solo cuando el lector de retraso configurado encuentra una indicación de tiempo válida, que es exactamente como GitHub señala que se agotó el límite de tasa principal.

El retraso proviene de un `DelayProvider`. El predeterminado lee el encabezado estándar `Retry-After`, y `RetryDelayProviders` incluye cuatro lectores específicos de proveedor:

- `Azure`: `x-ms-retry-after-ms`, luego `retry-after-ms`, luego `Retry-After`.
- `Aws`: `x-amz-retry-after` en milisegundos, luego `Retry-After`.
- `GitHub`: `Retry-After`, o `x-ratelimit-reset` (segundos Unix) cuando la cuota restante es cero en un 403 o 429.
- `Jira`: `Retry-After`, o el `X-RateLimit-Reset` en ISO 8601 en un 429.

Cuando no existe una indicación válida, recurre a un backoff exponencial que empieza en un segundo, con un tope de 30 segundos y jitter completo. El jitter nunca acorta una indicación del servidor, y una indicación mayor que `MaxDelay` hace que el manejador devuelva la respuesta en lugar de reintentar demasiado pronto.

## Conectarlo a un cliente de Refit

Con `Refit.HttpClientFactory`, el manejador entra en la cadena como cualquier otro manejador de mensajes:

```csharp
using Refit;

services.AddRefitGeneratedClient<IGitHubApi>()
    .ConfigureHttpClient(static client =>
        client.BaseAddress = new Uri("https://api.github.com"))
    .AddHttpMessageHandler(static () => new HttpRetryHandler(new HttpRetryOptions
    {
        MaxRetries = 3,
        DelayProvider = RetryDelayProviders.GitHub,
        MaxDelay = TimeSpan.FromMinutes(2),
    }));
```

Devuelve un manejador nuevo desde la lambda de la fábrica, como arriba. Las instancias de manejador pertenecen a un único pipeline.

Si tu API usa algún otro encabezado, `RetryDelayProviders.ReadHeader` interpreta por ti segundos, milisegundos, marcas de tiempo Unix o fechas:

```csharp
var options = new HttpRetryOptions
{
    DelayProvider = static (response, now, ct) =>
        RetryDelayProviders.ReadHeader(
            response, "X-Throttle-Reset", RetryHeaderFormat.UnixTimeSeconds, now, ct),
};
```

## Las barreras de seguridad

`POST`, `PUT`, `PATCH` y `DELETE` no se reintentan a menos que establezcas `RetryUnsafeMethods = true`, y solo deberías hacerlo para endpoints que acepten una clave de idempotencia. Cada intento es un `HttpRequestMessage` nuevo con los encabezados y opciones copiados. El cuerpo se almacena en búfer una sola vez, con un límite predeterminado de 1 MiB (`MaxRequestContentBufferSize`), así que las subidas en streaming sin límite no encajan bien.

Dos detalles de orden importan. Un manejador de autenticación colocado dentro del manejador de reintentos se ejecuta en cada intento, que es lo que quieres para tokens renovados. Y `HttpClient.Timeout` cubre la llamada completa, incluidas las esperas entre reintentos, así que un timeout predeterminado de 100 segundos puede cortar una ventana de restablecimiento de GitHub de dos minutos.

No lo apiles encima de `AddStandardResilienceHandler`. Elige una sola capa de reintentos. Si ya usas el pipeline de resiliencia de Microsoft, mantenlo. Si tienes un cliente de Refit pequeño que solo necesita comportarse con educación frente a una API con límite de tasa, ahora es un cambio de dos líneas.

Para las pruebas, `Refit.Testing` agrega `RetryReply.After`, `RetryReply.Header` y `StubHttp.CreateRetryHandler`, todos controlados por `TimeProvider`, para que puedas verificar las esperas sin dormir.

La versión también agrega `[Query(Name = "client_id")]` y `[Url(AllowRelative = true)]`, y corrige los parámetros de ruta y de consulta que solo difieren en mayúsculas y minúsculas. Es la mayor entrega de Refit desde que [16.1 empezó a generar el bucle de paginación con PagedEnumerable](/es/2026/09/refit-16-1-generates-the-paging-loop-with-pagedenumerable/).
