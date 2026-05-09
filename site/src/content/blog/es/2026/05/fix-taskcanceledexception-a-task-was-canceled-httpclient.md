---
title: "Fix: TaskCanceledException: A task was canceled en HttpClient"
description: "HttpClient lanza TaskCanceledException por tres razones distintas: timeout, cancelación del llamador o un aborto a nivel de conexión. Distínguelos con InnerException y CancellationToken.IsCancellationRequested, y luego corrige el correcto."
pubDate: 2026-05-09
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "httpclient"
  - "cancellation"
lang: "es"
translationOf: "2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient"
translatedBy: "claude"
translationDate: 2026-05-09
---

La solución: `HttpClient` lanza `TaskCanceledException` (una subclase de `OperationCanceledException`) por tres causas distintas, y tienes que distinguirlas antes de poder actuar. Si `ex.InnerException is TimeoutException`, la solicitud alcanzó `HttpClient.Timeout` (100 segundos por defecto), así que sube el timeout o mueve las llamadas de larga duración a un `CancellationTokenSource` por solicitud. Si tu propio `CancellationToken` se cancela (`ex.CancellationToken.IsCancellationRequested == true`), es el llamador abandonando, no hace falta corregir nada más allá de dejar que se propague. Si ninguna de las dos es cierta, estás viendo un aborto a nivel de transporte (DNS, TCP, TLS, reset del servidor), que normalmente apunta a la infraestructura, no a tu código.

```text
System.Threading.Tasks.TaskCanceledException: The request was canceled due to the configured HttpClient.Timeout of 100 seconds elapsing.
 ---> System.TimeoutException: The operation was canceled.
 ---> System.Threading.Tasks.TaskCanceledException: The operation was canceled.
   at System.Threading.Tasks.TaskCompletionSource`1.TrySetCanceled(CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(...)
   at System.Net.Http.HttpClient.<SendAsync>g__Core|...
   at MyApp.Program.<Main>$(String[] args)
```

Esta guía está escrita contra .NET 11 preview 4 y `System.Net.Http` 11.0.0-preview.4. El tipo de excepción y la forma del `TimeoutException` envuelto no han cambiado desde .NET 5, pero el texto del mensaje se ajustó en .NET 8 para indicar qué timeout se disparó ("The request was canceled due to the configured `HttpClient.Timeout` of 100 seconds elapsing"). En .NET 6 y anteriores solo obtenías el genérico "A task was canceled.", razón por la cual tantos consejos previos a 2024 te dicen que registres la excepción interna manualmente.

## Por qué HttpClient lanza TaskCanceledException para todo

El pipeline de `HttpClient.SendAsync` está construido sobre `Task` y un único parámetro `CancellationToken`. El timeout, el token del llamador y el aborto interno de conexión se enlazan todos en un único `CancellationTokenSource` antes de que la solicitud llegue al socket. Cuando cualquiera de esas fuentes se dispara, la operación se completa con el mismo fallo con forma de `OperationCanceledException`, sin importar cuál se activó primero.

Microsoft ha confirmado esta decisión de diseño en [dotnet/runtime#21965](https://github.com/dotnet/runtime/issues/21965): el timeout no se expone como `TimeoutException` directamente porque cambiar el tipo sería un cambio que rompería la compatibilidad binaria. En su lugar, .NET 5 agregó un `InnerException` de `TimeoutException` para que los llamadores puedan distinguir los casos, y .NET 8 agregó el texto explícito del mensaje. La propiedad `CancellationToken` en la excepción, establecida por el runtime, es el segundo desambiguador.

Así que la misma excepción cubre tres problemas completamente diferentes. Actuar sobre "task was canceled" sin inspeccionar en qué caso estás es la razón más común por la que este bug se queda sin resolver durante semanas.

## Una reproducción mínima para cada causa

```csharp
// .NET 11, C# 14, System.Net.Http 11.0.0-preview.4
using System.Net.Http;

// Cause 1: HttpClient.Timeout elapsed
using var c1 = new HttpClient { Timeout = TimeSpan.FromMilliseconds(50) };
try
{
    await c1.GetAsync("https://httpbin.org/delay/3");
}
catch (TaskCanceledException ex)
{
    Console.WriteLine($"Inner: {ex.InnerException?.GetType().Name}");
    // Inner: TimeoutException
}

// Cause 2: caller's CancellationToken cancelled
using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
using var c2 = new HttpClient();
try
{
    await c2.GetAsync("https://httpbin.org/delay/3", cts.Token);
}
catch (TaskCanceledException ex)
{
    Console.WriteLine($"Token cancelled: {ex.CancellationToken.IsCancellationRequested}");
    Console.WriteLine($"Linked token: {cts.Token == ex.CancellationToken}");
    // Token cancelled: True
}

// Cause 3: connection-level abort (DNS/TCP/TLS) - simulated with a closed port
using var c3 = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
try
{
    await c3.GetAsync("http://10.255.255.1/");
}
catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException)
{
    Console.WriteLine("Looks like a timeout, was actually connect failure under timeout.");
}
catch (HttpRequestException ex)
{
    Console.WriteLine($"True transport failure: {ex.HttpRequestError}");
    // .NET 8+ exposes ex.HttpRequestError = ConnectionError, NameResolutionError, etc.
}
```

El tercer caso es interesante. Si se alcanza el timeout de conexión, obtienes `HttpRequestException` con `ex.HttpRequestError == HttpRequestError.ConnectionError`. Si la conexión tiene éxito pero la respuesta se estanca lo suficiente como para disparar `HttpClient.Timeout`, vuelves al caso 1. Los dos se ven casi idénticos en los registros pero requieren correcciones diferentes.

## La solución, en detalle

### 1. Diagnostica primero, con un filtro de excepción

Antes de cambiar cualquier timeout, registra en qué caso estás. De lo contrario subirás `Timeout` a 5 minutos y descubrirás que el problema real era un llamador cancelando.

```csharp
// .NET 11, C# 14
try
{
    return await client.GetAsync(url, ct);
}
catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException)
{
    logger.LogWarning(ex,
        "HttpClient.Timeout elapsed for {Url} (configured: {Timeout})",
        url, client.Timeout);
    throw;
}
catch (OperationCanceledException ex) when (ct.IsCancellationRequested)
{
    logger.LogInformation("Caller cancelled request to {Url}", url);
    throw;
}
catch (TaskCanceledException ex)
{
    logger.LogError(ex, "Unknown cancellation cause for {Url}", url);
    throw;
}
```

`OperationCanceledException` es el tipo padre y es lo que quieres para la rama de cancelación del llamador, ya que el tipo exacto en runtime puede ser `OperationCanceledException` o `TaskCanceledException` dependiendo de en qué punto del pipeline se disparó la cancelación.

### 2. Sube HttpClient.Timeout, pero solo para los clientes que lo necesiten

`HttpClient.Timeout` es por cliente y se aplica a cada solicitud que no pase un token con su propio timeout. El valor por defecto de 100 segundos está bien para llamadas REST típicas. Si tienes un endpoint de larga duración, dale un cliente dedicado.

```csharp
// .NET 11
builder.Services.AddHttpClient("LongRunning", c =>
{
    c.Timeout = TimeSpan.FromMinutes(10);
    c.BaseAddress = new Uri("https://reports.example.com/");
});

builder.Services.AddHttpClient("Default", c =>
{
    c.Timeout = TimeSpan.FromSeconds(30);
});
```

No subas `Timeout` en el cliente global solo para que funcione una llamada lenta. Ocultarás regresiones futuras: una llamada que debería tomar 200ms pero empieza a tomar 90s pasará silenciosamente la barrera relajada y se manifestará como un cuelgue en la UI. Los timeouts más estrictos detectan regresiones de rendimiento temprano. El [recorrido de pruebas unitarias de HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/) cubre cómo ejercitar estos límites de timeout en pruebas para que una regresión aquí no se cuele por CI.

### 3. Cambia a CancellationTokenSource por solicitud para un control fino

`HttpClient.Timeout` es un instrumento contundente. Dentro de un `BackgroundService` o un pipeline de solicitud que ya tiene un token, enlázalos:

```csharp
// .NET 11, C# 14
using var perCallCts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
using var linked = CancellationTokenSource.CreateLinkedTokenSource(
    perCallCts.Token, requestAborted);

try
{
    var response = await client.GetAsync(url, linked.Token);
    return await response.Content.ReadAsStringAsync(linked.Token);
}
catch (OperationCanceledException) when (perCallCts.IsCancellationRequested
                                          && !requestAborted.IsCancellationRequested)
{
    // Per-call timeout, not caller cancellation. Surface as your own timeout type.
    throw new TimeoutException($"GET {url} exceeded 15 seconds.");
}
```

Este patrón se compone limpiamente con `IHttpClientFactory`: mantén el `Timeout` del cliente nombrado en un valor alto (o `Timeout.InfiniteTimeSpan`), y aplica el presupuesto real en el sitio de la llamada con el CTS enlazado. La razón por la que `Timeout.InfiniteTimeSpan` funciona aquí es que `HttpClient` solo agrega su `Timeout` al token enlazado cuando es positivo, así que un `Timeout` infinito en el cliente significa "el llamador está al mando". El [recorrido de interbloqueo de cancelación](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) cubre el patrón de token enlazado con más detalle, incluyendo cómo distinguir timeouts de cancelaciones del llamador en capas superiores.

### 4. Usa HttpCompletionOption.ResponseHeadersRead para cuerpos en streaming

`HttpClient.Timeout` cubre el tiempo desde `SendAsync` hasta "listo para leer el cuerpo" solo cuando se usa el valor por defecto `HttpCompletionOption.ResponseContentRead`. Con `ResponseHeadersRead`, el timeout se aplica solo hasta recibir los encabezados. La lectura del cuerpo queda a cargo tuyo para aplicar timeout, como se confirma en [la documentación de HttpCompletionOption](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpcompletionoption).

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));
using var response = await client.GetAsync(
    url, HttpCompletionOption.ResponseHeadersRead, cts.Token);

response.EnsureSuccessStatusCode();
await using var stream = await response.Content.ReadAsStreamAsync(cts.Token);
await using var file = File.Create(path);
await stream.CopyToAsync(file, cts.Token);
```

Pasa el mismo token en todos lados. Un bug común es pasar `cts.Token` a `GetAsync` pero olvidarlo en `CopyToAsync`, en cuyo caso `HttpClient.Timeout` ya no aplica al cuerpo y un productor estancado se cuelga para siempre. La [publicación sobre streaming desde ASP.NET Core](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) cubre el error simétrico del lado del servidor, donde olvidar reenviar el `CancellationToken` de la solicitud produce el mismo cuelgue en el productor.

### 5. Configura el timeout de conexión por separado en .NET 8 y posteriores

`HttpClient.Timeout` cubre toda la solicitud, pero DNS y la conexión TCP son parte de ese presupuesto. Si quieres que DNS o la conexión fallen rápido independientemente del timeout de la solicitud, configura `SocketsHttpHandler.ConnectTimeout`:

```csharp
// .NET 11, C# 14
var handler = new SocketsHttpHandler
{
    ConnectTimeout = TimeSpan.FromSeconds(5),
    PooledConnectionLifetime = TimeSpan.FromMinutes(2),
};

builder.Services.AddHttpClient("Api", c =>
{
    c.Timeout = TimeSpan.FromSeconds(30);
    c.BaseAddress = new Uri("https://api.example.com/");
}).ConfigurePrimaryHttpMessageHandler(() => handler);
```

Un timeout de conexión corto convierte "esperar 30 segundos por nada" en "fallar en 5 segundos, reintentar en otro endpoint". Distinguir los timeouts de conexión de los de respuesta es la diferencia entre un circuit breaker de Polly que se abre rápido y uno que arrastra a cada llamador a través de toda la ventana de timeout.

## Formas comunes que disparan esto

### Cliente tipado de IHttpClientFactory con el Timeout incorrecto

Un cliente tipado toma el `Timeout` que configuraste en `AddHttpClient`, no la propiedad que estableciste en `HttpClient` después. Código que hace `_client.Timeout = TimeSpan.FromMinutes(5)` desde inyección por constructor lanza `InvalidOperationException` una vez que ya pasó una solicitud por el cliente. La factory recicla el handler subyacente, pero la instancia de `HttpClient` es de un solo uso para efectos de `Timeout`. Configura el timeout en `AddHttpClient`, no en el constructor del cliente tipado.

### Un Task.WhenAll con tokens desajustados

Cuando despliegas N llamadas HTTP con `Task.WhenAll(tasks)` y una se cancela, solo esa lanza. El resto sigue ejecutándose y también puede alcanzar timeouts. Si tu código relanza la primera cancelación, las tareas sobrevivientes quedan sin observar y sus excepciones afloran en `TaskScheduler.UnobservedTaskException`. Usa `Task.WhenAll` con un CTS enlazado compartido que canceles al primer fallo, para que las solicitudes restantes también se detengan.

### Una política de reintento de Polly oculta el timeout interno

Un handler de reintento de Polly que se traga `TaskCanceledException` y reintenta puede enmascarar el timeout subyacente por completo. Si el upstream es genuinamente lento, conviertes una espera de 100 segundos en tres esperas de 100 segundos, y luego te rindes. Configura Polly para hacer corto-circuito en `TimeoutException` interno y deja que el llamador decida.

```csharp
// .NET 11, Microsoft.Extensions.Http.Resilience 11.0.0-preview.4
builder.Services.AddHttpClient("Api")
    .AddStandardResilienceHandler(options =>
    {
        options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(10);
        options.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(30);
        options.Retry.ShouldHandle = args => args.Outcome switch
        {
            { Exception: HttpRequestException } => PredicateResult.True(),
            { Exception: TaskCanceledException tce } when tce.InnerException is TimeoutException
                => PredicateResult.False(),
            _ => PredicateResult.False(),
        };
    });
```

El `AddStandardResilienceHandler` del paquete `Microsoft.Extensions.Http.Resilience` separa limpiamente los timeouts por intento y de solicitud total, que es el reemplazo limpio para el código de Polly + CTS enlazado hecho a mano.

### Wait o Result sincrónicos sobre una llamada de HttpClient

`client.GetAsync(url).Result` produce interbloqueo bajo un contexto de sincronización de un solo hilo (ASP.NET clásico, WPF) y se manifiesta como una `TaskCanceledException` cuando `HttpClient.Timeout` finalmente se dispara 100 segundos después. La solución es `await`, punto final. El interbloqueo hace que la solicitud nunca inicie la fase de respuesta, el temporizador finalmente se dispara y el síntoma parece un timeout de red. Si ves "task was canceled" sin tráfico de red saliente en tus trazas, busca llamadas sincrónicas bloqueantes en la pila de llamadas. La [publicación del patrón BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/) cubre la regla de async-todo-el-camino para servicios alojados, donde esto golpea más fuerte.

### Reusar HttpRequestMessage

`HttpRequestMessage` no se puede enviar dos veces. El segundo `SendAsync` lanza `InvalidOperationException: The request message was already sent`. Algunas bibliotecas de reintento disimulan esto y el fallo se manifiesta como una cancelación de una solicitud diferente que compartía un token con la que estaba fallando. Siempre crea un nuevo `HttpRequestMessage` por intento.

## Variantes que parecen este error pero no lo son

### "The operation was canceled" sin excepción interna, en .NET Framework 4.8

En .NET Framework, el `InnerException` rara vez es un `TimeoutException`. El patrón de desambiguación del paso 1 solo funciona en .NET 5 y posteriores. Si todavía estás en Framework, tu mejor señal es comparar `ex.CancellationToken` contra el token que pasaste, y registrar el tiempo transcurrido antes del lanzamiento. La ergonomía de este caso es una de las mejores razones para terminar de migrar fuera de Framework más temprano que tarde.

### "An error occurred while sending the request" envolviendo SocketException

Clase de excepción completamente diferente (`HttpRequestException`), casi siempre un problema de transporte (DNS, TCP RST, fallo de handshake TLS). En .NET 8+, `ex.HttpRequestError` enumera la causa: `ConnectionError`, `NameResolutionError`, `SecureConnectionError`, etc. La solución vive en DNS, firewall o configuración de certificados, no en tu código.

### "The SSL connection could not be established"

La excepción interna es `AuthenticationException` de `System.Net.Security`. Esto es un fallo de negociación TLS, no un timeout, aunque pueda tomar segundos y verse superficialmente similar. Verifica la cadena de certificados, el host SNI y la versión del protocolo TLS (`SslProtocols.Tls12 | SslProtocols.Tls13` es el valor por defecto en .NET 11).

### "A connection attempt failed because the connected party did not properly respond"

`SocketException` con `ErrorCode == 10060` (WSAETIMEDOUT). Se dispara cuando un syn-ack nunca llega. Normalmente una caída a nivel de firewall de red. Manifestarse como `TaskCanceledException` ocurre solo cuando el `HttpClient.Timeout` que envuelve es más corto que el timeout de conexión a nivel del SO; de lo contrario obtienes una `HttpRequestException`.

### "Request was forcibly aborted" vía CancelPendingRequests

Llamar a `HttpClient.CancelPendingRequests` cancela cada solicitud en vuelo en ese cliente, no solo una. Si tu app reusa un cliente y un componente llama a `CancelPendingRequests`, la solicitud pendiente de cualquier otro componente falla con la misma `TaskCanceledException`. Esta es una de las razones más fuertes para usar `IHttpClientFactory` en lugar de un cliente estático de larga vida. Los clientes tipados por llamada de la factory son fachadas de vida corta, así que un `CancelPendingRequests` perdido solo afecta al llamador.

## Relacionado

Para el patrón completo de cancelación, el [recorrido de cancelar-una-tarea-de-larga-duración](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) cubre `CancellationToken`, `Task.WaitAsync` y la forma del token enlazado usada arriba. La [guía de pruebas unitarias de HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/) muestra cómo simular timeouts en pruebas para que las ramas de timeout realmente se ejerciten. Para descargas en streaming, la [publicación de stream-desde-ASP.NET-Core](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) cubre el reenvío de cancelación correspondiente del lado del servidor. Si tus workers en segundo plano están emitiendo estas llamadas, el [recorrido de BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/) cubre las reglas de tiempo de vida y cancelación que mantienen correcto el patrón de token enlazado durante el apagado del host.

## Fuentes

- [Propiedad `HttpClient.Timeout`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpclient.timeout), Microsoft Learn.
- [Enum `HttpCompletionOption`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpcompletionoption), Microsoft Learn.
- [`SocketsHttpHandler.ConnectTimeout`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.socketshttphandler.connecttimeout), Microsoft Learn.
- [Enum `HttpRequestError`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httprequesterror), Microsoft Learn.
- [HttpClient throws TaskCanceledException on timeout](https://github.com/dotnet/runtime/issues/21965), issue de dotnet/runtime.
- [How to identify HttpClient connect timeout errors?](https://github.com/dotnet/runtime/issues/78070), issue de dotnet/runtime.
- [Handler estándar de `Microsoft.Extensions.Http.Resilience`](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience), Microsoft Learn.
