---
title: "Cómo usar Channels en lugar de BlockingCollection en C#"
description: "System.Threading.Channels es el reemplazo asíncrono de BlockingCollection en .NET 11. Esta guía muestra cómo migrar, cómo elegir entre acotado y no acotado, y cómo manejar contrapresión, cancelación y apagado controlado sin interbloqueos."
pubDate: 2026-04-25
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
  - "async"
lang: "es"
translationOf: "2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

Si tienes un `BlockingCollection<T>` en una aplicación .NET escrita antes de .NET Core 3.0, el reemplazo moderno es `System.Threading.Channels`. Sustituye `new BlockingCollection<T>(capacity)` por `Channel.CreateBounded<T>(capacity)`, reemplaza `Add` / `Take` por `await WriteAsync` / `await ReadAsync`, y llama a `channel.Writer.Complete()` en lugar de `CompleteAdding()`. Los consumidores iteran con `await foreach (var item in channel.Reader.ReadAllAsync(ct))` en vez de `foreach (var item in collection.GetConsumingEnumerable(ct))`. Todo sigue siendo seguro entre hilos, ningún hilo queda bloqueado esperando elementos, y la contrapresión funciona a través de `await` en lugar de estacionar un hilo de trabajo.

Esta guía apunta a .NET 11 (preview 3) y C# 14, pero `System.Threading.Channels` ha sido una API estable e integrada desde .NET Core 3.0 y está disponible en .NET Standard 2.0 mediante el [paquete NuGet `System.Threading.Channels`](https://www.nuget.org/packages/System.Threading.Channels). Nada de lo que aquí se describe es exclusivo de la versión preliminar.

## Por qué BlockingCollection ya no encaja

`BlockingCollection<T>` llegó con .NET Framework 4.0 en 2010. Su diseño asumía un mundo donde un hilo por consumidor era barato y donde async/await no existía. `Take()` estaciona el hilo que lo invoca en una primitiva de sincronización del kernel hasta que haya un elemento disponible; `Add()` hace lo mismo cuando la capacidad acotada está llena. En una aplicación de consola que procesa 10 elementos por segundo, está bien. En un endpoint de ASP.NET Core, un servicio worker, o cualquier código que se ejecute bajo presión del `ThreadPool`, cada consumidor bloqueado consume un hilo que el runtime no puede usar para nada más. Veinte consumidores bloqueados en `Take()` son veinte hilos que el runtime no puede usar, y la heurística de hill-climbing del thread pool responde generando más hilos, que en sí mismos son costosos (alrededor de 1 MB de pila cada uno en Windows por defecto).

`System.Threading.Channels` se añadió en .NET Core 3.0 específicamente para eliminar ese coste. Un consumidor que espera en `ReadAsync` no retiene un hilo en absoluto: la continuación se encola en el thread pool sólo cuando un elemento se escribe realmente. Es el mismo patrón de máquina de estados asíncrona que impulsa `Task` y `ValueTask`, y es la razón por la que un único proceso de ASP.NET Core puede hospedar decenas de miles de consumidores de canal concurrentes sin agotar el thread pool. La [introducción oficial a los canales](https://devblogs.microsoft.com/dotnet/an-introduction-to-system-threading-channels/) en el blog de .NET hace la recomendación explícita: usa canales para cualquier nuevo patrón productor-consumidor que toque I/O, y reserva `BlockingCollection<T>` para escenarios sincrónicos y limitados por CPU donde bloquear un hilo sea genuinamente aceptable.

También hay una diferencia de rendimiento medible. Los benchmarks propios de Microsoft y varias comparaciones independientes (consulta el [análisis de rendimiento productor/consumidor de Michael Shpilt](https://michaelscodingspot.com/performance-of-producer-consumer/)) sitúan a `Channel<T>` en aproximadamente 4 veces el rendimiento de procesamiento de `BlockingCollection<T>` para tamaños de mensaje típicos, porque el canal usa operaciones `Interlocked` libres de bloqueos en la ruta rápida y evita las transiciones al kernel en las que incurre `BlockingCollection`.

## Una reproducción mínima del patrón BlockingCollection

Aquí está la configuración canónica de `BlockingCollection<T>` que sigue la mayoría del código heredado. Usa una capacidad acotada (para que los productores se regulen cuando los consumidores se quedan atrás), un `CancellationToken`, y `CompleteAdding` para permitir que los consumidores salgan limpiamente.

```csharp
// .NET 11, C# 14 -- legacy pattern, do not write new code like this
using System.Collections.Concurrent;

var queue = new BlockingCollection<int>(boundedCapacity: 100);
using var cts = new CancellationTokenSource();

var producer = Task.Run(() =>
{
    for (int i = 0; i < 10_000; i++)
        queue.Add(i, cts.Token);

    queue.CompleteAdding();
});

var consumer = Task.Run(() =>
{
    foreach (int item in queue.GetConsumingEnumerable(cts.Token))
        Process(item);
});

await Task.WhenAll(producer, consumer);

static void Process(int item) { /* work */ }
```

Dos hilos quedan dedicados durante toda la vida de este pipeline. Si `Process` hace I/O, el hilo del consumidor permanece inactivo durante cada espera equivalente a `await` y el canal puede hacerlo mejor. Si escalas a cuatro productores y ocho consumidores, eso son doce hilos consumidos.

## El equivalente con Channels

Aquí está el mismo pipeline usando `System.Threading.Channels`. La forma del código es similar; la diferencia es que ningún hilo queda bloqueado.

```csharp
// .NET 11, C# 14 -- modern replacement
using System.Threading.Channels;

var channel = Channel.CreateBounded<int>(new BoundedChannelOptions(100)
{
    FullMode = BoundedChannelFullMode.Wait,
    SingleReader = false,
    SingleWriter = false
});

using var cts = new CancellationTokenSource();

var producer = Task.Run(async () =>
{
    for (int i = 0; i < 10_000; i++)
        await channel.Writer.WriteAsync(i, cts.Token);

    channel.Writer.Complete();
});

var consumer = Task.Run(async () =>
{
    await foreach (int item in channel.Reader.ReadAllAsync(cts.Token))
        await ProcessAsync(item);
});

await Task.WhenAll(producer, consumer);

static ValueTask ProcessAsync(int item) => ValueTask.CompletedTask;
```

Vale la pena señalar tres diferencias directamente. `WriteAsync` devuelve un `ValueTask` en lugar de bloquear cuando el búfer está lleno: la continuación del productor se reanuda sólo cuando hay espacio. `ReadAllAsync` devuelve un `IAsyncEnumerable<T>` que se completa cuando se llama a `Writer.Complete()`, reflejando exactamente el comportamiento de `GetConsumingEnumerable` después de `CompleteAdding`. Y `Channel.CreateBounded` requiere que declares `FullMode` explícitamente, lo que obliga a tomar una decisión que `BlockingCollection` tomaba silenciosamente por ti (siempre bloqueaba).

## Acotado vs no acotado: elige deliberadamente

`Channel.CreateBounded(capacity)` tiene un límite superior estricto sobre los elementos en búfer y aplica contrapresión a los productores cuando el búfer está lleno. `Channel.CreateUnbounded()` no tiene límite superior, por lo que las escrituras se completan sincrónicamente y nunca esperan. Los canales no acotados son tentadores porque parecen más rápidos en un microbenchmark, pero son una fuga de memoria a la espera de ocurrir: si tu consumidor se queda atrás aunque sea unos segundos en un pipeline de alto rendimiento, el canal felizmente acumulará gigabytes de elementos de trabajo antes de que alguien lo note. Usa `CreateBounded` por defecto. Recurre a `CreateUnbounded` sólo cuando puedas demostrar que el consumidor es más rápido que el productor, o cuando la tasa del productor esté intrínsecamente limitada por algo más (por ejemplo, un receptor de webhooks cuyo rendimiento esté acotado por el remitente).

`BoundedChannelFullMode` controla qué sucede cuando un canal acotado está lleno y un productor llama a `WriteAsync`. Las cuatro opciones son:

- `Wait` (por defecto): el `ValueTask` del productor no se completa hasta que haya espacio disponible. Es el equivalente directo del comportamiento bloqueante de `BlockingCollection.Add` y es el valor por defecto correcto.
- `DropOldest`: el elemento más antiguo del búfer se elimina para hacer espacio. Úsalo para telemetría donde los datos obsoletos son peores que los datos faltantes.
- `DropNewest`: el elemento más nuevo ya en el búfer se elimina. Rara vez es útil.
- `DropWrite`: el nuevo elemento se descarta silenciosamente. Úsalo para registros fire-and-forget donde descartar la nueva escritura es más barato que aplicar contrapresión al productor.

Si eliges `DropOldest` / `DropNewest` / `DropWrite`, `WriteAsync` siempre se completa sincrónicamente, por lo que el productor nunca se regula. Mezclar estos modos con la expectativa de "quiero contrapresión" es una fuente común de errores. `Wait` es el único modo que aplica contrapresión real.

## Migrar un pipeline BlockingCollection existente

La mayoría del código BlockingCollection se mapea mecánicamente. La tabla de traducción:

- `new BlockingCollection<T>(capacity)` -> `Channel.CreateBounded<T>(new BoundedChannelOptions(capacity) { FullMode = BoundedChannelFullMode.Wait })`
- `new BlockingCollection<T>()` (no acotado) -> `Channel.CreateUnbounded<T>()`
- `collection.Add(item, token)` -> `await channel.Writer.WriteAsync(item, token)`
- `collection.TryAdd(item)` -> `channel.Writer.TryWrite(item)` (devuelve `bool`, nunca bloquea)
- `collection.Take(token)` -> `await channel.Reader.ReadAsync(token)`
- `collection.TryTake(out var item)` -> `channel.Reader.TryRead(out var item)`
- `collection.GetConsumingEnumerable(token)` -> `channel.Reader.ReadAllAsync(token)` (con `await foreach`)
- `collection.CompleteAdding()` -> `channel.Writer.Complete()` (o `Complete(exception)` para señalar un fallo)
- `collection.IsCompleted` -> `channel.Reader.Completion.IsCompleted`
- `BlockingCollection.AddToAny / TakeFromAny` -> sin equivalente directo, ver "problemas comunes" más abajo

Los `TryWrite` y `TryRead` no bloqueantes son críticos para un escenario específico: rutas de código sincrónicas que no deben introducir un `await`. Devuelven `false` en lugar de esperar, y puedes consultar repetidamente o recurrir a una ruta de código diferente. La mayoría del código no los necesita; prefiere las formas asíncronas.

Si tus productores se ejecutan en el thread pool y tu canal está caliente, podrías querer establecer `SingleWriter = true` (o `SingleReader = true`). Los canales usan una implementación interna distinta y más rápida cuando saben que hay exactamente un productor o consumidor. La verificación es sólo oportunista: el runtime no la fuerza, así que establece esta marca honestamente. Si estableces `SingleWriter = true` y luego accidentalmente tienes dos productores, `WriteAsync` se comportará mal de formas sutiles (elementos perdidos, finalización rota).

## Contrapresión, cancelación y apagado controlado

La contrapresión funciona a través del `ValueTask` de `WriteAsync`. Cuando el búfer está lleno, la tarea del productor está incompleta hasta que el consumidor lee un elemento, momento en el cual se libera un único escritor en espera. Es la misma forma que un semáforo, pero con la semántica ligada al estado del búfer en lugar de a un contador separado.

La cancelación se propaga del mismo modo que en cualquier API asíncrona. Pasa un `CancellationToken` a `WriteAsync`, `ReadAsync` y `ReadAllAsync`. Cuando el token se dispara, el `ValueTask` en vuelo lanza `OperationCanceledException`. El canal en sí no se cancela mediante el token: otros productores y consumidores que no pasaron ese token continúan normalmente. Si quieres cancelar todo el pipeline, llama a `channel.Writer.Complete()` (o `Complete(exception)`), que indica a todos los lectores actuales y futuros que no vendrán más datos. Consulta [cómo cancelar una Task de larga duración en C# sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) para el patrón más amplio.

El apagado controlado se ve así en un servicio worker:

```csharp
// .NET 11, C# 14
public class ImportWorker : BackgroundService
{
    private readonly Channel<ImportJob> _channel =
        Channel.CreateBounded<ImportJob>(new BoundedChannelOptions(500)
        {
            FullMode = BoundedChannelFullMode.Wait
        });

    public ChannelWriter<ImportJob> Writer => _channel.Writer;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var job in _channel.Reader.ReadAllAsync(stoppingToken))
                await ProcessAsync(job, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // expected on host shutdown
        }
        finally
        {
            _channel.Writer.TryComplete();
        }
    }

    private static ValueTask ProcessAsync(ImportJob job, CancellationToken ct)
        => ValueTask.CompletedTask;
}

public record ImportJob(string Id);
```

Dos notas. `TryComplete` (frente a `Complete`) es idempotente y seguro para llamar desde `finally`. El filtro `OperationCanceledException` sólo traga la cancelación cuando viene realmente de `stoppingToken`: una cancelación disparada por un token diferente sigue propagándose, que es lo que quieres.

Si tus productores pueden fallar, prefiere `channel.Writer.Complete(exception)`. La siguiente llamada del consumidor a `ReadAsync` o `ReadAllAsync` relanzará esa excepción, que es el equivalente en canales a que `BlockingCollection.GetConsumingEnumerable` relance después de que se haya llamado a `CompleteAdding` tras un fallo.

## Problemas comunes con los que te toparás

`Channel.Writer.WriteAsync` devuelve `ValueTask`, no `Task`. Si almacenas el resultado y lo esperas más de una vez, provocas un comportamiento indefinido: `ValueTask` está documentado como de espera única. El 99% de los casos es `await channel.Writer.WriteAsync(item)` en línea; esto sólo es una preocupación si empiezas a pasar el valor de retorno por ahí.

`Reader.Completion` es una `Task` que se completa cuando se llama a `Writer.Complete` y se han drenado todos los elementos. Si quieres saber cuándo el canal está completamente vacío y cerrado, espera `Reader.Completion`. No verifiques `Reader.Count == 0`, que existe pero compite con escrituras en vuelo.

`ChannelReader<T>.WaitToReadAsync` devuelve `false` sólo cuando el canal está completado y vacío. Es la primitiva correcta para bucles de consumidor escritos a mano donde `await foreach` no encaja, por ejemplo porque quieres procesar lecturas en lotes:

```csharp
// .NET 11, C# 14 -- batched consumer
while (await channel.Reader.WaitToReadAsync(ct))
{
    var batch = new List<int>(capacity: 100);
    while (batch.Count < 100 && channel.Reader.TryRead(out int item))
        batch.Add(item);

    if (batch.Count > 0)
        await ProcessBatchAsync(batch, ct);
}

static ValueTask ProcessBatchAsync(IReadOnlyList<int> items, CancellationToken ct)
    => ValueTask.CompletedTask;
```

`BlockingCollection` tenía `AddToAny` y `TakeFromAny` que operaban a través de múltiples colecciones. Los canales no tienen equivalente directo. Si realmente necesitas fan-in entre N canales, el patrón idiomático es generar una tarea consumidora por canal de origen que todas escriban en un único canal aguas abajo; esto se compone limpiamente con el modelo de cancelación y se mantiene amigable con async. Si realmente necesitas fan-out (un productor alimentando N consumidores), genera N tareas lectoras contra el mismo `Reader`: los canales son seguros para múltiples lectores siempre que no establezcas `SingleReader = true`.

`System.Threading.Channels` no es un canal de serialización como el `chan` de Go ni una primitiva de mensajería distribuida. Es sólo en proceso. Si necesitas mensajería entre procesos o entre máquinas, usa un broker de mensajes real (Azure Service Bus, RabbitMQ, Kafka). Los canales son la herramienta correcta dentro de un único proceso; son la herramienta incorrecta en el momento en que hay una red de por medio.

## Cuándo BlockingCollection todavía es defendible

Hay un caso estrecho en el que mantener `BlockingCollection<T>` es razonable: un grupo de workers sincrónicos limitados por CPU dentro de una aplicación de consola o trabajo por lotes, donde controlas la cantidad de hilos y no te preocupa la presión sobre el thread pool porque no hay presión de thread pool de la que preocuparse. La [descripción general de Channels en Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels) es explícita en este punto. En todos los demás lugares (ASP.NET Core, servicios worker, cualquier código que toque I/O, cualquier código compartido con consumidores conscientes de async), prefiere `System.Threading.Channels`.

## Relacionado

- [Cómo cancelar una Task de larga duración en C# sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Cómo usar IAsyncEnumerable&lt;T&gt; con EF Core 11](/es/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [Cómo leer un CSV grande en .NET 11 sin quedarte sin memoria](/es/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [Cómo transmitir un archivo desde un endpoint de ASP.NET Core sin almacenarlo en búfer](/es/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

## Fuentes

- [An Introduction to System.Threading.Channels (Microsoft .NET Blog)](https://devblogs.microsoft.com/dotnet/an-introduction-to-system-threading-channels/)
- [Channels overview (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels)
- [BoundedChannelOptions class reference](https://learn.microsoft.com/en-us/dotnet/api/system.threading.channels.boundedchanneloptions)
- [Performance Showdown of Producer/Consumer Implementations in .NET (Michael Shpilt)](https://michaelscodingspot.com/performance-of-producer-consumer/)
- [System.Threading.Channels source on GitHub](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Threading.Channels)
