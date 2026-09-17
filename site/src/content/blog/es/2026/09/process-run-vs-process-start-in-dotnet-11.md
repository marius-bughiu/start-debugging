---
title: "Process.Run vs Process.Start en .NET 11: ¿cuál deberías usar?"
description: "Usa Process.Run cuando inicias una herramienta y solo te importa cómo terminó: una sola llamada, un timeout que mata al proceso hijo y un ProcessExitStatus con la señal. Quédate con Process.Start cuando necesitas el objeto Process: escribir en stdin, leer la salida a medida que llega, UseShellExecute o matar un árbol de procesos completo."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "process"
lang: "es"
translationOf: "2026/09/process-run-vs-process-start-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-17
---

**Usa `Process.Run` (o `Process.RunAsync`) siempre que inicies un proceso, lo dejes terminar y solo necesites saber cómo terminó.** Es una sola llamada, no puede filtrar un handle de `Process`, su timeout o `CancellationToken` realmente mata al proceso hijo, y devuelve un `ProcessExitStatus` que te dice si el hijo terminó normalmente, si lo mató una señal o si lo mataste tú. **Quédate con `Process.Start` cuando necesitas el objeto `Process` vivo**: escribir en stdin, leer la salida línea por línea mientras el proceso se ejecuta, `UseShellExecute` para abrir una URL o un documento, el evento `Exited`, o `Kill(entireProcessTree: true)` para herramientas que lanzan sus propios workers. El rendimiento no es lo que decide: ambos midieron unos 740 microsegundos por lanzamiento en .NET 11 RC 1. Todo lo siguiente se verificó con .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`, runtime `11.0.0-rc.1.26425.128`, C# 15) en macOS 26.6 con un Apple M4.

## Las dos APIs lado a lado

| Comportamiento (.NET 11 RC 1)             | `Process.Run` / `RunAsync`                          | `Process.Start` + `WaitForExit`                  |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| Disponible en                             | .NET 11+                                            | todas las versiones de .NET                      |
| Devuelve                                  | `ProcessExitStatus`                                 | `Process` (hay que liberarlo)                    |
| stdin/stdout/stderr por defecto           | heredados del padre (o null con `silent: true`)     | heredados del padre                              |
| `RedirectStandardOutput = true`           | `InvalidOperationException`                         | sí                                               |
| Escribir en stdin mientras se ejecuta     | no                                                  | sí                                               |
| `UseShellExecute = true`                  | `InvalidOperationException`                         | sí                                               |
| Timeout                                   | mata al hijo, `Canceled = true`                     | `WaitForExit(TimeSpan)` devuelve `false`, el hijo sigue ejecutándose |
| Cancelación (asíncrona)                   | mata al hijo, sin excepción                         | `WaitForExitAsync(ct)` lanza, el hijo sigue ejecutándose |
| Señal de terminación                      | `ProcessExitStatus.Signal`                          | adivinar a partir de `ExitCode` (137, 143)       |
| Matar nietos en el timeout                | no, solo el hijo directo                            | `Kill(entireProcessTree: true)`                  |
| ID del proceso                            | no se devuelve                                      | `Process.Id`                                     |
| Lanzar `/usr/bin/true`, síncrono          | 737.0 us, 16.56 KB                                  | 739.4 us, 16.84 KB                               |

Las primeras cinco filas deciden la mayoría de los casos. Si tu código toca `StandardInput`, `BeginOutputReadLine` o `UseShellExecute`, `Process.Run` directamente no es una opción. Si no toca ninguno de ellos, `Process.Run` es más corto y tiene valores por defecto más seguros.

## Qué hace realmente Process.Run

`Process.Run` llegó en .NET 11 Preview 4 junto con `RunAndCaptureText` y `StartAndForget`, como parte de la [renovación de la API de Process](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/) que cubrí cuando [llegó la captura de salida sin interbloqueos](/es/2026/05/dotnet-11-process-api-deadlock-free-capture/). La superficie en RC 1 es:

```csharp
// .NET 11 RC 1, System.Diagnostics.Process
public static ProcessExitStatus Run(ProcessStartInfo startInfo, TimeSpan? timeout = default);
public static ProcessExitStatus Run(string fileName, IEnumerable<string>? arguments = null,
    bool silent = false, TimeSpan? timeout = default);

public static Task<ProcessExitStatus> RunAsync(ProcessStartInfo startInfo,
    CancellationToken cancellationToken = default);
public static Task<ProcessExitStatus> RunAsync(string fileName, IEnumerable<string>? arguments = null,
    bool silent = false, CancellationToken cancellationToken = default);
```

Dos detalles difieren del artículo del blog de Preview 4. Preview 7 cambió `arguments` de `IList<string>?` a `IEnumerable<string>?` ([dotnet/runtime#130630](https://github.com/dotnet/runtime/pull/130630)), y las sobrecargas con `fileName` ganaron un flag `silent` que apunta stdin, stdout y stderr al dispositivo nulo.

La implementación en [`Process.Scenarios.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Scenarios.cs) es lo bastante corta como para resumirla con exactitud. Nunca crea un objeto `Process`. Llama a `SafeProcessHandle.Start(startInfo)`, luego a `WaitForExit()` o a `WaitForExitOrKillOnTimeout(timeout)`, y libera el handle antes de devolver. `RunAsync` hace lo mismo con `WaitForExitOrKillOnCancellationAsync`. Por eso no puede filtrar un handle, y también por eso rechaza todo lo que necesite un `Process` para manejarlo: los flags `RedirectStandard*` solo tienen sentido si alguien sostiene `Process.StandardOutput` y lo vacía.

`ProcessExitStatus` tiene tres propiedades: `ExitCode`, `Canceled` y un `PosixSignal? Signal` anulable. El mismo tipo es el que devuelven los [nuevos métodos `Process.WaitForExitStatus` de RC 1](/es/2026/09/dotnet-11-rc-1-process-signal-exit-status/).

## El mismo trabajo escrito de las dos formas

Este es el caso cotidiano: ejecutar `dotnet build`, dejar que su salida fluya a la consola, fallar si falla y rendirse después de cinco minutos.

```csharp
// .NET 11 RC 1, C# 15 -- before: Process.Start
using System.Diagnostics;

using Process build = Process.Start("dotnet", ["build", "-c", "Release"]);

if (!build.WaitForExit(TimeSpan.FromMinutes(5)))
{
    build.Kill(entireProcessTree: true);
    build.WaitForExit();
    throw new TimeoutException("dotnet build took longer than 5 minutes");
}

if (build.ExitCode != 0)
    throw new InvalidOperationException($"dotnet build failed with {build.ExitCode}");
```

```csharp
// .NET 11 RC 1, C# 15 -- after: Process.Run
using System.Diagnostics;

ProcessExitStatus status = Process.Run(
    "dotnet", ["build", "-c", "Release"],
    timeout: TimeSpan.FromMinutes(5));

if (status.Canceled)
    throw new TimeoutException("dotnet build took longer than 5 minutes");

if (status.ExitCode != 0)
    throw new InvalidOperationException($"dotnet build failed with {status.ExitCode}");
```

La versión con `Process.Start` es correcta, pero solo porque recuerda dos cosas que la gente olvida habitualmente: `WaitForExit(TimeSpan)` no mata nada al vencer el timeout, y el `Process` tiene que liberarse. La versión con `Process.Run` no tiene forma de equivocarse en ninguna de las dos. Fíjate, eso sí, en que mantuve `entireProcessTree: true` en la primera versión a propósito. Más sobre eso en los detalles a tener en cuenta.

## Los timeouts y la cancelación se comportan distinto

Esta es la diferencia que muerde a quienes migran con buscar y reemplazar. Ejecuté ambos contra `sleep 10` con un margen de 500 ms en .NET 11 RC 1:

```csharp
// .NET 11 RC 1, C# 15, macOS 26.6
using System.Diagnostics;

using var cts = new CancellationTokenSource(500);
ProcessExitStatus s = await Process.RunAsync("sleep", ["10"], cancellationToken: cts.Token);
Console.WriteLine($"ExitCode={s.ExitCode} Canceled={s.Canceled} Signal={s.Signal}");
// ExitCode=137 Canceled=True Signal=SIGKILL   (returned after 505 ms, no exception)

using var cts2 = new CancellationTokenSource(500);
using Process p = Process.Start("sleep", ["10"]);
try { await p.WaitForExitAsync(cts2.Token); }
catch (TaskCanceledException) { Console.WriteLine($"HasExited={p.HasExited}"); }
// HasExited=False   (the child is still running)
```

Tres cosas que sacar de esa salida:

1. **`RunAsync` no lanza excepción al cancelarse.** Mata al hijo con `SIGKILL` (o `TerminateProcess` en Windows), espera a que termine y devuelve un estado con `Canceled = true`. El código que lo envuelve en `catch (OperationCanceledException)` nunca entrará en el bloque catch. Revisa `status.Canceled` en su lugar.
2. **`Process.WaitForExitAsync(ct)` solo cancela la espera.** Lanza `TaskCanceledException` y deja el proceso vivo. Si lo querías muerto, llamas a `Kill()` tú mismo.
3. **`Signal` elimina las conjeturas sobre el código de salida.** En Unix, un proceso matado por `SIGKILL` reporta el código de salida 137 y uno matado por `SIGTERM` reporta 143, y un proceso también puede simplemente hacer `exit 137`. `ProcessExitStatus.Signal` te dice cuál de los dos ocurrió. Dentro de una llamada a `Process.Run`, `Canceled` te dice si la señal de muerte fue tuya.

El `Run` síncrono recibe un `TimeSpan? timeout` y ningún token; `RunAsync` recibe un token y ningún timeout. Para un timeout asíncrono, usa `new CancellationTokenSource(TimeSpan)` como arriba. Si la cancelación llega desde una solicitud de ASP.NET Core o desde un hosted service, los patrones de [cómo cancelar una Task de larga duración sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) aplican sin cambios.

## Cuándo elegir Process.Run

- **Scripts de compilación y wrappers de CLI** que ejecutan `git`, `dotnet`, `npm` o `docker` y dejan que la salida vaya directo a la consola. Con el valor por defecto `silent: false`, el hijo hereda los handles del padre, así que los colores y las barras de progreso siguen funcionando.
- **Health checks y sondeos** donde solo importa el código de salida. `Process.Run("pg_isready", ["-h", host], silent: true, timeout: TimeSpan.FromSeconds(3))` es la implementación completa.
- **Herramientas que nunca deben colgar tu servicio.** Las rutas de timeout y cancelación matan al hijo por ti, así que un `ffprobe` atascado no puede acumularse detrás de una solicitud.
- **Escribir la salida en un archivo en lugar de la consola.** `ProcessStartInfo.StandardOutputHandle` acepta cualquier `SafeFileHandle`, y `Run(ProcessStartInfo)` lo soporta:

```csharp
// .NET 11 RC 1, C# 15
using System.Diagnostics;
using Microsoft.Win32.SafeHandles;

using SafeFileHandle log = File.OpenHandle("build.log", FileMode.Create, FileAccess.Write);

ProcessExitStatus status = Process.Run(new ProcessStartInfo("dotnet", ["build"])
{
    StandardOutputHandle = log,
    StandardErrorHandle = log,
    WorkingDirectory = "/src/app",
});
```

Si necesitas la salida en memoria en lugar de en un archivo, olvídate de ambas APIs y llama a `Process.RunAndCaptureText`, que vacía stdout y stderr de forma concurrente para que el clásico interbloqueo por redirección no pueda ocurrir.

## Cuándo quedarte con Process.Start

- **stdin interactivo.** Pasarle una contraseña a `ssh-keygen`, enviar SQL a `psql` por una tubería o hablar con un REPL requiere `RedirectStandardInput` y `Process.StandardInput`. `Run` lanza con cualquier flag `RedirectStandard*`.
- **Salida en streaming mientras el proceso se ejecuta.** Una UI de progreso que muestra las líneas de `ffmpeg` a medida que aparecen necesita el `Process`. En .NET 11 al menos puedes prescindir de los manejadores de eventos y usar `process.ReadAllLinesAsync(ct)`, que produce valores `ProcessOutputLine` de ambos streams sin interbloqueos.
- **Ejecución a través del shell.** `Process.Start(new ProcessStartInfo("https://startdebugging.net") { UseShellExecute = true })` sigue siendo la forma de abrir una URL o un documento con su aplicación predeterminada. `Run`, `RunAsync` y `StartAndForget` lanzan excepción, porque en Windows la ejecución a través del shell puede no crear ningún proceso nuevo.
- **Árboles de procesos.** Si el hijo lanza workers (nodos de MSBuild, `npm` ejecutando `node`, un script de shell), solo `Process.Kill(entireProcessTree: true)` los limpia. Mira la siguiente sección.
- **Necesitas el `Process` en sí**: `Id` para el registro, el evento `Exited`, `PriorityClass` o las sobrecargas `userName`/`password` exclusivas de Windows.
- **Apuntas a cualquier versión anterior a .NET 11.** `Process.Run` no existe en .NET 10. Una biblioteca con múltiples targets necesita `#if NET11_0_OR_GREATER`.

## El benchmark

El rendimiento no es motivo para elegir uno u otro, y lo medí para que no tengas que preguntártelo. Entorno: .NET 11 RC 1 (`11.0.0-rc.1.26425.128`), BenchmarkDotNet 0.15.8 con el toolchain in-process emit (0.15.8 todavía no reconoce `net11.0` para ejecuciones fuera de proceso), 3 iteraciones de calentamiento y 15 medidas, macOS 26.6.2, Apple M4 con 10 núcleos. Cada benchmark lanza `/usr/bin/true` y espera a que termine.

```csharp
// .NET 11 RC 1, BenchmarkDotNet 0.15.8
[MemoryDiagnoser]
[InProcess, WarmupCount(3), IterationCount(15)]
public class SpawnBenchmarks
{
    private const string Exe = "/usr/bin/true";

    [Benchmark(Baseline = true)]
    public int Start_WaitForExit()
    {
        using Process p = Process.Start(Exe);
        p.WaitForExit();
        return p.ExitCode;
    }

    [Benchmark]
    public int Run() => Process.Run(Exe).ExitCode;

    [Benchmark]
    public async Task<int> Start_WaitForExitAsync()
    {
        using Process p = Process.Start(Exe);
        await p.WaitForExitAsync();
        return p.ExitCode;
    }

    [Benchmark]
    public async Task<int> RunAsync() => (await Process.RunAsync(Exe)).ExitCode;
}
```

| Method                   | Mean     | StdDev   | Allocated |
| ------------------------ | -------: | -------: | --------: |
| `Start_WaitForExit`      | 739.4 us | 6.26 us  | 16.84 KB  |
| `Run`                    | 737.0 us | 2.76 us  | 16.56 KB  |
| `Start_WaitForExitAsync` | 768.5 us | 13.89 us | 17.89 KB  |
| `RunAsync`               | 762.6 us | 2.56 us  | 17.47 KB  |

La diferencia está dentro del ruido. Casi todo el costo es el sistema operativo creando el proceso, y ambas APIs comparten la misma ruta de inicio de `SafeProcessHandle`. Omitir el objeto `Process` ahorra unos 300 bytes. Las grandes mejoras de .NET 11 (un inicio de procesos 98x más rápido en Apple Silicon, según las mediciones del equipo de .NET) benefician por igual a ambas APIs, porque viven por debajo de esta capa.

## Detalles que deciden por ti

**Un timeout mata solo al hijo directo.** Ejecuté `Process.Run("sh", ["-c", "sleep 31; true"], timeout: TimeSpan.FromMilliseconds(500))`. `Run` devolvió `Canceled=True Signal=SIGKILL`, y `pgrep -f "sleep 31"` seguía encontrando el proceso `sleep` después, reasignado a otro padre y en ejecución. La misma prueba con `Process.Start` y `Kill(entireProcessTree: true)` no dejó nada atrás. `dotnet build`, `npm run`, `docker compose` y la mayoría de los scripts de shell lanzan hijos, así que si un timeout debe dejar la máquina limpia, `Process.Start` con una muerte del árbol completo sigue siendo la herramienta correcta. `ProcessStartInfo.KillOnParentExit` (solo Windows, Linux y Android) no es un sustituto: se dispara cuando tu proceso termina, no cuando vence un timeout.

**No hay sobrecarga con argumentos como string.** `Process.Run("git", "status")` no compila, porque `string` no es `IEnumerable<string>`. Pasa `["status"]`, o construye un `ProcessStartInfo("git", "status")` y usa la sobrecarga `Run(ProcessStartInfo)`.

**`silent: true` también anula stdin.** Un hijo que pide datos, como `git` solicitando credenciales, lee fin de archivo inmediatamente en lugar de quedarse colgado. Eso suele ser lo que quieres en un servicio y resulta sorprendente en un script de desarrollo.

**`Run(ProcessStartInfo)` rechaza tu start info existente.** Si migras un `ProcessStartInfo` que todavía tiene `RedirectStandardOutput = true`, obtienes `InvalidOperationException: The RedirectStandardInput, RedirectStandardOutput, and RedirectStandardError properties cannot be used by SafeProcessHandle.Start or Process.StartAndForget`. El mensaje no menciona ni `Run` ni `RunAsync`, pero es la misma comprobación. Reemplaza el flag por `StandardOutputHandle`, o cambia a `RunAndCaptureText`.

**Los fallos al iniciar son idénticos.** Un ejecutable inexistente lanza la misma `Win32Exception` ("No such file or directory") desde ambas APIs, así que el manejo de errores existente sigue sirviendo.

**Ninguno está soportado en iOS ni tvOS.** Ambos llevan `[UnsupportedOSPlatform("ios")]` y `[UnsupportedOSPlatform("tvos")]`, y Mac Catalyst sí está soportado. El analizador de plataformas marca las llamadas en un proyecto MAUI en cualquiera de los dos casos.

## La decisión

Para código nuevo de .NET 11 que ejecuta un proceso hasta completarse, usa por defecto `Process.Run` o `Process.RunAsync`. Eliminan los tres errores más comunes en el código de procesos (el `Process` sin liberar, el timeout que no mata, el código de salida que oculta una señal) sin ningún costo medible. Pasa a `Process.RunAndCaptureText` en el momento en que necesites la salida como string. Recurre a `Process.Start` solo cuando el proceso tenga que manejarse mientras se ejecuta, abrirse a través del shell o eliminarse como un árbol completo. Ese último caso importa más de lo que parece, porque muchas herramientas que envolverías en `Process.Run` lanzan hijos en silencio que su timeout no tocará. Si todavía mantienes código antiguo que se bloquea en `WaitForExit`, los [patrones básicos de espera a que termine un proceso](/es/2023/08/c-how-to-wait-for-a-process-to-end/) son donde suele empezar el código con `Process.Start`, y vale la pena revisarlos con estos valores por defecto en mente.

### Relacionados

- [.NET 11 agrega captura de salida de procesos sin interbloqueos](/es/2026/05/dotnet-11-process-api-deadlock-free-capture/)
- [.NET 11 RC 1 te permite enviar SIGTERM a un proceso hijo sin P/Invoke](/es/2026/09/dotnet-11-rc-1-process-signal-exit-status/)
- [C#: cómo esperar a que termine un proceso](/es/2023/08/c-how-to-wait-for-a-process-to-end/)
- [Cómo cancelar una Task de larga duración en C# sin interbloqueos](/es/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [.Result y .Wait() vs GetAwaiter().GetResult() vs await en C#](/es/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)

### Fuentes

- [Process API improvements in .NET 11](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/), .NET Blog
- [`Process.Scenarios.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Scenarios.cs) y [`SafeProcessHandle.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/Microsoft/Win32/SafeHandles/SafeProcessHandle.cs) en el tag `v11.0.0-rc.1.26425.128`, dotnet/runtime
- [Implement Process.Run, RunAsync, RunAndCaptureText, RunAndCaptureTextAsync](https://github.com/dotnet/runtime/pull/127210), PR de dotnet/runtime
- [Notas de la versión de bibliotecas de .NET 11 Preview 7](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/libraries.md) (el cambio de los argumentos a `IEnumerable<string>`), dotnet/core
- [Novedades de las bibliotecas de .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries), MS Learn
- [Método `Process.Start`](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.start), MS Learn
