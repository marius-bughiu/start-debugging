---
title: ".NET 11 agrega captura de salida de procesos sin interbloqueos"
description: ".NET 11 Preview 4 incorpora nuevas APIs de System.Diagnostics.Process que drenan stdout y stderr en paralelo, además de helpers de una sola línea para ejecutar y capturar, y KillOnParentExit."
pubDate: 2026-05-15
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "process"
lang: "es"
translationOf: "2026/05/dotnet-11-process-api-deadlock-free-capture"
translatedBy: "claude"
translationDate: 2026-05-15
---

Adam Sitnik [anunció](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/) una serie de mejoras en `System.Diagnostics.Process` que llegaron en .NET 11 Preview 4. Lo principal es que la trampa de interbloqueo con la que tropieza al menos una vez todo desarrollador de .NET por fin se resuelve a nivel de la BCL, y el código repetitivo de "iniciar un proceso, capturar su salida, esperar" se reduce a una sola llamada.

## Por qué el patrón antiguo se interbloquea

La forma clásica parece segura y no lo es:

```csharp
var psi = new ProcessStartInfo("git", "log")
{
    RedirectStandardOutput = true,
    RedirectStandardError = true,
};
using var p = Process.Start(psi)!;
string stdout = p.StandardOutput.ReadToEnd();
string stderr = p.StandardError.ReadToEnd();
p.WaitForExit();
```

Si el proceso hijo escribe en `stderr` más de lo que cabe en el búfer de la tubería antes de que el padre llegue a `stderr.ReadToEnd()`, el hijo se bloquea esperando que la tubería se vacíe y el padre se bloquea esperando que `stdout` se cierre. Ambos esperan para siempre. La solución documentada era la API basada en eventos con `OutputDataReceived`, `StringBuilder` manuales y un `ManualResetEvent` por cada stream. Funciona, pero nadie la escribe correctamente al primer intento.

## Los nuevos one-liners

.NET 11 agrega `Process.RunAndCaptureText` y `Process.RunAndCaptureTextAsync`, que multiplexan ambas tuberías internamente:

```csharp
ProcessTextOutput result = await Process.RunAndCaptureTextAsync(
    "git",
    ["log", "--oneline", "-n", "20"]);

if (result.ExitStatus.ExitCode != 0)
    throw new InvalidOperationException(result.StandardError);

Console.WriteLine(result.StandardOutput);
```

`ProcessTextOutput` lleva el stdout capturado, stderr, el ID del proceso y un `ProcessExitStatus` que reporta tanto el código de salida como, en Unix, la señal de terminación. Existe un hermano `Process.ReadAllText` para quienes ya tienen un `Process` en ejecución, además de `ReadAllLines/Async` para transmitir `IEnumerable<ProcessOutputLine>` con un flag `StandardError` en cada línea, y `ReadAllBytes/Async` para herramientas binarias. Según el blog, el `RunAndCaptureText` síncrono asigna aproximadamente 4.5 veces menos memoria que el bucle equivalente basado en eventos en Windows.

## Tiempo de vida y desvinculación

Dos viejos problemas también obtienen soporte de primera clase. `ProcessStartInfo.KillOnParentExit` ata el hijo al ciclo de vida del padre en Windows, Linux y Android, de modo que una herramienta CLI que falle ya no deja workers huérfanos. `ProcessStartInfo.StartDetached` es lo opuesto: el hijo sobrevive al padre y a la terminal que lo lanzó. Y `Process.StartAndForget` devuelve solo el PID y libera de inmediato el handle del padre, que es lo que quieres para lanzamientos "fire and forget":

```csharp
int pid = Process.StartAndForget("notepad.exe");
```

## Manejo de handles

Para escenarios de más bajo nivel, `ProcessStartInfo.StandardInputHandle`, `StandardOutputHandle` y `StandardErrorHandle` aceptan cualquier `SafeFileHandle`, incluidas las tuberías del nuevo `SafeFileHandle.CreateAnonymousPipe` y el sumidero de descarte de `File.OpenNullHandle`. `ProcessStartInfo.InheritedHandles` te permite incluir en una lista blanca exactamente qué handles cruzan el límite del fork, lo cual cierra una fuente real de fugas de bloqueos de archivos en Windows.

Pruébalo en [.NET 11 Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) y empieza a borrar manejadores `OutputDataReceived`.
