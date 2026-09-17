---
title: "Process.Run vs Process.Start in .NET 11: which should you use?"
description: "Use Process.Run when you start a tool and only care how it exited: one call, a timeout that kills the child, and a ProcessExitStatus with the signal. Keep Process.Start when you need the Process object: writing to stdin, reading output as it arrives, UseShellExecute, or killing a whole process tree."
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "process"
---

**Use `Process.Run` (or `Process.RunAsync`) whenever you start a process, let it finish, and only need to know how it exited.** It is one call, it cannot leak a `Process` handle, its timeout or `CancellationToken` actually kills the child, and it returns a `ProcessExitStatus` that tells you whether the child exited normally, was killed by a signal, or was killed by you. **Keep `Process.Start` when you need the live `Process` object**: writing to stdin, reading output line by line while the process runs, `UseShellExecute` to open a URL or document, the `Exited` event, or `Kill(entireProcessTree: true)` for tools that spawn their own workers. Performance does not decide it: both measured at about 740 microseconds per spawn on .NET 11 RC 1. Everything below was verified against .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`, runtime `11.0.0-rc.1.26425.128`, C# 15) on macOS 26.6 with an Apple M4.

## The two APIs side by side

| Behaviour (.NET 11 RC 1)                  | `Process.Run` / `RunAsync`                          | `Process.Start` + `WaitForExit`                  |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| Available on                              | .NET 11+                                            | every .NET version                               |
| Returns                                   | `ProcessExitStatus`                                 | `Process` (must be disposed)                     |
| Default stdin/stdout/stderr               | inherited from parent (or null with `silent: true`) | inherited from parent                            |
| `RedirectStandardOutput = true`           | `InvalidOperationException`                         | yes                                              |
| Write to stdin while running              | no                                                  | yes                                              |
| `UseShellExecute = true`                  | `InvalidOperationException`                         | yes                                              |
| Timeout                                   | kills the child, `Canceled = true`                  | `WaitForExit(TimeSpan)` returns `false`, child keeps running |
| Cancellation (async)                      | kills the child, no exception                       | `WaitForExitAsync(ct)` throws, child keeps running |
| Terminating signal                        | `ProcessExitStatus.Signal`                          | guess from `ExitCode` (137, 143)                 |
| Kill grandchildren on timeout             | no, direct child only                               | `Kill(entireProcessTree: true)`                  |
| Process ID                                | not returned                                        | `Process.Id`                                     |
| Spawn `/usr/bin/true`, sync               | 737.0 us, 16.56 KB                                  | 739.4 us, 16.84 KB                               |

The first five rows decide most cases. If your call site touches `StandardInput`, `BeginOutputReadLine`, or `UseShellExecute`, `Process.Run` is not an option at all. If it does none of those, `Process.Run` is shorter and has safer defaults.

## What Process.Run actually does

`Process.Run` shipped in .NET 11 Preview 4 alongside `RunAndCaptureText` and `StartAndForget`, as part of the [Process API overhaul](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/) I covered when [deadlock-free output capture landed](/2026/05/dotnet-11-process-api-deadlock-free-capture/). The RC 1 surface is:

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

Two details differ from the Preview 4 blog post. Preview 7 changed `arguments` from `IList<string>?` to `IEnumerable<string>?` ([dotnet/runtime#130630](https://github.com/dotnet/runtime/pull/130630)), and the `fileName` overloads gained a `silent` flag that points stdin, stdout, and stderr at the null device.

The implementation in [`Process.Scenarios.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Scenarios.cs) is short enough to summarize exactly. It never creates a `Process` object. It calls `SafeProcessHandle.Start(startInfo)`, then either `WaitForExit()` or `WaitForExitOrKillOnTimeout(timeout)`, and disposes the handle before returning. `RunAsync` does the same with `WaitForExitOrKillOnCancellationAsync`. That is why it cannot leak a handle, and also why it rejects anything that needs a `Process` to drive it: the `RedirectStandard*` flags only make sense if someone holds `Process.StandardOutput` and drains it.

`ProcessExitStatus` has three properties: `ExitCode`, `Canceled`, and a nullable `PosixSignal? Signal`. The same type comes back from the [new `Process.WaitForExitStatus` methods in RC 1](/2026/09/dotnet-11-rc-1-process-signal-exit-status/).

## The same job written both ways

Here is the everyday case: run `dotnet build`, let its output flow to the console, fail if it fails, and give up after five minutes.

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

The `Process.Start` version is correct, but only because it remembers two things people routinely forget: `WaitForExit(TimeSpan)` does not kill anything on timeout, and the `Process` has to be disposed. The `Process.Run` version has no way to get either wrong. Note, though, that I kept `entireProcessTree: true` in the first version on purpose. More on that in the gotchas.

## Timeouts and cancellation behave differently

This is the difference that bites people who migrate by search-and-replace. I ran both against `sleep 10` with a 500 ms budget on .NET 11 RC 1:

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

Three things to take from that output:

1. **`RunAsync` does not throw on cancellation.** It kills the child with `SIGKILL` (or `TerminateProcess` on Windows), waits for it to exit, and returns a status with `Canceled = true`. Code that wraps it in `catch (OperationCanceledException)` will never enter the catch block. Check `status.Canceled` instead.
2. **`Process.WaitForExitAsync(ct)` only cancels the wait.** It throws `TaskCanceledException` and leaves the process alive. If you wanted it dead, you call `Kill()` yourself.
3. **`Signal` removes the exit code guessing.** On Unix, a process killed by `SIGKILL` reports exit code 137 and one killed by `SIGTERM` reports 143, and a process can also just `exit 137`. `ProcessExitStatus.Signal` tells you which one happened. Inside a `Process.Run` call, `Canceled` tells you whether the kill was yours.

The synchronous `Run` takes a `TimeSpan? timeout` and no token; `RunAsync` takes a token and no timeout. For an async timeout, use `new CancellationTokenSource(TimeSpan)` as above. If the cancellation flows in from an ASP.NET Core request or a hosted service, the patterns in [how to cancel a long-running Task without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) apply unchanged.

## When to pick Process.Run

- **Build scripts and CLI wrappers** that run `git`, `dotnet`, `npm`, or `docker` and let the output go straight to the console. With the default `silent: false`, the child inherits the parent's handles, so colours and progress bars keep working.
- **Health checks and probes** where only the exit code matters. `Process.Run("pg_isready", ["-h", host], silent: true, timeout: TimeSpan.FromSeconds(3))` is the entire implementation.
- **Tools that must never hang your service.** The timeout and cancellation paths kill the child for you, so a stuck `ffprobe` cannot pile up behind a request.
- **Writing output to a file instead of the console.** `ProcessStartInfo.StandardOutputHandle` accepts any `SafeFileHandle`, and `Run(ProcessStartInfo)` supports it:

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

If you need the output in memory rather than in a file, skip both APIs and call `Process.RunAndCaptureText`, which drains stdout and stderr concurrently so the classic redirect deadlock cannot happen.

## When to keep Process.Start

- **Interactive stdin.** Feeding a password to `ssh-keygen`, piping SQL into `psql`, or talking to a REPL needs `RedirectStandardInput` and `Process.StandardInput`. `Run` throws on any `RedirectStandard*` flag.
- **Streaming output while the process runs.** A progress UI that shows `ffmpeg` lines as they appear needs the `Process`. In .NET 11 you can at least drop the event handlers and use `process.ReadAllLinesAsync(ct)`, which yields `ProcessOutputLine` values from both streams without deadlocking.
- **Shell execution.** `Process.Start(new ProcessStartInfo("https://startdebugging.net") { UseShellExecute = true })` is still the way to open a URL or a document with its default app. `Run`, `RunAsync`, and `StartAndForget` all throw, because on Windows shell execution may not create a new process at all.
- **Process trees.** If the child spawns workers (MSBuild nodes, `npm` running `node`, a shell script), only `Process.Kill(entireProcessTree: true)` cleans them up. See the next section.
- **You need the `Process` itself**: `Id` for logging, the `Exited` event, `PriorityClass`, or the Windows-only `userName`/`password` overloads.
- **You target anything before .NET 11.** `Process.Run` does not exist in .NET 10. A library that multi-targets needs `#if NET11_0_OR_GREATER`.

## The benchmark

Performance is not a reason to choose either one, and I measured it so you do not have to wonder. Environment: .NET 11 RC 1 (`11.0.0-rc.1.26425.128`), BenchmarkDotNet 0.15.8 with the in-process emit toolchain (0.15.8 does not yet recognise `net11.0` for out-of-process runs), 3 warmup and 15 measured iterations, macOS 26.6.2, Apple M4 with 10 cores. Each benchmark spawns `/usr/bin/true` and waits for it.

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

The difference is inside the noise. Almost all of the cost is the OS creating the process, and both APIs share the same `SafeProcessHandle` start path. Skipping the `Process` object saves about 300 bytes. The big .NET 11 wins (98x faster process start on Apple Silicon, according to the .NET team's measurements) apply to both APIs equally, because they live below this layer.

## Gotchas that decide it for you

**A timeout kills only the direct child.** I ran `Process.Run("sh", ["-c", "sleep 31; true"], timeout: TimeSpan.FromMilliseconds(500))`. `Run` returned `Canceled=True Signal=SIGKILL`, and `pgrep -f "sleep 31"` still found the `sleep` process afterwards, reparented and running. The same test with `Process.Start` and `Kill(entireProcessTree: true)` left nothing behind. `dotnet build`, `npm run`, `docker compose`, and most shell scripts spawn children, so if a timeout must leave the machine clean, `Process.Start` with a tree kill is still the correct tool. `ProcessStartInfo.KillOnParentExit` (Windows, Linux, and Android only) is not a substitute: it fires when your process exits, not when a timeout expires.

**There is no string-arguments overload.** `Process.Run("git", "status")` does not compile, because `string` is not `IEnumerable<string>`. Pass `["status"]`, or build a `ProcessStartInfo("git", "status")` and use the `Run(ProcessStartInfo)` overload.

**`silent: true` also nulls stdin.** A child that prompts, such as `git` asking for credentials, reads end-of-file immediately instead of hanging. That is usually what you want in a service and surprising in a dev script.

**`Run(ProcessStartInfo)` rejects your existing start info.** If you migrate a `ProcessStartInfo` that still has `RedirectStandardOutput = true`, you get `InvalidOperationException: The RedirectStandardInput, RedirectStandardOutput, and RedirectStandardError properties cannot be used by SafeProcessHandle.Start or Process.StartAndForget`. The message mentions neither `Run` nor `RunAsync`, but it is the same check. Replace the flag with `StandardOutputHandle`, or switch to `RunAndCaptureText`.

**Starting failures are identical.** A missing executable throws the same `Win32Exception` ("No such file or directory") from both APIs, so existing error handling carries over.

**Neither is supported on iOS or tvOS.** Both carry `[UnsupportedOSPlatform("ios")]` and `[UnsupportedOSPlatform("tvos")]`, and Mac Catalyst is supported. The platform analyzer flags calls in a MAUI project either way.

## The call

For new .NET 11 code that runs a process to completion, default to `Process.Run` or `Process.RunAsync`. They remove the three most common mistakes in process code (the undisposed `Process`, the timeout that does not kill, the exit code that hides a signal) with no measurable cost. Move to `Process.RunAndCaptureText` the moment you need the output as a string. Reach for `Process.Start` only when the process has to be driven while it runs, opened through the shell, or torn down as a whole tree. That last case matters more than it looks, because many tools you would wrap in `Process.Run` quietly spawn children that its timeout will not touch. If you still maintain older code that blocks on `WaitForExit`, the [basic wait-for-exit patterns](/2023/08/c-how-to-wait-for-a-process-to-end/) are where `Process.Start` code usually starts, and they are worth revisiting with these defaults in mind.

### Related

- [.NET 11 adds deadlock-free process output capture](/2026/05/dotnet-11-process-api-deadlock-free-capture/)
- [.NET 11 RC 1 lets you SIGTERM a child process without P/Invoke](/2026/09/dotnet-11-rc-1-process-signal-exit-status/)
- [C#: how to wait for a process to end](/2023/08/c-how-to-wait-for-a-process-to-end/)
- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [.Result and .Wait() vs GetAwaiter().GetResult() vs await in C#](/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)

### Sources

- [Process API improvements in .NET 11](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/), .NET Blog
- [`Process.Scenarios.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Scenarios.cs) and [`SafeProcessHandle.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/Microsoft/Win32/SafeHandles/SafeProcessHandle.cs) at the `v11.0.0-rc.1.26425.128` tag, dotnet/runtime
- [Implement Process.Run, RunAsync, RunAndCaptureText, RunAndCaptureTextAsync](https://github.com/dotnet/runtime/pull/127210), dotnet/runtime PR
- [.NET 11 Preview 7 libraries release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/libraries.md) (the `IEnumerable<string>` arguments change), dotnet/core
- [What's new in .NET libraries for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries), MS Learn
- [`Process.Start` method](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.start), MS Learn
