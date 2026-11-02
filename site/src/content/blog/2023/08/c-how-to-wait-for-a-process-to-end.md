---
title: "C# How to wait for a process to end?"
description: "Wait for a child process in C# with WaitForExit or WaitForExitAsync. Run a complete example covering exit codes, timeouts, cancellation, and cleanup on .NET 8 and 10."
pubDate: 2023-08-11
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
---
Use `process.WaitForExit()` to block the current thread until a started process exits. In asynchronous code, use `await process.WaitForExitAsync()` instead; it waits without blocking the calling thread. Read `ExitCode` after the process has exited.

> Updated November 2, 2026: the original `cmd.exe /C timeout 5` example depended on Windows and its command environment. The replacement below starts its own child process and verifies both wait methods, timeouts, and cancellation on .NET 8 and .NET 10.

## Run the complete example

[Download the runnable process-wait project](/examples/process-wait.zip). Unzip it and run the following commands from its folder with the .NET 10 SDK. The .NET 8 command also needs the .NET 8 runtime:

```sh
dotnet run -c Release -f net10.0
dotnet run -c Release -f net8.0
```

The same source runs on both targets. It starts copies of itself rather than invoking a shell or requiring an external executable. The first two children intentionally return exit code `7`; the parent checks that result and returns `0` when every check succeeds. A third child waits for input so the timeout and cancellation checks do not depend on how quickly a short-lived command happens to finish.

Here is the complete `Program.cs`:

```cs
using System.Diagnostics;
using System.Reflection;

if (args is ["--child"])
{
    await Task.Delay(100);
    return 7;
}

if (args is ["--child-until-input"])
{
    await Console.In.ReadLineAsync();
    return 0;
}

using (var process = StartChild("--child"))
{
    process.WaitForExit();
    Require(process.ExitCode == 7, "Synchronous child exit code.");
    Console.WriteLine($"sync exit: {process.ExitCode}");
}

using (var process = StartChild("--child"))
{
    await process.WaitForExitAsync();
    Require(process.ExitCode == 7, "Asynchronous child exit code.");
    Console.WriteLine($"async exit: {process.ExitCode}");
}

using (var process = StartChild("--child-until-input"))
{
    try
    {
        bool exited = process.WaitForExit(50);
        Require(!exited, "A timed-out wait must leave the child running.");
        Console.WriteLine($"timed wait exited: {exited}");

        using var cancellation = new CancellationTokenSource(50);
        bool canceled = false;
        try
        {
            await process.WaitForExitAsync(cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            canceled = true;
        }

        Require(canceled && !process.HasExited, "Canceling the wait must not kill the child.");
        Console.WriteLine("canceled wait; child still running");

        process.StandardInput.Close();
        await process.WaitForExitAsync();
        Require(process.ExitCode == 0, "The released child must exit normally.");
        Console.WriteLine($"released child exit: {process.ExitCode}");
    }
    finally
    {
        if (!process.HasExited)
        {
            try { process.Kill(); }
            catch (InvalidOperationException) when (process.HasExited) { }
            await process.WaitForExitAsync();
        }
    }
}

return 0;

static Process StartChild(string mode)
{
    var start = new ProcessStartInfo
    {
        FileName = Environment.ProcessPath ?? throw new InvalidOperationException("No process path."),
        UseShellExecute = false,
        RedirectStandardInput = mode == "--child-until-input"
    };

    if (string.Equals(Path.GetFileNameWithoutExtension(start.FileName), "dotnet", StringComparison.OrdinalIgnoreCase))
        start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);

    start.ArgumentList.Add(mode);
    return Process.Start(start) ?? throw new InvalidOperationException("Child did not start.");
}

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
```

Expected output:

```text
sync exit: 7
async exit: 7
timed wait exited: False
canceled wait; child still running
released child exit: 0
```

## Timeouts, cancellation, and cleanup

`WaitForExit(50)` returns `false` when the child has not exited within the given number of milliseconds. `WaitForExitAsync(token)` throws `OperationCanceledException` when the wait is canceled. Neither result terminates the child. In the example, closing the child’s input lets it finish normally; the `finally` block kills only the child owned by this example if cleanup is needed after a failure.

For a real tool, choose an explicit shutdown policy: keep waiting, request a graceful shutdown using the tool’s protocol, or terminate the process when appropriate. `Kill()` requests forced termination, so still wait for the process to exit afterward. Disposing a `Process` releases its component resources; it does not stop the running program.

The [C# using declaration guide](/2020/05/c-using-var-using-declaration/) explains how `using` controls disposal when a scope ends.

If you redirect standard output or standard error, start draining those streams before waiting for exit. Otherwise a full pipe can leave the child waiting for its parent while the parent waits for the child. The [process-output capture guide](/2026/05/dotnet-11-process-api-deadlock-free-capture/) covers that separate problem and the newer .NET 11 APIs; the example here uses APIs already available on .NET 8.

Verified locally on macOS arm64 with actual .NET 8.0.33 and .NET 10.0.10 runtimes, using both the generated apphost and `dotnet ProcessWait.dll`. This is not a Windows or Linux execution claim; the download includes the exact verification record.

API references: [WaitForExit](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexit), [WaitForExitAsync](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexitasync), and [Kill](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill).
