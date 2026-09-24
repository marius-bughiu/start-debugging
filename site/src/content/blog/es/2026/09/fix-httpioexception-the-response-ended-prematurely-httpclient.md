---
title: "Solución: HttpIOException: The response ended prematurely de HttpClient en .NET"
description: "HttpClient reutiliza una conexión keep-alive que el servidor acaba de cerrar, o el servidor corta la conexión a mitad de la respuesta. Baja PooledConnectionIdleTimeout por debajo del timeout de inactividad del servidor y reintenta solo las solicitudes idempotentes."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "httpclient"
  - "networking"
lang: "es"
translationOf: "2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient"
translatedBy: "claude"
translationDate: 2026-09-24
---

`HttpIOException: The response ended prematurely. (ResponseEnded)` significa que la conexión TCP se cerró antes de que `HttpClient` recibiera una respuesta HTTP completa. La causa más común es una carrera de keep-alive: `HttpClient` envía una solicitud por una conexión del pool justo en el momento en que el servidor la cierra por inactividad. Configura `SocketsHttpHandler.PooledConnectionIdleTimeout` bastante por debajo del timeout de inactividad del servidor (o del balanceador de carga), y reintenta `ResponseEnded` solo para las solicitudes que se pueden enviar dos veces sin riesgo. Si el error ocurre en cada solicitud, estás hablando con lo que no es: `http://` contra un puerto HTTPS, o un mapeo de puertos de Docker sin nada escuchando detrás.

Todo lo que sigue se reprodujo en .NET 10.0.10 (SDK 10.0.302) y .NET 11 RC 1 (SDK 11.0.100-rc.1.26425.128) contra pequeños servidores de sockets crudos que se portan mal a propósito. Ambos runtimes dieron resultados idénticos byte por byte.

## El error en contexto

La excepción que ves en el punto de llamada es casi siempre una `HttpRequestException` que envuelve la `HttpIOException`:

```text
System.Net.Http.HttpRequestException: An error occurred while sending the request.
 ---> System.Net.Http.HttpIOException: The response ended prematurely. (ResponseEnded)
   at System.Net.Http.HttpConnection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at System.Net.Http.HttpConnection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(HttpRequestMessage request, Boolean async, Boolean doRequestAuth, CancellationToken cancellationToken)
   at System.Net.Http.RedirectHandler.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpClient.<SendAsync>g__Core|83_0(HttpRequestMessage request, HttpCompletionOption completionOption, CancellationTokenSource cts, Boolean disposeCts, CancellationTokenSource pendingRequestsCts, CancellationToken originalCancellationToken)
```

Hay tres variantes del mensaje, y la que te toca indica dónde murió la conexión:

| Mensaje externo | Mensaje interno | Qué significa |
| --- | --- | --- |
| `An error occurred while sending the request.` | `The response ended prematurely. (ResponseEnded)` | EOF antes de que llegara un solo byte de la línea de estado |
| `Error while copying content to a stream.` | `The response ended prematurely. (ResponseEnded)` | Llegaron los encabezados, el cuerpo quedó truncado (lectura con búfer) |
| ninguno, `HttpIOException` se lanza directamente | `The response ended prematurely, with at least 90 additional bytes expected. (ResponseEnded)` | Cuerpo truncado mientras lees el stream tú mismo |

Las conexiones HTTP/2 añaden una cuarta: `The response ended prematurely while waiting for the next frame from the server.` Desde .NET 8, `HttpRequestException.HttpRequestError` y `HttpIOException.HttpRequestError` se establecen en `HttpRequestError.ResponseEnded` en todos estos casos, y eso es lo que tu código debería comprobar en lugar de analizar cadenas de mensajes.

## Por qué ocurre

`SocketsHttpHandler` lanza `ResponseEnded` cada vez que una lectura del socket devuelve 0 bytes (un FIN limpio del otro lado) mientras todavía espera datos. El origen son dos líneas en `HttpConnection.cs`: un búfer de lectura vacío después de enviar la solicitud, o `bytesRead == 0` dentro de `FillAsync`. Nada en .NET decidió fallar. El otro extremo cerró la conexión. La pregunta es por qué, y las causas, ordenadas por frecuencia, son:

1. **Carrera de keep-alive.** El servidor (o un proxy, o un balanceador de carga en la nube) cierra las conexiones inactivas después de N segundos. `HttpClient` mantiene las conexiones inactivas 60 segundos por defecto. Si N es menor, tarde o temprano una solicitud sale por una conexión que el servidor está cerrando en ese mismo instante. Esta es la versión intermitente, la de "funciona el 99% de las veces".
2. **No hay nada real escuchando.** Docker Desktop, `kubectl port-forward`, los túneles SSH y algunos proxies inversos aceptan la conexión TCP ellos mismos y luego la cierran cuando el backend no está. Obtienes `ResponseEnded` en lugar de `Connection refused`.
3. **Protocolo incorrecto en el puerto.** Enviar `http://` plano a un puerto solo TLS (una confusión común con `launchSettings.json` de Kestrel) hace que el servidor falle el handshake y cierre el socket.
4. **El servidor se cayó o se rindió a mitad de la respuesta.** Un proceso que muere mientras transmite, un proxy que alcanza un límite de tamaño o tiempo, o un handler que establece `Content-Length` más alto de lo que escribe. Esto produce las variantes de la fase del cuerpo.

## Reproducción mínima

Esta aplicación basada en archivo inicia un servidor TCP crudo que responde la primera solicitud de cada conexión y cierra la conexión sin responder la segunda, que es exactamente lo que parece un timeout de inactividad del lado del servidor cuando se dispara durante tu solicitud.

```csharp
// .NET 10.0.10, C# 14. Run with: dotnet run repro.cs
using System.Net;
using System.Net.Sockets;
using System.Text;

var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
int port = ((IPEndPoint)listener.LocalEndpoint).Port;
int connections = 0;

_ = Task.Run(async () =>
{
    while (true)
    {
        var tcp = await listener.AcceptTcpClientAsync();
        int connectionId = Interlocked.Increment(ref connections);
        _ = Task.Run(async () =>
        {
            using (tcp)
            {
                var stream = tcp.GetStream();
                for (int requestNo = 1; ; requestNo++)
                {
                    if (!await ReadRequestAsync(stream)) return;
                    Console.WriteLine($"  server: connection {connectionId}, request {requestNo}");
                    if (requestNo == 2) return; // idle timeout fires: close, no response
                    await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"u8.ToArray());
                }
            }
        });
    }
});

using var client = new HttpClient();
foreach (var method in new[] { HttpMethod.Get, HttpMethod.Post })
{
    for (int i = 1; i <= 2; i++)
    {
        try
        {
            using var request = new HttpRequestMessage(method, $"http://127.0.0.1:{port}/");
            if (method == HttpMethod.Post) request.Content = new StringContent("{}");
            using var response = await client.SendAsync(request);
            Console.WriteLine($"{method} #{i}: {await response.Content.ReadAsStringAsync()}");
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"{method} #{i}: {ex.HttpRequestError} / {ex.InnerException?.Message}");
        }
    }
}

// Reads one request: headers up to the blank line, then Content-Length bytes of body.
static async Task<bool> ReadRequestAsync(NetworkStream stream)
{
    var data = new List<byte>();
    var buffer = new byte[8192];
    int headerEnd;
    while ((headerEnd = Encoding.ASCII.GetString(data.ToArray()).IndexOf("\r\n\r\n")) < 0)
    {
        int read = await stream.ReadAsync(buffer);
        if (read == 0) return false;
        data.AddRange(buffer.AsSpan(0, read));
    }
    var headers = Encoding.ASCII.GetString(data.ToArray(), 0, headerEnd);
    var lengthLine = headers.Split("\r\n")
        .FirstOrDefault(h => h.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase));
    int remaining = (lengthLine is null ? 0 : int.Parse(lengthLine[15..])) - (data.Count - headerEnd - 4);
    while (remaining > 0)
    {
        int read = await stream.ReadAsync(buffer);
        if (read == 0) return false;
        remaining -= read;
    }
    return true;
}
```

Salida en .NET 10.0.10 y .NET 11 RC 1:

```text
  server: connection 1, request 1
GET #1: ok
  server: connection 1, request 2
  server: connection 2, request 1
GET #2: ok
  server: connection 2, request 2
POST #1: ResponseEnded / The response ended prematurely. (ResponseEnded)
  server: connection 3, request 1
POST #2: ok
```

Lee las líneas del servidor. `GET #2` también dio con la conexión muerta (conexión 1, solicitud 2), y `SocketsHttpHandler` la reenvió en silencio por una conexión 2 completamente nueva. Luego `POST #1` reutilizó la conexión 2, fue descartada de la misma forma y sacó a la luz la excepción. El handler reenvía una solicitud fallida solo cuando salió por una conexión reutilizada del pool y no tenía cuerpo, o su cuerpo estaba retenido por `Expect: 100-continue` (el flag `_canRetry` en `HttpConnection.SendAsync`). Un `POST` con contenido nunca se reenvía, porque el handler no puede saber si el servidor ya actuó sobre él. Por eso este error aparece en los registros para tus escrituras y casi nunca para tus lecturas.

## Solución 1: mantén las conexiones inactivas menos tiempo que el servidor

La solución duradera para la versión intermitente es asegurarte de que `HttpClient` descarte una conexión inactiva antes de que lo haga el servidor. Encuentra el timeout de inactividad más corto de la ruta: el propio servicio, cualquier proxy inverso y el balanceador de carga. Algunos valores por defecto reales:

- `KeepAliveTimeout` de Kestrel: 130 segundos, más que el valor por defecto del cliente, así que de .NET a .NET funciona bien de fábrica.
- `http.Server` de Node.js 26: `keepAliveTimeout` 5 segundos, `keepAliveTimeoutBuffer` 1 segundo.
- uvicorn: `--timeout-keep-alive` 5 segundos. Gunicorn: `keepalive` 2 segundos.
- AWS Application Load Balancer: timeout de inactividad de 60 segundos, igual que el valor por defecto del cliente, lo que hace posible la carrera en cada conexión que queda inactiva alrededor de un minuto.

Luego configura el handler por debajo de ese número. Con `IHttpClientFactory`:

```csharp
// .NET 10, Microsoft.Extensions.Http 10.0.12
builder.Services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://orders.internal/"))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        // Server or load balancer closes idle connections after 60s (AWS ALB default).
        PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
        // Also recycle connections so DNS changes are picked up.
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    });
```

Deja un margen real. `PooledConnectionIdleTimeout` no se comprueba cuando se toma una conexión del pool. Lo aplica un temporizador de limpieza en segundo plano que se ejecuta cada `PooledConnectionIdleTimeout / 4`, con un mínimo de un segundo (`HttpConnectionPoolManager.cs`). Por lo tanto, una conexión puede vivir hasta aproximadamente 1.25 veces el timeout de inactividad configurado, o el timeout de inactividad más un segundo para valores pequeños. La mitad del timeout del servidor es una regla segura.

Lo que sí se comprueba al tomar la conexión es el propio encabezado de respuesta `Keep-Alive: timeout=N` del servidor. `HttpConnection.PrepareForReuse` llama a `CheckKeepAliveTimeoutExceeded()` y descarta la conexión si ha estado inactiva N segundos o más, tanto en HTTP/1.1 como en 1.0. Por eso los servicios de Node.js rara vez provocan esto: Node anuncia `timeout=5` y en realidad cierra después de 6. Si controlas el servidor, enviar un encabezado `Keep-Alive` con un valor menor que el timeout real es una solución que protege a todos los clientes, no solo a los de .NET.

Medí las tres opciones contra un servidor que cierra las conexiones después de exactamente 2 000 ms de inactividad, con un cliente que envía un `POST` cada 1 990-2 010 ms (150 solicitudes cada una, .NET 10.0.10):

| Configuración cliente/servidor | Exitosas | `ResponseEnded` |
| --- | --- | --- |
| Valores por defecto (`PooledConnectionIdleTimeout` 60 s) | 147 | 3 |
| `PooledConnectionIdleTimeout = 800 ms` | 150 | 0 |
| El servidor envía `Keep-Alive: timeout=1` | 150 | 0 |

Tres fallos de 150 es lo que hace que este error sea tan molesto en producción: es lo bastante raro como para pasar todas las pruebas y lo bastante frecuente como para despertar a alguien de guardia. La mayoría de las veces el FIN del servidor llega antes de la siguiente solicitud, y `PrepareForReuse` ve la conexión cerrada y abre una nueva sin decir nada. Solo aparece cuando el cierre cae en los pocos milisegundos entre esa comprobación y la salida de la solicitud. Ambas soluciones lo eliminaron por completo. El timeout de inactividad de 800 ms funciona porque el limpiador (que con ese valor se ejecuta cada segundo) descarta las conexiones antes del timeout de 2 000 ms del servidor. El encabezado funciona porque el cliente lo comprueba de forma síncrona cada vez que toma una conexión.

## Solución 2: reintenta `ResponseEnded`, pero solo cuando un segundo intento es seguro

Los timeouts reducen la carrera, no pueden eliminarla: un servidor todavía puede reiniciarse, reducir su escala o cortar una conexión por sus propias razones. Así que trata `ResponseEnded` como transitorio, con una condición. Puede que el servidor haya recibido y procesado la solicitud antes de cerrar el socket. Mi servidor de reproducción leyó el cuerpo completo de cada solicitud que luego descartó. Para un `POST` que crea un pedido, un reintento a ciegas puede crear dos pedidos.

`AddStandardResilienceHandler()` no hace esta distinción por ti. Su `ShouldHandle` por defecto (`HttpClientResiliencePredicates.IsTransient`) trata toda `HttpRequestException` como transitoria, para cualquier método HTTP. O llamas a `options.Retry.DisableForUnsafeHttpMethods()`, o escribes un predicado que reintente los métodos no seguros solo cuando la solicitud lleva una clave de idempotencia con la que el servidor deduplica:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddHttpClient<OrdersClient>()
    .AddResilienceHandler("stale-connection", pipeline => pipeline.AddRetry(new HttpRetryStrategyOptions
    {
        MaxRetryAttempts = 1,
        Delay = TimeSpan.Zero, // a new connection is all we need, no backoff
        ShouldHandle = args => ValueTask.FromResult(
            args.Outcome.Exception is HttpRequestException { HttpRequestError: HttpRequestError.ResponseEnded }
            && args.Context.GetRequestMessage() is { } request
            && (request.Method == HttpMethod.Get
                || request.Method == HttpMethod.Put
                || request.Method == HttpMethod.Delete
                || request.Headers.Contains("Idempotency-Key"))),
    }));
```

Y en el punto de llamada:

```csharp
// .NET 10
using var request = new HttpRequestMessage(HttpMethod.Post, "orders") { Content = JsonContent.Create(order) };
request.Headers.Add("Idempotency-Key", order.ClientRequestId.ToString());
using var response = await http.SendAsync(request, ct);
```

Contra el servidor de reproducción (que descarta la segunda solicitud en cada conexión), tres `POST` con este handler devolvieron `200 ok`, con un reintento cada uno para el segundo y el tercero. El servidor vio cinco solicitudes en tres conexiones, y esa es la clave: las dos descartadas sí le llegaron. Si tu reintento vive en un `DelegatingHandler`, ten en cuenta [dónde se ejecuta ese handler respecto al bucle de reintentos](/es/2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler/), y lee [Polly frente a los handlers de resiliencia integrados](/es/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) si estás decidiendo entre las dos APIs.

## Solución 3: cuando falla en todas y cada una de las solicitudes

Un `ResponseEnded` constante en la primera solicitud de un proceso nuevo no es una carrera. Mi prueba produjo exactamente la misma excepción en estos dos casos:

**`http://` contra un endpoint TLS.** Un servidor que solo habla TLS recibe `GET / HTTP/1.1` como un ClientHello basura, falla el handshake y cierra. Comprueba el esquema y el puerto contra `launchSettings.json` (el perfil por defecto de Kestrel escucha en un puerto `https` y en un puerto `http`, y es fácil emparejar los equivocados) o contra `ASPNETCORE_URLS`. El error opuesto, `https://` contra un puerto HTTP plano, produce en su lugar [the SSL connection could not be established](/es/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/).

**Un listener sin nada detrás.** Docker publica los puertos a través de su propio proxy. Si la aplicación dentro del contenedor escucha en `localhost` en lugar de `0.0.0.0` (`ASPNETCORE_URLS=http://+:8080` lo arregla para ASP.NET Core), o se ha caído, el proxy acepta tu conexión y la cierra de inmediato. Ejecuta `curl -v http://localhost:8080/` desde la misma máquina. Si curl informa `Empty reply from server`, el problema no está en tu código .NET.

## Solución 4: cuando lo que se corta es el cuerpo

Si el mensaje externo es `Error while copying content to a stream.`, o lees el stream tú mismo y ves `with at least N additional bytes expected`, la línea de estado y los encabezados llegaron y la conexión se cerró a mitad del cuerpo. La respuesta está en los registros del lado del servidor:

- El proceso upstream se cayó o fue terminado (OOM, un desalojo de pod, una implementación) mientras transmitía.
- Un proxy cortó la respuesta por un límite de tamaño o duración. `proxy_read_timeout` de nginx, un límite de respuesta de una CDN o un tope de payload de un API gateway terminan todos así.
- El servidor declaró un `Content-Length` mayor que los bytes que escribió, normalmente un middleware que cambió el cuerpo (compresión, reescritura) después de establecer el encabezado. .NET informa exactamente el faltante, 90 bytes en mi reproducción, donde el encabezado decía 100 y el servidor envió 10.
- Una respuesta chunked terminó sin el chunk final de longitud cero, lo que también produce la variante `copying content`.

Reintentar un cuerpo truncado solo es seguro bajo las mismas reglas de idempotencia que la Solución 2, porque el servidor ciertamente procesó esta solicitud.

## Trampas y errores parecidos

**`HttpRequestError` existe solo en .NET 8 y posteriores.** En .NET 6 y 7 la excepción interna es una `IOException` simple con el mensaje `The response ended prematurely.`, y no hay enum sobre el que decidir. El comportamiento de keep-alive y todas las soluciones anteriores son iguales.

**`Connection reset by peer` es la misma carrera, un paso después.** Si el servidor cierra un socket que todavía tiene datos de solicitud sin leer en su búfer de recepción, el kernel envía RST en lugar de FIN, y obtienes una `HttpRequestException` que envuelve `IOException: Unable to read data from the transport connection: Connection reset by peer` (`An existing connection was forcibly closed by the remote host` en Windows). Las soluciones son idénticas.

**`PooledConnectionIdleTimeout = TimeSpan.Zero` desactiva el pooling.** Hace imposible la carrera, y en mi prueba convirtió el `POST` que fallaba en un éxito, pero cada solicitud paga entonces un nuevo handshake TCP (y TLS). Úsalo solo para diagnóstico: si el error desaparece con esto, has confirmado la carrera de keep-alive.

**`TaskCanceledException` es un fallo distinto.** Una solicitud que alcanza `HttpClient.Timeout` termina con [a task was canceled](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/), no con `ResponseEnded`. Si ves ambos, probablemente el servidor es lento y algo delante de él está cerrando las conexiones que esperan demasiado.

**Crear un `HttpClient` nuevo por solicitud no lo arregla.** Oculta la carrera de keep-alive al no reutilizar nunca las conexiones, y la cambia por agotamiento de sockets bajo carga. [HttpClient vs HttpClientFactory vs Refit](/es/2026/05/httpclient-vs-httpclientfactory-vs-refit/) cubre las reglas de ciclo de vida que realmente funcionan.

## Relacionado

- [Solución: TaskCanceledException: A task was canceled con HttpClient](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/), la contraparte de timeout de este error.
- [Solución: The SSL connection could not be established](/es/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/), para la confusión de esquema en la dirección contraria.
- [Por qué un DelegatingHandler no se ejecuta en cada reintento con AddStandardResilienceHandler](/es/2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler/).
- [Polly frente a los handlers de resiliencia en .NET 11](/es/2026/05/polly-vs-resilience-handlers-in-dotnet-11/).
- [Cómo hacer pruebas unitarias de código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/), si quieres una prueba que lance `HttpRequestException` con `HttpRequestError.ResponseEnded` para cubrir tu predicado de reintento.

## Fuentes

- [`HttpConnection.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/HttpConnection.cs) (`SendAsync`, `FillAsync`, `PrepareForReuse`, `CheckKeepAliveTimeoutExceeded`) y [`HttpConnectionPoolManager.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/HttpConnectionPoolManager.cs) (periodo del limpiador) en la rama `release/10.0` de dotnet/runtime.
- [`ContentLengthReadStream.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/ContentLengthReadStream.cs) y las [cadenas de recursos de System.Net.Http](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/Resources/Strings.resx) para los mensajes exactos.
- [Enum `HttpRequestError`](https://learn.microsoft.com/dotnet/api/system.net.http.httprequesterror) y [`SocketsHttpHandler.PooledConnectionIdleTimeout`](https://learn.microsoft.com/dotnet/api/system.net.http.socketshttphandler.pooledconnectionidletimeout) en Microsoft Learn.
- [Guía de HttpClient para .NET](https://learn.microsoft.com/dotnet/fundamentals/networking/http/httpclient-guidelines), sobre el ciclo de vida de las conexiones del pool y la reutilización del cliente.
- [`HttpClientResiliencePredicates.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Polly/HttpClientResiliencePredicates.cs) y [`HttpRetryStrategyOptionsExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Polly/HttpRetryStrategyOptionsExtensions.cs) en dotnet/extensions.
- [`server.keepAliveTimeout` de Node.js](https://nodejs.org/api/http.html#serverkeepalivetimeout) y [timeout de inactividad de conexión de AWS ALB](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html#connection-idle-timeout).
