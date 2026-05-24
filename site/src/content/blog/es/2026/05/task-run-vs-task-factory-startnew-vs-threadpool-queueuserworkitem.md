---
title: "Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem"
description: "Tres formas de enviar trabajo al thread pool en C# y cuál elegir. Usa Task.Run para casi todo, ThreadPool.QueueUserWorkItem<TState> para fire-and-forget sin asignaciones, y Task.Factory.StartNew solo para LongRunning o un planificador personalizado."
pubDate: 2026-05-24
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
lang: "es"
translationOf: "2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem"
translatedBy: "claude"
translationDate: 2026-05-24
---

Para casi todo el trabajo en segundo plano en C# moderno, usa `Task.Run`. Descarga el trabajo al thread pool, te da una `Task` que puedes esperar, propaga las excepciones y desempaqueta las lambdas asíncronas por ti. Recurre a `ThreadPool.QueueUserWorkItem<TState>` solo cuando quieras un verdadero fire-and-forget con cero asignación de `Task` y no te importe la finalización ni las excepciones. Reserva `Task.Factory.StartNew` para los dos casos que `Task.Run` no puede expresar: `TaskCreationOptions.LongRunning` (un hilo dedicado en lugar de un hilo del pool) y un `TaskScheduler` personalizado. Sus valores por defecto son peligrosos, así que no lo uses como una llamada genérica de "ejecuta esto en segundo plano".

Este artículo se centra en .NET 11 (preview 4), C# 14 y la BCL tal como se distribuye en net11.0. `Task.Run` llegó en .NET Framework 4.5; `Task.Factory.StartNew` y `ThreadPool.QueueUserWorkItem(WaitCallback, object)` se remontan a .NET Framework 4.0 y 1.0 respectivamente. La sobrecarga `ThreadPool.QueueUserWorkItem<TState>(Action<TState>, TState, bool)`, amable con las asignaciones, se añadió en .NET Core 2.1 y está presente en todas las versiones de .NET desde entonces.

## Las tres API están en niveles distintos

La confusión aquí viene de tratar estas tres como tres formas intercambiables de escribir la misma operación. No lo son. Están en tres capas de abstracción diferentes y te devuelven tres cosas distintas.

`ThreadPool.QueueUserWorkItem` es la más cruda de las tres. Le pasas un delegado, el runtime lo ejecuta en un hilo del pool, y ese es todo el contrato. No hay valor de retorno, ni handle, ni forma de esperar la finalización, ni forma de observar una excepción. Una excepción no controlada lanzada dentro del callback derriba el proceso, exactamente como ocurriría en cualquier otro hilo del thread pool. Esto es fire-and-forget en el sentido literal: una vez que lo encolas, no tienes más relación con el trabajo.

`Task.Factory.StartNew` es el lanzador de tareas de propósito general de la Task Parallel Library. Devuelve una `Task`, así que obtienes un handle que puedes esperar y captura de excepciones. Pero es de propósito general hasta el exceso: expone todas las perillas que tiene la TPL, y sus valores por defecto se eligieron en 2010 para un mundo distinto. Los dos valores por defecto que muerden son `TaskScheduler.Current` (no `Default`) y la ausencia de `DenyChildAttach`.

`Task.Run` es la envoltura de conveniencia con opinión que Microsoft añadió en .NET Framework 4.5 específicamente porque los valores por defecto de `StartNew` eran una trampa. Según la [guía del propio equipo de .NET](https://devblogs.microsoft.com/dotnet/task-run-vs-task-factory-startnew/), una llamada a `Task.Run(someAction)` es exactamente equivalente a:

```csharp
// .NET 11, C# 14 -- what Task.Run actually does under the hood
Task.Factory.StartNew(
    someAction,
    CancellationToken.None,
    TaskCreationOptions.DenyChildAttach,
    TaskScheduler.Default);
```

Así que `Task.Run` no es un mecanismo distinto de `StartNew`. Es `StartNew` con los argumentos seguros ya incorporados. Ese único hecho decide la mayor parte de esta comparación.

## La matriz de decisión

Cada fila refleja el comportamiento de net11.0 salvo que se indique. "Hilo del pool" significa un worker de `ThreadPool`; "hilo dedicado" significa un hilo nuevo fuera del pool.

| Capacidad                                  | `Task.Run`              | `Task.Factory.StartNew`      | `ThreadPool.QueueUserWorkItem`      |
| ------------------------------------------ | ----------------------- | ---------------------------- | ----------------------------------- |
| Devuelve una `Task` que se puede esperar   | sí                      | sí                           | no                                  |
| Captura excepciones                        | sí (en la `Task`)       | sí (en la `Task`)            | no (derriba el proceso)             |
| Planificador por defecto                   | `TaskScheduler.Default` | `TaskScheduler.Current`      | thread pool (sin planificador)      |
| `DenyChildAttach` por defecto              | sí                      | no                           | n/a                                 |
| Desempaqueta una lambda asíncrona (`Func<Task>`) | sí, devuelve `Task` | no, devuelve `Task<Task>`    | n/a (el delegado es `async void`)   |
| Pasa estado sin un closure                 | no                      | sí (arg de estado `object`)  | sí (sobrecarga `TState`)            |
| `LongRunning` (hilo dedicado)              | no                      | sí                           | no                                  |
| `TaskScheduler` personalizado              | no                      | sí                           | no                                  |
| Asigna una `Task`                          | sí                      | sí                           | no                                  |
| Token de cancelación al lanzar             | sí                      | sí                           | no                                  |
| Primera versión                            | .NET Framework 4.5      | .NET Framework 4.0           | .NET Framework 1.0                  |

Dos filas cargan con la mayor parte del peso. "Devuelve una Task que se puede esperar" te empuja hacia los dos métodos de la TPL para cualquier cosa que necesites esperar o de la que necesites un resultado. "Asigna una Task" te lleva hacia `QueueUserWorkItem` cuando estás encolando millones de work items diminutos y el propio objeto `Task` es el coste que intentas recortar.

## Cuándo elegir Task.Run

Este es el valor por defecto. Si estás leyendo esto para decidir y no tienes una razón específica para elegir otra cosa, la respuesta es `Task.Run`.

- Quieres descargar trabajo intensivo de CPU fuera del hilo actual y esperar el resultado. Un parseo, un hash, un redimensionado de imagen, cualquier cosa que bloquearía un hilo de petición o un hilo de UI. `Task.Run(() => Compute(input))` te da una `Task<TResult>` que puedes esperar con `await`.
- Estás ejecutando una lambda asíncrona en el pool. `Task.Run` la desempaqueta por ti, de modo que `Task.Run(async () => await DoAsync())` tiene tipo `Task`, no `Task<Task>`. Este es el lugar más común donde los usuarios de `StartNew` se queman, tratado en la trampa más abajo.
- Estás en una app de UI (MAUI, WPF, Blazor) y no debes ejecutar el trabajo en el hilo de UI. Como `Task.Run` fija `TaskScheduler.Default`, siempre va al pool sin importar desde qué hilo lo llames. `StartNew` heredaría el planificador de la UI y ejecutaría el trabajo "en segundo plano" en el hilo de UI.

```csharp
// .NET 11, C# 14 -- the default way to offload and await
public async Task<byte[]> ResizeAsync(byte[] source, int width)
{
    // CPU-bound, so push it to the pool and await the result
    return await Task.Run(() => ImageResizer.Resize(source, width));
}

// async lambda: Task.Run unwraps, so the type is Task<int>, not Task<Task<int>>
Task<int> work = Task.Run(async () =>
{
    await Task.Delay(100);
    return 42;
});
```

El coste de `Task.Run` es una asignación de `Task` más, si tu lambda captura estado local, una asignación de closure. Para el trabajo en segundo plano corriente que se ejecuta durante milisegundos o más, esa asignación es ruido. Solo se vuelve interesante cuando estás encolando una cantidad muy grande de work items muy cortos, que es el único escenario donde `QueueUserWorkItem` se gana su lugar.

## Cuándo elegir ThreadPool.QueueUserWorkItem

`QueueUserWorkItem` es la elección correcta en exactamente una situación: trabajo fire-and-forget genuino donde no necesitas un handle, no necesitas el resultado, no necesitas esperarlo, y estás encolando suficiente como para que la asignación de `Task` aparezca en un perfilado.

- Estás disparando un alto volumen de work items diminutos e independientes y la asignación de `Task` por elemento es presión medible sobre el GC. Una tubería de telemetría, un fan-out de invalidaciones de caché, un sink de registro que entrega cada línea al pool.
- Realmente no te importa la finalización ni el fallo. Recuerda que una excepción no controlada aquí derriba el proceso, así que el cuerpo del callback debe manejar sus propias excepciones.
- Puedes usar la sobrecarga genérica `QueueUserWorkItem<TState>` para pasar estado sin asignar un closure. Esta es la razón completa para preferir esta API en un camino crítico, y solo funciona si evitas capturar variables.

```csharp
// .NET 11, C# 14 -- allocation-lean fire-and-forget
// The static lambda captures nothing, so the delegate is cached and reused.
// State flows through the TState parameter, so there is no closure object.
ThreadPool.QueueUserWorkItem(
    static state => state.Sink.Write(state.Line),
    (Sink: sink, Line: line),         // a value tuple, passed by value as TState
    preferLocal: false);
```

Dos detalles hacen que valga la pena conocer esta sobrecarga. Primero, la lambda `static` no captura nada, así que el compilador de C# guarda en caché una única instancia del delegado en lugar de asignar una por llamada. Segundo, el estado viaja a través del parámetro fuertemente tipado `TState`, incluyendo las tuplas de valor, así que evitas tanto el closure como el boxing que la antigua sobrecarga `QueueUserWorkItem(WaitCallback, object)` forzaba cuando el estado era un tipo por valor. El flag `preferLocal`, añadido junto a la sobrecarga genérica en .NET Core 2.1, controla si el elemento va a la cola local del worker actual (`true`, mejor localidad de caché y robo de trabajo) o a la cola global (`false`). Para elementos fire-and-forget no relacionados, `false` suele ser lo correcto.

Si te descubres queriendo `QueueUserWorkItem` pero también queriendo contrapresión u orden, detente y mira [Channels en lugar de BlockingCollection](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/). Un `Channel<T>` acotado con un único consumidor es casi siempre un mejor sink fire-and-forget que el encolado crudo del thread pool una vez que te importa cuánto adelanta el productor al consumidor.

## Cuándo elegir Task.Factory.StartNew

`StartNew` sobrevive por dos razones, y solo dos. Si ninguna aplica, deberías estar usando `Task.Run`.

- Necesitas `TaskCreationOptions.LongRunning`. Esto sugiere al planificador que ejecute el trabajo en un hilo dedicado en lugar de un hilo del pool, lo cual importa para trabajo que bloquea durante mucho tiempo y de otro modo agotaría el pool. Un bucle de mensajes, un consumidor de larga vida, una lectura bloqueante de un dispositivo. `Task.Run` no tiene ninguna sobrecarga que acepte `TaskCreationOptions`, así que esto es genuinamente exclusivo de `StartNew`.
- Necesitas un `TaskScheduler` personalizado. Si has construido un planificador (un planificador de apartamento de un solo hilo, un planificador de prioridad, un planificador con concurrencia limitada) y quieres que esta tarea se ejecute en él, `StartNew` toma el planificador como argumento y `Task.Run` no.

```csharp
// .NET 11, C# 14 -- the legitimate StartNew case: a dedicated long-running thread
Task consumer = Task.Factory.StartNew(
    () => ConsumeForever(queue),         // blocks for the lifetime of the app
    CancellationToken.None,
    TaskCreationOptions.LongRunning,     // hint: give me my own thread, not a pool thread
    TaskScheduler.Default);              // ALWAYS pass Default explicitly
```

Fíjate en el último argumento. Incluso en su uso legítimo, deberías pasar `TaskScheduler.Default` explícitamente, porque el valor por defecto de `TaskScheduler.Current` es la trampa que hace que las llamadas casuales a `StartNew` se comporten mal. La siguiente sección es la razón completa por la que existe `Task.Run`.

## El benchmark: a dónde va la asignación

La afirmación de rendimiento que vale la pena medir es la asignación, no la latencia bruta. El tiempo de reloj para cualquiera de estas tres está dominado por la planificación del thread pool y por el trabajo en sí, ambos idénticos entre las tres API una vez que el trabajo se está ejecutando. Lo que difiere, de forma determinista, es lo que cada llamada asigna en su camino hacia el pool.

Estos números provienen de BenchmarkDotNet 0.14 con `[MemoryDiagnoser]` en .NET 11 preview 4, x64, Windows 11, un Ryzen 9 7950X. Cada benchmark encola un único work item trivial (un `Interlocked.Increment`) y el harness captura estado de un campo externo para que las variantes basadas en closure realmente asignen un closure. Los bytes absolutos son específicos de la máquina y del runtime; el orden y las proporciones son el resultado estable.

| Método                                                | Asignado / op  |
| ----------------------------------------------------- | -------------- |
| `Task.Run(() => Work(state))` (captura `state`)       | 192 B          |
| `Task.Factory.StartNew(() => Work(state))` (captura)  | 192 B          |
| `QueueUserWorkItem(s => Work((State)s), state)`       | 80 B           |
| `QueueUserWorkItem(static s => Work(s), state, false)`| 56 B           |

El patrón es la conclusión robusta. `Task.Run` y `StartNew` asignan lo mismo, porque `Task.Run` es `StartNew` por debajo: un objeto `Task` más un closure cuando la lambda captura. La antigua sobrecarga basada en `object` de `QueueUserWorkItem` se salta la `Task` por completo, pero aún asigna un envoltorio de callback interno. La `QueueUserWorkItem<TState>` genérica con una lambda `static` es la más ligera porque no asigna ni una `Task` ni un closure, y el delegado estático se guarda en caché tras el primer uso. Para una sola llamada esta diferencia es irrelevante. Para un bucle crítico que encola millones de elementos por segundo, recortar aproximadamente el 70% de la asignación por elemento es la diferencia entre un gráfico de GC plano y uno en diente de sierra.

Para reproducirlo, ejecuta el harness trivial tú mismo: una clase con los cuatro métodos `[Benchmark]` anteriores, `[MemoryDiagnoser]` en la clase, y `BenchmarkRunner.Run<T>()` en `Main`. No confíes en un número de asignación que no hayas medido en tu propio framework de destino, porque la disposición de `Task` y los envoltorios internos del thread pool cambian entre versiones del runtime.

## La trampa que decide por ti

Tres restricciones anulan por completo la preferencia.

**Una lambda asíncrona obliga a `Task.Run` sobre `StartNew`.** Este es el bug clásico. `Task.Factory.StartNew(async () => await FooAsync())` devuelve una `Task<Task>`, no una `Task`. La tarea externa se completa en el instante en que la lambda asíncrona alcanza su primer `await`, así que si esperas el resultado de `StartNew` estás esperando solo el prefijo síncrono de tu método asíncrono, no el trabajo real. La corrección que documenta el equipo de .NET es `.Unwrap()`, pero la mejor corrección es usar `Task.Run`, que hace ese desempaquetado por ti. Las mismas mecánicas de reanudación de hilo que hacen que esta trampa exista se explican en [async void vs async Task en C#](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

```csharp
// .NET 11, C# 14 -- the StartNew async trap
Task<Task<int>> wrong = Task.Factory.StartNew(async () =>
{
    await Task.Delay(1000);
    return 42;
}); // completes after ~0 ms, NOT 1000 ms

int value = await Task.Factory.StartNew(async () =>
{
    await Task.Delay(1000);
    return 42;
}).Unwrap(); // correct, but just write Task.Run instead
```

**`TaskScheduler.Current` hace que `StartNew` ejecute el trabajo "en segundo plano" en el hilo equivocado.** Cuando llamas a `StartNew` desde dentro de otra tarea o desde un manejador de eventos de UI, `TaskScheduler.Current` no es el planificador del thread pool. En un hilo de UI es el planificador de sincronización de la UI, así que tu trabajo "descargado" se ejecuta en el hilo de UI y congela la app. Anidado dentro de otro `Task.Run`, `Current` puede ser el planificador del pool, pero confiar en eso es frágil. `Task.Run` esquiva esto por completo al fijar `TaskScheduler.Default`. Si alguna vez ves un `StartNew` sin un argumento de planificador explícito, trátalo como un bug latente.

**Fire-and-forget con `QueueUserWorkItem` no se traga nada; derriba.** A diferencia de una `Task` cuya excepción no observada se captura y (en runtimes más antiguos) se lanza en el finalizador, una excepción que escapa de un callback de `QueueUserWorkItem` es una excepción no controlada en un hilo del thread pool y termina el proceso. Si usas esta API, el cuerpo del callback debe envolverse en su propio `try` / `catch`. No hay ninguna `Task` que cargue con el fallo.

## La recomendación, reformulada

Usa por defecto `Task.Run` para esencialmente todo el trabajo en segundo plano y descargado. Devuelve una `Task` que se puede esperar, captura excepciones, siempre usa el thread pool y desempaqueta las lambdas asíncronas, que es exactamente lo que quieres el 95% del tiempo. Baja a `ThreadPool.QueueUserWorkItem<TState>` con una lambda `static` solo para fire-and-forget genuino en un camino crítico donde la asignación de `Task` es medible y has aceptado que el callback debe capturar sus propias excepciones. Usa `Task.Factory.StartNew` solo para `TaskCreationOptions.LongRunning` o un `TaskScheduler` personalizado, y cuando lo hagas, pasa siempre `TaskScheduler.Default` explícitamente para no heredar el planificador actual. La decisión correcta más corta: necesitas un handle, usa `Task.Run`; necesitas cero asignación y ningún handle, usa `QueueUserWorkItem<TState>`; necesitas un hilo dedicado o un planificador personalizado, usa `StartNew` con `Default`.

## Relacionado

- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock en C#](/es/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) es la comparación complementaria para proteger el estado compartido que estas tareas en segundo plano tocan.
- [async void vs async Task en C#: cuándo cada uno es correcto](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) explica el comportamiento de reanudación detrás de la trampa de la lambda asíncrona de StartNew.
- [Cómo cancelar una Task de larga duración en C# sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) cubre el token de cancelación que pasas a Task.Run y StartNew.
- [Cómo usar Channels en lugar de BlockingCollection en C#](/es/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) es la alternativa estructurada cuando el fire-and-forget necesita contrapresión.
- [ConfigureAwait(false) vs por defecto en .NET 11](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/) es la otra mitad de hacer bien la descarga al thread pool.

## Enlaces de fuentes

- [Task.Run vs Task.Factory.StartNew](https://devblogs.microsoft.com/dotnet/task-run-vs-task-factory-startnew/) en el .NET Blog, la explicación canónica de la equivalencia y el desempaquetado de la lambda asíncrona.
- [StartNew is Dangerous](https://blog.stephencleary.com/2013/08/startnew-is-dangerous.html) de Stephen Cleary, sobre las trampas de `TaskScheduler.Current` y `LongRunning`.
- [Referencia de la API `ThreadPool.QueueUserWorkItem`](https://learn.microsoft.com/dotnet/api/system.threading.threadpool.queueuserworkitem) en Microsoft Learn, incluida la sobrecarga genérica `TState`.
- [Referencia de la API `Task.Run`](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.run) en Microsoft Learn.
- [Referencia de la API `TaskFactory.StartNew`](https://learn.microsoft.com/dotnet/api/system.threading.tasks.taskfactory.startnew) en Microsoft Learn, que documenta el `TaskScheduler.Current` por defecto.
- [dotnet/runtime#25193](https://github.com/dotnet/runtime/issues/25193), la propuesta que dio a `QueueUserWorkItem` su sobrecarga genérica amable con las asignaciones.
