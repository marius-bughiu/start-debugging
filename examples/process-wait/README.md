# Waiting for a child process in C#

Requires the .NET 10 SDK. The project targets .NET 8 and .NET 10; install the .NET 8 runtime as well to execute that target. A newer major runtime alone does not satisfy a `net8.0` application's default runtime requirement. From this folder:

```sh
dotnet run -c Release -f net10.0
dotnet run -c Release -f net8.0
```

The program starts copies of itself, without a shell or platform-specific commands. The two short-lived children return exit code 7 intentionally; the parent validates that code and exits successfully. A third child waits for standard input, so it cannot finish merely because the machine is fast or a timeout is short.

Expected parent output:

```text
sync exit: 7
async exit: 7
timed wait exited: False
canceled wait; child still running
released child exit: 0
```

The assertions cover blocking `WaitForExit()`, nonblocking `WaitForExitAsync()`, a timed-out synchronous wait, cancellation of an asynchronous wait without terminating the child, and orderly completion after closing the child's input. The `finally` block terminates only this example's owned child if an assertion or wait fails. There are no redirected output pipes to fill up.

Both the generated apphost and `dotnet path/to/ProcessWait.dll` are supported. When the current host is `dotnet`, the assembly path is passed as its own argument before the child-mode argument. `ArgumentList` handles argument boundaries; the example never constructs a shell command.

`WaitForExitAsync` is available starting with .NET 5. The same source runs on both targets; it does not depend on the newer process-capture APIs discussed in the linked .NET 11 article. With only the .NET 8 SDK installed, restrict the project to its .NET 8 target with `dotnet run -c Release -f net8.0 -p:TargetFrameworks=net8.0`. `Process.Dispose` releases the component's resources; it does not terminate a running process. Choose a shutdown policy appropriate to the process you own.

Sources: [WaitForExit](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexit), [WaitForExitAsync](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexitasync), [Kill](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill).
