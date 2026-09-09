---
title: ".NET 11 RC 1 te deja enviar SIGTERM a un proceso hijo sin P/Invoke"
description: "Signal, WaitForExitStatus y ProcessExitStatus llegan directamente a System.Diagnostics.Process en .NET 11 RC 1, así que apagar de forma ordenada un proceso hijo ya no necesita un P/Invoke a kill ni un rodeo por SafeProcessHandle."
pubDate: 2026-09-09
tags:
  - "dotnet-11"
  - "csharp"
  - "process"
  - "dotnet"
lang: "es"
translationOf: "2026/09/dotnet-11-rc-1-process-signal-exit-status"
translatedBy: "claude"
translationDate: 2026-09-09
---

[.NET 11 Release Candidate 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/) salió el 2026-09-08 con licencia go-live. La sección de bibliotecas abre con algo que ha molestado a cualquiera que haya supervisado un proceso hijo desde C#: `System.Diagnostics.Process` ahora envía señales POSIX e informa cómo murió realmente un proceso, sin bajar a `SafeProcessHandle` ([dotnet/runtime#131165](https://github.com/dotnet/runtime/pull/131165)).

## Kill() siempre fue un SIGKILL

`Process.Kill()` en Unix es `SIGKILL`. El hijo no tiene ninguna oportunidad de vaciar un búfer, cerrar un socket ni ejecutar un manejador de apagado. Eso está bien para un proceso descontrolado y está mal para casi todo lo demás: un servidor de desarrollo, una transcodificación de `ffmpeg`, un contenedor de Postgres, un arnés de pruebas que quieres detener limpiamente.

La solución alternativa era un P/Invoke:

```csharp
[LibraryImport("libc", SetLastError = true)]
private static partial int kill(int pid, int sig);

// 15 on Linux and macOS, but you had to know that
kill(process.Id, 15);
```

Son tres líneas de suposiciones sobre la plataforma, un número de señal escrito a mano y ninguna forma de saber si la señal se entregó de verdad.

## La superficie de API de RC 1

RC 1 agrega cuatro miembros a `Process`:

```csharp
public bool Signal(PosixSignal signal);
public ProcessExitStatus WaitForExitStatus();
public bool TryWaitForExitStatus(TimeSpan timeout, out ProcessExitStatus? exitStatus);
public Task<ProcessExitStatus> WaitForExitStatusAsync(
    CancellationToken cancellationToken = default);
```

Con eso ya se puede escribir bien el patrón de escalado:

```csharp
using System.Diagnostics;
using System.Runtime.InteropServices;

using Process worker = Process.Start("./worker")!;

if (!worker.Signal(PosixSignal.SIGTERM))
{
    // false means the process is already gone, not that the call failed
    return;
}

if (!worker.TryWaitForExitStatus(TimeSpan.FromSeconds(10), out ProcessExitStatus? status))
{
    worker.Signal(PosixSignal.SIGKILL);
    status = worker.WaitForExitStatus();
}

Console.WriteLine($"exit={status.ExitCode} signal={status.Signal}");
```

## ProcessExitStatus acaba con las adivinanzas del código de salida

`ProcessExitStatus` es una clase pequeña marcada como sealed con tres propiedades: `ExitCode`, `Canceled` y un `PosixSignal? Signal` anulable. La señal anulable es la parte útil. Hasta ahora deducías una muerte por señal a partir de la convención `128 + signal number` incrustada en el código de salida, que choca en silencio con cualquier proceso que salga legítimamente con 143. Ahora `status.Signal is PosixSignal.SIGTERM` responde la pregunta directamente, y `Canceled` te dice si la espera terminó por tu tiempo de espera o tu `CancellationToken` en lugar de por el hijo.

Es el mismo `ProcessExitStatus` que devuelven `Process.RunAndCaptureText` y compañía, del que hablé cuando [llegaron las API de captura sin interbloqueos en la Preview 4](/es/2026/05/dotnet-11-process-api-deadlock-free-capture/).

## Dónde no funciona

Tres límites que conviene conocer antes de escribir código supervisor multiplataforma:

- `Signal` está anotado con `[UnsupportedOSPlatform("ios")]` y `[UnsupportedOSPlatform("tvos")]`. Mac Catalyst sí está soportado.
- En Windows solo se acepta `PosixSignal.SIGKILL`, y se traduce a `TerminateProcess`. Cualquier otra señal lanza `PlatformNotSupportedException`, así que una ruta primero ordenada y luego forzada necesita una rama con `OperatingSystem.IsWindows()`.
- En Unix, `WaitForExitStatus` solo funciona para un hijo del proceso actual. Esperar sobre un `Process` al que te adjuntaste por PID lanza una excepción.

La lista completa está en las [notas de la versión de bibliotecas de RC 1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/libraries.md). Con la licencia go-live incluida, este es el primer RC que puedes poner detrás de una supervisión de procesos en producción.
