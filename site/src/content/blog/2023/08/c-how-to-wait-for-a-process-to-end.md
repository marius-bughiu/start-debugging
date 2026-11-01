---
title: "C# How to wait for a process to end?"
description: "You can use the WaitForExit method to wait for the process to complete. Your code will wait synchronously for the process to finish, then it will resume execution. Let’s look at an example: The code above will start a new cmd.exe process, and execute the timeout 5 command. The process.WaitForExit() call will force your program…"
pubDate: 2023-08-11
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
---
You can use the `WaitForExit` method to wait for the process to complete. Your code will wait synchronously for the process to finish, then it will resume execution.

Let’s look at an example:

```cs
var process = new Process
{
    StartInfo = new ProcessStartInfo
    {
        WindowStyle = ProcessWindowStyle.Hidden,
        FileName = "cmd.exe",
        Arguments = "/C timeout 5"
    }
};

process.Start();
process.WaitForExit();
```

The code above will start a new `cmd.exe` process, and execute the `timeout 5` command. The `process.WaitForExit()` call will force your program to wait until the process finishes executing the `timeout` command. Then it will resume the execution of the thread.

If you also need to capture standard output and standard error, the [.NET 11 process API guide](/2026/05/dotnet-11-process-api-deadlock-free-capture/) covers the newer capture methods and the deadlock risks of redirected streams.
