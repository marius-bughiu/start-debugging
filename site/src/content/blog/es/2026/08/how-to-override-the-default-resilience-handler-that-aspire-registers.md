---
title: "Cómo sobrescribir el manejador de resiliencia predeterminado que registra Aspire"
description: "AddServiceDefaults de Aspire aplica un manejador de resiliencia estándar a cada HttpClient. Llamar a AddStandardResilienceHandler otra vez apila un segundo manejador en lugar de reemplazarlo. Aquí están las tres rutas reales para sobrescribirlo, el nombre de opciones -standard que nadie documenta y el timeout infinito que heredas si solo lo eliminas."
pubDate: 2026-08-10
template: how-to
tags:
  - "aspire"
  - "dotnet"
  - "dotnet-11"
  - "httpclient"
  - "resilience"
  - "polly"
  - "how-to"
lang: "es"
translationOf: "2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers"
translatedBy: "claude"
translationDate: 2026-08-10
---

El método `AddServiceDefaults()` de Aspire llama a `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())`, lo que coloca reintentos, un circuit breaker, un limitador de tasa y un timeout total de solicitud de 30 segundos delante de cada `HttpClient` del proceso. Llamar a `AddStandardResilienceHandler()` otra vez sobre un cliente no reemplaza eso. Apila un segundo manejador encima del primero, así que una sola solicitud lógica puede convertirse en dieciséis solicitudes físicas. Existen exactamente tres formas de sobrescribir realmente el valor predeterminado: editar `ServiceDefaults/Extensions.cs` si es tuyo, llamar a `RemoveAllResilienceHandlers()` sobre el `IHttpClientBuilder` específico antes de añadir el tuyo, o reconfigurar la instancia de opciones con nombre que lee el manejador predeterminado, la cual se llama literalmente `-standard`.

Cada comportamiento descrito aquí fue verificado ejecutándolo, no leyendo la documentación. La prueba apunta a `net10.0` con el SDK 10.0.201 y `Microsoft.Extensions.Http.Resilience` 10.8.0, que es el paquete que trae la plantilla ServiceDefaults de Aspire 13.4.6. El comportamiento de resiliencia vive en ese paquete y no en Aspire, así que las mismas reglas aplican a cualquier aplicación con `IHttpClientFactory` que use `ConfigureHttpClientDefaults`.

## Qué pone realmente AddServiceDefaults delante de tu HttpClient

El archivo `ServiceDefaults/Extensions.cs` generado contiene esto:

```csharp
// Aspire 13.4.6 ServiceDefaults template
public static TBuilder AddServiceDefaults<TBuilder>(this TBuilder builder)
    where TBuilder : IHostApplicationBuilder
{
    builder.ConfigureOpenTelemetry();
    builder.AddDefaultHealthChecks();
    builder.Services.AddServiceDiscovery();

    builder.Services.ConfigureHttpClientDefaults(http =>
    {
        // Turn on resilience by default
        http.AddStandardResilienceHandler();

        // Turn on service discovery by default
        http.AddServiceDiscovery();
    });

    return builder;
}
```

`AddStandardResilienceHandler()` compone cinco estrategias de Polly v8, de la más externa a la más interna: un limitador de tasa (1000 permisos, cola 0), un timeout total de solicitud de 30 segundos, una estrategia de reintentos (3 reintentos, backoff exponencial con jitter, retardo base de 2 segundos), un circuit breaker (ratio de fallos del 10 por ciento, throughput mínimo 100, ventana de muestreo de 30 segundos, apertura de 5 segundos) y un timeout por intento de 10 segundos. Los reintentos y la apertura del circuito se disparan con HTTP 5xx, 408, 429, `HttpRequestException` y la `TimeoutRejectedException` de Polly.

Hay una línea más en ese método que importa más que cualquiera de los valores predeterminados de las estrategias:

```csharp
// ResilienceHttpClientBuilderExtensions.StandardResilience.cs, dotnet/extensions
// Disable the HttpClient timeout to allow the timeout strategies to control the timeout.
_ = builder.ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan);
```

Añadir el manejador estándar apaga por completo `HttpClient.Timeout` y entrega la responsabilidad del timeout a las estrategias de Polly. Recuerda esto, porque sobrevive a la eliminación del manejador. Vuelvo sobre ello en la sección de trampas.

## Por qué añadir un segundo manejador no reemplaza el primero

La intuición de que un registro por cliente sobrescribe un registro de valores predeterminados es errónea aquí. Tanto `ConfigureHttpClientDefaults` como `AddHttpClient(name)` empujan a la misma lista ordenada `HttpClientFactoryOptions.HttpMessageHandlerBuilderActions`, y `AddStandardResilienceHandler` acaba llamando a `AddHttpMessageHandler`, que añade al final. Nada deduplica.

Registré el bloque de valores predeterminados y después un manejador por cliente, y luego recorrí la cadena de manejadores construida con `IHttpMessageHandlerFactory.CreateHandler`:

```text
A stacked: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
           -> ResilienceHandler -> ResilienceHandler
           -> LoggingHttpMessageHandler -> SocketsHttpHandler
```

Dos instancias de `ResilienceHandler`. Eso no es un duplicado cosmético. La estrategia de reintentos externa emite hasta 4 intentos, y cada uno de ellos pasa por la estrategia de reintentos interna, que emite hasta 4 propios, así que una llamada desde tu código puede convertirse en 16 solicitudes contra la dependencia que intentabas proteger. Los dos limitadores de tasa cobran un permiso cada uno, y los dos circuit breakers observan porciones distintas del mismo tráfico. El timeout total externo de 30 segundos es lo único que lo mantiene acotado, lo que significa que obtienes una solicitud que falla a los 30 segundos después de martillear el servicio dependiente, en vez del comportamiento ajustado que creías haber configurado.

Ocurre lo mismo si tú llamas a `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())` en `Program.cs` encima de `AddServiceDefaults()`. Lo comprobé, y la cadena muestra dos manejadores en cada cliente del proceso.

## Pasos para sobrescribir el valor predeterminado sin apilar manejadores

1. **Decide el alcance.** Si la nueva configuración debe aplicarse a todas las llamadas salientes del servicio, cambia `ServiceDefaults/Extensions.cs`. Si solo una dependencia es lenta o no idempotente, hazlo por cliente y deja el valor predeterminado en paz.
2. **Elimina antes de añadir.** Sobre el `IHttpClientBuilder` que quieres modificar, llama primero a `RemoveAllResilienceHandlers()` y después a `AddStandardResilienceHandler(...)`. El orden de registro dentro de un mismo builder es lo que decide el resultado.
3. **Suprime `EXTEXP0001`.** `RemoveAllResilienceHandlers` está anotado con `[Experimental]`, y el diagnóstico es un error, no una advertencia, así que la compilación falla sin un `#pragma warning disable` o una entrada `NoWarn`.
4. **Mantén los timeouts coherentes entre sí.** `TotalRequestTimeout` debe ser mayor que `AttemptTimeout`, y `CircuitBreaker.SamplingDuration` debe ser al menos el doble de `AttemptTimeout`, o el host lanzará una excepción al arrancar.
5. **Verifica la cadena, no la intención.** Resuelve `IHttpMessageHandlerFactory` en una prueba y cuenta las instancias de `ResilienceHandler` en el pipeline construido.

## Cambiarlo para todo el servicio en ServiceDefaults

Si el proyecto `ServiceDefaults` es tuyo, editar el bloque es la solución honesta. Microsoft distribuye exactamente esta forma en la plantilla de chat de `Microsoft.Extensions.AI`, donde el endpoint de Ollama suele tardar minutos en responder y el timeout por intento de 10 segundos mataría cada solicitud:

```csharp
// Microsoft.Extensions.Http.Resilience 10.8.0, .NET 10
public static IServiceCollection AddOllamaResilienceHandler(this IServiceCollection services)
{
    services.ConfigureHttpClientDefaults(http =>
    {
#pragma warning disable EXTEXP0001 // RemoveAllResilienceHandlers is experimental
        http.RemoveAllResilienceHandlers();
#pragma warning restore EXTEXP0001

        http.AddStandardResilienceHandler(config =>
        {
            config.AttemptTimeout.Timeout = TimeSpan.FromMinutes(3);

            // Must be at least double the AttemptTimeout to pass options validation
            config.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(10);
            config.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(10);
        });
    });

    return services;
}
```

Fíjate en que este es un segundo bloque `ConfigureHttpClientDefaults`, llamado después de `AddServiceDefaults()`. La eliminación se ejecuta antes de volver a añadir porque las acciones se ejecutan en orden de registro, así que el efecto neto es un manejador con tu configuración. La plantilla también vuelve a añadir `AddServiceDiscovery()` dentro de ese bloque, lo cual es innecesario: `RemoveAllResilienceHandlers` solo quita manejadores de tipo `ResilienceHandler`, y volver a añadir el descubrimiento de servicios te deja con dos manejadores de descubrimiento de servicios.

## Sobrescribir un solo cliente sin tocar ServiceDefaults

Este es el caso que aparece de verdad: una dependencia es lenta, o un endpoint es un `POST` que nunca debes reintentar, y el resto del servicio debe conservar los valores predeterminados de Aspire.

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.8.0
builder.AddServiceDefaults();

builder.Services.AddHttpClient("reports", client =>
    {
        client.BaseAddress = new Uri("https+http://reporting");
    })
#pragma warning disable EXTEXP0001
    .RemoveAllResilienceHandlers()
#pragma warning restore EXTEXP0001
    .AddStandardResilienceHandler(o =>
    {
        o.AttemptTimeout.Timeout = TimeSpan.FromMinutes(3);
        o.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(10);
        o.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(10);
        o.Retry.DisableForUnsafeHttpMethods();
    });
```

Dos cosas de esto que no son obvias.

Primera, el orden de llamada entre `AddServiceDefaults()` y `AddHttpClient(...)` no importa. `ConfigureHttpClientDefaults` inserta sus registros en una posición rastreada de la colección de servicios para que los valores predeterminados siempre se ejecuten antes de la configuración de clientes con nombre. Registré primero el cliente con nombre y después el bloque de valores predeterminados, y el cliente `reports` terminó igualmente con exactamente un `ResilienceHandler` usando el timeout por intento de tres minutos, mientras que un cliente no relacionado conservó el valor predeterminado de 10 segundos. El orden sí importa dentro de una misma cadena de builder: pon `RemoveAllResilienceHandlers()` después de `AddStandardResilienceHandler()` sobre el mismo cliente y obtendrás un cliente sin resiliencia alguna.

Segunda, `DisableForUnsafeHttpMethods()` desactiva los reintentos para `POST`, `PATCH`, `PUT`, `DELETE` y `CONNECT`. El manejador estándar reintenta todos los métodos por defecto, lo que es un error de duplicación de datos esperando a ocurrir en un endpoint no idempotente. `DisableFor(HttpMethod.Post, HttpMethod.Delete)` te da la versión más acotada.

## El nombre de opciones que nadie documenta: `-standard`

`AddStandardResilienceHandler` no usa la instancia de opciones predeterminada. Calcula un nombre de opciones como `$"{httpClientName}-{pipelineIdentifier}"` con el identificador `standard`, y después lee esa instancia con nombre a través de `IOptionsMonitor<HttpStandardResilienceOptions>`. Para un cliente llamado `slow`, el nombre de opciones es `slow-standard`. Dentro de `ConfigureHttpClientDefaults` el `Name` del builder es null, así que la interpolación de cadenas produce `-standard`, con un guion inicial y nada delante.

Esto tiene un filo peligroso. La llamada a `Configure<HttpStandardResilienceOptions>` que parece correcta no hace nada:

```csharp
builder.Services.ConfigureHttpClientDefaults(h => h.AddStandardResilienceHandler());
builder.Services.Configure<HttpStandardResilienceOptions>(o => o.Retry.MaxRetryAttempts = 9);
```

```text
options[''].MaxRetryAttempts          = 9
options['-standard'].MaxRetryAttempts = 3
```

Tu valor aterriza en la instancia sin nombre, que ningún manejador lee jamás, y el manejador conserva el valor predeterminado de 3. Sin excepción, sin entrada de registro. Si alguna vez "configuraste" la resiliencia y viste que no tenía ningún efecto, esta es casi con certeza la razón. También explica por qué el manejador estándar es inmune a un `Configure` simple aunque `HttpStandardResilienceOptions` sea una clase de opciones corriente. La [diferencia entre las interfaces de acceso a opciones](/es/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) no es el problema aquí; el nombre sí lo es.

Conocer el nombre te da una tercera ruta de sobrescritura, útil cuando no puedes editar `ServiceDefaults` (un paquete compartido, una plantilla que no controlas) y no quieres enumerar cada cliente:

```csharp
// Retunes the handler that AddServiceDefaults already registered.
builder.Services.Configure<HttpStandardResilienceOptions>("-standard", o =>
{
    o.AttemptTimeout.Timeout = TimeSpan.FromSeconds(20);
    o.CircuitBreaker.SamplingDuration = TimeSpan.FromSeconds(60);
    o.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(90);
});
```

Eso resuelve a `attempt=00:00:20 total=00:01:30` al arrancar, con un solo manejador en la cadena. Es un literal de cadena acoplado a un detalle de implementación, así que deja un comentario al lado, pero funciona y no apila.

Para configuraciones por cliente que pertenecen a la configuración en vez de al código, enlaza una sección. `AddStandardResilienceHandler(IConfigurationSection)` es una sobrecarga real que reenvía a `.Configure(section)` sobre la instancia de opciones con el nombre correcto:

```json
{
  "Resilience": {
    "Slow": {
      "AttemptTimeout": { "Timeout": "00:03:00" },
      "TotalRequestTimeout": { "Timeout": "00:10:00" },
      "CircuitBreaker": { "SamplingDuration": "00:10:00" },
      "Retry": { "MaxRetryAttempts": 2 }
    }
  }
}
```

```csharp
builder.Services.AddHttpClient("slow")
#pragma warning disable EXTEXP0001
    .RemoveAllResilienceHandlers()
#pragma warning restore EXTEXP0001
    .AddStandardResilienceHandler(builder.Configuration.GetSection("Resilience:Slow"));
```

Los valores enlazados llegan exactamente como se escribieron y, como el manejador estándar llama a `context.EnableReloads`, editar esos valores en `appsettings.json` reconstruye el pipeline sin reiniciar.

## Las trampas que muerden

**Los timeouts mal configurados fallan al arrancar, no en la primera solicitud.** Ambos validadores se registran con `AddOptionsWithValidateOnStart`, así que una incoherencia lanza una excepción cuando arranca el host. Poner solo `AttemptTimeout` en 3 minutos y dejar el resto intacto produce esto:

```text
Microsoft.Extensions.Options.OptionsValidationException: Total request timeout resilience
strategy must have a greater timeout than the attempt resilience strategy. Total Request
Timeout: 30s, Attempt Timeout: 180s; The sampling duration of circuit breaker strategy needs
to be at least double of an attempt timeout strategy’s timeout interval, in order to be
effective. Sampling Duration: 30s,Attempt Timeout: 180s
```

La regla del doble es un multiplicador de 2 codificado a fuego en `HttpStandardResilienceOptionsCustomValidator`. Subir `AttemptTimeout` siempre significa subir también `TotalRequestTimeout` y `CircuitBreaker.SamplingDuration`. Si quieres ese tipo de comprobación sobre tus propias opciones, la misma maquinaria está disponible mediante la [validación al arranque con `IValidateOptions<T>`](/es/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/).

**Eliminar el manejador te deja sin ningún timeout.** Esta es la peor. `RemoveAllResilienceHandlers()` quita las instancias de `ResilienceHandler`, pero no deshace el `ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan)` que registró `AddStandardResilienceHandler`. Un cliente construido con `AddHttpClient("bare").RemoveAllResilienceHandlers()` y nada añadido de vuelta da:

```text
bare client chain:   LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
                     -> LoggingHttpMessageHandler -> SocketsHttpHandler
HttpClient('bare').Timeout = -00:00:00.0010000
```

Ese milisegundo negativo es `Timeout.InfiniteTimeSpan`. Sin manejador de resiliencia, sin el valor predeterminado de 100 segundos de `HttpClient`, sin timeout de ningún tipo. Una dependencia colgada ahora cuelga el thread pool de tus solicitudes hasta que se dispare el token de cancelación que ojalá hayas pasado. Si eliminas el manejador y no añades otro, establece `client.Timeout` explícitamente. El modo de fallo relacionado en el que sí salta un timeout está cubierto en [por qué HttpClient lanza TaskCanceledException](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

**La eliminación está limitada por tipo, no por cadena.** La implementación recorre los manejadores adicionales hacia atrás y quita solo aquellos que cumplen `is ResilienceHandler`. Los tipos `DelegatingHandler` propios, los manejadores de autenticación y el manejador de descubrimiento de servicios sobreviven todos. Lo confirmé con un manejador marcador registrado en el bloque de valores predeterminados: después de `RemoveAllResilienceHandlers()` sobre un cliente con nombre, el marcador sigue ahí. Así que no vuelvas a añadir el descubrimiento de servicios después de una eliminación.

**Los clientes gRPC necesitan `Grpc.Net.ClientFactory` 2.64.0 o posterior.** Combinar el manejador estándar con un `AddGrpcClient` más antiguo lanza `System.InvalidOperationException: The ConfigureHttpClient method isn't supported when creating gRPC clients`. Hay una comprobación en tiempo de compilación para ello, suprimible con `<SuppressCheckGrpcNetClientFactoryVersion>`.

**`RemoveAllResilienceHandlers` es experimental.** `EXTEXP0001` lo emite como error el analizador de `Microsoft.Extensions.Http.Resilience` 10.8.0, así que el pragma es obligatorio y no un detalle de limpieza. La API ha sido estable en su forma desde 9.0, pero la anotación significa que el equipo se reserva el derecho de cambiarla.

La regla que cubre todo esto: un manejador de resiliencia es un manejador de mensajes, y los manejadores de mensajes se componen en vez de reemplazarse. Una vez que lo interiorizas, "cómo sobrescribo el valor predeterminado de Aspire" deja de ser un acertijo y se convierte en "elimina, después añade, en ese orden, sobre el builder correcto".

## Relacionado

- [Polly vs manejadores de resiliencia en .NET 11](/es/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) explica en qué capa configurar la resiliencia para empezar.
- [Añadir Aspire a una solución ASP.NET Core existente](/es/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) cubre qué más activa `AddServiceDefaults()`.
- [HttpClient vs HttpClientFactory vs Refit](/es/2026/05/httpclient-vs-httpclientfactory-vs-refit/) para entender cómo se construye la cadena de manejadores.
- [IOptions vs IOptionsSnapshot vs IOptionsMonitor en .NET 11](/es/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) para el monitor a través del cual el manejador estándar lee sus opciones con nombre.
- [Aspire vs Docker Compose para desarrollo local multiservicio](/es/2026/08/aspire-vs-docker-compose-for-local-multi-service-development/) si todavía estás decidiendo si adoptar Aspire.

## Fuentes

- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) en MS Learn, por la tabla de valores predeterminados del manejador estándar y los problemas conocidos.
- [`ResilienceHttpClientBuilderExtensions.StandardResilience.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/ResilienceHttpClientBuilderExtensions.StandardResilience.cs) en dotnet/extensions, por el nombre de opciones y el timeout infinito del cliente.
- [`HttpStandardResilienceOptionsCustomValidator.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/Internal/Validators/HttpStandardResilienceOptionsCustomValidator.cs), por las reglas de validación exactas y sus mensajes.
- [`OllamaResilienceHandlerExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/ProjectTemplates/Microsoft.Extensions.AI.Templates/templates/AIChatWeb-CSharp/AIChatWeb-CSharp.Web/OllamaResilienceHandlerExtensions.cs), la propia sobrescritura de Microsoft del valor predeterminado de Aspire.
- [Aspire service defaults](https://aspire.dev/get-started/csharp-service-defaults/), por el código fuente generado de `AddServiceDefaults`.
