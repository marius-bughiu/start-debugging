---
title: ".NET 11 RC 1 sendet SIGTERM an einen Kindprozess ohne P/Invoke"
description: "Signal, WaitForExitStatus und ProcessExitStatus landen in .NET 11 RC 1 direkt auf System.Diagnostics.Process, sodass das saubere Beenden eines Kindprozesses weder ein P/Invoke auf kill noch einen Umweg über SafeProcessHandle braucht."
pubDate: 2026-09-09
tags:
  - "dotnet-11"
  - "csharp"
  - "process"
  - "dotnet"
lang: "de"
translationOf: "2026/09/dotnet-11-rc-1-process-signal-exit-status"
translatedBy: "claude"
translationDate: 2026-09-09
---

[.NET 11 Release Candidate 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/) ist am 2026-09-08 mit Go-Live-Lizenz erschienen. Der Bibliotheksabschnitt beginnt mit etwas, das jeden geärgert hat, der jemals einen Kindprozess aus C# heraus überwacht hat: `System.Diagnostics.Process` sendet jetzt POSIX-Signale und meldet, woran ein Prozess tatsächlich gestorben ist, ohne den Umweg über `SafeProcessHandle` ([dotnet/runtime#131165](https://github.com/dotnet/runtime/pull/131165)).

## Kill() war immer ein SIGKILL

`Process.Kill()` ist unter Unix ein `SIGKILL`. Der Kindprozess bekommt keine Gelegenheit, einen Puffer zu leeren, einen Socket zu schließen oder einen Shutdown-Handler auszuführen. Für einen außer Kontrolle geratenen Prozess ist das in Ordnung, für fast alles andere falsch: einen Entwicklungsserver, eine `ffmpeg`-Transkodierung, einen Postgres-Container, ein Test-Harness, das Sie sauber stoppen wollen.

Der Workaround war ein P/Invoke:

```csharp
[LibraryImport("libc", SetLastError = true)]
private static partial int kill(int pid, int sig);

// 15 on Linux and macOS, but you had to know that
kill(process.Id, 15);
```

Das sind drei Zeilen Plattformannahmen, eine fest verdrahtete Signalnummer und keine Möglichkeit festzustellen, ob das Signal überhaupt zugestellt wurde.

## Die API-Oberfläche von RC 1

RC 1 fügt `Process` vier Member hinzu:

```csharp
public bool Signal(PosixSignal signal);
public ProcessExitStatus WaitForExitStatus();
public bool TryWaitForExitStatus(TimeSpan timeout, out ProcessExitStatus? exitStatus);
public Task<ProcessExitStatus> WaitForExitStatusAsync(
    CancellationToken cancellationToken = default);
```

Damit lässt sich das Eskalationsmuster sauber schreiben:

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

## ProcessExitStatus beendet das Raten am Exit-Code

`ProcessExitStatus` ist eine kleine sealed-Klasse mit drei Eigenschaften: `ExitCode`, `Canceled` und ein nullbares `PosixSignal? Signal`. Das nullbare Signal ist der nützliche Teil. Bisher haben Sie den Signaltod aus der Konvention `128 + signal number` im Exit-Code abgeleitet, die stillschweigend mit jedem Prozess kollidiert, der regulär mit 143 endet. Jetzt beantwortet `status.Signal is PosixSignal.SIGTERM` die Frage direkt, und `Canceled` sagt Ihnen, ob das Warten an Ihrem Timeout oder Ihrem `CancellationToken` endete und nicht am Kindprozess.

Es ist dasselbe `ProcessExitStatus`, das `Process.RunAndCaptureText` und Verwandte zurückgeben und das ich behandelt habe, als [die deadlockfreien Capture-APIs in Preview 4 ankamen](/de/2026/05/dotnet-11-process-api-deadlock-free-capture/).

## Wo es nicht funktioniert

Drei Grenzen, die Sie kennen sollten, bevor Sie plattformübergreifenden Supervisor-Code schreiben:

- `Signal` ist mit `[UnsupportedOSPlatform("ios")]` und `[UnsupportedOSPlatform("tvos")]` annotiert. Mac Catalyst wird unterstützt.
- Unter Windows wird nur `PosixSignal.SIGKILL` akzeptiert und auf `TerminateProcess` abgebildet. Jedes andere Signal wirft `PlatformNotSupportedException`, ein erst sanfter und dann harter Pfad braucht also einen `OperatingSystem.IsWindows()`-Zweig.
- Unter Unix funktioniert `WaitForExitStatus` nur für ein Kind des aktuellen Prozesses. Das Warten auf einen `Process`, an den Sie sich über die PID angehängt haben, wirft eine Exception.

Die vollständige Liste steht in den [Release Notes zu den Bibliotheken in RC 1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/libraries.md). Mit der beiliegenden Go-Live-Lizenz ist das der erste RC, den Sie hinter eine produktive Prozessüberwachung stellen können.
