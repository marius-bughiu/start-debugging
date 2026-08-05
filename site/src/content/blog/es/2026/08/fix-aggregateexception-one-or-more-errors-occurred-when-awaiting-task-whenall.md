---
title: "Solución: AggregateException \"One or more errors occurred\" al esperar Task.WhenAll en C#"
description: "await Task.WhenAll relanza solo uno de los fallos. Guarda la tarea de WhenAll en una variable y lee su Exception.InnerExceptions para ver todos los errores, no uno solo."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "es"
translationOf: "2026/08/fix-aggregateexception-one-or-more-errors-occurred-when-awaiting-task-whenall"
translatedBy: "claude"
translationDate: 2026-08-05
---

Si varias tareas de un `Task.WhenAll` fallan, la tarea devuelta termina en estado de fallo con una `AggregateException` cuyo mensaje es "One or more errors occurred", pero `await` la desenvuelve y relanza exactamente una de las excepciones internas. Todos los demás fallos se descartan en silencio y nunca llegan a tu bloque `catch`. La solución es guardar en una variable local la tarea que devuelve `Task.WhenAll`, esperarla dentro de un `try` y leer `whenAll.Exception.InnerExceptions` en el `catch` para obtenerlos todos. Si estás viendo el tipo `AggregateException` literal en un `catch`, es que estás bloqueando con `.Wait()` o `.Result` en lugar de esperar, lo cual es un problema distinto y peor. Verificado en .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14), con el comportamiento del runtime medido en .NET 10.0.5; el código del runtime relevante es idéntico byte a byte en las ramas `release/10.0` y `main`.

## El error en contexto

Bloquear sobre la tarea de `WhenAll` te entrega el envoltorio directamente:

```
Unhandled exception. System.AggregateException: One or more errors occurred. (Connection refused) (The operation has timed out.)
 ---> System.Net.Http.HttpRequestException: Connection refused
   at OrderSync.FetchAsync(String url)
   --- End of inner exception stack trace ---
   at System.Threading.Tasks.Task.ThrowIfExceptional(Boolean includeTaskCanceledExceptions)
   at System.Threading.Tasks.Task.Wait(Int32 millisecondsTimeout, CancellationToken cancellationToken)
```

Esperarla no te da ninguna `AggregateException`, solo una de las excepciones internas:

```
Unhandled exception. System.Net.Http.HttpRequestException: Connection refused
   at OrderSync.FetchAsync(String url)
   at OrderSync.SyncAllAsync()
```

Ambas son la misma situación de fondo. Esas dos formas son la razón de que las búsquedas de este error terminen en consejos contradictorios.

## Por qué await oculta todos los fallos menos uno

La documentación de `Task.WhenAll` dice que la tarea termina en estado `Faulted` "donde sus excepciones contendrán la agregación del conjunto de excepciones desenvueltas de cada una de las tareas suministradas". Esa agregación vive en la propiedad `Exception` de la tarea devuelta, y realmente contiene todos los fallos.

La pérdida ocurre una capa más arriba. `await` está especificado para relanzar la excepción de una tarea ya desenvuelta, de modo que capturas `HttpRequestException` en lugar de `AggregateException` cuando falla una sola tarea. Ese desenvoltorio es el comportamiento correcto por defecto: casi toda API asíncrona produce como mucho un error, y escribir `catch (AggregateException ae) { ae.InnerException ... }` alrededor de cada await sería insoportable. `Task.WhenAll` es la API principal donde esa suposición se rompe, y el awaiter no tiene forma de indicar "hubo cuatro". Toma un exception dispatch info de la lista y lo relanza. Esto se planteó como [dotnet/runtime#31494](https://github.com/dotnet/runtime/issues/31494) y de nuevo como [dotnet/runtime#47605](https://github.com/dotnet/runtime/issues/47605), pidiendo un await opcional que propagara el agregado completo. Ninguno llegó a publicarse, así que la alternativa de abajo sigue siendo la respuesta.

El corolario importa para tus cláusulas `catch`: después de `await Task.WhenAll(...)`, un `catch (AggregateException)` nunca se activa. Si escribiste uno, es código muerto y la excepción real pasa de largo.

## Reproducción mínima

```csharp
// .NET 11, C# 14
static async Task FailAsync(string message)
{
    await Task.Delay(10);
    throw new InvalidOperationException(message);
}

try
{
    await Task.WhenAll(FailAsync("first"), FailAsync("second"), FailAsync("third"));
}
catch (Exception ex)
{
    Console.WriteLine(ex.Message);   // prints one message, not three
}
```

Entran tres fallos, sale uno. Nada dentro del bloque `catch` puede recuperar los otros dos, porque la única referencia al agregado era el temporal que devolvió `Task.WhenAll` y que `await` consumió.

## Solución 1: guarda la tarea de WhenAll y lee InnerExceptions

Esta es la solución para la inmensa mayoría de los casos, y el único cambio es una variable local:

```csharp
// .NET 11, C# 14
Task whenAll = Task.WhenAll(FailAsync("first"), FailAsync("second"), FailAsync("third"));

try
{
    await whenAll;
}
catch
{
    // whenAll.Exception is the AggregateException the await threw away
    foreach (Exception inner in whenAll.Exception!.InnerExceptions)
    {
        _logger.LogError(inner, "Sync step failed");
    }
    throw;
}
```

`whenAll.Exception` no es nulo exactamente cuando `whenAll.Status == TaskStatus.Faulted`, y su colección `InnerExceptions` guarda una entrada por cada tarea fallida, cada una con su traza de pila original intacta. El `catch` vacío con un `throw` preserva el comportamiento existente para quien llama (sigue viendo una única excepción desenvuelta) mientras te da fidelidad total en el log.

Dos detalles hacen que esto sea seguro de aplicar de forma mecánica. Primero, no metas la llamada a `Task.WhenAll(...)` dentro del `try`: quien lanza es el `await`, no la llamada, pero dejar la asignación fuera hace que la variable sea visible en el `catch`. Segundo, usa `catch` o `catch (Exception)`, no `catch (AggregateException)`, por la razón de la sección anterior.

## Solución 2: evita que la tarea de WhenAll falle nunca

Si tu fan-out es un lote donde el fallo parcial es normal, el diseño más limpio es impedir que las excepciones escapen de las tareas individuales. Envuelve cada unidad de trabajo para que devuelva su resultado en vez de lanzar:

```csharp
// .NET 11, C# 14
static async Task<(int Id, Exception? Error)> RunSafeAsync(int id, Func<Task> work)
{
    try
    {
        await work();
        return (id, null);
    }
    catch (Exception ex)
    {
        return (id, ex);
    }
}

var results = await Task.WhenAll(orders.Select(o => RunSafeAsync(o.Id, () => SyncAsync(o))));

foreach (var (id, error) in results.Where(r => r.Error is not null))
{
    _logger.LogError(error, "Order {OrderId} failed", id);
}
```

`Task.WhenAll` ahora siempre se completa, así que no hay agregado que desempaquetar, ningún filtro de excepciones que acertar, y sobrevive la asociación entre cada fallo y el elemento que lo causó. Esa asociación es justo lo que la Solución 1 no puede darte: `InnerExceptions` es una lista plana de excepciones sin referencia de vuelta a la tarea que las produjo. Cuando necesitas reintentar los fallos o informar qué registros fueron rechazados, usa esta forma.

El coste es que un error genuinamente fatal ya no se propaga solo. Decide explícitamente qué hacer cuando `results` contenga errores, o habrás construido un fallo silencioso.

## Solución 3: relanza el agregado completo a propósito

Cuando quien llama realmente debe ver todos los fallos, relanza el agregado en vez de dejar que `await` elija uno. `ExceptionDispatchInfo` conserva las trazas de pila originales:

```csharp
// .NET 11, C# 14
using System.Runtime.ExceptionServices;

public static async Task WhenAllWithAggregateAsync(IEnumerable<Task> tasks)
{
    Task whenAll = Task.WhenAll(tasks);
    try
    {
        await whenAll;
    }
    catch
    {
        ExceptionDispatchInfo.Capture(whenAll.Exception!).Throw();
    }
}
```

Quien llame a ese helper recibe una `AggregateException` con todas las excepciones internas, que es lo que la gente suele buscar cuando escribe `catch (AggregateException)` después de un `await`. Úsalo en una frontera donde una única operación lógica realmente falló de varias formas a la vez, como una importación por lotes que debe reportar todos los errores de validación. No lo conviertas en tu comportamiento por defecto: empuja el manejo de `AggregateException` a todos los que llaman, que es exactamente el problema de ergonomía que el desenvoltorio de `await` vino a eliminar.

## ¿Qué excepción lanza realmente await?

Aquí es donde la mayoría de las respuestas existentes se equivocan, incluidas las que dicen "la primera excepción". Depende de qué sobrecarga llamaste, y la diferencia es determinista.

```csharp
// .NET 10.0.5, C# 14 -- three tasks that fail at staggered times,
// slowest one first in argument order
static async Task FailAfterAsync(int ms, string message)
{
    await Task.Delay(ms);
    throw new InvalidOperationException(message);
}

static async Task<int> FailAfterIntAsync(int ms, string message)
{
    await Task.Delay(ms);
    throw new InvalidOperationException(message);
}

// non-generic overload -> Task
var nonGeneric = Task.WhenAll(
    FailAfterAsync(150, "index0-slow"),
    FailAfterAsync(80,  "index1-medium"),
    FailAfterAsync(10,  "index2-fast"));
// await throws:    index2-fast
// InnerExceptions: index2-fast, index1-medium, index0-slow

// generic overload -> Task<int[]>
var generic = Task.WhenAll(
    FailAfterIntAsync(150, "index0-slow"),
    FailAfterIntAsync(80,  "index1-medium"),
    FailAfterIntAsync(10,  "index2-fast"));
// await throws:    index0-slow
// InnerExceptions: index0-slow, index1-medium, index2-fast
```

El `Task.WhenAll` no genérico ordena `InnerExceptions` por **tiempo de finalización**. El genérico `Task.WhenAll<TResult>` las ordena por **posición del argumento**. Ambos lanzan `InnerExceptions[0]`. Ese resultado fue estable a lo largo de ejecuciones repetidas en .NET 10.0.5.

La causa se ve en el código fuente del runtime. Ambas promesas están en [`Task.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/Task.cs). La `WhenAllPromise` no genérica deliberadamente no conserva el array de entrada; su callback de finalización `Invoke` añade cada tarea fallida a una lista a medida que se completa, y luego recorre esa lista:

```csharp
// dotnet/runtime, Task.WhenAllPromise.Invoke
if (failedOrCanceled is List<Task> list)
{
    foreach (Task task in list) { HandleTask(task); }
}
```

La `WhenAllPromise<T>` genérica conserva el array porque tiene que producir los resultados `T[]` en orden, y lo recorre por índice:

```csharp
// dotnet/runtime, Task.WhenAllPromise<T>.Invoke
for (int i = 0; i < m_tasks.Length; i++)
{
    Task<T>? task = m_tasks[i];
    if (task.IsFaulted) { observedExceptions ??= new(); observedExceptions.AddRange(task.GetExceptionDispatchInfos()); }
    ...
}
```

Esta divergencia apareció en .NET 8 y se reportó como [dotnet/runtime#93504](https://github.com/dotnet/runtime/issues/93504) después de que la ruta no genérica se reescribiera por motivos de asignación de memoria. Se cerró como "not planned" y no está en la documentación de cambios incompatibles. En la práctica: nunca escribas código que dependa de qué fallo aflora desde un `await Task.WhenAll`. Lee la lista completa, según la Solución 1.

## La cancelación desaparece cuando algo falla

La otra pérdida silenciosa es la cancelación. Si una tarea se cancela y otra falla, la cancelada no aporta nada:

```csharp
// .NET 10.0.5
var mixed = Task.WhenAll(canceledTask, faultingTask);
try { await mixed; } catch (Exception ex) { /* InvalidOperationException */ }

// mixed.Status                          -> Faulted
// mixed.Exception.InnerExceptions.Count -> 1   (the cancellation is gone)
```

Ambas implementaciones de la promesa registran `canceledTask` en una variable local aparte y solo llaman a `TrySetCanceled` cuando la lista de excepciones está vacía, lo que coincide con la regla documentada: el fallo gana a la cancelación, y la cancelación gana al éxito. Si nada falla y al menos una tarea se cancela, la tarea de `WhenAll` termina en `Canceled`, su propiedad `Exception` es `null` y `await` lanza una `TaskCanceledException`. El código que hace `whenAll.Exception!.InnerExceptions` sin comprobar `Status` provocará una `NullReferenceException` exactamente en ese caso, así que protégelo:

```csharp
// .NET 11, C# 14
catch (Exception ex)
{
    if (whenAll.Exception is { } aggregate)
    {
        foreach (var inner in aggregate.InnerExceptions) _logger.LogError(inner, "Step failed");
    }
    else
    {
        _logger.LogWarning(ex, "Batch was canceled");
    }
    throw;
}
```

Distinguir una cancelación genuina de un timeout disfrazado de cancelación es su propia trampa, cubierta en [por qué HttpClient lanza TaskCanceledException](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

## Trampas y variantes

- **Estás capturando `AggregateException` y funciona.** Entonces no estás esperando. `.Wait()`, `.Result` y `Task.WaitAll` lanzan el envoltorio tal cual, que es la única razón por la que ese nombre de tipo aparece en un `catch`. Eso también significa que estás bloqueando un hilo, con todo lo que implica: ver [.Result vs .Wait() vs GetAwaiter().GetResult() vs await](/es/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/).

- **`Flatten()` no hace nada aquí.** `AggregateException.Flatten` existe para agregados anidados, pero `Task.WhenAll` ya desenvuelve sus componentes, así que incluso un `WhenAll` sobre otro `WhenAll` produce una lista plana. Verificado: tres fallos anidados a dos niveles dieron tres excepciones internas antes y después de `Flatten()`. Reserva `Flatten()` para `Parallel.ForEach` y PLINQ, donde el anidamiento sí es real.

- **Una consulta LINQ perezosa enumerada dos veces inicia el trabajo dos veces.** `Enumerable.Range(0, 3).Select(_ => DoAsync())` es una consulta, no una lista. `Task.WhenAll` la enumera una vez, pero pasar la misma consulta a un segundo `WhenAll` (o a `.Count()` para una línea de log) vuelve a ejecutarlo todo. Medido: tres tareas iniciadas tras el primer `WhenAll`, seis tras el segundo. Llama a `.ToArray()` antes de pasar una proyección a `WhenAll`.

- **`Task.WhenAll` no se detiene en el primer fallo.** Cada tarea se ejecuta hasta el final incluso después de que una lance, y por eso obtienes varias excepciones. Si quieres que el fan-out abandone el resto, necesitas un `CancellationTokenSource` que las tareas respeten, cableado como en [propagar un CancellationToken por métodos asíncronos](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

- **`Task.WhenAll` no tiene límite de concurrencia.** Si el agregado está lleno de excepciones de socket y timeouts, puede que el error real sea que lanzaste 5 000 peticiones a la vez. Las alternativas con tope de concurrencia se comparan en [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/es/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/).

- **Los fallos llegan tarde.** `WhenAll` no te dice nada hasta que termina la tarea más lenta, así que un fallo rápido queda invisible detrás de un éxito lento. Si quieres reaccionar a cada resultado según llega, [Task.WhenEach](/es/2026/01/streaming-tasks-with-net-9-task-wheneach/) te da un `IAsyncEnumerable<Task>` en orden de finalización.

- **Una colección vacía tiene éxito.** `Task.WhenAll(Array.Empty<Task>())` pasa directamente a `RanToCompletion`. Un trabajo por lotes que reporta éxito con una entrada vacía suele ser un error de filtrado más arriba, no un error de `WhenAll`.

- **Esperar la tarea de `WhenAll` observa todas las excepciones internas.** No recibirás un `TaskScheduler.UnobservedTaskException` por los fallos que no viste, porque `WhenAll` ya los observó por ti. Cómodo, y también la razón de que las pérdidas sean tan silenciosas.

El modelo mental de una línea: `Task.WhenAll` recoge fielmente todos los fallos, y `await` es el paso que pierde información. Dale un nombre a la tarea devuelta y no se pierde nada.

## Relacionado

- [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll en C#](/es/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) para elegir la primitiva de fan-out correcta y limitar la concurrencia.
- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await en C#](/es/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) para entender por qué bloquear es lo que hace aflorar la `AggregateException` cruda.
- [Solución: TaskCanceledException: A task was canceled en HttpClient](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) para el caso de cancelación que un `WhenAll` fallido se traga.
- [Streaming de tareas con Task.WhenEach de .NET 9](/es/2026/01/streaming-tasks-with-net-9-task-wheneach/) para tratar cada resultado según se completa en vez de esperar al más lento.
- [Cómo propagar un CancellationToken por métodos asíncronos en .NET 11](/es/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) para hacer que un fan-out abandone el trabajo restante.

## Fuentes

- Microsoft Learn, [método Task.WhenAll](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.whenall) (las reglas de fallo, cancelación y `RanToCompletion` citadas arriba).
- Microsoft Learn, [clase AggregateException](https://learn.microsoft.com/en-us/dotnet/api/system.aggregateexception) (`InnerExceptions`, `Flatten`, `Handle` y el mensaje "One or more errors occurred").
- Microsoft Learn, [manejo de excepciones en Task](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/task-exception-handling) y [manejo de excepciones en la TPL](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/exception-handling-task-parallel-library).
- dotnet/runtime, [`Task.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/Task.cs) (`WhenAllPromise` y `WhenAllPromise<T>`, la diferencia entre orden de finalización y orden de argumentos).
- dotnet/runtime, [Issue #93504: Awaiting nongeneric Task.WhenAll changes behavior in .NET 8](https://github.com/dotnet/runtime/issues/93504) (cerrado como "not planned", sin documentar).
- dotnet/runtime, [Issue #31494: Task.WhenAll inner exceptions are lost](https://github.com/dotnet/runtime/issues/31494) e [Issue #47605: Configure an await to propagate all errors](https://github.com/dotnet/runtime/issues/47605).
