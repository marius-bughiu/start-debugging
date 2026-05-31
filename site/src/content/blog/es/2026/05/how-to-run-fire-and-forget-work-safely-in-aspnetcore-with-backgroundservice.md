---
title: "Cómo ejecutar trabajo fire-and-forget de forma segura en ASP.NET Core con BackgroundService"
description: "Llamar a Task.Run desde un controlador pierde trabajo al apagar, se traga las excepciones y captura servicios scoped ya desechados. El patrón seguro es una cola Channel acotada que drena un BackgroundService, que abre un scope nuevo por cada elemento de trabajo y termina el trabajo en curso en StopAsync."
pubDate: 2026-05-31
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "backgroundservice"
  - "async"
lang: "es"
translationOf: "2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice"
translatedBy: "claude"
translationDate: 2026-05-31
---

En el momento en que quieres que una solicitud HTTP devuelva de inmediato mientras algún trabajo más lento (enviar un correo, escribir un registro de auditoría, llamar a un webhook) sigue ejecutándose, el movimiento obvio es `_ = Task.Run(() => DoTheWorkAsync())` dentro del controlador. Compila, la respuesta es rápida y en una demo parece funcionar. En producción pierde trabajo en cada despliegue, se traga todas las excepciones y accede a servicios scoped que ya han sido desechados. El reemplazo seguro es una cola `Channel<T>` acotada registrada como singleton, drenada por un único `BackgroundService` que abre un scope de DI nuevo por cada elemento de trabajo, captura y registra las excepciones por elemento, y termina el trabajo en curso durante un apagado controlado. Esta guía está escrita contra .NET 11 (preview 4 en el momento de escribir, disponibilidad general prevista para noviembre de 2026), `Microsoft.Extensions.Hosting` 11.0.0 y `System.Threading.Channels` de la BCL incluida. Los contratos de la cola y de `BackgroundService` han sido estables desde .NET Core 3.1, así que cada patrón aquí se aplica sin cambios a .NET 6, 8 y 10.

## Por qué `Task.Run` en un manejador de solicitud es una trampa

El atractivo de `Task.Run` es que devuelve al instante y el framework nunca se bloquea en él. Ese es exactamente el problema: el framework nunca se bloquea en él, nunca lo rastrea y nunca lo espera.

De ahí se siguen tres fallos concretos:

- **Trabajo perdido al apagar.** Cuando el host se apaga (un despliegue, un scale-in, un pod hermano caído que dispara un reinicio gradual), no sabe que tu `Task` desligada existe. Deja de aceptar solicitudes, espera las solicitudes que conoce y desmonta el proceso. Cualquier trabajo de `Task.Run` aún en curso se mata a mitad de ejecución. En un servicio con mucha carga, cada despliegue descarta silenciosamente un puñado de correos o filas de auditoría.
- **Excepciones tragadas.** Una excepción no observada en una `Task` desligada no hace caer la aplicación y no llega a tu canalización de registro. Aparece, si acaso, en el hilo del finalizador como `TaskScheduler.UnobservedTaskException` mucho después de que la solicitud haya desaparecido. La primera vez que te enteras de que el trabajo está fallando es cuando un cliente pregunta dónde está su correo.
- **Dependencias capturadas y desechadas.** Este es el sutil. Si tu controlador captura un `DbContext` inyectado o cualquier servicio scoped, ese servicio está atado al scope de la solicitud. ASP.NET Core desecha el scope de la solicitud en el instante en que se escribe la respuesta. El cuerpo de tu `Task.Run`, aún en ejecución, ahora toca un `DbContext` desechado y lanza `ObjectDisposedException: Cannot access a disposed context instance`, o peor, compite con el desecho y corrompe el estado.

Hay también una dimensión de carga: un controlador que arranca `Task.Run` en cada solicitud compite por el mismo pool de hilos que sirve tus solicitudes, así que un pico de tráfico se convierte en inanición del pool de hilos. Si quieres el desglose completo de cómo `Task.Run` difiere de las otras primitivas de descarga, la comparación en [Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/es/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/) cubre cuándo es apropiada cada una. Para los manejadores de solicitud, la respuesta es: ninguna directamente.

El fire-and-forget solo es aceptable cuando perder el trabajo en un reinicio es realmente aceptable. El patrón de abajo no hace el trabajo duradero (para eso necesitas una cola externa como Azure Storage Queues o un almacén de trabajos respaldado por base de datos), pero sí arregla los otros tres problemas y le da al trabajo en memoria un drenado limpio al apagar.

## La forma del patrón seguro

La propia [guía de tareas en cola en segundo plano](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) de Microsoft describe la estructura canónica, y tiene tres partes:

1. Una **cola de elementos de trabajo** respaldada por un `Channel<Func<CancellationToken, ValueTask>>` acotado, registrada como singleton para que los productores y el consumidor compartan una única instancia.
2. Un único **consumidor `BackgroundService`** que itera, extrae un elemento de trabajo a la vez, abre un scope de DI, lo ejecuta y captura las excepciones por elemento.
3. **Productores** (controladores, manejadores de minimal API, otros servicios) que inyectan la interfaz de la cola y encolan un delegado en lugar de ejecutarlo en línea.

El manejador de solicitud devuelve en el instante en que se encola el elemento de trabajo. El trabajo en sí se ejecuta en el consumidor, completamente desacoplado de la vida de la solicitud. Construyamos cada pieza.

## Paso 1: definir e implementar la cola acotada

La cola expone dos operaciones: encolar (llamada por los productores) y desencolar (llamada por el consumidor). El elemento de trabajo es un `Func<CancellationToken, ValueTask>` para que el consumidor pueda pasar su propio token de cancelación en el momento de la ejecución.

```csharp
// .NET 11, C# 14 - IBackgroundTaskQueue.cs
public interface IBackgroundTaskQueue
{
    ValueTask QueueBackgroundWorkItemAsync(Func<CancellationToken, ValueTask> workItem);

    ValueTask<Func<CancellationToken, ValueTask>> DequeueAsync(
        CancellationToken cancellationToken);
}
```

La implementación envuelve un channel acotado. Acotar el channel no es opcional en un servicio de producción: una cola no acotada bajo un productor que adelanta al consumidor es una fuga de memoria con pasos extra.

```csharp
// .NET 11, C# 14 - BackgroundTaskQueue.cs
using System.Threading.Channels;

public sealed class BackgroundTaskQueue : IBackgroundTaskQueue
{
    private readonly Channel<Func<CancellationToken, ValueTask>> _queue;

    public BackgroundTaskQueue(int capacity)
    {
        // BoundedChannelFullMode.Wait makes QueueBackgroundWorkItemAsync await
        // a free slot once the queue is full, applying back pressure to producers
        // instead of dropping work or growing without bound.
        var options = new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.Wait
        };
        _queue = Channel.CreateBounded<Func<CancellationToken, ValueTask>>(options);
    }

    public async ValueTask QueueBackgroundWorkItemAsync(
        Func<CancellationToken, ValueTask> workItem)
    {
        ArgumentNullException.ThrowIfNull(workItem);
        await _queue.Writer.WriteAsync(workItem);
    }

    public async ValueTask<Func<CancellationToken, ValueTask>> DequeueAsync(
        CancellationToken cancellationToken)
    {
        var workItem = await _queue.Reader.ReadAsync(cancellationToken);
        return workItem;
    }
}
```

La elección de `BoundedChannelFullMode` es una decisión de diseño real. `Wait` (arriba) aplica back pressure al productor, lo que para un manejador de solicitud significa que la llamada de encolado espera hasta que haya sitio. Si prefieres descartar carga antes que hacer esperar a una solicitud, usa `BoundedChannelFullMode.DropWrite` y comprueba el valor de retorno de `TryWrite`. Sea cual sea la que elijas, hazlo deliberadamente. Si los channels son nuevos para ti, [usar Channels en lugar de BlockingCollection](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) explica el modelo lector/escritor y por qué `Channel<T>` es la primitiva productor-consumidor asíncrona correcta en .NET moderno.

## Paso 2: el BackgroundService que drena la cola

El consumidor es un único `BackgroundService`. Su única tarea es extraer un elemento de trabajo a la vez y ejecutarlo dentro de un try/catch para que un solo elemento de trabajo envenenado no pueda matar el bucle.

```csharp
// .NET 11, C# 14 - QueuedHostedService.cs
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

public sealed class QueuedHostedService(
    IBackgroundTaskQueue taskQueue,
    ILogger<QueuedHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Queued hosted service is running.");
        await BackgroundProcessing(stoppingToken);
    }

    private async Task BackgroundProcessing(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var workItem = await taskQueue.DequeueAsync(stoppingToken);

            try
            {
                await workItem(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                // Expected during shutdown; let the loop unwind.
                break;
            }
            catch (Exception ex)
            {
                // The whole point: one failing item is logged, not lost, and the
                // loop survives to process the next item.
                logger.LogError(ex, "Error occurred executing background work item.");
            }
        }
    }

    public override async Task StopAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Queued hosted service is stopping.");
        await base.StopAsync(stoppingToken);
    }
}
```

El try/catch por elemento es la diferencia entre esto y `Task.Run`. Con `Task.Run`, una excepción queda sin observar. Aquí, cada fallo aterriza en `ILogger` con una traza de pila, y el consumidor sigue drenando. Esta es también la razón por la que el elemento de trabajo es un `Func` que devuelve `ValueTask` en lugar de un delegado `async void`: un cuerpo `async void` lanza al vacío y vuelves a las excepciones tragadas. Si la distinción entre `async void` y `async Task` es difusa, [async void vs async Task en C#](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) expone exactamente por qué `async void` queda reservado para manejadores de eventos y nada más.

## Paso 3: registrar todo

La cola es un singleton (una única instancia compartida), el consumidor es un servicio alojado y tú eliges una capacidad. La capacidad debería reflejar cuánto trabajo estás dispuesto a mantener en memoria a la vez.

```csharp
// .NET 11, C# 14 - Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHostedService<QueuedHostedService>();
builder.Services.AddSingleton<IBackgroundTaskQueue>(_ =>
{
    // Tune to your workload. 100 means at most 100 queued items before
    // producers start waiting (with BoundedChannelFullMode.Wait).
    const int queueCapacity = 100;
    return new BackgroundTaskQueue(queueCapacity);
});

builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();
```

## Paso 4: encolar desde un manejador de solicitud, con un scope por elemento de trabajo

Ahora el productor. Un controlador inyecta `IBackgroundTaskQueue` y encola un delegado. El detalle crítico: el delegado **no** debe capturar ningún servicio scoped de la solicitud. El scope de la solicitud ha desaparecido para cuando el trabajo se ejecuta. En su lugar, captura solo datos planos (un id de pedido, una cadena), y resuelve los servicios scoped desde un scope nuevo dentro del delegado usando `IServiceScopeFactory`.

```csharp
// .NET 11, C# 14 - OrdersController.cs
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

[ApiController]
[Route("orders")]
public sealed class OrdersController(
    IBackgroundTaskQueue queue,
    IServiceScopeFactory scopeFactory) : ControllerBase
{
    [HttpPost("{id:int}/confirm")]
    public async Task<IActionResult> Confirm(int id)
    {
        // Capture only the id - a value type, not a scoped service.
        await queue.QueueBackgroundWorkItemAsync(async token =>
        {
            // Fresh scope per work item: a clean DbContext, resolved and disposed here.
            await using var scope = scopeFactory.CreateAsyncScope();
            var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();
            await processor.ConfirmAsync(id, token);
        });

        // Returns immediately; the confirmation runs on the consumer.
        return Accepted();
    }
}
```

`HTTP 202 Accepted` es el código de estado honesto aquí: has aceptado la solicitud para procesarla, no la has completado. Devolver `200 OK` implicaría que el trabajo está hecho, lo cual no es así.

La regla de un scope por elemento de trabajo es la misma disciplina que necesitas en cualquier sitio donde un singleton toca servicios scoped. Abrir un `CreateAsyncScope()` por unidad de trabajo, resolver dentro de él y desecharlo cuando el trabajo termina se cubre en profundidad en [usar servicios scoped dentro de un BackgroundService](/es/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/). La razón por la que `await using` y `CreateAsyncScope()` importan (en lugar del `CreateScope()` síncrono) es que el `DbContext` de EF Core implementa `IAsyncDisposable` y puede lanzar si se desecha de forma síncrona.

Si te saltas el scope y en su lugar capturas el `DbContext` de la solicitud directamente en el delegado, reproduces exactamente el bug de la dependencia desechada del comienzo de este artículo, y con frecuencia [el error de segunda operación en la instancia del contexto](/es/2026/05/fix-second-operation-was-started-on-this-context-instance/) cuando una solicitud posterior reutiliza un contexto que el framework cree que ha liberado. Y si intentas inyectar el servicio scoped directamente en un consumidor singleton para "simplificar" las cosas, te topas con [no se puede consumir un servicio scoped desde un singleton](/es/2026/05/fix-cannot-consume-scoped-service-from-singleton/) al arrancar.

## Apagado controlado: drenar frente a abandonar

Aquí es donde el patrón se gana su valor sobre `Task.Run`. `BackgroundService` participa en la secuencia de apagado del host. Cuando el host se detiene, señala `stoppingToken`, y el host espera hasta el tiempo límite de apagado (30 segundos por defecto) a que `StopAsync` devuelva.

Vale la pena ser deliberado con dos comportamientos:

**Dejar de aceptar, terminar el elemento actual.** Con el bucle de arriba, `DequeueAsync(stoppingToken)` lanza `OperationCanceledException` una vez que el token se dispara, el bucle se rompe, y cualquier elemento de trabajo que se esté ejecutando en ese momento termina (porque hacemos `await workItem(stoppingToken)` antes de volver a iterar). Los elementos que aún están en el channel se abandonan. Para el fire-and-forget en memoria, ese es el compromiso aceptado.

**Dar suficiente tiempo al trabajo en curso.** Si tus elementos de trabajo pueden ejecutarse durante más de un par de segundos, sube el tiempo límite de apagado para que el host no mate un elemento a medio terminar:

```csharp
// .NET 11, C# 14 - Program.cs
builder.Services.Configure<HostOptions>(options =>
{
    options.ShutdownTimeout = TimeSpan.FromSeconds(60);
});
```

Un productor que necesita que el trabajo esté ligado a la vida de la aplicación en lugar de a una solicitud puede tomar `IHostApplicationLifetime` y encolar contra `ApplicationStopping`, pero para el trabajo originado por una solicitud el `stoppingToken` del consumidor es la señal correcta. Hagas lo que hagas, propaga el token de principio a fin de tu elemento de trabajo. Un elemento de trabajo que ignora el token y se bloquea retendrá todo el apagado como rehén durante el tiempo límite completo. Para el trabajo que genuinamente no puede cancelarse de forma cooperativa, [cancelar una Task de larga ejecución sin deadlock](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) cubre las opciones.

## Procesar elementos en paralelo sin compartir un scope

El bucle de consumidor único procesa un elemento a la vez. Si tus elementos de trabajo son independientes y quieres rendimiento de procesamiento, puedes ejecutar varios de forma concurrente, pero cada elemento concurrente debe obtener su propio scope, porque un `DbContext` y un scope de DI no son seguros para hilos. Acota la concurrencia con un `SemaphoreSlim` para que una ráfaga de encolados no pueda saturar el pool de hilos:

```csharp
// .NET 11, C# 14 - inside BackgroundProcessing
private readonly SemaphoreSlim _concurrency = new(initialCount: 4);

private async Task BackgroundProcessing(CancellationToken stoppingToken)
{
    while (!stoppingToken.IsCancellationRequested)
    {
        var workItem = await taskQueue.DequeueAsync(stoppingToken);
        await _concurrency.WaitAsync(stoppingToken);

        // Fire each item on its own task; the semaphore caps concurrency at 4.
        _ = Task.Run(async () =>
        {
            try
            {
                await workItem(stoppingToken);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error executing background work item.");
            }
            finally
            {
                _concurrency.Release();
            }
        }, stoppingToken);
    }
}
```

Fíjate en que el `Task.Run` de aquí es aceptable de una forma en que no lo era en el controlador: está dentro de un `BackgroundService` rastreado, cada excepción se captura y se registra, la concurrencia está acotada, y cada elemento de trabajo ya crea su propio scope internamente. Lo que hacía peligroso a `Task.Run` en un manejador de solicitud (sin rastreo, sin manejo de excepciones, scope de solicitud capturado) está ausente aquí. El compromiso es que el procesamiento en paralelo complica la historia del apagado, porque los bucle ya no espera las tareas en curso. Si necesitas tanto paralelismo como un drenado limpio, rastrea las tareas pendientes en una `List<Task>` y haz `await Task.WhenAll` sobre ellas en `StopAsync`.

## Cuándo una cola Channel no es suficiente

Este patrón mantiene todo en la memoria del proceso. Esa es su fortaleza (cero infraestructura externa) y su límite. Recurre a algo más pesado cuando:

- **El trabajo debe sobrevivir a un reinicio.** Si perder el trabajo encolado en un despliegue es inaceptable, necesitas una durabilidad que el channel no puede darte. Persiste el trabajo en una tabla de base de datos o empújalo a Azure Storage Queues / Amazon SQS, y haz que el `BackgroundService` (o un proceso de trabajo separado) lo extraiga de allí. La forma de encolar/consumir se mantiene idéntica; solo cambia el almacén de respaldo.
- **Ejecutas múltiples instancias y necesitas exactamente una vez.** Una cola en memoria es por instancia. Tres pods significan tres colas independientes. Una cola duradera compartida con un lease de tiempo de visibilidad es la manera de coordinar.
- **Necesitas reintentos, programación o paneles.** En ese punto una biblioteca como Hangfire o una plataforma de trabajos alojada se gana su complejidad. No reconstruyas un programador de trabajos sobre un channel.

Para los trabajadores de larga vida que mantienes en producción, empareja la cola con observabilidad para que un consumidor atascado o que falla silenciosamente salga a la luz antes de que los usuarios lo noten; el enfoque de [monitorizar trabajos en segundo plano sin Hangfire](/es/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) se aplica directamente a este consumidor.

El modelo mental que mantiene todo esto correcto: la tarea del manejador de solicitud es *aceptar* trabajo y devolver, el consumidor singleton *posee el bucle y la cancelación*, y cada elemento de trabajo *posee un scope nuevo para su propio estado*. En el instante en que colapsas esas responsabilidades (ejecutando el trabajo en línea, capturando el scope de la solicitud, o desligando una `Task` no rastreada), uno de los tres fallos del comienzo de este artículo vuelve.

## Fuentes

- Microsoft Learn, [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) (actualizado 2026-05-05), el patrón canónico de tareas en cola en segundo plano sobre el que se construye este post.
- Microsoft Learn, [System.Threading.Channels](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels) para `BoundedChannelOptions` y `BoundedChannelFullMode`.
- Microsoft Learn, [`HostOptions.ShutdownTimeout`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.shutdowntimeout) para ajustar la ventana de apagado controlado.
- Microsoft Learn, [`AsyncServiceScope` y `CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope) para el desecho de scope por elemento de trabajo.
