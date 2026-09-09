---
title: ".NET 11 RC 1 Lets You SIGTERM a Child Process Without P/Invoke"
description: "Signal, WaitForExitStatus, and ProcessExitStatus land directly on System.Diagnostics.Process in .NET 11 RC 1, so graceful shutdown of a child process no longer needs a kill P/Invoke or a SafeProcessHandle detour."
pubDate: 2026-09-09
tags:
  - "dotnet-11"
  - "csharp"
  - "process"
  - "dotnet"
---

[.NET 11 Release Candidate 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/) shipped on September 8, 2026 with a go-live license. The libraries section leads with something that has annoyed anyone who has ever supervised a child process from C#: `System.Diagnostics.Process` now sends POSIX signals and reports how a process actually died, without dropping down to `SafeProcessHandle` ([dotnet/runtime#131165](https://github.com/dotnet/runtime/pull/131165)).

## Kill() Was Always a SIGKILL

`Process.Kill()` on Unix is `SIGKILL`. The child gets no chance to flush a buffer, close a socket, or run a shutdown handler. That is fine for a runaway process and wrong for almost everything else: a dev server, an `ffmpeg` transcode, a Postgres container, a test harness you want to stop cleanly.

The workaround was a P/Invoke:

```csharp
[LibraryImport("libc", SetLastError = true)]
private static partial int kill(int pid, int sig);

// 15 on Linux and macOS, but you had to know that
kill(process.Id, 15);
```

That is three lines of platform assumptions, a hardcoded signal number, and no way to tell whether the signal was actually delivered.

## The RC 1 API Surface

RC 1 adds four members to `Process`:

```csharp
public bool Signal(PosixSignal signal);
public ProcessExitStatus WaitForExitStatus();
public bool TryWaitForExitStatus(TimeSpan timeout, out ProcessExitStatus? exitStatus);
public Task<ProcessExitStatus> WaitForExitStatusAsync(
    CancellationToken cancellationToken = default);
```

That is enough to write the escalation pattern properly:

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

## ProcessExitStatus Stops the Exit-Code Guessing

`ProcessExitStatus` is a small sealed class with three properties: `ExitCode`, `Canceled`, and a nullable `PosixSignal? Signal`. The nullable signal is the useful part. Until now you inferred a signal death from the `128 + signal number` convention baked into the exit code, which quietly collides with any process that genuinely exits with 143. Now `status.Signal is PosixSignal.SIGTERM` answers the question directly, and `Canceled` tells you the wait ended on your timeout or `CancellationToken` rather than on the child.

This is the same `ProcessExitStatus` returned by `Process.RunAndCaptureText` and friends, which I covered when the [deadlock-free capture APIs landed in Preview 4](/2026/05/dotnet-11-process-api-deadlock-free-capture/).

## Where It Does Not Work

Three limits worth knowing before you write cross-platform supervisor code:

- `Signal` is annotated `[UnsupportedOSPlatform("ios")]` and `[UnsupportedOSPlatform("tvos")]`. Mac Catalyst is supported.
- On Windows only `PosixSignal.SIGKILL` is accepted, and it maps to `TerminateProcess`. Any other signal throws `PlatformNotSupportedException`, so a graceful-then-forceful path needs an `OperatingSystem.IsWindows()` branch.
- On Unix, `WaitForExitStatus` only works for a child of the current process. Waiting on a `Process` you attached to by PID throws.

The full list is in the [RC 1 libraries release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/libraries.md). With the go-live license attached, this is the first RC you can put behind production process supervision.
