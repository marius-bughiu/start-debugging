---
title: "Thread.Sleep vs Task.Delay vs SpinWait para esperar en C#"
description: "Usa await Task.Delay para cualquier espera temporizada en código asíncrono, Thread.Sleep solo en un hilo dedicado que tú controlas, y SpinWait solo para esperas de menos de un microsegundo dentro de código sin bloqueos. Para esperar una condición, usa una señal (ManualResetEventSlim, SemaphoreSlim, TaskCompletionSource) en lugar de cualquiera de los tres. Medido en .NET 10.0.10."
pubDate: 2026-10-14
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "async"
  - "performance"
lang: "es"
translationOf: "2026/10/thread-sleep-vs-task-delay-vs-spinwait-for-waiting-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-14
---

Para una pausa temporizada, usa `await Task.Delay(...)` en cualquier código asíncrono, porque libera el hilo mientras espera. Usa `Thread.Sleep` solo en un hilo que creaste tú mismo (un bucle de consola, un worker dedicado), nunca en un hilo del pool de hilos ni en un hilo de UI. Usa `SpinWait` solo cuando esperas que la espera termine en unos pocos microsegundos, normalmente dentro de código sin bloqueos. Y si en realidad estás esperando a que **ocurra algo** en lugar de a que pase el tiempo, ninguna de las tres es la herramienta correcta: usa una señal como `ManualResetEventSlim`, `SemaphoreSlim` o un `TaskCompletionSource`, que en mis mediciones despertaron aproximadamente 50 veces más rápido que cualquier bucle de sondeo.

Todos los números de este artículo se midieron en .NET 10.0.10 (SDK 10.0.302), C# 14, en un Apple M4 de 10 núcleos con macOS 26.6. Las APIs en sí no han cambiado en años: `Task.Delay` existe desde .NET Framework 4.5, `SpinWait` desde 4.0, y todo lo que se explica aquí aplica igualmente a .NET 8, 9 y las versiones preliminares de .NET 11.

## La comparación de un vistazo

| | `Thread.Sleep` | `await Task.Delay` | `SpinWait` |
| --- | --- | --- | --- |
| Retiene el hilo mientras espera | Sí, bloqueado | No, el hilo vuelve al pool | Sí, ejecutándose o cediendo |
| CPU mientras espera (500 ms, medido) | 0 ms | 0 ms | 4 ms con `SpinUntil`, 500 ms con `SpinOnce(-1)` |
| Espera real más corta (`1` ms solicitado, macOS) | ~1.5 ms | ~1.3 ms | ~1 us por giro inicial |
| Espera real más corta en Windows (temporizador por defecto) | ~1-15.6 ms | ~15.6 ms | ~1 us por giro inicial |
| Cancelable | No | Sí, mediante `CancellationToken` | Solo con tu propia condición |
| Se puede probar con tiempo simulado | No | Sí, `Task.Delay(TimeSpan, TimeProvider)` (.NET 8+) | No |
| Seguro en un hilo del pool de hilos | No | Sí | Solo durante microsegundos |
| Seguro en un hilo de UI | No, congela la UI | Sí | No |
| Uso típico | Bucles en hilos dedicados, herramientas de consola rápidas | Backoff de reintentos, limitación de frecuencia, sondeo en código asíncrono | Bucles de reintento sin bloqueos, primitivas que giran y luego bloquean |

## Qué le hace realmente cada una a tu hilo

`Thread.Sleep(ms)` suspende el hilo del sistema operativo que lo llama. El planificador lo saca de la CPU y no lo vuelve a considerar hasta que transcurre el intervalo. No se consume CPU, pero el hilo sigue existiendo, sigue reteniendo su pila y no puede hacer nada más. Eso está bien para un hilo cuyo único trabajo es esperar. Es un problema para un hilo que pertenece a un recurso compartido.

`Task.Delay(ms)` devuelve un `Task` que se completa cuando se dispara un `TimerQueueTimer` interno. Cuando haces `await` sobre él, tu método regresa a quien lo llamó, el hilo vuelve al pool (o al bucle de mensajes de la UI) y el resto del método se programa como continuación cuando el temporizador se dispara. Mientras el retraso está pendiente, no hay ningún hilo asociado a tu método.

`SpinWait` mantiene el hilo en la CPU y vuelve a comprobar. Es un struct con un método que importa, `SpinOnce()`, y su comportamiento depende de cuántas veces lo hayas llamado. Según el [código fuente de .NET 10](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Threading/SpinWait.cs), las constantes son `YieldThreshold = 10`, `Sleep0EveryHowManyYields = 5` y `DefaultSleep1Threshold = 20`:

- Las llamadas 0 a 9 ejecutan `Thread.SpinWait(n)`, un bucle activo de instrucciones de pausa de la CPU que crece en cada iteración.
- A partir de la llamada 10, una de cada dos llamadas cede el intervalo de tiempo con `Thread.Yield()` o `Thread.Sleep(0)`.
- A partir de la llamada 20, cada llamada ejecuta `Thread.Sleep(1)`.
- En una máquina de un solo procesador omite el giro por completo y cede desde la primera llamada, porque girar ahí solo retrasa al hilo que estás esperando.

Así que "`SpinWait`" es menos un giro que una escalera de escalada. Ese detalle decide la mayoría de sus compromisos más abajo.

## Medido: cuánto tarda realmente "esperar 1 ms"

Este probe mide 200 llamadas de cada una e imprime la mediana y el percentil 99:

```csharp
// .NET 10.0.10, C# 14, dotnet run probe.cs
using System.Diagnostics;

foreach (var ms in new[] { 0, 1, 10, 15 })
{
    var sleep = new List<double>();
    for (int i = 0; i < 200; i++)
    {
        var t = Stopwatch.GetTimestamp();
        Thread.Sleep(ms);
        sleep.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
    }

    var delay = new List<double>();
    for (int i = 0; i < 200; i++)
    {
        var t = Stopwatch.GetTimestamp();
        await Task.Delay(ms);
        delay.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
    }

    sleep.Sort(); delay.Sort();
    Console.WriteLine($"{ms} ms: Sleep p50={sleep[100]:F3} | Delay p50={delay[100]:F3}");
}
```

| Solicitado | `Thread.Sleep` p50 | `Thread.Sleep` p99 | `Task.Delay` p50 | `Task.Delay` p99 |
| --- | --- | --- | --- | --- |
| 0 ms | 0.000 ms | 0.015 ms | 0.000 ms | 0.001 ms |
| 1 ms | 1.510 ms | 1.633 ms | 1.297 ms | 1.513 ms |
| 10 ms | 12.012 ms | 12.033 ms | 12.043 ms | 12.083 ms |
| 15 ms | 16.763 ms | 17.071 ms | 17.023 ms | 17.215 ms |

De aquí hay que sacar dos conclusiones. Primero, ambas son "al menos este tiempo", nunca "exactamente este tiempo". En macOS el exceso fue constante, de 0,3 a 2 ms. Segundo, `Task.Delay(0)` se completa de forma síncrona: devuelve una tarea ya completada, así que `await Task.Delay(0)` no cede en absoluto. Si quieres ceder en código asíncrono, `await Task.Yield()` es la API que lo hace.

En Windows la diferencia es mucho mayor. La [documentación de `Task.Delay`](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.delay) indica que el retraso depende del reloj del sistema, cuya resolución es de unos 15 ms en Windows, por lo que `Task.Delay(1)` allí suele tardar alrededor de 15,6 ms. `Thread.Sleep(1)` en Windows puede acercarse a 1 ms o a 15,6 ms según si algún proceso de la máquina ha elevado la resolución global del temporizador. Ninguna de las dos APIs es un temporizador de precisión. Si tu bucle depende de un tick de 1 ms, funcionará a una fracción de la frecuencia que esperas en un equipo Windows con la configuración por defecto.

## Medido: qué le hace `Thread.Sleep` al pool de hilos

La razón real por la que `Thread.Sleep` es peligroso no es la CPU ni la precisión. Es lo que le hace a un pool compartido. Este probe encola 200 elementos de trabajo que esperan un segundo cada uno y luego mide, desde un hilo dedicado, cuánto espera un elemento de trabajo nuevo antes de siquiera empezar:

```csharp
// .NET 10.0.10, C# 14, dotnet run probe3.cs -- sleep|delay
using System.Diagnostics;

string mode = args[0];
var sw = Stopwatch.StartNew();

var tasks = Enumerable.Range(0, 200).Select(_ => Task.Run(async () =>
{
    if (mode == "sleep") Thread.Sleep(1000);
    else await Task.Delay(1000);
})).ToArray();

var sampler = new Thread(() =>
{
    using var started = new ManualResetEventSlim();
    var t = Stopwatch.GetTimestamp();
    ThreadPool.UnsafeQueueUserWorkItem(_ => started.Set(), null);
    started.Wait();
    Console.WriteLine($"new work item waited {Stopwatch.GetElapsedTime(t).TotalMilliseconds:F0} ms");
});
sampler.Start();

Task.WaitAll(tasks);
sampler.Join();
Console.WriteLine($"{mode}: 200 waits done in {sw.ElapsedMilliseconds} ms, pool threads = {ThreadPool.ThreadCount}");
```

| | `Thread.Sleep(1000)` | `await Task.Delay(1000)` |
| --- | --- | --- |
| Tiempo total de las 200 esperas de un segundo | 18,034 ms | 1,005 ms |
| Hilos del pool al final | 12 | 11 |
| Retraso antes de que empezara un elemento de trabajo no relacionado | 17,030 ms | 1 ms |

Con `Task.Delay`, las 200 esperas se solapan y todo el lote tarda un segundo en diez hilos. Con `Thread.Sleep`, el pool solo puede ejecutar a la vez tantas suspensiones como hilos tiene, así que el lote se serializa en grupos de aproximadamente diez, y cualquier otro trabajo encolado detrás, en este caso un trivial `started.Set()`, esperó en la cola **17 segundos**. Ten en cuenta que el pool no resolvió la situación añadiendo hilos: los elementos de trabajo seguían completándose cada segundo, así que su lógica de hill-climbing solo lo hizo crecer de 10 a 12 hilos.

En una aplicación ASP.NET Core, ese elemento de trabajo encolado es la siguiente solicitud HTTP. Este es el patrón clásico de inanición del pool de hilos, y un `Thread.Sleep` dentro de un manejador de solicitudes o de un `BackgroundService` es una de las formas más fáciles de provocarlo. Lo mismo ocurre con `Task.Delay(1000).Wait()`, que es simplemente `Thread.Sleep` con asignaciones extra. Si ese patrón te resulta familiar, el artículo sobre [cómo arreglar interbloqueos por `.Result` y `.Wait()`](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) cubre el lado de sincrónico-sobre-asíncrono.

## Medido: costo de CPU y latencia de despertar de `SpinWait`

`SpinWait.SpinUntil(condition)` suena como si fuera a quemar un núcleo todo el tiempo que esperes. Gracias a la escalera de escalada, no es así:

| Estrategia de espera, 500 ms de tiempo real | Tiempo de CPU usado |
| --- | --- |
| `Thread.Sleep(500)` | 0 ms |
| `await Task.Delay(500)` | 0 ms |
| `SpinWait.SpinUntil(...)` | 4 ms |
| bucle con `SpinOnce(sleep1Threshold: -1)` | 500 ms (un núcleo completo) |
| bucle `while` vacío | 499 ms |

Los primeros 10 giros puros tardaron 9.8 us en total y los giros 10 a 19 otros 10 us. Después de eso, cada `SpinOnce()` es un `Thread.Sleep(1)`, que medí en unos 1,265 us cada uno. Si pasas `sleep1Threshold: -1` para desactivar la etapa de `Sleep(1)`, obtienes exactamente lo que sugiere el nombre: un núcleo al máximo.

La otra mitad del compromiso es qué tan rápido nota cada estrategia que lo que esperaba ya ocurrió. Aquí un segundo hilo activa una bandera tras un retraso aleatorio de 0 a 3 ms, y el hilo principal mide el tiempo desde que se activa la bandera hasta que la detecta (200 ejecuciones cada una):

```csharp
// .NET 10.0.10, C# 14
int flag = 0;
using var ev = new ManualResetEventSlim();
// setter thread: busy-waits a random 0-3 ms, then
//   Volatile.Write(ref flag, 1); ev.Set();

SpinWait.SpinUntil(() => Volatile.Read(ref flag) == 1);       // "spinuntil"
while (Volatile.Read(ref flag) == 0) Thread.Sleep(1);         // "sleep1"
while (Volatile.Read(ref flag) == 0) await Task.Delay(1);     // "delay1"
ev.Wait();                                                    // "mres"
```

| Estrategia | Retraso de despertar p50 | Retraso de despertar p90 |
| --- | --- | --- |
| `SpinWait.SpinUntil` | 745 us | 1,182 us |
| Sondeo con `Thread.Sleep(1)` | 710 us | 1,158 us |
| Sondeo con `await Task.Delay(1)` | 836 us | 1,205 us |
| `ManualResetEventSlim.Wait()` | 15 us | 37 us |

Cuando la espera dura más de unos 20 us, `SpinUntil` es solo un bucle de sondeo con `Thread.Sleep(1)` con un nombre más bonito, y no despierta más rápido. La espera basada en eventos fue 50 veces más rápida en la mediana, y no usó CPU mientras esperaba. `ManualResetEventSlim` y `SemaphoreSlim` ya giran brevemente antes de bloquear, así que te dan en una sola llamada la ruta rápida y barata de `SpinWait` y la ruta lenta y eficiente de una espera del kernel.

## Cuándo elegir `await Task.Delay`

- **Reintentos y backoff en código asíncrono.** Un cliente HTTP que reintenta tras un 429, un bucle de reconexión a una base de datos. Pasa el `CancellationToken` de la solicitud para que el apagado o una desconexión del cliente cancele la espera en lugar de dejarla pendiente.
- **Trabajo periódico en un `BackgroundService`.** `await Task.Delay(interval, stoppingToken)` en un bucle está bien. Si quieres ticks que no se desplacen según la duración del trabajo, `PeriodicTimer` (.NET 6+) encaja mejor.
- **Limitación de frecuencia o debouncing en un hilo de UI.** WPF, WinForms, MAUI y Blazor siguen respondiendo porque el hilo de UI queda libre mientras el retraso está pendiente.
- **Cualquier cosa que quieras probar con pruebas unitarias.** La sobrecarga `Task.Delay(TimeSpan, TimeProvider, CancellationToken)` (.NET 8+) permite que una prueba avance el tiempo al instante con `FakeTimeProvider`, que expliqué paso a paso en el artículo sobre [probar código dependiente del tiempo con `TimeProvider`](/es/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).

```csharp
// .NET 10, C# 14
async Task<HttpResponseMessage> GetWithRetryAsync(
    HttpClient http, string url, TimeProvider time, CancellationToken ct)
{
    for (int attempt = 0; ; attempt++)
    {
        var response = await http.GetAsync(url, ct);
        if (response.StatusCode != System.Net.HttpStatusCode.TooManyRequests || attempt == 4)
            return response;

        response.Dispose();
        var backoff = TimeSpan.FromMilliseconds(200 * Math.Pow(2, attempt));
        await Task.Delay(backoff, time, ct); // cancellable, testable, holds no thread
    }
}
```

## Cuándo elegir `Thread.Sleep`

- **Un hilo que creaste y controlas.** Un `new Thread(...)` que sondea hardware o un archivo cada segundo, donde no hay nada más programado en ese hilo. Bloquearlo no cuesta nada que otro necesite.
- **Una herramienta de consola síncrona o un script.** Un `Main` que no es asíncrono y simplemente necesita pausar entre pasos. No hay pool ni hilo de UI que dejar sin recursos.
- **Reproducir el bloqueo a propósito.** Pruebas o demos que necesitan simular una llamada síncrona lenta, como el probe de inanición del pool de más arriba.

Incluso en un hilo dedicado, considera usar `WaitHandle.WaitOne(timeout)` o `CancellationToken.WaitHandle.WaitOne(timeout)`. Espera el mismo intervalo pero regresa antes cuando alguien le pide al hilo que se detenga, algo que `Thread.Sleep` no puede hacer:

```csharp
// .NET 10, C# 14: a dedicated worker thread that can be stopped promptly
void PollLoop(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
    {
        PollDevice();
        ct.WaitHandle.WaitOne(TimeSpan.FromSeconds(1)); // returns immediately on Cancel()
    }
}
```

## Cuándo elegir `SpinWait`

- **Bucles de reintento sin bloqueos.** Un bucle de compare-and-swap que falló porque otro hilo está a mitad de una actualización. El otro hilo terminará en nanosegundos, así que un cambio de contexto costaría más que la espera.
- **La ruta rápida de tu propia primitiva de sincronización.** Gira unas cuantas veces con `SpinOnce()` mientras `NextSpinWillYield` sea falso y luego recurre a una espera bloqueante real. Es la misma estructura que usa internamente `ManualResetEventSlim`.

```csharp
// .NET 10, C# 14: spin briefly, then block
var spinner = new SpinWait();
while (!IsReady())
{
    if (spinner.NextSpinWillYield)
    {
        readyEvent.Wait(); // stop spinning, let the OS park the thread
        break;
    }
    spinner.SpinOnce();
}
```

No uses `SpinWait` para esperas medidas en milisegundos, y no uses `Thread.SpinWait(n)` directamente con un `n` grande. La [documentación de `SpinWait`](https://learn.microsoft.com/dotnet/api/system.threading.spinwait) lo presenta como un bloque de construcción de bajo nivel para código de sincronización, y girar solo compensa cuando la espera esperada es más corta que el costo de un cambio de contexto. Si no estás escribiendo una estructura de datos sin bloqueos ni una primitiva de sincronización, probablemente no lo necesites. El artículo sobre [`lock` vs `Monitor` vs `SemaphoreSlim` vs `System.Threading.Lock`](/es/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) cubre las primitivas de más alto nivel que ya hacen este giro por ti.

## El detalle que decide por ti: ¿esperas tiempo o un evento?

La mayoría de las llamadas a `Thread.Sleep` y `Task.Delay` que veo en las revisiones de código no son realmente esperas temporizadas. Son bucles de sondeo: "dormir 100 ms, comprobar si el trabajo terminó, repetir". Ese patrón pierde siempre en ambos ejes. Añade hasta un intervalo de latencia después del evento y se despierta para nada mientras tanto.

Si otra parte de tu programa provoca el evento, señálalo directamente:

```csharp
// .NET 10, C# 14: replace "while (!done) await Task.Delay(100);"
var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

_ = Task.Run(async () =>
{
    await DoWorkAsync();
    completion.TrySetResult();
});

await completion.Task.WaitAsync(TimeSpan.FromSeconds(30)); // a real timeout, no polling
```

`RunContinuationsAsynchronously` evita que el código que espera `completion.Task` se ejecute en línea en el hilo que llama a `TrySetResult`. `WaitAsync(TimeSpan)` (.NET 6+) te da el tiempo de espera máximo sin un `Task.WhenAny(task, Task.Delay(...))` armado a mano. Para traspasos productor/consumidor usa un `Channel<T>`, y para "como máximo N a la vez" usa `SemaphoreSlim.WaitAsync`. Sondea solo cuando el evento ocurre fuera de tu proceso y nada puede notificarte, como un endpoint de estado de un trabajo remoto. En ese caso, `await Task.Delay` con un `CancellationToken` es el intervalo de sondeo correcto.

## Recomendación

Usa por defecto `await Task.Delay(interval, cancellationToken)`. No retiene ningún hilo, no usa CPU, se puede cancelar y, con un `TimeProvider`, se puede probar sin esperar de verdad. En la medición anterior terminó 200 esperas de un segundo en 1 segundo, mientras que `Thread.Sleep` tardó 18 segundos y bloqueó trabajo no relacionado durante 17 de ellos.

Usa `Thread.Sleep` solo en un hilo que nada más comparta, y prefiere un `WaitHandle.WaitOne(timeout)` cancelable incluso ahí. Usa `SpinWait` solo para esperas más cortas que un cambio de contexto dentro de código sin bloqueos o de sincronización; para cualquier cosa más larga se degrada de todos modos en un bucle de `Sleep(1)`. Y antes de elegir cualquiera de ellos, pregúntate si estás esperando tiempo o a que ocurra algo. Si es lo segundo, un `TaskCompletionSource`, `ManualResetEventSlim`, `SemaphoreSlim` o `Channel<T>` te despertará unas 50 veces antes.

### Sigue leyendo

- [Cómo agotar el tiempo de espera de una operación asíncrona con `CancellationTokenSource.CancelAfter`](/es/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)
- [Cómo cancelar una tarea de larga duración en C# sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [`Task.Run` vs `Task.Factory.StartNew` vs `ThreadPool.QueueUserWorkItem`](/es/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/)
- [`Volatile.Read` vs `Volatile.ReadBarrier` en .NET 10](/es/2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10/)

### Fuentes

- [Referencia de la API `Thread.Sleep`](https://learn.microsoft.com/dotnet/api/system.threading.thread.sleep), Microsoft Learn
- [Referencia de la API `Task.Delay`](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.delay), incluida la nota sobre la resolución del reloj del sistema
- [Referencia de la API `SpinWait`](https://learn.microsoft.com/dotnet/api/system.threading.spinwait), Microsoft Learn
- [`SpinWait.cs` en v10.0.0](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Threading/SpinWait.cs), dotnet/runtime
- [Depurar la inanición del pool de hilos](https://learn.microsoft.com/dotnet/core/diagnostics/debug-threadpool-starvation), documentación de diagnóstico de .NET
- [Descripción general de `TimeProvider`](https://learn.microsoft.com/dotnet/standard/datetime/timeprovider-overview), Microsoft Learn
