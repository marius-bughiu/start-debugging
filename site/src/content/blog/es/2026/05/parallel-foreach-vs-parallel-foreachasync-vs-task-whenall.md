---
title: "Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll en C#"
description: "Usa Parallel.ForEach para trabajo intensivo de CPU sobre datos en memoria, Parallel.ForEachAsync para E/S asíncrona sobre muchos elementos con un límite de concurrencia, y Task.WhenAll para un fan-out fijo y pequeño donde quieres todas las operaciones en vuelo y necesitas los resultados."
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
lang: "es"
translationOf: "2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall"
translatedBy: "claude"
translationDate: 2026-05-25
---

Usa `Parallel.ForEach` cuando el trabajo es intensivo de CPU y los datos ya están en memoria: hashear 100 000 archivos, transformar un arreglo grande, cualquier cosa que sature los núcleos. Usa `Parallel.ForEachAsync` cuando cada elemento dispara E/S asíncrona (una llamada HTTP, una consulta a base de datos) y quieres un número acotado de esas operaciones en vuelo a la vez. Usa `Task.WhenAll` cuando tienes un conjunto pequeño y fijo de operaciones asíncronas que quieres iniciar todas a la vez y de las que necesitas recolectar resultados. El único error que decide por ti: nunca hagas E/S asíncrona dentro de `Parallel.ForEach`, porque bloquear con `.Result` o `.Wait()` dentro de su cuerpo síncrono mata de hambre al grupo de hilos.

Este artículo apunta a .NET 11 y C# 14. `Parallel.ForEach` existe desde .NET Framework 4.0 (2010); `Task.WhenAll` desde .NET Framework 4.5; y `Parallel.ForEachAsync` es el recién llegado, agregado en .NET 6 (2021). El comportamiento que se describe aquí es estable desde .NET 6 hasta .NET 11.

## Estos tres resuelven problemas distintos

La comparación es incómoda porque los tres no son APIs intercambiables con distinto rendimiento. Son respuestas a tres preguntas diferentes.

`Parallel.ForEach` pregunta: "Tengo una colección y una operación síncrona, intensiva de CPU, por elemento. Repártela entre los núcleos." Su cuerpo es un `Action<T>`. Particiona la fuente, ejecuta el cuerpo en varios hilos del grupo de hilos, y bloquea el hilo llamador hasta que cada elemento termina. Es el caballo de batalla de paralelismo de datos de la Task Parallel Library.

`Parallel.ForEachAsync` pregunta: "Tengo una colección y una operación asíncrona por elemento. Ejecútalas de forma concurrente, pero limita cuántas corren a la vez." Su cuerpo es un `Func<TSource, CancellationToken, ValueTask>`. Devuelve una `Task` que esperas; no bloquea. Lo crucial: limita. Por defecto ejecuta como máximo `Environment.ProcessorCount` operaciones en paralelo, y puedes fijarlo explícitamente con `ParallelOptions.MaxDegreeOfParallelism`.

`Task.WhenAll` pregunta: "Ya tengo un montón de tareas. Avísame cuando todas terminen." No inicia nada, no limita nada, y no itera una fuente. Tú creas las tareas (lo que las inicia), entregas la colección a `WhenAll`, y esperas la única tarea que devuelve. Si inicias 5 000 tareas, las 5 000 están en vuelo en el momento en que esperas.

Así que la decisión real es sobre la forma de tu trabajo, no sobre la velocidad bruta: intensivo de CPU sobre datos (`Parallel.ForEach`), E/S asíncrona sobre muchos elementos con un techo (`Parallel.ForEachAsync`), o un puñado conocido de operaciones asíncronas que quieres todas a la vez y cuyos resultados necesitas (`Task.WhenAll`).

## La matriz de decisión

El comportamiento siguiente es para .NET 6+ salvo que se indique; `Parallel.ForEachAsync` no existe antes de .NET 6.

| Capacidad                           | `Parallel.ForEach`            | `Parallel.ForEachAsync`                       | `Task.WhenAll`                       |
| ----------------------------------- | ----------------------------- | --------------------------------------------- | ------------------------------------ |
| Mejor para                          | trabajo intensivo de CPU      | E/S asíncrona por elemento                    | un conjunto fijo de operaciones async|
| Delegado del cuerpo                 | `Action<T>` (síncrono)        | `Func<T, CancellationToken, ValueTask>`       | tú creas las tareas                  |
| Bloquea el hilo llamador            | sí                            | no (devuelve `Task`)                           | no (devuelve `Task`)                 |
| Límite de concurrencia incorporado  | sí (`MaxDegreeOfParallelism`) | sí (`MaxDegreeOfParallelism`)                 | no -- todas las tareas a la vez      |
| Grado de paralelismo por defecto    | gestionado por el planificador (`-1`) | `Environment.ProcessorCount`          | sin límite                           |
| Devuelve resultados                 | no                            | no (devuelve `Task`, no `Task<T[]>`)          | sí (`Task<TResult[]>`, ordenados)    |
| Acepta `IAsyncEnumerable<T>`        | no                            | sí                                            | n/a                                  |
| Cancelación                         | `ParallelOptions`             | `ParallelOptions` + token pasado al cuerpo    | cancela tú las tareas subyacentes    |
| Ante la primera excepción           | deja de lanzar iteraciones    | cancela el token, deja de programar elementos | deja correr cada tarea hasta el final|
| Superficie de excepciones           | `AggregateException`          | `AggregateException` (await desenvuelve a la primera) | `AggregateException` (await desenvuelve) |
| Primera versión                     | .NET Framework 4.0            | .NET 6                                         | .NET Framework 4.5                   |

Las filas que deciden la mayoría de los casos reales son "delegado del cuerpo" y "límite de concurrencia incorporado". Si tu trabajo por elemento es `async`, `Parallel.ForEach` ya está mal. Si necesitas limitar la concurrencia, `Task.WhenAll` ya está mal.

## Cuándo elegir Parallel.ForEach

Recurre a `Parallel.ForEach` cuando el trabajo por elemento es síncrono e intensivo de CPU, y la colección ya está materializada en memoria.

- **Transformar un arreglo o lista grande en memoria.** Redimensionar 50 000 imágenes, calcular checksums, parsear filas. El trabajo mantiene un núcleo ocupado, y particionar la fuente entre núcleos es exactamente para lo que `Parallel.ForEach` está hecho. Fija `MaxDegreeOfParallelism` si quieres dejar margen para otro trabajo.
- **Cálculo numérico vergonzosamente paralelo.** Una simulación de Monte Carlo, un filtro por píxel, un lote de operaciones matriciales independientes. Sin estado compartido, sin E/S, solo CPU.
- **Quieres que el hilo llamador espere.** `Parallel.ForEach` es síncrono por diseño. En una herramienta de consola o un trabajo en segundo plano donde bloquear está bien, esa simplicidad es una ventaja.

```csharp
// .NET 11, C# 14 -- CPU-bound work over an in-memory array.
// Parallel.ForEach partitions across cores and blocks until done.
var files = Directory.GetFiles(@"C:\data", "*.bin");
var hashes = new ConcurrentDictionary<string, string>();

Parallel.ForEach(
    files,
    new ParallelOptions { MaxDegreeOfParallelism = Environment.ProcessorCount },
    file =>
    {
        using var stream = File.OpenRead(file);
        byte[] hash = SHA256.HashData(stream);   // CPU + sync I/O, no await
        hashes[file] = Convert.ToHexString(hash);
    });
```

La regla dura: si el cuerpo quiere `await` de algo, no recurras a `Parallel.ForEach`. La gente sortea el `Action<T>` síncrono escribiendo `SomeAsyncCall().Result` o `.GetAwaiter().GetResult()` dentro del cuerpo. Eso bloquea un hilo del grupo de hilos durante toda la duración de la E/S, y como `Parallel.ForEach` ya está consumiendo hilos del grupo para ejecutar iteraciones, puedes provocar un interbloqueo o matar de hambre al grupo bajo carga. Ese antipatrón es la razón más común por la que `Parallel.ForEachAsync` existe.

## Cuándo elegir Parallel.ForEachAsync

`Parallel.ForEachAsync` es la respuesta a "tengo muchos elementos y cada uno llama a algo asíncrono, y no quiero abrir diez mil conexiones a la vez".

- **Llamar a una API HTTP por cada uno de muchos elementos.** Enriquecer 8 000 registros desde un endpoint REST, donde disparar las 8 000 solicitudes simultáneamente te limitaría la tasa o agotaría los sockets. Fija `MaxDegreeOfParallelism = 20` y mantiene 20 solicitudes en vuelo, iniciando la siguiente a medida que cada una termina.
- **Trabajo por elemento contra base de datos o cola con un techo.** Un pool de conexiones tiene un tamaño finito. `Parallel.ForEachAsync` te permite ajustar el grado de paralelismo al pool para no bloquearte esperando conexiones.
- **Una fuente en streaming.** Acepta `IAsyncEnumerable<T>`, así que puedes procesar elementos a medida que llegan desde una API paginada o un canal sin bufferizar la secuencia completa primero.

```csharp
// .NET 11, C# 14 -- async I/O per item, capped at 20 concurrent calls.
var ids = await db.Products.Select(p => p.Id).ToListAsync(ct);
var client = httpClientFactory.CreateClient("pricing");

await Parallel.ForEachAsync(
    ids,
    new ParallelOptions
    {
        MaxDegreeOfParallelism = 20,
        CancellationToken = ct
    },
    async (id, token) =>
    {
        var price = await client.GetFromJsonAsync<Price>($"/price/{id}", token);
        await SavePriceAsync(id, price, token);   // never blocks a pool thread
    });
```

Dos detalles que importan. Primero, el cuerpo recibe un `CancellationToken` como segundo parámetro: pásalo a cada llamada asíncrona dentro, no el `ct` externo, porque `Parallel.ForEachAsync` cancela ese token interno cuando una iteración falla para que el resto pueda abortar pronto. Segundo, el `MaxDegreeOfParallelism` por defecto es `Environment.ProcessorCount`, que está afinado para trabajo de CPU, no de E/S. Para llamadas con E/S casi siempre quieres fijarlo más alto que el conteo de núcleos, porque los hilos están la mayor parte del tiempo esperando la red, no calculando. Si necesitas un control más fino que un solo límite entero, una [compuerta basada en SemaphoreSlim](/es/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) combinada con `Task.WhenAll` te da el mismo límite con más margen para variar el tope por llamada.

## Cuándo elegir Task.WhenAll

`Task.WhenAll` es para un conjunto conocido, normalmente pequeño, de operaciones asíncronas que quieres ejecutar de forma concurrente y cuyos resultados necesitas de vuelta.

- **Un fan-out fijo.** Cargar el perfil de un usuario, sus pedidos y sus notificaciones en paralelo: tres awaits independientes que deberían solaparse. Inicia los tres, `await Task.WhenAll`, listo. Este es el uso de todos los días y es el correcto.
- **Necesitas los resultados, en orden.** La sobrecarga genérica devuelve `Task<TResult[]>`, y el arreglo preserva el orden de entrada sin importar el orden de finalización. `Parallel.ForEachAsync` devuelve una `Task` simple sin resultados, así que si necesitas un resultado por elemento, `WhenAll` (o recolectar en una estructura segura para hilos) es el camino.
- **El conteo es acotado y pequeño.** Una docena de llamadas, no diez mil. Como `WhenAll` no hace ningún límite, el número de operaciones concurrentes es igual al número de tareas que iniciaste.

```csharp
// .NET 11, C# 14 -- a small, fixed fan-out; results returned in order.
Task<Profile> profile = LoadProfileAsync(userId, ct);
Task<Order[]> orders = LoadOrdersAsync(userId, ct);
Task<Alert[]> alerts = LoadAlertsAsync(userId, ct);

await Task.WhenAll(profile, orders, alerts);

// Each task is complete here; .Result no longer blocks.
var dashboard = new Dashboard(profile.Result, orders.Result, alerts.Result);
```

La trampa con `Task.WhenAll` es usarlo para una lista no acotada. `Task.WhenAll(ids.Select(id => CallApiAsync(id)))` sobre 10 000 ids inicia las 10 000 llamadas en el instante en que se enumera el LINQ, porque `Select` materializa las tareas y cada tarea se inicia al crearse. Eso es un ataque de denegación de servicio contra tu propio servicio aguas abajo. En el momento en que la lista es grande o no acotada, quieres `Parallel.ForEachAsync` (o una compuerta `SemaphoreSlim`) en su lugar.

## El benchmark: 500 llamadas de E/S simuladas

La velocidad bruta es un eje engañoso aquí, porque la opción más rápida suele ser la más peligrosa. La comparación honesta es velocidad contra concurrencia máxima. Cada "elemento" abajo espera `Task.Delay(20)` para representar una llamada de red de 20 ms, ejecutado sobre 500 elementos.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x, dotnet run -c Release
// Each item simulates a 20 ms I/O call.
[MemoryDiagnoser]
public class FanOutBench
{
    private readonly int[] _items = Enumerable.Range(0, 500).ToArray();
    private static Task IoAsync(CancellationToken ct = default) => Task.Delay(20, ct);

    [Benchmark]
    public Task WhenAll_Unbounded() =>
        Task.WhenAll(_items.Select(_ => IoAsync()));

    [Benchmark]
    public Task ForEachAsync_DefaultDop() =>
        Parallel.ForEachAsync(_items, async (_, ct) => await IoAsync(ct));

    [Benchmark]
    public Task ForEachAsync_Dop50() =>
        Parallel.ForEachAsync(
            _items,
            new ParallelOptions { MaxDegreeOfParallelism = 50 },
            async (_, ct) => await IoAsync(ct));
}
```

Resultados representativos en un Ryzen 7 de 16 núcleos / Windows 11 / .NET 11, con la columna de concurrencia máxima añadida a mano a partir de la configuración:

| Método                     | Media   | Ops concurrentes pico | Notas                              |
| -------------------------- | ------- | --------------------- | ---------------------------------- |
| `WhenAll_Unbounded`        | ~24 ms  | 500                   | la más rápida, pero 500 conexiones abiertas |
| `ForEachAsync_Dop50`       | ~210 ms | 50                    | 10 lotes de 50                     |
| `ForEachAsync_DefaultDop`  | ~640 ms | 16 (`ProcessorCount`) | el tope por defecto es el conteo de CPU, bajo para E/S |

`WhenAll` es aproximadamente 25x más rápido que el `ForEachAsync` por defecto aquí, y eso es justamente el punto: consigue esa velocidad abriendo 500 conexiones a la vez. Si tu sistema aguas abajo lo soporta, genial. Si es una API de terceros con un límite de tasa, la ejecución "lenta" y limitada es la que no te consigue un 429 o un `SocketException`. El `Parallel.ForEachAsync` por defecto es el más lento porque su grado de paralelismo por defecto es `Environment.ProcessorCount`, afinado para trabajo de CPU; para E/S lo subes deliberadamente, como muestra `Dop50`. La conclusión no es "WhenAll gana", es "elige la concurrencia que puedes permitirte, luego escoge la API que la imponga".

## Las trampas que deciden por ti

Algunas restricciones anulan la preferencia por completo.

**Cuerpo asíncrono significa que no es `Parallel.ForEach`.** Su cuerpo es `Action<T>`. No hay sobrecarga asíncrona. Bloquear dentro con `.Result` o `.GetAwaiter().GetResult()` ata un hilo del grupo por iteración e invita a la inanición. Si el trabajo espera con await, estás en `Parallel.ForEachAsync` o `Task.WhenAll`. Mira [async void vs async Task](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) para entender por qué una lambda `async` se convierte silenciosamente en `async void` cuando se asigna a `Action<T>`, lo que traga excepciones y derrota el bucle por completo.

**Lista no acotada significa que no es `Task.WhenAll`.** `WhenAll` no tiene límite. Sobre un número grande o desconocido de elementos inicia todo a la vez. Si no puedes garantizar que el conteo es pequeño, usa `Parallel.ForEachAsync` con un `MaxDegreeOfParallelism`.

**Múltiples fallos se manifiestan de forma distinta.** Los tres recolectan excepciones en una `AggregateException`, pero cómo las observas difiere. `Parallel.ForEach` (síncrono) lanza la `AggregateException` directamente, así que un `catch (AggregateException ae)` ve cada excepción interna. Con `Parallel.ForEachAsync` y `Task.WhenAll` haces `await`, y `await` desenvuelve solo a la *primera* excepción; para verlas todas, inspecciona la propiedad `.Exception` de la tarea fallida. La diferencia más profunda es el tiempo: `Task.WhenAll` deja correr cada tarea hasta el final incluso después de que una falla, así que obtienes fallos de todas ellas, mientras que `Parallel.ForEachAsync` cancela su token interno ante el primer fallo y deja de programar nuevas iteraciones, así que cortocircuita. Si "intentar todo, reportar todos los fallos" es el requisito, eso apunta a `WhenAll`; si lo es "detenerse en cuanto uno falle", eso apunta a `ForEachAsync`.

**Anterior a .NET 6 significa sin `Parallel.ForEachAsync`.** Si estás atascado en .NET Framework o .NET Core 3.1, la API no existe. El sustituto idiomático es una compuerta `SemaphoreSlim` alrededor de `Task.WhenAll`, o para una forma productor/consumidor, [un Channel en lugar de BlockingCollection](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

Una nota transversal más: cuando cualquiera de estos ejecuta trabajo asíncrono, la cancelación debería fluir. `Parallel.ForEachAsync` le entrega a tu cuerpo un token; `Task.WhenAll` solo cancela si las tareas que creaste honran un token. Cablear eso correctamente es su propio tema, cubierto en [cómo cancelar una Task de larga ejecución sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## La recomendación, repetida

Decide por la forma del trabajo. Intensivo de CPU sobre una colección en memoria: `Parallel.ForEach`, con `MaxDegreeOfParallelism` si quieres dejar núcleos libres. E/S asíncrona sobre muchos elementos donde debes limitar la concurrencia: `Parallel.ForEachAsync`, y recuerda subir `MaxDegreeOfParallelism` por encima del conteo de núcleos para E/S y pasar el token del cuerpo a cada llamada interna. Un fan-out pequeño y fijo donde quieres todo en vuelo y necesitas los resultados: `Task.WhenAll`, pero nunca sobre una lista no acotada. La versión más corta y correcta: CPU y datos es `Parallel.ForEach`; E/S asíncrona a escala es `Parallel.ForEachAsync`; un puñado conocido de awaits es `Task.WhenAll`.

## Relacionados

- [Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/es/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/) cubre las primitivas de más bajo nivel sobre las que se construyen estas APIs de más alto nivel.
- [async void vs async Task en C#: cuándo cada uno es correcto](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) explica la trampa de `async void` que muerde cuando pasas una lambda asíncrona a `Parallel.ForEach`.
- [Cómo cancelar una Task de larga ejecución en C# sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) es la mitad de cancelación de los tres.
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/es/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) muestra la compuerta SemaphoreSlim que limita `Task.WhenAll` cuando necesitas más control del que da `Parallel.ForEachAsync`.
- [Cómo usar Channels en lugar de BlockingCollection en C#](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) es la alternativa productor/consumidor cuando el trabajo es un pipeline, no un fan-out plano.

## Fuentes

- [Referencia del método Parallel.ForEachAsync (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.parallel.foreachasync)
- [Referencia del método Task.WhenAll (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.whenall)
- [Referencia del método Parallel.ForEach (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.parallel.foreach)
- [ParallelOptions.MaxDegreeOfParallelism (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.paralleloptions.maxdegreeofparallelism)
- [Parallel.ForEachAsync and Exceptions (Jeremy Bytes)](https://jeremybytes.blogspot.com/2024/02/parallelforeachasync-and-exceptions.html)
