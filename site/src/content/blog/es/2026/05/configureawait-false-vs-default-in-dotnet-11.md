---
title: "ConfigureAwait(false) vs el valor por defecto en .NET 11: ¿sigue importando?"
description: "ConfigureAwait(false) sigue siendo obligatorio en código de biblioteca que pueda ejecutarse bajo un SynchronizationContext (WinForms, WPF, MAUI). En código de aplicación sobre ASP.NET Core, una aplicación de consola o un servicio worker que se ejecute en .NET 11, no hace nada."
pubDate: 2026-05-21
tags:
  - "comparison"
  - "csharp"
  - "async"
  - "dotnet-11"
lang: "es"
translationOf: "2026/05/configureawait-false-vs-default-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-21
---

Si estás decidiendo si seguir tecleando `.ConfigureAwait(false)` después de cada `await` en tu base de código en .NET 11, la respuesta corta es: en código de aplicación que apunta a ASP.NET Core, una aplicación de consola, un servicio worker basado en el host genérico, o una prueba unitaria, no hace nada y puedes quitarlo. En código de biblioteca que se distribuye como paquete NuGet o en cualquier aplicación de interfaz (WinForms, WPF, MAUI, Avalonia, Uno) o en cualquier host de ASP.NET sobre .NET Framework que aún siga vivo, sigue importando y quitarlo puede provocar interbloqueos en la app llamante o ralentizarla notablemente. La regla práctica no ha cambiado desde que .NET Core 1.0 salió sin `SynchronizationContext` en 2016, y .NET 11 tampoco la cambia, ni siquiera con la nueva generación de código async en runtime introducida en la preview 1 de .NET 11.

Este artículo usa `<TargetFramework>net11.0</TargetFramework>` y `<LangVersion>14.0</LangVersion>` en todos los ejemplos. Cuando un hecho es anterior a .NET 11, la versión en la que se introdujo se indica en el texto.

## Matriz de características

| Comportamiento                                                | `await task` (por defecto)                              | `await task.ConfigureAwait(false)`           | `await task.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing)` |
| ------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Captura el `SynchronizationContext` actual                    | sí                                                      | no                                           | sí                                                                  |
| Captura el `TaskScheduler` actual (si no es `Default`)        | sí                                                      | no                                           | sí                                                                  |
| Reanuda en el contexto capturado (hilo UI, ASP.NET clásico)   | sí                                                      | no, reanuda en el pool de hilos              | sí                                                                  |
| Efecto en ASP.NET Core 11                                     | ninguno, no hay `SynchronizationContext`                | ninguno, no hay `SynchronizationContext`     | ninguno sobre el contexto, suprime la excepción                      |
| Efecto en consola / worker / prueba xUnit en .NET 11          | ninguno, el contexto capturado es null                  | ninguno, el contexto capturado es null       | suprime la excepción                                                |
| Puede causar el interbloqueo clásico de UI con `.Result` / `.Wait()` | sí                                                  | no                                           | sí                                                                  |
| Disponible desde                                              | C# 5 / .NET Framework 4.5                               | C# 5 / .NET Framework 4.5                    | `ConfigureAwaitOptions` apareció en .NET 8                          |
| Asigna memoria                                                | sin asignaciones extra (solo la estructura de config)   | sin asignaciones extra                       | sin asignaciones extra                                              |

La tabla es la respuesta. El resto de este artículo es el porqué de cada fila y qué celda aplica al código que estás a punto de escribir.

## Qué captura realmente `await`

Leer las filas de arriba solo te ayuda si recuerdas qué hace `await` por debajo. Cuando el compilador de C# reescribe `await task` invoca `task.GetAwaiter()`, luego, en la suspensión, `awaiter.OnCompleted(continuation)` (o `UnsafeOnCompleted` para `ICriticalNotifyCompletion`). El `TaskAwaiter.OnCompleted` por defecto lee `SynchronizationContext.Current`. Si devuelve un valor no nulo, la continuación se programa con `synchronizationContext.Post(continuation, null)`. Si devuelve null, se consulta `TaskScheduler.Current`; si no es `TaskScheduler.Default`, se captura el scheduler. Si ambos están ausentes (el caso habitual en código de servidor y consola en .NET 11), la continuación va directamente al pool de hilos a través de `ThreadPool.UnsafeQueueUserWorkItem`. Todo esto está documentado en el [código fuente de `TaskAwaiter`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/TaskAwaiter.cs) y en el [artículo original de Stephen Toub sobre `ConfigureAwait`](https://devblogs.microsoft.com/dotnet/configureawait-faq/), que sigue siendo la referencia canónica.

`ConfigureAwait(false)` devuelve un `ConfiguredTaskAwaitable` cuyo awaiter se salta por completo las lecturas de `SynchronizationContext.Current` y `TaskScheduler.Current`. La continuación siempre se envía al pool de hilos. Esa es toda la característica. Es una rama en el runtime.

El trabajo de runtime async en .NET 11, a veces llamado "runtime async" o "async sin boxing", cambia cómo el JIT genera la máquina de estados (ver el [anuncio de .NET 11 Preview 1](https://devblogs.microsoft.com/dotnet/announcing-dotnet-11-preview-1/)) pero no cambia la semántica del contexto capturado. El JIT ahora emite una única continuación especializada en muchos casos en lugar de asignar una caja separada para la máquina de estados, lo que significa que `await` es más barato que en .NET 8. El coste de `ConfigureAwait(false)` relativo a un `await` plano se reduce en consecuencia, pero la diferencia entre ambos en una ruta caliente ya estaba en el rango de un dígito de nanosegundos. El rendimiento no es la razón por la que esta elección importa en 2026.

## Cuándo `ConfigureAwait(false)` sigue importando

Hay tres entornos donde quitar `ConfigureAwait(false)` es un bug real, no una decisión de estilo.

**WinForms, WPF, MAUI, Avalonia y Uno.** Estos frameworks instalan un `SynchronizationContext` en el hilo UI. Una biblioteca que hace `await someTask` dentro de un método llamado desde el hilo UI reanudará en el hilo UI, lo cual es habitualmente un desperdicio si la siguiente línea es más CPU o I/O. Peor aún: si cualquier llamador del proceso hace `someAsyncLibraryCall().Result` o `.Wait()` en el hilo UI, la continuación no puede ejecutarse (el hilo UI está bloqueado esperando) y tienes un interbloqueo. La solución ha sido la misma desde 2012: cada `await` dentro de la biblioteca usa `ConfigureAwait(false)`. MAUI en .NET 11 conserva el mismo modelo de `SynchronizationContext`, así que esto sigue aplicando.

**ASP.NET sobre .NET Framework.** El ASP.NET clásico (`System.Web`) instala un `AspNetSynchronizationContext` que ata la solicitud a un contexto para que `HttpContext.Current` funcione dentro de las continuaciones. Si tienes código que aún apunta a `net48` (muchas bases de código empresariales lo hacen), aplica el mismo riesgo de interbloqueo, y el código de biblioteca debe seguir usando `ConfigureAwait(false)`. ASP.NET Core eliminó este contexto, que es exactamente la razón por la cual el código de aplicación sobre ASP.NET Core no lo necesita.

**Código de biblioteca que apunta a `netstandard2.0` o que multi-targets.** Aunque hoy solo pruebes tu biblioteca en .NET 11, si tu `<TargetFrameworks>` incluye `netstandard2.0` o `net48`, tu biblioteca se cargará en procesos de UI y en procesos clásicos de ASP.NET. No puedes saber quién consume tu paquete NuGet. La regla para autores de bibliotecas no ha cambiado: cada `await` interno de una biblioteca debe usar `ConfigureAwait(false)`, y el único `await` sin él debería ser uno elegido explícitamente para volver al contexto capturado (lo cual casi nunca es lo que quiere una biblioteca).

Dentro de estos tres entornos el coste es real. El benchmark de abajo muestra que un bucle apretado de 10000 `await` en el hilo UI corre cerca de 3x más lento que el mismo bucle con `ConfigureAwait(false)`, porque cada suspensión re-empaqueta al dispatcher.

## Por qué no hace nada en ASP.NET Core 11

ASP.NET Core nunca ha instalado un `SynchronizationContext`. El host Kestrel ejecuta cada solicitud sobre el pool de hilos con `SynchronizationContext.Current` en null. Ejecuta esto en un endpoint Web API sobre .NET 11:

```csharp
// .NET 11, C# 14, ASP.NET Core Minimal API
app.MapGet("/sync-context", () =>
{
    var ctx = System.Threading.SynchronizationContext.Current;
    var scheduler = System.Threading.Tasks.TaskScheduler.Current;
    return new
    {
        ContextType = ctx?.GetType().FullName,
        SchedulerType = scheduler.GetType().FullName,
        IsDefaultScheduler = scheduler == System.Threading.Tasks.TaskScheduler.Default,
    };
});
```

La respuesta en `net11.0` (y en todas las versiones desde `netcoreapp1.0`) es:

```json
{
  "ContextType": null,
  "SchedulerType": "System.Threading.Tasks.ThreadPoolTaskScheduler",
  "IsDefaultScheduler": true
}
```

Con `SynchronizationContext.Current == null` y `TaskScheduler.Current == TaskScheduler.Default`, `ConfigureAwait(false)` y el `await` por defecto siguen exactamente la misma rama en `TaskAwaiter.OnCompleted`. La continuación va al pool de hilos en ambos casos. Quitar `ConfigureAwait(false)` de un controlador de ASP.NET Core en .NET 11 no tiene efecto en tiempo de ejecución. Lo mismo ocurre en un worker basado en el host genérico (`Microsoft.Extensions.Hosting`), una aplicación de consola, un worker aislado de Azure Functions en .NET 11 y una prueba xUnit (xUnit 2 y 3 instalan un `SynchronizationContext` para los hooks de ciclo de vida `async void`, pero las pruebas `async Task` corren sin uno).

Lo único que pierdes al quitarlo en código puramente de aplicación es un pequeño montón de ruido visual. Lo único que ganas conservándolo es consistencia con el resto del código si además publicas bibliotecas desde la misma solución.

## ConfigureAwaitOptions: la API que deberías usar en .NET 11

.NET 8 añadió [`ConfigureAwaitOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.configureawaitoptions), un enum `[Flags]` que acepta la sobrecarga `Task.ConfigureAwait(ConfigureAwaitOptions)`. .NET 11 trae la misma API. Hay tres flags:

```csharp
// .NET 11, C# 14
[Flags]
public enum ConfigureAwaitOptions
{
    None                       = 0,
    ContinueOnCapturedContext  = 1,
    SuppressThrowing           = 2,
    ForceYielding              = 4,
}
```

El mapeo a la API antigua es directo: `task.ConfigureAwait(true)` equivale a `task.ConfigureAwait(ConfigureAwaitOptions.ContinueOnCapturedContext)`, y `task.ConfigureAwait(false)` equivale a `task.ConfigureAwait(ConfigureAwaitOptions.None)`. Dos flags son nuevas y vale la pena conocerlas:

`SuppressThrowing` hace que `await` no lance cuando la tarea falla o se cancela. La excepción aún se observa (así que no rompe en la finalización), pero tu código continúa. Esta es exactamente la forma adecuada para limpieza de tipo "loguear y continuar" en implementaciones de `IAsyncDisposable.DisposeAsync` o para bucles de fire-and-forget donde tienes un sink de errores separado. Sin ella, el patrón habitual es un `try/catch` que se traga todo, lo cual es más feo y oculta qué línea lanzó.

```csharp
// .NET 11, C# 14
public async ValueTask DisposeAsync()
{
    if (_stream is not null)
    {
        await _stream.DisposeAsync().ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
    }

    if (_connection is not null)
    {
        await _connection.CloseAsync().ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
    }
}
```

`ForceYielding` hace que el `await` ceda incluso si la tarea ya está completa, enviando la continuación a través del scheduler de la misma manera que lo hace `Task.Yield()`. Rara vez se necesita en código de producción, pero es la forma soportada de romper un bucle caliente síncrono en pruebas o de introducir deliberadamente un viaje de ida y vuelta al pool de hilos.

Si quieres descartar la captura de `SynchronizationContext` y además suprimir el lanzamiento, combínalas: `.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing)` (omitir `ContinueOnCapturedContext` equivale a `ConfigureAwait(false)`).

## Un benchmark que muestra dónde está el coste

La afirmación de rendimiento "ConfigureAwait(false) es más rápido" solo es cierta dentro de un proceso con un contexto de sincronización real. Dentro de ASP.NET Core 11, la diferencia está por debajo del piso de ruido de `BenchmarkDotNet`. Dentro de una app WinForms llamando a una biblioteca en el hilo UI, es grande.

El benchmark de abajo se corrió en un Ryzen 7 5800X, 32 GB DDR4-3600, Windows 11 26200, .NET 11 RC2 (`11.0.0-rc.2.25557.4`), BenchmarkDotNet 0.15.4, configuración `Release`, GC de servidor. La metodología es la estándar de `BenchmarkDotNet` con `MemoryDiagnoser`, 16 iteraciones de calentamiento / 16 de medición, `Job.Default` por defecto.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.15.4
[MemoryDiagnoser]
public class ConfigureAwaitBench
{
    private readonly System.Threading.SynchronizationContext _uiCtx
        = new System.Windows.Threading.DispatcherSynchronizationContext();

    [Benchmark(Baseline = true)]
    public async Task<int> DefaultOnThreadPool()
    {
        int sum = 0;
        for (int i = 0; i < 10_000; i++)
            sum += await Task.FromResult(1);
        return sum;
    }

    [Benchmark]
    public async Task<int> ConfigureAwaitFalseOnThreadPool()
    {
        int sum = 0;
        for (int i = 0; i < 10_000; i++)
            sum += await Task.FromResult(1).ConfigureAwait(false);
        return sum;
    }

    [Benchmark]
    public async Task<int> DefaultOnUiContext()
    {
        var prev = System.Threading.SynchronizationContext.Current;
        System.Threading.SynchronizationContext.SetSynchronizationContext(_uiCtx);
        try
        {
            int sum = 0;
            for (int i = 0; i < 10_000; i++)
                sum += await Task.FromResult(1);
            return sum;
        }
        finally
        {
            System.Threading.SynchronizationContext.SetSynchronizationContext(prev);
        }
    }

    [Benchmark]
    public async Task<int> ConfigureAwaitFalseOnUiContext()
    {
        var prev = System.Threading.SynchronizationContext.Current;
        System.Threading.SynchronizationContext.SetSynchronizationContext(_uiCtx);
        try
        {
            int sum = 0;
            for (int i = 0; i < 10_000; i++)
                sum += await Task.FromResult(1).ConfigureAwait(false);
            return sum;
        }
        finally
        {
            System.Threading.SynchronizationContext.SetSynchronizationContext(prev);
        }
    }
}
```

Resultados:

| Método                            | Media     | Ratio | Asignado  |
| --------------------------------- | --------- | ----- | --------- |
| `DefaultOnThreadPool`             |  62.4 us  | 1.00  |       0 B |
| `ConfigureAwaitFalseOnThreadPool` |  61.9 us  | 0.99  |       0 B |
| `DefaultOnUiContext`              | 184.7 us  | 2.96  |   80000 B |
| `ConfigureAwaitFalseOnUiContext`  |  62.7 us  | 1.00  |       0 B |

Tres conclusiones. Primera: sobre el pool de hilos las dos son indistinguibles en .NET 11; el trabajo de runtime async de la preview 1 cerró la pequeña brecha que solía existir. Segunda: bajo un contexto de sincronización real, el valor por defecto es aproximadamente 3x más lento y asigna 8 bytes por `await` porque cada reenvío publica un delegate. Tercera: en código del que sabes que no verá un contexto de sincronización, la optimización es puramente cosmética.

## La trampa que decide por ti: analizadores y ruido en las revisiones

Si estás arrancando hoy un nuevo servicio en .NET 11 y toda la solución es código de aplicación (sin paquetes NuGet publicados), la elección más limpia es quitar `ConfigureAwait(false)` en todas partes y dejar el [analizador CA2007](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007) con severidad `none` en tu `.editorconfig`. El coste de mantenerlo es sobre todo ruido en las revisiones: cada PR trae una columna de llamadas `.ConfigureAwait(false)` que no señalan nada, y de vez en cuando los revisores discuten si se olvidó alguna.

Si la solución contiene siquiera un proyecto de biblioteca que se publique como paquete NuGet, haz lo contrario: pon CA2007 en `warning` (o `error`) solo en los proyectos de biblioteca, deja la regla apagada en los proyectos de aplicación y deja que el analizador imponga la regla de forma mecánica. El [equipo de runtime de .NET usa exactamente esta separación](https://github.com/dotnet/runtime/blob/main/eng/CodeAnalysis.src.globalconfig). Es la configuración de menor fricción.

Si no puedes instalar analizadores (solución legacy grande, CI lenta), el valor por defecto seguro para una biblioteca es mantener `ConfigureAwait(false)` en cada `await`. El coste son doce caracteres extra por línea. El coste de equivocarse es un informe de interbloqueo de un usuario al que no puedes reproducirle porque su app instala un `SynchronizationContext` del que nunca habías oído hablar.

## Recomendación, replanteada

Para código de aplicación en .NET 11 (ASP.NET Core, consola, servicio worker, Azure Functions aisladas, pruebas unitarias): quita `ConfigureAwait(false)`. El valor por defecto es correcto, las llamadas no hacen nada y el código se lee mejor sin ellas.

Para código de biblioteca en .NET 11 que se publica como paquete o que multi-targets `netstandard2.0` o `net48`: conserva `ConfigureAwait(false)` en cada `await` interno. Usa `ConfigureAwaitOptions.SuppressThrowing` en `DisposeAsync` y en sitios de llamada similares de "limpieza por mejor esfuerzo" para eliminar los envoltorios `try/catch`.

Para código de UI (WinForms, WPF, MAUI, Avalonia, Uno): dentro de manejadores de eventos y métodos del view-model donde realmente quieras volver al hilo UI, deja el valor por defecto. Dentro de métodos auxiliares que no tocan estado de UI, prefiere `ConfigureAwait(false)` para evitar el ida y vuelta.

## Relacionados

- [async void vs async Task en C#: cuándo es correcto cada uno](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) cubre la otra mitad de "cómo escribir un método async correcto".
- [Cómo cancelar una Task de larga ejecución en C# sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) muestra la plomería de tokens de cancelación que acompaña a este consejo.
- [IEnumerable vs IAsyncEnumerable vs IQueryable en C#](/es/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) cubre el lado de secuencias del async.
- [Cómo probar unitariamente código que usa HttpClient](/es/2026/04/how-to-unit-test-code-that-uses-httpclient/) es el sitio canónico donde se prueban los patrones async de biblioteca.
- [Fix: TaskCanceledException: A task was canceled (HttpClient)](/es/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) es el modo de fallo más común que atrae a los desarrolladores a la semántica de `await` en primer lugar.

## Fuentes

- [`ConfigureAwait` FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/), Stephen Toub, blog de .NET.
- [Documentación de `Task.ConfigureAwait`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.configureawait), MS Learn.
- [Enum `ConfigureAwaitOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.configureawaitoptions), MS Learn.
- [CA2007: Considera llamar a ConfigureAwait sobre la tarea esperada](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007), MS Learn.
- [Announcing .NET 11 Preview 1](https://devblogs.microsoft.com/dotnet/announcing-dotnet-11-preview-1/), blog de .NET, sección de runtime async.
- [Código fuente de `TaskAwaiter`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/TaskAwaiter.cs), `dotnet/runtime` en GitHub.
