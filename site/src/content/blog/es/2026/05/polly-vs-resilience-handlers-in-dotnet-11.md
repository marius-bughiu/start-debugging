---
title: "Polly vs. resilience handlers en .NET 11: ¿cuál deberías usar?"
description: "Usa el resilience handler de Microsoft.Extensions.Http.Resilience para las llamadas con HttpClient, porque es Polly con valores predeterminados que entienden HTTP y telemetría en una sola línea. Recurre a ResiliencePipeline de Polly directamente solo cuando protejas algo que no sea un HttpClient."
pubDate: 2026-05-24
tags:
  - "comparison"
  - "polly"
  - "resilience"
  - "httpclient"
  - "dotnet"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/polly-vs-resilience-handlers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-24
---

El planteamiento de "Polly vs. resilience handlers" es ligeramente erróneo, y darte cuenta de por qué es toda la respuesta. El resilience handler, `AddStandardResilienceHandler` del paquete `Microsoft.Extensions.Http.Resilience`, no es una alternativa a Polly. Es Polly, envuelto en una capa que entiende HTTP y se integra con la inyección de dependencias, que se conecta directamente a `IHttpClientFactory`. Así que la verdadera pregunta no es "qué biblioteca" sino "en qué capa configuro la resiliencia". Para código nuevo en .NET 11 en 2026: si lo que estás protegiendo es una llamada con `HttpClient`, usa el resilience handler, porque te da las estrategias de Polly con valores predeterminados que entienden HTTP, telemetría y enlace de configuración en una sola línea. Recurre a la API `ResiliencePipeline` de Polly directamente solo cuando la operación no sea una solicitud con `HttpClient`: una consulta a base de datos, una publicación en un broker de mensajes, una llamada gRPC invocada manualmente o cualquier delegado arbitrario.

Todos los ejemplos aquí apuntan a `<TargetFramework>net11.0</TargetFramework>` con el SDK de .NET 11 y C# 14. "Polly" se refiere a Polly v8 (el paquete `Polly.Core`, 8.6.6 en NuGet), cuya API `ResiliencePipeline` reemplazó los antiguos tipos `Policy`. "Resilience handler" se refiere a `Microsoft.Extensions.Http.Resilience` 10.6.0, que depende de `Microsoft.Extensions.Resilience` y de Polly. Los dos son el mismo motor visto desde dos alturas.

## La tabla de características de un vistazo

Esta es la tabla por la que viniste. Las columnas son las dos formas en que realmente conectas la resiliencia, y las filas son las decisiones que cambian cuál eliges.

| Aspecto | Polly `ResiliencePipeline` | Resilience handler (`Microsoft.Extensions.Http.Resilience`) |
| ------- | ------------------------- | ---------------------------------------------------------- |
| Qué envuelve | Cualquier delegado u operación | Solo solicitudes con `HttpClient` |
| Construido sobre | `Polly.Core` (el motor) | `Polly.Core`, envuelto |
| Cómo se ejecuta | Llamas a `pipeline.ExecuteAsync(...)` explícitamente | Transparente, dentro del pipeline de `HttpMessageHandler` |
| Predeterminados que entienden HTTP (5xx, 408, 429) | Escribes `ShouldHandle` tú mismo | Incluido |
| Un pipeline predeterminado sensato en una línea | No, lo compones tú | Sí, `AddStandardResilienceHandler()` |
| Telemetría (métricas + trazas) | Vía `Microsoft.Extensions.Resilience` o manual | Incluida |
| Enlace de configuración + recarga en caliente | Manual | De primera clase (`EnableReloads`) |
| Integración con inyección de dependencias | `ResiliencePipelineRegistry<TKey>` | `IHttpClientBuilder` |
| Paquete NuGet | `Polly.Core` 8.6.6 | `Microsoft.Extensions.Http.Resilience` 10.6.0 |
| Mejor para | Llamadas a base de datos, colas, gRPC, código arbitrario | Llamadas con `HttpClient` con nombre o tipado |

El patrón en la tabla es que el resilience handler es la columna de la derecha que hereda el motor de la izquierda y añade conocimiento de HTTP, telemetría y conexión con la inyección de dependencias encima. El costo de moverse a la derecha es que renuncias a la generalidad: el handler solo se ejecuta contra `HttpClient`.

## Por qué el resilience handler es solo Polly con uniforme

Cuando llamas a `AddStandardResilienceHandler`, el paquete construye un `ResiliencePipeline<HttpResponseMessage>` de Polly y lo instala como un `DelegatingHandler` en el pipeline de manejadores de mensajes que `IHttpClientFactory` compone para ese cliente. Cada reintento, cada apertura del circuit breaker, cada tiempo de espera lo ejecuta `Polly.Core`. No hay un segundo motor de resiliencia en .NET. Microsoft no reimplementó los reintentos; tomó Polly v8, le dio valores predeterminados ajustados para HTTP, lo conectó al sistema de opciones y emitió métricas y trazas compatibles con OpenTelemetry a su alrededor.

Por eso "¿debería usar Polly o el resilience handler?" es un error de categoría para código HTTP. Usar el handler es usar Polly. La decisión es si quieres la capa de conveniencia con forma de HTTP o si necesitas el motor en bruto porque tu operación no es HTTP.

## Cuándo el resilience handler es la opción correcta

Para cualquier resiliencia que viva sobre un `HttpClient` resuelto mediante `IHttpClientFactory`, el handler gana. El handler estándar es una sola línea encima de un cliente tipado:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 10.6.0
using Microsoft.Extensions.DependencyInjection;

builder.Services.AddHttpClient<GitHubService>(client =>
{
    client.BaseAddress = new Uri("https://api.github.com");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
})
.AddStandardResilienceHandler(); // rate limiter, total timeout, retry, breaker, attempt timeout
```

Esa única llamada apila cinco estrategias con valores predeterminados que entienden HTTP: ya sabe que HTTP 500+, 408 y 429 son transitorios, que `HttpRequestException` y la `TimeoutRejectedException` de Polly deben reintentarse, y que un encabezado `Retry-After` debe respetarse. No escribiste un predicado `ShouldHandle` para nada de eso. Este es el reemplazo moderno de cablear políticas de Polly a mano sobre un cliente, y es el valor predeterminado correcto para casi todo el código HTTP del lado del servidor.

Cuando los valores predeterminados no son del todo correctos, no bajas a Polly en bruto. Te quedas en la capa del handler y personalizas, porque el handler expone las mismas opciones de Polly a través de tipos de opciones específicos de HTTP. Usa `AddResilienceHandler` para construir un pipeline con nombre y totalmente personalizado:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 10.6.0
using System.Net;
using Microsoft.Extensions.Http.Resilience;
using Polly;

httpClientBuilder.AddResilienceHandler("CustomPipeline", static builder =>
{
    builder.AddRetry(new HttpRetryStrategyOptions
    {
        BackoffType = DelayBackoffType.Exponential,
        MaxRetryAttempts = 5,
        UseJitter = true
    });

    builder.AddCircuitBreaker(new HttpCircuitBreakerStrategyOptions
    {
        SamplingDuration = TimeSpan.FromSeconds(10),
        FailureRatio = 0.2,
        MinimumThroughput = 3,
        ShouldHandle = static args => ValueTask.FromResult(args is
        {
            Outcome.Result.StatusCode:
                HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests
        })
    });

    builder.AddTimeout(TimeSpan.FromSeconds(5));
});
```

Fíjate en los tipos: `HttpRetryStrategyOptions` y `HttpCircuitBreakerStrategyOptions`. Estas son las versiones con sabor a HTTP de `RetryStrategyOptions<T>` y `CircuitBreakerStrategyOptions<T>` de Polly, que llevan conveniencias como `DisableForUnsafeHttpMethods()` que solo tienen sentido para HTTP. Sigues en Polly, solo que en la parte de Polly que entiende `HttpResponseMessage`.

El handler también se enlaza a la configuración y se recarga en tiempo de ejecución. Enlaza `HttpStandardResilienceOptions` a una sección de `appsettings.json`, llama a `EnableReloads` dentro de una sobrecarga de `AddResilienceHandler` que expone el `ResilienceHandlerContext`, y cambiar el JSON reajusta el pipeline en vivo sin reiniciar. Esa fontanería no es gratis de escribir a mano contra Polly en bruto, y el handler te la da.

## Qué configura realmente el handler estándar

Los lectores llegan a esta comparación porque quieren saber qué hace `AddStandardResilienceHandler` antes de confiar en él. La configuración predeterminada encadena cinco estrategias, de la más externa a la más interna. Los números a continuación son los valores predeterminados de .NET 11 / `Microsoft.Extensions.Http.Resilience` 10.6.0:

| Orden | Estrategia | Predeterminado |
| ----- | -------- | ------- |
| 1 | Rate limiter | Permit: `1_000`, Queue: `0` |
| 2 | Tiempo de espera total de la solicitud | 30s a través de todos los intentos |
| 3 | Reintento | Máx. reintentos: `3`, backoff exponencial, jitter activo, retardo base 2s |
| 4 | Circuit breaker | Ratio de fallos: 10%, throughput mín.: `100`, muestreo 30s, apertura 5s |
| 5 | Tiempo de espera por intento | 10s por intento individual |

El orden importa. El tiempo de espera total (30s) se sitúa fuera de los reintentos, así que tres reintentos que cada uno alcance el tiempo de espera por intento de 10s no pueden ejecutarse para siempre: toda la operación está limitada a 30s. El circuit breaker se sitúa dentro del reintento, así que cuenta los fallos de intentos individuales, y una vez que el 10% de al menos 100 llamadas muestreadas fallan dentro de 30s, se abre durante 5s y cortocircuita todo lo que hay debajo. Si solo recuerdas una cosa sobre los valores predeterminados: los reintentos están limitados por un reloj de pared de 30s, no solo por un conteo.

## Cuándo recurrir a Polly directamente

El handler deja de ser una opción en el momento en que lo que estás protegiendo no es una llamada con `HttpClient`. No hay `AddStandardResilienceHandler` para una consulta a base de datos, un `ServiceBusSender.SendMessageAsync`, una llamada a Redis o un bloque de lógica de negocio que ocasionalmente lanza una excepción. Para esos, construyes un `ResiliencePipeline` de Polly y lo invocas explícitamente:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - resilience around a non-HTTP operation
using Polly;
using Polly.Retry;

ResiliencePipeline pipeline = new ResiliencePipelineBuilder()
    .AddRetry(new RetryStrategyOptions
    {
        MaxRetryAttempts = 3,
        BackoffType = DelayBackoffType.Exponential,
        UseJitter = true,
        // Only retry the transient failures this dependency actually throws
        ShouldHandle = new PredicateBuilder().Handle<TimeoutException>()
    })
    .AddTimeout(TimeSpan.FromSeconds(5))
    .Build();

await pipeline.ExecuteAsync(
    async token => await SaveOrderAsync(order, token),
    cancellationToken);
```

La forma es el mismo motor que viste dentro del handler: `AddRetry`, `AddTimeout`, `AddCircuitBreaker`, el mismo `DelayBackoffType` y `ShouldHandle`. Lo que cambia es que llamas a `ExecuteAsync` tú mismo, eliges qué cuenta como fallo transitorio (aquí `TimeoutException`, porque no hay código de estado HTTP que inspeccionar), y el pipeline puede envolver literalmente cualquier delegado.

Para resultados tipados, usa el builder genérico para que el pipeline pueda razonar sobre el valor de retorno, no solo sobre excepciones:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - a pipeline that inspects the result
using Polly;

ResiliencePipeline<DbResult> pipeline = new ResiliencePipelineBuilder<DbResult>()
    .AddRetry(new()
    {
        MaxRetryAttempts = 3,
        ShouldHandle = static args => ValueTask.FromResult(
            args.Outcome.Result is { Status: DbStatus.Throttled })
    })
    .Build();

DbResult result = await pipeline.ExecuteAsync(
    async token => await QueryAsync(token),
    cancellationToken);
```

En una aplicación con inyección de dependencias no instancias pipelines en los sitios de llamada. Los registras una vez con `AddResiliencePipeline`, y aterrizan en el `ResiliencePipelineRegistry<TKey>` para que puedas resolverlos en cualquier lugar mediante `ResiliencePipelineProvider<TKey>`:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - register once, resolve anywhere
using Microsoft.Extensions.DependencyInjection;
using Polly;
using Polly.Registry;

builder.Services.AddResiliencePipeline("db-writes", static b =>
{
    b.AddRetry(new()).AddTimeout(TimeSpan.FromSeconds(5));
});

// elsewhere, injected ResiliencePipelineProvider<string> provider
ResiliencePipeline pipeline = provider.GetPipeline("db-writes");
await pipeline.ExecuteAsync(static async ct => await DoWorkAsync(ct), ct);
```

Si además incorporas `Microsoft.Extensions.Resilience`, estos pipelines registrados reciben el mismo tratamiento de telemetría que disfruta el handler HTTP, así que un pipeline que no es HTTP aún puede emitir métricas y trazas. Eso es lo más cercano que consigues a "la experiencia del handler" para código que no es HTTP, y es la herramienta correcta cuando quieres resiliencia alrededor de tu capa de datos o de mensajería en lugar de tu HTTP saliente.

## ¿Es uno más rápido que el otro?

No, y la pregunta revela el malentendido. Como el resilience handler ejecuta un `ResiliencePipeline` de Polly por debajo, la sobrecarga por llamada de "el handler" y de "Polly en bruto" es el mismo motor ejecutando las mismas estrategias. No hay un impuesto de Polly que evites al construir un pipeline a mano, ni un impuesto del handler que pagues por la conveniencia. Polly v8 fue reescrito específicamente para recortar asignaciones frente a v7, y ambos puntos de entrada se apoyan en esa reescritura.

Lo que difiere no es el throughput sino lo que obtienes alrededor de la ejecución: el handler añade telemetría, enlace de configuración y las garantías de tiempo de vida de `IHttpClientFactory` gratis, mientras que un pipeline en bruto te los da solo si los cableas. Si quieres un número real para tu propia carga de trabajo, ejecuta BenchmarkDotNet contra tu propio delegado con y sin el pipeline; no elijas entre estos dos por motivos de rendimiento, porque el rendimiento no es el eje que los separa.

## El detalle que decide por ti

Unas pocas restricciones duras zanjan la elección antes de que entre la preferencia en juego.

**El handler solo funciona sobre `HttpClient` mediante `IHttpClientFactory`.** Si tu código no pasa por `AddHttpClient` y un cliente inyectado, no hay handler que añadir. Un `HttpClient` singleton estático, un `DbContext`, un productor de Kafka: ninguno de estos puede tomar un resilience handler. Toman un pipeline de Polly o nada. Este único hecho decide la mayoría de los casos reales.

**No apiles resilience handlers.** La guía de Microsoft es explícita: añade exactamente un resilience handler por cliente. Si necesitas una forma distinta, llama primero a `RemoveAllResilienceHandlers()` y luego añade el tuyo personalizado. Apilar un handler estándar y uno personalizado anida dos pipelines completos y produce conteos de reintentos y tiempos de espera que se multiplican de formas que nadie pretende.

**Los reintentos con verbos no idempotentes duplican datos.** El handler estándar reintenta cada método HTTP por defecto. Un `POST` reintentado que ya llegó al servidor puede insertar el mismo registro dos veces. Llama a `options.Retry.DisableForUnsafeHttpMethods()` para omitir los reintentos en `POST`, `PATCH`, `PUT`, `DELETE` y `CONNECT`, o `DisableFor(HttpMethod.Post, ...)` para una lista específica. Este es un asunto de la capa del handler con el que Polly en bruto no puede ayudarte, porque Polly en bruto no sabe qué es un verbo HTTP.

**Polly lanza `TimeoutRejectedException`, no `TimeoutException`.** Si escribes un predicado `ShouldHandle` en un reintento y esperas capturar el fallo de la estrategia de tiempo de espera, recuerda que aflora como la `TimeoutRejectedException` de Polly. Manejar esto mal es una fuente frecuente de una [TaskCanceledException que indica que una tarea fue cancelada](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) que sube donde esperabas un reintento.

## La decisión, en una línea

Para código nuevo en .NET 11 en 2026: si estás añadiendo resiliencia a un `HttpClient` resuelto mediante `IHttpClientFactory`, usa el resilience handler, porque `AddStandardResilienceHandler` es Polly con valores predeterminados que entienden HTTP, telemetría y enlace de configuración en una sola línea, y `AddResilienceHandler` te permite personalizar sin abandonar esa capa. Baja a la API `ResiliencePipeline` de Polly directamente solo cuando la operación no sea una llamada con `HttpClient`: acceso a base de datos, brokers de mensajes, gRPC que invocas a mano o delegados arbitrarios. Nunca estás eligiendo realmente entre dos bibliotecas de resiliencia, porque solo hay una. Estás eligiendo si usar Polly por la puerta con forma de HTTP o por la de propósito general, y el tipo de operación que estás protegiendo elige la puerta por ti.

## Relacionado

- [HttpClient vs. HttpClientFactory vs. Refit: ¿cuál deberías usar en .NET 11?](/es/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [Solución: TaskCanceledException, una tarea fue cancelada en HttpClient](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Cómo cancelar una Task de larga ejecución en C# sin provocar interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Cómo usar OpenTelemetry con .NET 11 y un backend gratuito](/es/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [Cómo hacer pruebas unitarias de código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/)

## Fuentes

- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) - `AddStandardResilienceHandler`, `AddResilienceHandler`, los valores predeterminados del pipeline estándar y la lista de resultados transitorios.
- [Introduction to resilient app development](https://learn.microsoft.com/en-us/dotnet/core/resilience/) - cómo `Microsoft.Extensions.Resilience` se construye sobre Polly y añade telemetría.
- [Polly docs: Resilience pipelines](https://www.pollydocs.org/pipelines/) - `ResiliencePipelineBuilder`, `ExecuteAsync` y el registry.
- [Polly docs: Advanced dependency injection](https://www.pollydocs.org/advanced/dependency-injection/) - `AddResiliencePipeline`, `ResiliencePipelineRegistry` y las recargas dinámicas.
- [Polly v7 to v8 migration guide](https://www.pollydocs.org/migration-v8.html) - por qué la API `Policy` fue reemplazada por `ResiliencePipeline`.
- [Microsoft.Extensions.Http.Resilience on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Http.Resilience) - versión actual del paquete y sus dependencias.
</content>
