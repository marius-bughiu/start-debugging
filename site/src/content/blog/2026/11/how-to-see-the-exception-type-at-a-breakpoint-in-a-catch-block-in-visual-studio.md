---
title: "How to see the exception type at a breakpoint in a catch block in Visual Studio"
description: "Hovering ex in catch (Exception ex) shows the declared type, not the real one. Use the $exception pseudovariable in the Locals window, ex.GetType() in Watch or Immediate, or break at the throw site with Exception Settings. Plus the wrapper types (AggregateException, TaskCanceledException) that hide the exception you actually care about, verified on .NET 11."
pubDate: 2026-11-27
template: how-to
tags:
  - "visual-studio"
  - "debugging"
  - "csharp"
  - "dotnet"
---

When you stop on a breakpoint inside `catch (Exception ex)`, the variable is declared as `Exception`, so the hover tooltip leads with the message and makes it easy to miss what the object really is. The fastest way to see the runtime type is the **Locals** window (Debug > Windows > Locals, or Alt+4): find the `$exception` pseudovariable (or `ex` itself) and read the **Type** column, which shows the concrete type such as `System.IO.DirectoryNotFoundException`. If you prefer typing, put `ex.GetType().FullName,nq` in a Watch window or `? ex.GetType()` in the Immediate window. And if you want to know the type *before* it gets caught, turn on "break when thrown" for Common Language Runtime Exceptions in Exception Settings, and the Exception Helper names the type at the throw site. The Visual Studio steps below follow the current Microsoft Learn docs for Visual Studio 2026 (version 18.x) and also apply to Visual Studio 2022; the C# snippets were run on .NET 11.0.0 (SDK 11.0.100, macOS arm64).

This came up as a [Stack Overflow question](https://stackoverflow.com/questions/80018330) this month, and it is worth a full answer because the "real" type is often one or two layers away from what `ex` points at.

## Why hovering ex does not just tell you

C# has two types for every reference: the static type the compiler knows (`Exception`, because that is what the `catch` clause declares) and the runtime type of the object on the heap. A `catch (Exception ex)` block catches everything derived from `System.Exception`, so `ex` can be a `FileNotFoundException`, a `SqlException`, a `TaskCanceledException`, or anything else. The data tip in the editor is built around the value, which for exceptions means the message, and you have to expand it to see what kind of object it is.

The runtime check is trivial in code, which is exactly what the asker did not want to do:

```csharp
// .NET 11, C# 14
try
{
    File.ReadAllText("/definitely/not/here.txt");
}
catch (Exception ex)
{
    Console.WriteLine(ex.GetType().FullName);
    Console.WriteLine(ex is IOException);
}
```

Running that on .NET 11.0.0 prints:

```text
System.IO.DirectoryNotFoundException
True
```

Note that the missing *directory* produces `DirectoryNotFoundException`, not `FileNotFoundException`. Both derive from `IOException`, which is why guessing the type from the message is unreliable and why you want the debugger to tell you. The rest of this post is about getting that answer without editing code.

## Read the type from the debugger, step by step

1. **Stop inside the catch.** Set a breakpoint on the `catch` line or the first statement in the block and start debugging (F5).
2. **Open Locals.** Debug > Windows > Locals, or Alt+4 per the [Autos and Locals docs](https://learn.microsoft.com/en-us/visualstudio/debugger/autos-and-locals-windows). The window has Name, Value, and Type columns.
3. **Find `$exception`.** It is a debugger pseudovariable that, per the [pseudovariables reference](https://learn.microsoft.com/en-us/visualstudio/debugger/pseudovariables), "displays information on the last exception." Its Type column gives you the concrete exception type. The `ex` row works too: its Type column shows the declared type together with the runtime type.
4. **Or ask with an expression.** In a Watch window, type `ex.GetType().FullName,nq` (the `nq` format specifier drops the quotes around the string). In the Immediate window (Debug > Windows > Immediate), `? ex.GetType()` prints the `Type` object.
5. **Or expand the data tip.** Hover `ex`, click the expand arrow, and the runtime type appears in the expanded view, along with members that only exist on the derived type, like `FileName` on `FileNotFoundException`.

A few details make this smoother.

### $exception works even without a variable

`$exception` is populated by the debugger, not by your code, so it also exists in a bare `catch { }` or `catch (Exception)` block with no variable name. The top-voted [Stack Overflow answer](https://stackoverflow.com/questions/80018330) also notes it is populated as soon as the `catch` line is hit, before you step into the block. That makes it useful in third-party code you are stepping through, where you cannot add `ex` to the catch clause. The docs add that when the Exception Helper is disabled, Visual Studio adds `$exception` to Locals automatically when an exception occurs. If nothing has been thrown, evaluating `$exception` gives an error rather than null.

### Use it in Watch, Immediate, and conditions

Because `$exception` is an expression the debugger understands, you can use it anywhere `ex` would work: `$exception.GetType().Name` in Watch, `$exception.InnerException` in Immediate, `$exception is System.IO.IOException` in a breakpoint condition. The [breakpoint docs](https://learn.microsoft.com/en-us/visualstudio/debugger/using-breakpoints) say a condition "can be any valid expression that the debugger recognizes", so a conditional breakpoint on the first line of a catch block with `ex is System.Net.Http.HttpRequestException` lets one generic handler run normally and only stops for the type you are chasing.

### Do not combine GetType() with nse

The `nse` format specifier means "no side effects": per the [C# format specifier reference](https://learn.microsoft.com/en-us/visualstudio/debugger/format-specifiers-in-csharp), if the expression "can only be resolved by an evaluation (such as a function call), you will see an error instead." `GetType()` is a method call, so `ex.GetType(),nse` fails. Plain `ex.GetType()` is safe: it has no side effects. If you have turned off "Enable property evaluation and other implicit function calls" under Tools > Options > Debugging, the [Watch window docs](https://learn.microsoft.com/en-us/visualstudio/debugger/watch-and-quickwatch-windows) note that C# lets you force evaluation of an expression with the `ac` specifier.

## Stop where the exception is thrown instead

Inspecting the type inside the catch tells you what arrived, but often the better question is where it came from. Visual Studio can break at the `throw` itself, before any handler runs:

1. Open **Debug > Windows > Exception Settings** (Ctrl+Alt+E in the default keyboard layout).
2. Check **Common Language Runtime Exceptions** to break on every managed exception, or expand it and check only the specific type, for example `System.IO.IOException`.
3. Run again. Per the [exception management docs](https://learn.microsoft.com/en-us/visualstudio/debugger/managing-exceptions-with-the-debugger), the debugger now breaks "wherever the exception is thrown, no matter whether it's handled", which is called a first chance exception.

When it breaks, the [Exception Helper](https://learn.microsoft.com/en-us/visualstudio/debugger/exception-helper) pops up next to the throwing line and shows the exception type and message at the top, any inner exceptions, and a "View Details" link to the full object. Its own Exception Settings section has a checkbox to keep breaking when that type is thrown, which is the quickest way to add a single type to the list from the place you first saw it.

Two things keep this from becoming noise. You can add a condition to an exception entry: per the docs, the supported conditions are module names to include or exclude, so you can limit breaking to your own assembly. And with Just My Code on, "Continue When Unhandled in User Code" (right-click an exception in the list) skips exceptions that framework code throws and handles itself. Exception Settings are stored in the solution's `.suo` file, so they persist between sessions for that solution.

## When the type you see is a wrapper

The type in the Type column is correct, but it is not always the type that matters. Three wrappers come up constantly, and all three were checked with a small console app on .NET 11.0.0.

### AggregateException from Wait() and .Result

Blocking on a faulted task wraps the original exception:

```csharp
// .NET 11, C# 14
try
{
    Task.Run(() => throw new InvalidOperationException("boom")).Wait();
}
catch (Exception ex)
{
    Console.WriteLine(ex.GetType().FullName);                    // System.AggregateException
    Console.WriteLine(ex.InnerException?.GetType().FullName);    // System.InvalidOperationException
    Console.WriteLine(ex.GetBaseException().GetType().FullName); // System.InvalidOperationException
}
```

`await` on the same task throws `InvalidOperationException` directly. If Locals shows `AggregateException`, expand `InnerExceptions` (plural, it can hold several), or watch `ex.GetBaseException().GetType()`. The full story, including `Task.WhenAll` and why only the first exception surfaces after `await`, is in [fixing AggregateException when awaiting Task.WhenAll](/2026/08/fix-aggregateexception-one-or-more-errors-occurred-when-awaiting-task-whenall/).

### TaskCanceledException that is really a timeout

`HttpClient` reports its own `Timeout` as cancellation. Pointing a client with a 300 ms timeout at a local TCP listener that accepts the connection but never responds gives:

```csharp
// .NET 11, C# 14
using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(300) };
try
{
    await http.GetStringAsync($"http://127.0.0.1:{port}/"); // server never answers
}
catch (Exception ex)
{
    Console.WriteLine(ex.GetType().FullName);                 // System.Threading.Tasks.TaskCanceledException
    Console.WriteLine(ex.InnerException?.GetType().FullName); // System.TimeoutException
    Console.WriteLine(ex is OperationCanceledException);      // True
}
```

So when Locals says `TaskCanceledException`, check `InnerException` before concluding something cancelled your token. The distinction, and how to tell a timeout from a real cancellation in code, is covered in [fixing TaskCanceledException from HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

### Base types in the hierarchy

`ex is IOException` was `True` for the `DirectoryNotFoundException` above because the full chain is `DirectoryNotFoundException -> IOException -> SystemException -> Exception`. The Type column shows only the most derived type. If you are deciding which `catch` clause to write, watch `ex.GetType().BaseType` and walk up, or check the type's page on Microsoft Learn, which lists the inheritance chain at the top.

## Let the code narrow the type for you

Once you know the type, the debugger session usually ends with a code change, and two C# features make the next session shorter.

The first is a specific `catch` clause or an exception filter, so the generic handler never sees the case you care about:

```csharp
// .NET 11, C# 14
try
{
    Thrower();
}
catch (Exception ex) when (Log(ex))
{
    // never reached, Log returns false
}
catch (Exception ex)
{
    Console.WriteLine($"second catch got {ex.GetType().Name}");
}

static void Thrower() => throw new FormatException("bad");

static bool Log(Exception ex)
{
    var onStack = new System.Diagnostics.StackTrace().GetFrames()
        .Any(f => f.GetMethod()?.Name.Contains("Thrower") == true);
    Console.WriteLine($"filter saw {ex.GetType().Name}; Thrower on stack: {onStack}");
    return false;
}
```

On .NET 11.0.0 this prints `filter saw FormatException; Thrower on stack: True`, then `second catch got FormatException`. The filter runs *before* the stack unwinds, so a breakpoint inside `Log` (or a filter like `when (ex is IOException)`) stops with the throwing method's locals still on the call stack. That is something a breakpoint inside a `catch` body cannot give you, because by then the stack has unwound. This "log in a filter that returns false" pattern is a cheap way to record every exception type passing through a boundary without changing control flow. If you are weighing exceptions against result types for expected failures, see [the Try pattern vs throwing exceptions in C#](/2026/10/try-pattern-vs-throwing-exceptions-for-expected-failures-in-csharp/).

The second is logging `ex.ToString()` rather than `ex.Message`. [`Exception.ToString()`](https://learn.microsoft.com/en-us/dotnet/api/system.exception.tostring) starts with the fully qualified type name, then the message, the inner exceptions, and the stack trace, so the log already answers "what type was it" the next time it happens in production where no debugger is attached. In ASP.NET Core, a single [global exception handler](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) is the natural place for that.

## Visual Studio Code and the C# Dev Kit

If you debug in VS Code with the C# extension, there is no Exception Settings tool window. The [VS Code C# debugging docs](https://code.visualstudio.com/docs/csharp/debugging) put the equivalent in the Run and Debug view's BREAKPOINTS section: "All Exceptions" and "User-Unhandled Exceptions" checkboxes, each accepting a condition that is "a comma-separated list of exception types to break on", or a list starting with `!` to exclude types, such as `!System.Threading.Tasks.TaskCanceledException`. Inside a catch block, the Variables pane lists `ex` with its runtime type once expanded, and the Debug Console evaluates `ex.GetType()` the same way the Immediate window does. Those docs do not mention `$exception`, so do not count on that pseudovariable outside Visual Studio.

## What was checked for this post

The C# snippets were compiled and run as one console app targeting `net11.0` with SDK 11.0.100 on macOS arm64 (`dotnet run -c Release`); the outputs quoted above are from that run. The Visual Studio and VS Code UI behavior (menu paths, shortcuts, `$exception`, Exception Settings, the Exception Helper) comes from the Microsoft documentation linked in each section and was not exercised in an IDE for this post, since Visual Studio itself is Windows-only. If you use the AI-assisted debugging features in recent releases, the [Visual Studio 18.5 debugger agent workflow](/2026/04/visual-studio-18-5-debugger-agent-workflow/) builds on the same Locals and Exception Helper surfaces.

## Sources

- [Pseudovariables in the Visual Studio debugger](https://learn.microsoft.com/en-us/visualstudio/debugger/pseudovariables) (`$exception`, `$returnvalue`)
- [Manage exceptions with the debugger in Visual Studio](https://learn.microsoft.com/en-us/visualstudio/debugger/managing-exceptions-with-the-debugger)
- [Inspect an exception using the Exception Helper](https://learn.microsoft.com/en-us/visualstudio/debugger/exception-helper)
- [Inspect variables in the Autos and Locals windows](https://learn.microsoft.com/en-us/visualstudio/debugger/autos-and-locals-windows)
- [Watch variables with Watch windows and QuickWatch](https://learn.microsoft.com/en-us/visualstudio/debugger/watch-and-quickwatch-windows)
- [Format specifiers for C# in the Visual Studio debugger](https://learn.microsoft.com/en-us/visualstudio/debugger/format-specifiers-in-csharp)
- [Use the right type of breakpoint](https://learn.microsoft.com/en-us/visualstudio/debugger/using-breakpoints)
- [Debugging C# in Visual Studio Code](https://code.visualstudio.com/docs/csharp/debugging)
- [Stack Overflow: How to see Exception type when in a breakpoint inside a catch block](https://stackoverflow.com/questions/80018330)
