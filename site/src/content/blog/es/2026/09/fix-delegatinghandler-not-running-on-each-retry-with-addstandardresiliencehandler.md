---
title: "Solución: un DelegatingHandler personalizado no se vuelve a ejecutar en cada reintento con AddStandardResilienceHandler"
description: "Un DelegatingHandler registrado antes de AddStandardResilienceHandler se ejecuta una vez por solicitud lógica, no una vez por reintento. Muévelo después del handler de resiliencia y hazlo idempotente, porque el reintento vuelve a enviar el mismo HttpRequestMessage. Medido en Microsoft.Extensions.Http.Resilience 10.10.0 y 8.10.0."
pubDate: 2026-09-23
template: how-to
tags:
  - "dotnet-10"
  - "httpclient"
  - "resilience"
  - "polly"
  - "aspnetcore"
lang: "es"
translationOf: "2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler"
translatedBy: "claude"
translationDate: 2026-09-23
---

**Respuesta corta:** `IHttpClientFactory` arma la cadena de handlers en el orden de registro, y el primero registrado queda en el exterior. Si llamas a `AddHttpMessageHandler<MyHandler>()` *antes* de `AddStandardResilienceHandler()`, tu handler queda fuera del bucle de reintentos y se ejecuta exactamente una vez, sin importar cuántos intentos haga Polly por debajo. Regístralo *después* del handler de resiliencia y se ejecutará una vez por intento. Luego corrige el segundo error que ese cambio deja al descubierto: el reintento estándar vuelve a enviar el **mismo** objeto `HttpRequestMessage`, así que cualquier `request.Headers.Add(...)` en un handler por intento acumula valores duplicados, y un cuerpo `StreamContent` no posicionable lanza `InvalidOperationException: The stream was already consumed` en el segundo intento.

Todo lo que sigue se midió con una prueba basada en un archivo sobre .NET 10.0.10 (SDK 10.0.302) contra `Microsoft.Extensions.Http.Resilience` 10.10.0, la versión estable actual, y se repitió en 8.10.0. Ambas versiones produjeron una salida idéntica, así que no es una regresión ni algo que vaya a cambiar al actualizar el paquete. Así es como se construye el pipeline.

## Por qué el handler se ejecuta solo una vez

`AddStandardResilienceHandler` no es una configuración del cliente. Es un `DelegatingHandler` más, de tipo `ResilienceHandler`, agregado a la misma lista ordenada a la que agrega `AddHttpMessageHandler`. La documentación de ASP.NET Core describe la regla en una línea: los handlers [se pueden registrar en el orden en que deben ejecutarse](https://learn.microsoft.com/aspnet/core/fundamentals/http-requests#outgoing-request-middleware), y cada uno envuelve al siguiente.

Dentro de `ResilienceHandler.SendAsync`, el pipeline de Polly ejecuta un callback que llama a `base.SendAsync(request, ...)`, es decir, al siguiente handler de la cadena. Cuando la estrategia de reintento decide intentarlo de nuevo, vuelve a invocar ese callback. Por eso solo se vuelven a ejecutar los handlers que están **debajo** de `ResilienceHandler`. Todo lo que está por encima ya llamó a `base.SendAsync` una vez y simplemente espera el resultado final.

Ese es todo el error. Los tutoriales y el código antiguo suelen registrar primero los handlers transversales y añadir la resiliencia al final, porque se lee de forma natural:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddTransient<SigningHandler>();

builder.Services.AddHttpClient<PaymentsClient>(c => c.BaseAddress = new("https://payments.example"))
    .AddHttpMessageHandler<SigningHandler>()   // outermost: runs once
    .AddStandardResilienceHandler();           // retries happen below this line
```

Si `SigningHandler` estampa una marca de tiempo y una firma HMAC, cada reintento sale con la firma calculada para el primer intento. Si obtiene un token de corta duración, un reintento después de un 503 lento puede salir con un token que ya expiró. Si registra "sending request", ves una sola línea de registro para tres llamadas de red.

## La cadena de handlers medida

Resolví `IHttpMessageHandlerFactory.CreateHandler("c")` y recorrí `InnerHandler` hasta el handler primario. El primario era un stub que devuelve `503` dos veces y luego `200`, y los retrasos de reintento se fijaron en cero para que la prueba se ejecute al instante. Un `CountingHandler` registra cada llamada que ve.

Registrado **antes** de `AddStandardResilienceHandler`:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> CountingHandler -> ResilienceHandler
       -> LoggingHttpMessageHandler -> StubPrimary
final: 200, primary calls: 3
CountingHandler #1 X-Attempt=[]
CountingHandler #1 <- 200
```

Tres solicitudes llegaron a la red. El handler se ejecutó una vez y solo vio el `200` final.

Registrado **después** de `AddStandardResilienceHandler`:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> ResilienceHandler -> CountingHandler
       -> LoggingHttpMessageHandler -> StubPrimary
final: 200, primary calls: 3
CountingHandler #2 <- 503
CountingHandler #3 <- 503
CountingHandler #4 <- 200
```

Ahora se ejecuta por intento y ve cada `503`. Fíjate dónde queda el propio `LoggingHttpMessageHandler` de la factory: siempre en lo más interno, justo encima del handler primario. Por eso la categoría de registro integrada `System.Net.Http.HttpClient.<name>.ClientHandler` ya muestra una entrada por intento, mientras que un handler que registraste primero muestra una entrada por llamada. Si tus registros y tu handler no coinciden en el número de solicitudes, esta es la razón.

## Corrígelo en tres pasos

1. Decide, para cada handler, si su trabajo pertenece a la **llamada lógica** o a **cada intento**. La firma, la obtención de tokens, el registro por intento y las métricas son por intento. Una clave de idempotencia, un ID de correlación que quieres mantener estable entre reintentos y cualquier cosa que deba ocurrir exactamente una vez son por llamada.
2. Registra los handlers por intento **después** de `AddStandardResilienceHandler()` (o `AddResilienceHandler(...)`), y los handlers por llamada antes.
3. Haz que cada handler por intento sea seguro de ejecutar repetidamente sobre el mismo `HttpRequestMessage`: reemplaza los encabezados en lugar de agregarlos, y asegúrate de que el cuerpo de la solicitud se pueda leer más de una vez.

El registro del ejemplo de pagos queda así:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddTransient<IdempotencyKeyHandler>();
builder.Services.AddTransient<SigningHandler>();

var payments = builder.Services
    .AddHttpClient<PaymentsClient>(c => c.BaseAddress = new("https://payments.example"));

payments.AddHttpMessageHandler<IdempotencyKeyHandler>(); // once per call: same key on every retry
payments.AddStandardResilienceHandler();
payments.AddHttpMessageHandler<SigningHandler>();        // once per attempt: fresh signature
```

Guarda el `IHttpClientBuilder` en una variable. No puedes encadenar `.AddHttpMessageHandler<T>()` a `AddStandardResilienceHandler()`, porque este devuelve un `IHttpStandardResiliencePipelineBuilder`, no el builder del cliente. Intentarlo hace fallar la compilación:

```text
error CS1929: 'IHttpStandardResiliencePipelineBuilder' does not contain a definition for
'AddHttpMessageHandler' and the best extension method overload
'HttpClientBuilderExtensions.AddHttpMessageHandler<SigningHandler>(IHttpClientBuilder)'
requires a receiver of type 'Microsoft.Extensions.DependencyInjection.IHttpClientBuilder'
```

Sospecho que ese error del compilador es la verdadera razón por la que tanto código registra los handlers primero: la cadena fluida solo compila en el orden incorrecto, así que la gente pone la resiliencia al final y sigue adelante. Una segunda llamada a `AddHttpClient<PaymentsClient>()` para el mismo cliente también funciona, ya que devuelve un builder para el mismo nombre, pero la variable hace visible el orden.

La clave de idempotencia es el caso en que la gente se equivoca en la dirección opuesta. Si mueves *todos* los handlers dentro del reintento para arreglar la firma, un handler que genera `Idempotency-Key: Guid.NewGuid()` ahora envía una clave distinta por intento, y el servidor ya no puede distinguir un reintento de un pago nuevo. El sentido de la clave es que se mantenga constante entre reintentos, así que tiene que vivir fuera del bucle.

## El reintento vuelve a enviar el mismo HttpRequestMessage

Esto me sorprendió. Esperaba que el handler de resiliencia clonara la solicitud en cada intento. No lo hace, en el caso del handler estándar (de reintento). La prueba registró el código hash de la solicitud en cada intento y era el mismo objeto todas las veces. Un handler por intento que usa `Headers.Add` produce entonces esto:

```text
chain: ... -> ResilienceHandler -> HeaderHandler -> CountingHandler -> ...
CountingHandler #5 X-Attempt=[1]
CountingHandler #6 X-Attempt=[1,1]
CountingHandler #7 X-Attempt=[1,1,1]
```

Para el tercer intento el encabezado tiene tres valores. En un encabezado de firma eso significa que el servidor recibe `X-Signature: abc, def, ghi` y lo rechaza. El código de `ResilienceHandler` lo confirma: el callback del pipeline llama a `GetRequestMessage(context, state.request)`, que devuelve la solicitud original a menos que una estrategia externa haya puesto otra distinta en el contexto. Solo el hedging hace eso.

La solución es escribir los encabezados con semántica de "set". `Authorization` es una propiedad tipada de un solo valor, así que asignarla reemplaza el valor anterior. Para encabezados personalizados, elimina primero:

```csharp
// .NET 10, C# 14
public sealed class SigningHandler(ISigner signer, TimeProvider clock) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var timestamp = clock.GetUtcNow().ToUnixTimeSeconds().ToString();

        request.Headers.Remove("X-Timestamp");
        request.Headers.Remove("X-Signature");
        request.Headers.Add("X-Timestamp", timestamp);
        request.Headers.Add("X-Signature", await signer.SignAsync(request, timestamp, cancellationToken));

        return await base.SendAsync(request, cancellationToken);
    }
}
```

Con `Remove` seguido de `Add`, la prueba mostró `X-Attempt=[1]`, `[2]`, `[3]` en los tres intentos: un solo valor, renovado cada vez. Lo mismo aplica a un handler de tokens: `request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);` ya es seguro de repetir.

## Los cuerpos de las solicitudes deben poder reenviarse

Como el mismo `HttpRequestMessage` vuelve a salir, también lo hace el mismo `HttpContent`. `StringContent`, `ByteArrayContent`, `JsonContent` y `FormUrlEncodedContent` están respaldados por memoria y se pueden serializar cualquier número de veces. El handler primario de la prueba copiaba el cuerpo con `CopyToAsync`, que es lo que hace `SocketsHttpHandler`, y un POST con `StringContent` llegó intacto en los tres intentos.

Un `StreamContent` sobre un stream no posicionable (un stream de red, un pipe, una carga que estás reenviando) no sobrevive:

```text
primary #1 body='{"a":1}'
primary #2 InvalidOperationException: The stream was already consumed. It cannot be read again.
```

`InvalidOperationException` no es una de las excepciones que el reintento estándar trata como transitorias, así que la llamada falla en el segundo intento con esa excepción en lugar de reintentar. Un stream posicionable funciona, porque `StreamContent` vuelve a su posición inicial antes de cada envío.

Tienes tres opciones:

```csharp
// .NET 10, C# 14
// Option 1: buffer it (fine for small bodies)
var content = new StreamContent(uploadStream);
await content.LoadIntoBufferAsync(cancellationToken);   // probe: all 3 attempts sent the full body

// Option 2: copy to a seekable stream first
var ms = new MemoryStream();
await uploadStream.CopyToAsync(ms, cancellationToken);
ms.Position = 0;
var seekable = new StreamContent(ms);

// Option 3: do not retry this request at all
builder.Services.AddHttpClient("uploads")
    .AddStandardResilienceHandler()
    .Configure(o => o.Retry.DisableForUnsafeHttpMethods());
```

Para cargas grandes, la opción 3 suele ser la respuesta honesta. Cargar un cuerpo de 500 MB en memoria para que se pueda reintentar es un modo de fallo peor que mostrar el error. `DisableForUnsafeHttpMethods` además evita que el handler estándar reintente `POST`, `PUT`, `PATCH` y `DELETE` en general, que es lo que a menudo quieres de todos modos para endpoints no idempotentes.

## Aspire y ConfigureHttpClientDefaults ya ponen tu handler dentro

Si tu proyecto usa los `ServiceDefaults` de .NET Aspire, puede que no tengas este error en absoluto. `AddServiceDefaults()` llama a `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())`, y las acciones predeterminadas siempre se ejecutan antes que la configuración propia de un cliente con nombre o tipado. Registré el handler de resiliencia mediante `ConfigureHttpClientDefaults` y un `CountingHandler` en el cliente con nombre:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> ResilienceHandler -> CountingHandler
       -> LoggingHttpMessageHandler -> StubPrimary
CountingHandler #8 <- 503
CountingHandler #9 <- 503
CountingHandler #10 <- 200
```

Cada handler por cliente termina dentro del reintento, sin importar el orden de `AddServiceDefaults()` y `AddHttpClient(...)` en `Program.cs`. Ese es el comportamiento predeterminado correcto para firmas y tokens, y el incorrecto para claves de idempotencia. Si necesitas un handler por llamada en una aplicación Aspire, tienes que quitar el handler de resiliencia predeterminado para ese cliente y volver a agregarlo después de tu handler, lo cual se explica en [cómo sobrescribir el handler de resiliencia predeterminado que registra Aspire](/es/2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers/). Agregar un segundo `AddStandardResilienceHandler()` no reemplaza al primero, se apila.

## El hedging se comporta de forma distinta

`AddStandardHedgingHandler()` es la excepción a la regla del "mismo objeto de solicitud". El hedging puede tener varios intentos en curso a la vez, así que toma una instantánea de la solicitud original y envía un clon por intento. La cadena también contiene dos instancias de `ResilienceHandler`, una para el pipeline de hedging y otra para las estrategias por endpoint:

```text
chain: ... -> ResilienceHandler -> ResilienceHandler -> HeaderHandler -> CountingHandler -> ...
final: 503, primary calls: 2
CountingHandler #16 req@9c43c1 X-Attempt=[1]
CountingHandler #17 req@17e61ce X-Attempt=[1]
```

Dos objetos de solicitud distintos, cada uno con exactamente un valor de encabezado, incluso con la versión del handler que usa `Headers.Add`. Los handlers registrados después del handler de hedging también se ejecutan por intento. Aun así, no dependas de la clonación: el código que solo es correcto con hedging se rompe el día en que alguien vuelve al handler estándar.

## Otras cosas que cambian cuando el handler queda dentro

Mover un handler debajo del handler de resiliencia lo pone bajo el **timeout por intento** (10 segundos de forma predeterminada) y dentro de la visión del mundo del **circuit breaker**. Tres consecuencias:

- El trabajo lento en el handler cuenta contra cada intento. Un endpoint de tokens que tarda 8 segundos deja 2 segundos para la solicitud real antes de que el intento agote su tiempo. Guarda los tokens en caché y renuévalos antes de que expiren, no en la ruta de la solicitud.
- Las excepciones que lanza tu handler son resultados que evalúan el reintento y el circuit breaker. Una `HttpRequestException` lanzada por tu handler se reintenta y cuenta como fallo para el breaker. Lanza algo no transitorio (o devuelve una respuesta) para fallos que un reintento no puede arreglar, como una configuración faltante.
- Un handler que corta el circuito y devuelve su propio `HttpResponseMessage` (un acierto de caché, por ejemplo) también está sujeto al `ShouldHandle` del reintento. Devolver un `503` sintético desde dentro del bucle se reintenta como uno real.

Las instancias de `DelegatingHandler` registradas con `AddHttpMessageHandler<T>()` deben ser transient, y eso no cambia. La factory crea una cadena por cada ciclo de vida del handler (dos minutos de forma predeterminada) y la reutiliza entre solicitudes, así que el estado por solicitud pertenece al `HttpRequestMessage` (`request.Options`), no a campos del handler.

## Cómo verificar tu propia cadena

No confíes en el código de registro, revisa la cadena construida. Esta prueba funciona para cualquier cliente:

```csharp
// .NET 10, xUnit v3, Microsoft.Extensions.Http.Resilience 10.10.0
[Fact]
public void SigningHandler_runs_inside_the_retry()
{
    var services = new ServiceCollection();
    services.AddTransient<SigningHandler>();
    services.AddSingleton<ISigner, FakeSigner>();
    services.AddSingleton(TimeProvider.System);
    var payments = services.AddHttpClient("payments");
    payments.AddStandardResilienceHandler();
    payments.AddHttpMessageHandler<SigningHandler>();

    using var sp = services.BuildServiceProvider();
    var handler = sp.GetRequiredService<IHttpMessageHandlerFactory>().CreateHandler("payments");

    var names = new List<string>();
    for (HttpMessageHandler? h = handler; h is not null; h = (h as DelegatingHandler)?.InnerHandler)
        names.Add(h.GetType().Name);

    Assert.True(names.IndexOf(nameof(ResilienceHandler)) < names.IndexOf(nameof(SigningHandler)));
}
```

Para una prueba de comportamiento, reemplaza el handler primario por un stub que falle un número fijo de veces, la misma técnica que en [pruebas unitarias de código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/), y comprueba que el número de llamadas de tu handler sea igual al número de intentos.

## Relacionado

- [Polly vs handlers de resiliencia en .NET 11](/es/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) explica las cinco estrategias dentro de `AddStandardResilienceHandler` y su orden.
- [Cómo sobrescribir el handler de resiliencia predeterminado que registra Aspire](/es/2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers/) para quitar y volver a agregar el handler por cliente.
- [HttpClient vs HttpClientFactory vs Refit](/es/2026/05/httpclient-vs-httpclientfactory-vs-refit/) cubre cómo la factory compone pipelines de `DelegatingHandler`.
- [Solución a TaskCanceledException: A task was canceled en HttpClient](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) para cuando lo que hace fallar la llamada es el timeout por intento y no tu handler.
- [Polly 8.8 recarga un pipeline de resiliencia desde tu propio IOptionsMonitor](/es/2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor/) si ajustas la configuración de reintentos en runtime.

## Fuentes

- [Make outgoing HTTP requests: outgoing request middleware](https://learn.microsoft.com/aspnet/core/fundamentals/http-requests#outgoing-request-middleware), Microsoft Learn
- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/dotnet/core/resilience/http-resilience), Microsoft Learn
- [`ResilienceHandler.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/ResilienceHandler.cs) en dotnet/extensions
- [`Microsoft.Extensions.Http.Resilience` en NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Http.Resilience), versiones 10.10.0 y 8.10.0 probadas
- [`HttpContent.LoadIntoBufferAsync`](https://learn.microsoft.com/dotnet/api/system.net.http.httpcontent.loadintobufferasync), Microsoft Learn
