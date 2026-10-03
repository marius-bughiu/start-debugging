---
title: "Cómo esperar un ValueTask de forma síncrona en un método no asíncrono sin asignar memoria"
description: "Comprueba primero IsCompleted y lee el resultado con GetAwaiter().GetResult(), lo que cuesta 0 bytes. Recurre al bloqueo solo cuando el ValueTask sigue pendiente, y hazlo con un evento en caché y UnsafeOnCompleted en lugar de AsTask(), que asigna entre 72 y 208 bytes por llamada. Medido en .NET 10 y .NET 11 RC1."
pubDate: 2026-10-03
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "valuetask"
  - "performance"
lang: "es"
translationOf: "2026/10/how-to-wait-for-a-valuetask-synchronously-without-allocating"
translatedBy: "claude"
translationDate: 2026-10-03
---

Para leer un `ValueTask<T>` desde un método síncrono sin asignar memoria, comprueba primero `IsCompleted`. Si ya terminó, llama una sola vez a `vt.GetAwaiter().GetResult()` y listo: 0 bytes, unos 3 ns. Si sigue pendiente, tienes que bloquear. `vt.AsTask().GetAwaiter().GetResult()` es la alternativa segura estándar, pero asigna un contenedor `Task<T>` en cada llamada. Un pequeño helper que hace spin brevemente y luego espera en un `ManualResetEventSlim` en caché mediante `UnsafeOnCompleted` bloquea con cero asignaciones. Nunca llames a `.Result` ni a `.GetAwaiter().GetResult()` sobre un `ValueTask` que no ha terminado: para instancias respaldadas por `IValueTaskSource` eso es comportamiento indefinido, y en la práctica lanza `InvalidOperationException`. Todas las cifras de abajo se midieron en un Apple M4 con el SDK 10.0.302 (.NET 10, C# 14) y se repitieron con el SDK 11.0.100-rc.1.26425.128 (.NET 11 RC1).

## Por qué bloquear un ValueTask es distinto de bloquear un Task

Un `Task<T>` es un tipo de referencia que admite bloqueo. `Task.Wait()`, `.Result` y `GetAwaiter().GetResult()` hacen spin un momento y luego detienen el hilo en un evento hasta que la tarea termina. Llamarlos sobre un `Task` sin terminar es lento y arriesgado (interbloqueos, agotamiento del grupo de hilos), pero la llamada en sí está definida: espera.

Un `ValueTask<T>` es un struct que envuelve una de tres cosas: un resultado `T` simple, un `Task<T>`, o un `IValueTaskSource<T>` más un token `short`. El tercer caso es el que rompe el bloqueo. `IValueTaskSource<T>` expone `GetStatus`, `OnCompleted` y `GetResult`, y nada en ese contrato dice que `GetResult` deba esperar. La [documentación de ValueTask&lt;TResult&gt;](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1) enumera cuatro cosas que nunca debes hacer con una instancia, entre ellas "usar `.Result` o `.GetAwaiter().GetResult()` cuando la operación aún no ha terminado", y dice claramente que si lo haces, "los resultados son indefinidos". El [artículo de diseño de ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/) de Stephen Toub explica el motivo: la fuente "no necesita admitir el bloqueo hasta que la operación termine, y probablemente no lo hace".

Las fuentes que importan en la práctica no lo admiten. `Socket`, `NetworkStream`, `System.IO.Pipelines` y `System.Threading.Channels` entregan `ValueTask`s respaldados por objetos `IValueTaskSource` agrupados en un pool, y la mayoría de las fuentes escritas a mano usan `ManualResetValueTaskSourceCore<T>`, que lanza una excepción si pides el resultado demasiado pronto.

## Un repro mínimo del caso indefinido

Aquí tienes una fuente agrupada que completa en el grupo de hilos, con la misma forma que usa `Socket` internamente:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
using System.Threading.Tasks.Sources;

sealed class PooledSource : IValueTaskSource<int>, IThreadPoolWorkItem
{
    private ManualResetValueTaskSourceCore<int> _core;

    public ValueTask<int> StartAsync()
    {
        _core.Reset();
        ThreadPool.UnsafeQueueUserWorkItem(this, preferLocal: false);
        return new ValueTask<int>(this, _core.Version);
    }

    void IThreadPoolWorkItem.Execute() { Thread.SpinWait(50); _core.SetResult(42); }

    public int GetResult(short token) => _core.GetResult(token);
    public ValueTaskSourceStatus GetStatus(short token) => _core.GetStatus(token);
    public void OnCompleted(Action<object?> c, object? s, short token,
        ValueTaskSourceOnCompletedFlags f) => _core.OnCompleted(c, s, token, f);
}
```

Bloquéalo como bloquearías un `Task`:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
var src = new PooledSource();
int r = src.StartAsync().GetAwaiter().GetResult();
// System.InvalidOperationException:
//   Operation is not valid due to the current state of the object.
```

En ambos SDK esto lanza la excepción de inmediato. `ManualResetValueTaskSourceCore<T>.GetResult` comprueba si la operación ha terminado y lanza una excepción si no. Ese es el resultado amable. Una fuente personalizada que no proteja este caso puede devolver `default(T)`, devolver el resultado de una operación anterior que reutilizó el mismo objeto del pool, o corromper su propio estado. El código que "funciona" en desarrollo porque la operación termina rápido puede fallar en producción bajo carga. Lo mismo aplica al `ValueTask` no genérico.

## Paso 1: leer un ValueTask completado sin coste

La mayoría de las APIs con `ValueTask` existen porque normalmente completan de forma síncrona: un acierto de caché, una lectura con búfer, un canal que ya tiene un elemento. Cuando eso se cumple, no hay nada que esperar, y la documentación permite leer `.Result` o `GetAwaiter().GetResult()` una vez que la instancia ha terminado. `SocketsHttpHandler` en `System.Net.Http` usa exactamente esta ruta rápida con `IsCompletedSuccessfully`.

```csharp
// .NET 10 / .NET 11 RC1, C# 14
ValueTask<int> vt = cache.GetAsync(key);

if (vt.IsCompleted)
{
    // Allowed: the operation is finished, and we consume it exactly once.
    int value = vt.GetAwaiter().GetResult();
}
```

En un helper síncrono, prefiere `IsCompleted` más `GetAwaiter().GetResult()` frente a `IsCompletedSuccessfully` más `.Result`. `IsCompleted` también es true para instancias con error y canceladas, y `GetAwaiter().GetResult()` vuelve a lanzar la excepción original (una `InvalidOperationException` sigue siendo una `InvalidOperationException`), igual que lo haría `await`. Si solo compruebas `IsCompletedSuccessfully`, un `ValueTask` con error cae en tu ruta lenta y se envuelve en un `Task` solo para que puedas observar su excepción.

Esto es lo que ahorra la ruta rápida frente al consejo habitual de llamar primero a `AsTask()`, para un `ValueTask<int>` que ya contiene el valor 42 (200 000 iteraciones, `GC.GetTotalAllocatedBytes(precise: true)` antes y después):

| Enfoque, `ValueTask<int>` ya completado | .NET 10 | .NET 11 RC1 |
| --- | --- | --- |
| `vt.AsTask().GetAwaiter().GetResult()` | 72 B, ~22 ns | 72 B, ~20 ns |
| `vt.IsCompleted` y luego `vt.GetAwaiter().GetResult()` | 0 B, ~3 ns | 0 B, ~3 ns |

`AsTask()` sobre un `ValueTask` respaldado por un valor tiene que fabricar un `Task<T>` mediante `Task.FromResult`, y el runtime solo guarda en caché esos objetos para unos pocos valores (`true`, `false` y enteros pequeños de -1 a 8). Tu objeto `User`, o el entero 42, recibe una tarea nueva de 72 bytes cada vez. Para un valor que nunca necesitó espera, esa asignación no aporta nada.

## Paso 2: bloquear un ValueTask pendiente sin AsTask

Cuando `IsCompleted` es false, tienes que esperar. La opción segura documentada es `vt.AsTask().GetAwaiter().GetResult()`, que la [comparación de .Result frente a GetAwaiter().GetResult()](/es/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) recomienda precisamente para esta situación. Es correcta, pero en una instancia respaldada por `IValueTaskSource`, `AsTask()` asigna una subclase dedicada de `Task<T>` que se registra en la fuente, y si la espera dura lo suficiente como para que `Task` deje de hacer spin y detenga el hilo, la maquinaria de bloqueo asigna un segundo objeto para el evento.

Puedes evitar ambos usando directamente el awaiter. `UnsafeOnCompleted` del awaiter registra una continuación `Action` simple en la fuente o la tarea subyacente y no captura el `ExecutionContext`. Si esa `Action` es un delegado en caché hacia un `ManualResetEventSlim.Set` en caché, registrarla no asigna nada:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
public static class ValueTaskSyncExtensions
{
    [ThreadStatic] private static ManualResetEventSlim? t_event;
    [ThreadStatic] private static Action? t_set;

    public static T WaitSync<T>(this ValueTask<T> task)
    {
        if (task.IsCompleted)
            return task.GetAwaiter().GetResult();   // fast path, 0 bytes

        // Short spin: many pending operations finish within microseconds.
        // Polling IsCompleted calls GetStatus, which may be called repeatedly.
        var spinner = new SpinWait();
        while (!task.IsCompleted && !spinner.NextSpinWillYield)
            spinner.SpinOnce();
        if (task.IsCompleted)
            return task.GetAwaiter().GetResult();

        var mres = t_event ??= new ManualResetEventSlim(false, spinCount: 0);
        var set = t_set ??= mres.Set;
        mres.Reset();

        var awaiter = task.ConfigureAwait(false).GetAwaiter();
        awaiter.UnsafeOnCompleted(set);             // no ExecutionContext capture
        mres.Wait();
        return awaiter.GetResult();                 // consume exactly once
    }

    public static void WaitSync(this ValueTask task)
    {
        if (task.IsCompleted) { task.GetAwaiter().GetResult(); return; }

        var spinner = new SpinWait();
        while (!task.IsCompleted && !spinner.NextSpinWillYield)
            spinner.SpinOnce();
        if (task.IsCompleted) { task.GetAwaiter().GetResult(); return; }

        var mres = t_event ??= new ManualResetEventSlim(false, spinCount: 0);
        var set = t_set ??= mres.Set;
        mres.Reset();

        var awaiter = task.ConfigureAwait(false).GetAwaiter();
        awaiter.UnsafeOnCompleted(set);
        mres.Wait();
        awaiter.GetResult();
    }
}
```

Los detalles que lo hacen correcto:

1. **Un solo consumo.** El `ValueTask` se lee exactamente una vez, mediante `GetResult()`, después de que la continuación se haya disparado. Sondear `IsCompleted` no cuenta como consumo; llama a `GetStatus` en la fuente, que puede invocarse repetidamente antes de leer el resultado.
2. **Un evento por hilo.** Un hilo bloqueado solo puede esperar una cosa a la vez, así que un evento `[ThreadStatic]` basta, y no pueden producirse esperas anidadas en el mismo hilo mientras está bloqueado. El delegado `Action` en caché también se crea una sola vez por hilo.
3. **`ConfigureAwait(false)`.** Sin él, se le indicaría a la fuente que ejecute la continuación en el `SynchronizationContext` capturado. En un hilo de UI, ese contexto es el hilo que estás bloqueando, así que `Set` nunca se ejecutaría. Con `ConfigureAwait(false)` la continuación se ejecuta donde la fuente complete.
4. **`UnsafeOnCompleted`, no `OnCompleted`.** La variante segura captura y restaura el `ExecutionContext`, lo cual no sirve de nada para un delegado que solo activa un evento.
5. **Spin antes de detener el hilo.** El bloqueo de `Task` hace spin antes de dormir, y este helper también debería. En la primera versión de mi benchmark detenía el hilo de inmediato (`spinCount: 0`, sin bucle de spin), y fue aproximadamente el doble de lento que `AsTask()` en operaciones cortas porque cada espera pagaba una transición al kernel.

## Qué dicen las cifras

Mismo arnés, 200 000 iteraciones para operaciones cortas y 2 000 para el caso de 1 ms, con los bytes por llamada medidos en todos los hilos:

| `ValueTask<int>` pendiente | Enfoque | .NET 10 | .NET 11 RC1 |
| --- | --- | --- | --- |
| `IValueTaskSource`, completa en microsegundos | `AsTask().GetAwaiter().GetResult()` | 80 B | 80 B |
| `IValueTaskSource`, completa en microsegundos | `WaitSync()` | 0 B | 0 B |
| `IValueTaskSource`, completa tras ~1 ms | `AsTask().GetAwaiter().GetResult()` | 144 B | 208 B |
| `IValueTaskSource`, completa tras ~1 ms | `WaitSync()` | 0 B | 0 B |
| Respaldado por `Task` (`Task.Run`) | `AsTask().GetAwaiter().GetResult()` | 72 B | 72 B |
| Respaldado por `Task` (`Task.Run`) | `WaitSync()` | 72 B | 72 B |

Los bytes fraccionarios que reportó el arnés para `WaitSync()` (0.1 a 0.3 B por llamada) son contabilidad interna del grupo de hilos, no asignaciones por llamada. Los 72 B de las filas respaldadas por `Task` son el `Task<int>` que crea el propio `Task.Run`. Para un `ValueTask` respaldado por un `Task`, `AsTask()` simplemente devuelve la tarea envuelta, así que ninguno de los dos enfoques añade nada ahí.

La latencia no es donde gana el helper. En operaciones cortas, ambos enfoques tardaron entre 1 y 6 microsegundos por llamada, con un ruido entre ejecuciones mayor que la diferencia entre ellos. En el caso de 1 ms, ambos quedaron a menos del 1% uno del otro, porque la espera domina. Si tu objetivo es la velocidad y no las asignaciones, lo único que realmente ayuda es la ruta rápida del Paso 1, y después de eso, no bloquear en absoluto.

Así que el resumen honesto es: la comprobación de `IsCompleted` es gratis y ahorra 72 bytes en cada finalización síncrona, que es el caso común de cualquier API que se ganó su tipo de retorno `ValueTask`. El helper de bloqueo ahorra entre 80 y 208 bytes adicionales en la ruta lenta, lo cual solo importa si esa ruta lenta es en sí misma crítica.

## Casos límite y advertencias

**Esto no arregla los interbloqueos de sync-over-async.** `ConfigureAwait(false)` en *tu* awaiter solo controla dónde se ejecuta *tu* continuación. Si el método asíncrono que estás bloqueando tiene un `await` sin `ConfigureAwait(false)` en su interior, y llamas a `WaitSync()` desde un hilo de WPF, WinForms, MAUI o ASP.NET clásico, esa continuación interna se encola en el hilo que acabas de bloquear, y caes en un interbloqueo exactamente como con `.Result`. El mecanismo y las soluciones están en [por qué bloquear un método asíncrono provoca un interbloqueo](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

**Tampoco arregla el agotamiento del grupo de hilos.** Un hilo del grupo detenido en `mres.Wait()` es un hilo que el grupo no puede usar para ejecutar la misma continuación que lo despertaría. Cero asignaciones no significa coste cero. Úsalo en fronteras síncronas genuinas (un método `Dispose`, una interfaz síncrona que no controlas, una sobrescritura de `Stream.Read` implementada sobre un núcleo asíncrono), no como una forma de evitar hacer asíncrona una cadena de llamadas. Si la frontera se puede mover, [migrar las llamadas bloqueantes a async de punta a punta](/es/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/) sigue siendo la solución real.

**No vuelvas a tocar el ValueTask después de `WaitSync()`.** Una vez que se ha llamado a `GetResult`, una fuente agrupada puede estar ya atendiendo una operación distinta. Copiar el struct y esperar la copia más tarde es el mismo error que esperarlo dos veces. CA2012 ("Use ValueTasks correctly") detecta las versiones obvias, pero no todas, porque el analizador no puede seguir un `ValueTask` a través de un método helper como este. La [explicación de ValueTask](/es/2026/06/what-is-valuetask-and-when-is-it-worth-it/) cubre el contrato completo de await una sola vez.

**`Preserve()` no es un atajo.** `ValueTask<T>.Preserve()` devuelve una instancia que puedes consumir varias veces, pero para una instancia pendiente respaldada por `IValueTaskSource` lo hace llamando internamente a `AsTask()`, así que asigna el mismo contenedor que intentabas evitar.

**Las excepciones salen sin envolver.** Como el helper termina en `GetAwaiter().GetResult()`, una operación con error lanza su tipo de excepción original, igual que `await`. En el arnés, un `ValueTask<int>` que lanzó `InvalidOperationException` tras un `Task.Yield()` apareció como `InvalidOperationException` desde `WaitSync()`, no como una `AggregateException`.

**La cancelación aparece como `OperationCanceledException`.** Si la operación se canceló, `GetResult` lanza `TaskCanceledException` u `OperationCanceledException` según la fuente. El helper de arriba no tiene una sobrecarga con tiempo de espera. Si necesitas una, pasa un tiempo de espera a `mres.Wait`, y al agotarse no vuelvas a tocar el `ValueTask`: su continuación sigue registrada y llamará a `Set` sobre tu evento thread-static más adelante, así que también debes reemplazar `t_event` y `t_set` por instancias nuevas antes de la siguiente espera en ese hilo.

**Si eres el dueño de la API, plantéate si debería ser `ValueTask` en absoluto.** Un método que se consume rutinariamente de forma síncrona es un método cuyos llamadores luchan contra su tipo de retorno. Expón un hermano síncrono `TryGet` para la ruta rápida, o vuelve a `Task<T>` como se describe en [migrar de ValueTask de vuelta a Task](/es/2026/06/migrate-from-valuetask-back-to-task-when-and-why/).

## La decisión, en orden

1. Si puedes usar `await`, usa `await`. Todo lo de este artículo es para fronteras síncronas que no puedes eliminar.
2. Comprueba `IsCompleted`. Si es true, `GetAwaiter().GetResult()` una vez. Cero asignaciones, tipo de excepción original.
3. Si está pendiente y la llamada no es crítica, `AsTask().GetAwaiter().GetResult()` es correcto y aburrido. Úsalo.
4. Si está pendiente y es lo bastante crítica como para que 80 a 208 bytes por llamada aparezcan en un profiler, usa el helper `WaitSync()` de arriba.
5. Nunca llames a `.Result` ni a `GetAwaiter().GetResult()` sobre un `ValueTask` pendiente. Es indefinido, y con `ManualResetValueTaskSourceCore<T>` lanza una excepción.

## Relacionado

- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await en C#](/es/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) cubre el lado de `Task` de la misma pregunta.
- [Qué es ValueTask y cuándo vale la pena](/es/2026/06/what-is-valuetask-and-when-is-it-worth-it/) explica el pooling de `IValueTaskSource` y la regla de await una sola vez.
- [Migrar de ValueTask de vuelta a Task](/es/2026/06/migrate-from-valuetask-back-to-task-when-and-why/) es la opción cuando los llamadores siguen necesitando acceso síncrono.
- [Soluciona el interbloqueo al llamar a .Result o .Wait() en un método asíncrono](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) explica por qué nada de esto es seguro en un hilo de UI.

## Fuentes

- [ValueTask&lt;TResult&gt; Struct](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1), Microsoft Learn (observaciones sobre el uso indefinido)
- [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/), Stephen Toub, .NET Blog
- [IValueTaskSource&lt;TResult&gt; Interface](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.ivaluetasksource-1), Microsoft Learn
- [ManualResetValueTaskSourceCore&lt;TResult&gt; Struct](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.manualresetvaluetasksourcecore-1), Microsoft Learn
- [CA2012: Use ValueTasks correctly](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012), Microsoft Learn
- [ValueTask.cs in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/ValueTask.cs)
