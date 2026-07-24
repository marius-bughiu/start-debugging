---
title: ".Result vs .Wait() vs GetAwaiter().GetResult() vs await en C#: cuál deberías usar?"
description: "await es la respuesta correcta casi siempre. Cuando de verdad tienes que bloquear, GetAwaiter().GetResult() supera a .Result y .Wait() porque lanza la excepción original. Una matriz de decisión para .NET 11 y C# 14."
pubDate: 2026-07-24
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "es"
translationOf: "2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-24
---

Si tienes un `Task<T>` y quieres sacar el `T` de él, tienes cuatro opciones: `task.Result`, `task.Wait()`, `task.GetAwaiter().GetResult()` y `await task`. Usa `await`. Es la única que no bloquea un hilo, y lanza exactamente la excepción que tu código lanzó en lugar de un envoltorio. Las otras tres bloquean el hilo llamador y arriesgan un interbloqueo; entre ellas, `GetAwaiter().GetResult()` es la menos mala porque desenvuelve las excepciones igual que `await`. Recurre a ella solo cuando estés atascado en un método síncrono que no puedes hacer `async`. Esto se cumple en .NET 11 (`Microsoft.NET.Sdk` 11.0.0) con C# 14, y la semántica ha sido estable desde .NET Framework 4.5.

## Las cuatro de un vistazo

| Comportamiento                       | `await`            | `GetAwaiter().GetResult()` | `.Result`           | `.Wait()`           |
| ------------------------------------ | ------------------ | -------------------------- | ------------------- | ------------------- |
| Bloquea el hilo llamador             | no                 | sí                         | sí                  | sí                  |
| Devuelve un valor                    | sí (`T`)           | sí (`T`)                   | sí (`T`)            | no (void)           |
| Funciona sobre `Task` no genérico    | sí                 | sí                         | no (solo `Task<T>`) | sí                  |
| Excepción lanzada                    | original           | original                   | `AggregateException`| `AggregateException`|
| Riesgo de interbloqueo (contexto capturado) | no          | sí                         | sí                  | sí                  |
| Inanición del thread pool bajo carga | no                 | sí                         | sí                  | sí                  |
| Seguro sobre `ValueTask<T>`          | sí (una vez)       | no                         | solo si completó    | n/a                 |

Lee esa tabla de arriba abajo para `await` y obtienes una columna limpia: sin bloqueo, valor real, excepción original, sin interbloqueo. Cualquier otra columna tiene al menos un "sí" en una fila que no quieres. Ese es todo el argumento. El resto de este artículo es por qué cada fila es verdad y cuándo el intercambio realmente te obliga.

## Por qué await gana por defecto

`await` no es una forma más elegante de llamar a `.Result`. Es una operación distinta. Cuando haces `await` de una tarea que no ha completado, el método se suspende y devuelve el control a su llamador. Ningún hilo se sienta a esperar. El runtime programa el resto de tu método como una continuación que se ejecuta cuando la tarea termina. Un miembro bloqueante hace lo contrario: aparca el hilo actual y lo retiene hasta que la tarea está lista.

Esa única diferencia es por qué `await` escala y bloquear no. En un servidor, un hilo bloqueado es un hilo del thread pool que no hace nada más que esperar, y bajo carga te quedas sin ellos. En un hilo de interfaz, un hilo bloqueado es una ventana congelada. `await` libera el hilo para hacer otro trabajo (atender otra solicitud, bombear el bucle de mensajes) y retoma tu método más tarde.

```csharp
// .NET 11, C# 14 -- the default: no thread is blocked while the I/O runs
public async Task<string> GetGreetingAsync(HttpClient http)
{
    string body = await http.GetStringAsync("https://example.com/greeting");
    return body.Trim();
}
```

`await` también te da la excepción que realmente lanzaste. Si `GetStringAsync` lanza un `HttpRequestException`, el `await` relanza ese `HttpRequestException`, con su traza de pila original, exactamente donde hiciste el await. Sin desenvolver, sin gimnasia de `catch (AggregateException)`. A menos que tengas una razón concreta para bloquear, aquí termina la decisión.

## Cuándo GetAwaiter().GetResult() es la llamada bloqueante correcta

A veces no puedes ser asíncrono. Un constructor de clase no puede ser `async`. Un `Main` anterior a C# 7.1, un `Dispose` (no `DisposeAsync`), un método de interfaz cuya firma no controlas, un punto de entrada de un plugin de terceros que te entrega un delegado síncrono: estas son costuras genuinamente síncronas. Si tienes que llamar a código asíncrono desde dentro de una de ellas y no puedes reestructurar, tienes que bloquear sobre algo. Bloquea sobre `GetAwaiter().GetResult()`.

La razón por la que supera a `.Result` y `.Wait()` es la fidelidad de las excepciones. `Task.Result` y `Task.Wait()` son anteriores a `async`/`await`; vienen de la Task Parallel Library de .NET 4.0, donde un solo `Task` (piensa en `Task.WhenAll`) podía fallar con varias excepciones a la vez. Para representar eso, envuelven lo que salió mal en un `AggregateException`, incluso cuando hay exactamente una excepción interna. `GetAwaiter().GetResult()` se añadió con `async`/`await` en .NET 4.5 y sigue la convención de `await`: lanza la primera excepción directamente, sin envolver.

```csharp
// .NET 11, C# 14 -- same failing task, three different exceptions surfaced
static async Task<int> FailAsync()
{
    await Task.Yield();
    throw new InvalidOperationException("boom");
}

// .Result -> throws AggregateException wrapping InvalidOperationException
try { _ = FailAsync().Result; }
catch (Exception ex) { Console.WriteLine(ex.GetType().Name); } // AggregateException

// GetAwaiter().GetResult() -> throws InvalidOperationException directly
try { _ = FailAsync().GetAwaiter().GetResult(); }
catch (Exception ex) { Console.WriteLine(ex.GetType().Name); } // InvalidOperationException
```

Si tus bloques `catch` están escritos para `InvalidOperationException` (como deberían), `.Result` los esquiva silenciosamente porque la excepción llega envuelta. Terminas atrapando `AggregateException` y llamando a `.InnerException`, o peor, la excepción queda sin manejar porque nadie esperaba el envoltorio. `GetAwaiter().GetResult()` evita todo eso. Por eso la guía estándar, que se remonta a la serie "A Tour of Task" de Stephen Cleary, es: si no te queda otra que bloquear, bloquea con `GetAwaiter().GetResult()`.

También funciona sobre un `Task` no genérico, así que es la única llamada bloqueante que cubre tanto "ejecuta esto y espera" como "ejecuta esto y dame el valor":

```csharp
// .NET 11, C# 14 -- blocks and unwraps, whether or not there is a return value
SaveAsync().GetAwaiter().GetResult();               // Task, no value
int count = CountAsync().GetAwaiter().GetResult();   // Task<int>, value
```

## Por qué .Result y .Wait() son estrictamente peores

`.Result` y `.Wait()` hacen todo lo que hace `GetAwaiter().GetResult()` (bloquear el hilo, la misma exposición al interbloqueo) y añaden el envoltorio `AggregateException` encima. No hay escenario en el que el envoltorio te ayude cuando la tarea es una sola operación lógica. El único lugar donde `.Result` se lee de forma aceptable es sobre una tarea que ya sabes que completó, donde no bloqueará:

```csharp
// .NET 11, C# 14 -- .Result on a known-completed task does not block
if (task.IsCompletedSuccessfully)
{
    var value = task.Result;   // safe: completed, so no wait, no deadlock
}
```

Incluso ahí, `GetAwaiter().GetResult()` es un sustituto perfecto y mantiene uniforme tu manejo de excepciones si la suposición sobre la finalización alguna vez resulta falsa. `.Wait()` tiene el uso legítimo más estrecho: esperar sobre un `Task` de tipo "dispara y olvida" donde deliberadamente no quieres un valor de retorno y estás manejando `AggregateException` de forma explícita. En la práctica eso es raro, y suele ser señal de que el trabajo debería haberse estructurado como un trabajo en segundo plano propio. Si estás ejecutando trabajo fuera del hilo de solicitud, hazlo con los patrones de [ejecutar trabajo de dispara-y-olvida de forma segura con BackgroundService](/es/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) en lugar de bloquear sobre una tarea suelta.

Hay una trampa real con `.Wait(timeout)` y `.Wait(cancellationToken)`. Hacen que la espera se rinda antes, lo que parece resiliencia pero no lo es. Un `Wait(5000)` que devuelve `false` no canceló la operación subyacente; la tarea sigue ejecutándose, su continuación sigue en cola, y simplemente dejaste de esperarla. Has tapado un cuelgue con un número mágico. Si necesitas acotar una operación, cancélala como es debido, como se cubre en [agotar el tiempo de una operación asíncrona con CancellationTokenSource.CancelAfter](/es/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/).

## El detalle que decide por ti: interbloqueos y ValueTask

Dos cosas pueden quitarte la elección por completo.

**Un `SynchronizationContext` capturado.** Si el hilo sobre el que bloqueas posee un contexto de un solo hilo (un hilo de interfaz de WPF o WinForms, un hilo de solicitud de ASP.NET clásico), cada opción bloqueante de esta comparación puede provocar un interbloqueo, y cambiar entre ellas no ayuda. `GetAwaiter().GetResult()` se interbloquea exactamente en el mismo punto que `.Result`; el mejor comportamiento de excepciones es un pobre consuelo cuando la aplicación se cuelga. El mecanismo, y cada arreglo en orden de preferencia, está en [por qué bloquear sobre un método asíncrono provoca un interbloqueo y cómo arreglarlo](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/). La versión corta: en un hilo de interfaz o de ASP.NET clásico, no bloquees en absoluto. En ASP.NET Core no hay `SynchronizationContext`, así que no obtendrás este interbloqueo específico, pero bloquear igual causa inanición del thread pool bajo carga, lo cual es más difícil de diagnosticar porque solo aparece con concurrencia.

**Un `ValueTask<T>`.** Si el método devuelve `ValueTask<T>` en lugar de `Task<T>`, ninguno de los miembros bloqueantes es seguro de usar directamente. Un `ValueTask` puede estar respaldado por un `IValueTaskSource` que puede reutilizarse después de consumir el valor, y solo puede consumirse una vez. Llamar a `.Result` o `.GetAwaiter().GetResult()` sobre un `ValueTask` que no ha completado es comportamiento indefinido, y hacer await de él dos veces es un error. Si te entregan un `ValueTask<T>` y de verdad no puedes hacerle await, conviértelo primero en un `Task<T>` con `.AsTask()` y bloquea sobre eso:

```csharp
// .NET 11, C# 14 -- never block a ValueTask directly; materialize a Task first
ValueTask<int> vt = ReadValueAsync();
int value = vt.AsTask().GetAwaiter().GetResult();   // safe
// int bad = vt.Result;                              // undefined if not completed
```

La regla más limpia es: haz `await` de un `ValueTask` exactamente una vez y nunca lo almacenes. Bloquear sobre uno es un mal olor de diseño sobre otro mal olor de diseño. Para el conjunto completo de restricciones, ve la nota sobre [cuándo vale la pena ValueTask](/es/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

## Hacer que bloquear sea innecesario

La mayoría de las veces el arreglo honesto es eliminar la llamada bloqueante, no elegir la menos dañina. Bloquear casi siempre existe porque alguien dejó de propagar `async` en una capa que podía haber seguido. Una acción de controlador síncrona que llama a un repositorio asíncrono, un manejador de eventos `void` que "solo necesita el valor ya": ambos pueden normalmente volverse `async Task` (o `async void` para el manejador, el único lugar donde es legítimo). El límite entre un `async void` correcto y un error se detalla en [cuándo async void es correcto y cuándo es una trampa](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

Cuando haces que una cadena sea asíncrona de arriba abajo, toda la comparación de este artículo se evapora. Nunca tocas `.Result`, `.Wait()` ni `GetAwaiter().GetResult()`, porque siempre tienes un `await` disponible. Esa es la recomendación real escondida detrás de la matriz de decisión: la mejor llamada bloqueante es la que refactorizaste hasta eliminarla.

## La recomendación, reafirmada

- **Usa `await` por defecto.** No bloquea, escala y lanza la excepción original. Si el método contenedor puede ser `async`, esta es la respuesta, punto.
- **Si de verdad no puedes ser asíncrono, bloquea con `GetAwaiter().GetResult()`.** Bloquea como las demás pero lanza la excepción real en lugar de un `AggregateException`, y funciona tanto sobre `Task` como sobre `Task<T>`.
- **Evita `.Result` y `.Wait()`** salvo sobre una tarea que ya sabes que completó. Añaden el envoltorio `AggregateException` sin beneficio en operaciones individuales.
- **Nunca bloquees en un hilo de interfaz o de ASP.NET clásico**, y nunca bloquees un `ValueTask` directamente. El primero se interbloquea; el segundo es comportamiento indefinido. Convierte el `ValueTask` en un `Task` con `.AsTask()` si no tienes alternativa.

Trata cada llamada bloqueante como un `TODO` para hacer asíncrono al llamador. La versión de tu código que nunca bloquea es más rápida, a prueba de interbloqueos, y tiene excepciones más limpias gratis.

## Relacionados

- [Fix: interbloqueo al llamar a .Result o .Wait() sobre un método asíncrono en C#](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [Cuándo async void es correcto y cuándo es una trampa en C#](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [ConfigureAwait(false) frente al valor por defecto en .NET 11: todavía importa?](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Qué es ValueTask y cuándo vale la pena?](/es/2026/06/what-is-valuetask-and-when-is-it-worth-it/)
- [Cómo agotar el tiempo de una operación asíncrona con CancellationTokenSource.CancelAfter en C#](/es/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)

## Fuentes

- [A Tour of Task, Part 6: Results](https://blog.stephencleary.com/2014/12/a-tour-of-task-part-6-results.html) -- Stephen Cleary
- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
- [TaskAwaiter.GetResult Method](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.taskawaiter.getresult) -- Microsoft Learn
- [Task exception handling in .NET](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/task-exception-handling) -- Microsoft Learn
- [ValueTask Restrictions](https://blog.stephencleary.com/2020/03/valuetask.html) -- Stephen Cleary
