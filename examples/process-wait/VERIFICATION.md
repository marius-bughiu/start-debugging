# Verification record — November 2, 2026

Executed locally on macOS 27 arm64. The project has no package dependencies. These runs establish the listed process behavior, not universal platform support or performance.

| Toolchain and actual runtime | Launches | Result |
| --- | --- | --- |
| SDK 8.0.427 / .NET 8.0.33 | `dotnet run` apphost; explicit `dotnet ProcessWait.dll` | Passed |
| SDK 10.0.302 / .NET 10.0.10 | `dotnet run` apphost; explicit `dotnet ProcessWait.dll` | Passed |
| SDK 10.0.302 / .NET 8.0.33 | Build the `net8.0` target; execute its DLL with the .NET 8 host | Passed |

Every run asserted:

1. `WaitForExit()` observes the owned child's exit code 7.
2. `WaitForExitAsync()` observes the owned child's exit code 7.
3. `WaitForExit(50)` returns false while a child waits on its open input pipe.
4. Canceling `WaitForExitAsync` raises cancellation while that child is still running.
5. Closing the child's input releases it, and a subsequent wait observes normal exit code 0.

Expected output from the parent, which exits with code 0:

```text
sync exit: 7
async exit: 7
timed wait exited: False
canceled wait; child still running
released child exit: 0
```

The exact `Program.cs` is published in all six language versions of the article. The tested project was copied to temporary directories so build products are outside the source archive. On the .NET 8 SDK, the multi-target project was narrowed with `-p:TargetFrameworks=net8.0`; on the .NET 10 SDK it restored both target frameworks. `-p:NuGetAudit=false` was used for these dependency-free local builds to avoid a blocked vulnerability-data network request.

The locally installed .NET 8 and .NET 10 runtimes live in separate installation roots. A .NET 10 `dotnet run -f net8.0` launch therefore cannot find .NET 8 in its own runtime root here; the SDK 10-built `net8.0` DLL was executed explicitly with the .NET 8 host instead. In a normal shared installation, install both runtimes to run both framework targets. Runtime 10 execution was checked with the `net10.0` output, not inferred from the SDK version or a roll-forward setting.

Windows and Linux execution were not performed locally. The example does not start a shell, redirect output streams, access unrelated processes, or require an external command. It creates only its own child processes. No wall-clock timing, throughput, process-tree cleanup, GUI responsiveness, or redirected-output behavior is claimed by these checks.
