---
title: ".NET 11 RC 1 позволяет отправить SIGTERM дочернему процессу без P/Invoke"
description: "Signal, WaitForExitStatus и ProcessExitStatus появились прямо в System.Diagnostics.Process в .NET 11 RC 1, поэтому корректное завершение дочернего процесса больше не требует ни P/Invoke к kill, ни обходного пути через SafeProcessHandle."
pubDate: 2026-09-09
tags:
  - "dotnet-11"
  - "csharp"
  - "process"
  - "dotnet"
lang: "ru"
translationOf: "2026/09/dotnet-11-rc-1-process-signal-exit-status"
translatedBy: "claude"
translationDate: 2026-09-09
---

[.NET 11 Release Candidate 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/) вышел 2026-09-08 с лицензией go-live. Раздел о библиотеках открывается тем, что раздражало каждого, кто когда-либо управлял дочерним процессом из C#: `System.Diagnostics.Process` теперь отправляет сигналы POSIX и сообщает, как процесс на самом деле завершился, без спуска на уровень `SafeProcessHandle` ([dotnet/runtime#131165](https://github.com/dotnet/runtime/pull/131165)).

## Kill() всегда был SIGKILL

`Process.Kill()` в Unix означает `SIGKILL`. У дочернего процесса нет ни единого шанса сбросить буфер, закрыть сокет или выполнить обработчик завершения. Для сорвавшегося процесса это нормально, а почти для всего остального неверно: для сервера разработки, для транскодирования `ffmpeg`, для контейнера Postgres, для тестового стенда, который вы хотите остановить аккуратно.

Обходным путём был P/Invoke:

```csharp
[LibraryImport("libc", SetLastError = true)]
private static partial int kill(int pid, int sig);

// 15 on Linux and macOS, but you had to know that
kill(process.Id, 15);
```

Это три строки предположений о платформе, жёстко прописанный номер сигнала и никакой возможности узнать, был ли сигнал действительно доставлен.

## Поверхность API в RC 1

RC 1 добавляет в `Process` четыре члена:

```csharp
public bool Signal(PosixSignal signal);
public ProcessExitStatus WaitForExitStatus();
public bool TryWaitForExitStatus(TimeSpan timeout, out ProcessExitStatus? exitStatus);
public Task<ProcessExitStatus> WaitForExitStatusAsync(
    CancellationToken cancellationToken = default);
```

Этого достаточно, чтобы корректно написать схему с эскалацией:

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

## ProcessExitStatus прекращает гадание по коду выхода

`ProcessExitStatus` это небольшой класс, помеченный sealed, с тремя свойствами: `ExitCode`, `Canceled` и допускающее null `PosixSignal? Signal`. Именно допускающий null сигнал здесь и полезен. До сих пор гибель от сигнала приходилось выводить из соглашения `128 + signal number`, зашитого в код выхода, а оно молча конфликтует с любым процессом, который штатно завершается с кодом 143. Теперь `status.Signal is PosixSignal.SIGTERM` отвечает на вопрос напрямую, а `Canceled` показывает, что ожидание прервалось по вашему тайм-ауту или `CancellationToken`, а не из-за дочернего процесса.

Это тот же самый `ProcessExitStatus`, который возвращают `Process.RunAndCaptureText` и родственные методы и о котором я писал, когда [API захвата вывода без взаимоблокировок появились в Preview 4](/ru/2026/05/dotnet-11-process-api-deadlock-free-capture/).

## Где это не работает

Три ограничения, которые стоит знать до написания кроссплатформенного кода супервизора:

- `Signal` помечен атрибутами `[UnsupportedOSPlatform("ios")]` и `[UnsupportedOSPlatform("tvos")]`. Mac Catalyst поддерживается.
- В Windows принимается только `PosixSignal.SIGKILL`, и он отображается на `TerminateProcess`. Любой другой сигнал выбрасывает `PlatformNotSupportedException`, поэтому путь сначала мягко, затем жёстко требует ветки с `OperatingSystem.IsWindows()`.
- В Unix `WaitForExitStatus` работает только для дочернего процесса текущего. Ожидание на `Process`, к которому вы подключились по PID, выбрасывает исключение.

Полный список приведён в [заметках о выпуске библиотек RC 1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/libraries.md). С приложенной лицензией go-live это первый RC, который можно поставить за продакшен-надзор над процессами.
