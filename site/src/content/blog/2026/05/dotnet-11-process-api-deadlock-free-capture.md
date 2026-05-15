---
title: ".NET 11 Adds Deadlock-Free Process Output Capture"
description: ".NET 11 Preview 4 ships new System.Diagnostics.Process APIs that drain stdout and stderr concurrently, plus one-line run-and-capture helpers and KillOnParentExit."
pubDate: 2026-05-15
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "process"
---

Adam Sitnik [announced](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/) a round of `System.Diagnostics.Process` improvements that landed in .NET 11 Preview 4. The headline is that the deadlock trap every .NET developer hits at least once is finally solved at the BCL level, and the boilerplate around "start a process, capture its output, wait" collapses into a single call.

## Why the Old Pattern Deadlocks

The classic shape looks safe and is not:

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

If the child writes more than a pipe buffer's worth to `stderr` before the parent gets to `stderr.ReadToEnd()`, the child blocks on the full pipe and the parent blocks waiting for `stdout` to close. Both sides wait forever. The documented workaround was the event-based API with `OutputDataReceived`, manual `StringBuilder`s, and a `ManualResetEvent` per stream. It works, but nobody writes it correctly on the first try.

## The New One-Liners

.NET 11 adds `Process.RunAndCaptureText` and `Process.RunAndCaptureTextAsync`, which multiplex both pipes internally:

```csharp
ProcessTextOutput result = await Process.RunAndCaptureTextAsync(
    "git",
    ["log", "--oneline", "-n", "20"]);

if (result.ExitStatus.ExitCode != 0)
    throw new InvalidOperationException(result.StandardError);

Console.WriteLine(result.StandardOutput);
```

`ProcessTextOutput` carries the captured stdout, stderr, the process ID, and a `ProcessExitStatus` that reports both exit code and, on Unix, the terminating signal. There is a sibling `Process.ReadAllText` for callers that already have a running `Process`, plus `ReadAllLines/Async` for streaming `IEnumerable<ProcessOutputLine>` with a `StandardError` flag on each line, and `ReadAllBytes/Async` for binary tools. Per the blog, the sync `RunAndCaptureText` allocates roughly 4.5x less memory than the equivalent event-based loop on Windows.

## Lifetime and Detachment

Two long-standing footguns also get first-class support. `ProcessStartInfo.KillOnParentExit` ties the child to the parent's lifetime on Windows, Linux, and Android, so a crashing CLI tool no longer leaves orphaned workers. `ProcessStartInfo.StartDetached` is the opposite: the child outlives the parent and the terminal that spawned it. And `Process.StartAndForget` returns just the PID and immediately releases the parent's handle, which is what you want for fire-and-forget launches:

```csharp
int pid = Process.StartAndForget("notepad.exe");
```

## Handle Plumbing

For lower-level scenarios, `ProcessStartInfo.StandardInputHandle`, `StandardOutputHandle`, and `StandardErrorHandle` accept any `SafeFileHandle`, including pipes from the new `SafeFileHandle.CreateAnonymousPipe` and the discard sink from `File.OpenNullHandle`. `ProcessStartInfo.InheritedHandles` lets you whitelist exactly which handles cross the fork boundary, which closes a real source of file-lock leaks on Windows.

Try it in [.NET 11 Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) and start deleting `OutputDataReceived` handlers.
