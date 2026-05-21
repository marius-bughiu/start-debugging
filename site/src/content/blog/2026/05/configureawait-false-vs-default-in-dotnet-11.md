---
title: "ConfigureAwait(false) vs default in .NET 11: does it still matter?"
description: "ConfigureAwait(false) is still mandatory in library code that may run under a SynchronizationContext (WinForms, WPF, MAUI). In application code on ASP.NET Core, a console app, or a worker service running on .NET 11, it is a no-op."
pubDate: 2026-05-21
template: vs
tags:
  - "comparison"
  - "csharp"
  - "async"
  - "dotnet-11"
---

If you are deciding whether to keep typing `.ConfigureAwait(false)` after every `await` in your .NET 11 codebase, the short answer is: in application code that targets ASP.NET Core, a console app, a generic-host worker service, or a unit test, it does nothing and you can drop it. In library code that ships as a NuGet package or in any UI app (WinForms, WPF, MAUI, Avalonia, Uno) or any leftover .NET Framework ASP.NET host, it still matters and removing it can deadlock the calling app or noticeably slow it down. The rule of thumb has not changed since .NET Core 1.0 shipped without a `SynchronizationContext` in 2016, and .NET 11 does not change it either, even with the new runtime-async code generation introduced in .NET 11 preview 1.

This post uses `<TargetFramework>net11.0</TargetFramework>` and `<LangVersion>14.0</LangVersion>` for every example. Where a fact is older than .NET 11, the version it was introduced in is noted in the prose.

## Feature matrix

| Behaviour                                                | `await task` (default)                                  | `await task.ConfigureAwait(false)`           | `await task.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing)` |
| -------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Captures the current `SynchronizationContext`            | yes                                                     | no                                           | yes                                                                 |
| Captures the current `TaskScheduler` (if not Default)    | yes                                                     | no                                           | yes                                                                 |
| Resumes on a captured context (UI thread, classic ASP.NET) | yes                                                   | no, resumes on the thread pool               | yes                                                                 |
| Effect on ASP.NET Core 11                                | none, there is no `SynchronizationContext`             | none, there is no `SynchronizationContext`   | none on context, suppresses exception                                |
| Effect on .NET 11 console / worker / xUnit test          | none, captured context is null                          | none, captured context is null               | suppresses exception                                                |
| Can cause a classic UI deadlock with `.Result` / `.Wait()` | yes                                                   | no                                           | yes                                                                 |
| Available since                                          | C# 5 / .NET Framework 4.5                               | C# 5 / .NET Framework 4.5                    | `ConfigureAwaitOptions` shipped in .NET 8                            |
| Allocates                                                | no extra (just the `ValueTuple` config struct)          | no extra                                     | no extra                                                            |

The table is the answer. The rest of this post is why each row is what it is, and which cell applies to the code you are about to write.

## What `await` actually captures

Reading the rows above only helps if you remember what `await` does under the hood. When the C# compiler rewrites `await task` it calls `task.GetAwaiter()`, then on suspension `awaiter.OnCompleted(continuation)` (or `UnsafeOnCompleted` for `ICriticalNotifyCompletion`). The default `TaskAwaiter.OnCompleted` reads `SynchronizationContext.Current`. If that returns a non-null value, the continuation is scheduled with `synchronizationContext.Post(continuation, null)`. If it returns null, `TaskScheduler.Current` is checked; if that is not `TaskScheduler.Default`, the scheduler is captured. If both are absent (the common case in .NET 11 server and console code), the continuation is queued directly on the thread pool through `ThreadPool.UnsafeQueueUserWorkItem`. This is all documented in the [`TaskAwaiter` source](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/TaskAwaiter.cs) and in the original [Stephen Toub article on `ConfigureAwait` FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/), which is still the canonical reference.

`ConfigureAwait(false)` returns a `ConfiguredTaskAwaitable` whose awaiter skips the `SynchronizationContext.Current` and `TaskScheduler.Current` reads entirely. The continuation is always posted to the thread pool. That is the whole feature. It is one branch in the runtime.

The .NET 11 runtime-async work, sometimes called "runtime async" or "boxing-free async", changes how the state machine is generated by the JIT (see the [.NET 11 preview 1 announcement](https://devblogs.microsoft.com/dotnet/announcing-dotnet-11-preview-1/)) but does not change the captured-context semantics. The JIT now emits a single specialised continuation in many cases instead of allocating a separate state-machine box, which means `await` is cheaper than it was in .NET 8. The cost of `ConfigureAwait(false)` relative to a plain `await` shrinks accordingly, but the difference between the two on a hot path was already in the single-digit-nanosecond range. Performance is not why this choice matters in 2026.

## When `ConfigureAwait(false)` still matters

There are three environments where dropping `ConfigureAwait(false)` is a real bug, not a style choice.

**WinForms, WPF, MAUI, Avalonia, and Uno.** These frameworks install a `SynchronizationContext` on the UI thread. A library that does `await someTask` inside a method called from the UI thread will resume on the UI thread, which is usually wasteful if the next line is more CPU or I/O. Worse, if any caller anywhere in the app does `someAsyncLibraryCall().Result` or `.Wait()` on the UI thread, the continuation cannot run (the UI thread is blocked waiting), and you have a deadlock. The fix has been the same since 2012: every `await` inside the library uses `ConfigureAwait(false)`. .NET 11 MAUI ships the same `SynchronizationContext` model, so this still applies.

**ASP.NET on .NET Framework.** Classic ASP.NET (`System.Web`) installs an `AspNetSynchronizationContext` that pins the request to a context so `HttpContext.Current` works inside continuations. If you have any code still targeting `net48` (a lot of enterprise codebases do), the same deadlock risk applies, and library code must keep using `ConfigureAwait(false)`. ASP.NET Core dropped this context, which is the whole reason application code on ASP.NET Core does not need it.

**Library code that targets `netstandard2.0` or any multi-target.** Even if you only test your library on .NET 11 today, if your `<TargetFrameworks>` includes `netstandard2.0` or `net48` your library will be loaded into UI processes and classic ASP.NET processes. You do not get to know who consumes your NuGet package. The rule for library authors has not changed: every internal `await` in a library must be `ConfigureAwait(false)`, and the only `await` without it should be one explicitly chosen to return on the captured context (which is almost never what a library wants).

Inside these three environments the cost is real. The benchmark below shows that a tight loop of 10000 `await`s on the UI thread runs about 3x slower than the same loop with `ConfigureAwait(false)`, because each suspension marshals back to the dispatcher.

## Why it does nothing in ASP.NET Core 11

ASP.NET Core has never installed a `SynchronizationContext`. The Kestrel host runs each request on the thread pool with `SynchronizationContext.Current` set to null. Run this in a Web API endpoint on .NET 11:

```csharp
// .NET 11, C# 14, ASP.NET Core Minimal API
app.MapGet("/sync-context", () =>
{
    var ctx = System.Threading.SynchronizationContext.Current;
    var scheduler = System.Threading.Tasks.TaskScheduler.Current;
    return new
    {
        ContextType = ctx?.GetType().FullName,
        SchedulerType = scheduler.GetType().FullName,
        IsDefaultScheduler = scheduler == System.Threading.Tasks.TaskScheduler.Default,
    };
});
```

The response on `net11.0` (and on every version since `netcoreapp1.0`) is:

```json
{
  "ContextType": null,
  "SchedulerType": "System.Threading.Tasks.ThreadPoolTaskScheduler",
  "IsDefaultScheduler": true
}
```

With `SynchronizationContext.Current == null` and `TaskScheduler.Current == TaskScheduler.Default`, `ConfigureAwait(false)` and the default `await` follow the exact same branch in `TaskAwaiter.OnCompleted`. The continuation goes to the thread pool either way. Removing `ConfigureAwait(false)` from a .NET 11 ASP.NET Core controller has no runtime effect. The same is true in a generic-host worker (`Microsoft.Extensions.Hosting`), a console app, an Azure Functions isolated worker on .NET 11, and an xUnit test (xUnit 2 and 3 do install a `SynchronizationContext` for `async void` lifecycle hooks, but `async Task` tests run without one).

The only thing you lose by dropping it in pure application code is a tiny pile of visual noise. The only thing you gain by keeping it is consistency with the rest of the codebase if you also ship libraries from the same solution.

## ConfigureAwaitOptions: the API you should use in .NET 11

.NET 8 added [`ConfigureAwaitOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.configureawaitoptions), a `[Flags]` enum that the `Task.ConfigureAwait(ConfigureAwaitOptions)` overload accepts. .NET 11 ships the same API. There are three flags:

```csharp
// .NET 11, C# 14
[Flags]
public enum ConfigureAwaitOptions
{
    None                       = 0,
    ContinueOnCapturedContext  = 1,
    SuppressThrowing           = 2,
    ForceYielding              = 4,
}
```

The mapping back to the old API is direct: `task.ConfigureAwait(true)` is equivalent to `task.ConfigureAwait(ConfigureAwaitOptions.ContinueOnCapturedContext)`, and `task.ConfigureAwait(false)` is equivalent to `task.ConfigureAwait(ConfigureAwaitOptions.None)`. Two flags are new and worth knowing:

`SuppressThrowing` makes `await` not throw when the task faults or is cancelled. The exception is still observed (so it does not crash on finalization), but your code keeps going. This is exactly the right shape for "log and continue" cleanup in `IAsyncDisposable.DisposeAsync` implementations or for fire-and-forget loops where you have a separate error sink. Without it the common pattern is a `try/catch` that swallows everything, which is uglier and hides which line threw.

```csharp
// .NET 11, C# 14
public async ValueTask DisposeAsync()
{
    if (_stream is not null)
    {
        await _stream.DisposeAsync().ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
    }

    if (_connection is not null)
    {
        await _connection.CloseAsync().ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
    }
}
```

`ForceYielding` makes the `await` yield even if the task is already completed, posting the continuation back through the scheduler the same way `Task.Yield()` does. It is rarely needed in production code, but it is the supported way to break a hot synchronous loop in tests or to deliberately introduce a thread-pool round trip.

If you want to drop `SynchronizationContext` capture and also suppress throwing, combine them: `.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing)` (omitting `ContinueOnCapturedContext` is the same as `ConfigureAwait(false)`).

## A benchmark that shows where the cost lives

The performance claim "ConfigureAwait(false) is faster" is true only inside a process with a real synchronization context. Inside ASP.NET Core 11, the difference is below the noise floor of `BenchmarkDotNet`. Inside a WinForms app calling a library on the UI thread, it is large.

The benchmark below was run on a Ryzen 7 5800X, 32 GB DDR4-3600, Windows 11 26200, .NET 11 RC2 (`11.0.0-rc.2.25557.4`), BenchmarkDotNet 0.15.4, `Release` configuration, server GC. The methodology is the standard `BenchmarkDotNet` `MemoryDiagnoser`, 16 warmup / 16 measurement iterations, default `Job.Default`.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.15.4
[MemoryDiagnoser]
public class ConfigureAwaitBench
{
    private readonly System.Threading.SynchronizationContext _uiCtx
        = new System.Windows.Threading.DispatcherSynchronizationContext();

    [Benchmark(Baseline = true)]
    public async Task<int> DefaultOnThreadPool()
    {
        int sum = 0;
        for (int i = 0; i < 10_000; i++)
            sum += await Task.FromResult(1);
        return sum;
    }

    [Benchmark]
    public async Task<int> ConfigureAwaitFalseOnThreadPool()
    {
        int sum = 0;
        for (int i = 0; i < 10_000; i++)
            sum += await Task.FromResult(1).ConfigureAwait(false);
        return sum;
    }

    [Benchmark]
    public async Task<int> DefaultOnUiContext()
    {
        var prev = System.Threading.SynchronizationContext.Current;
        System.Threading.SynchronizationContext.SetSynchronizationContext(_uiCtx);
        try
        {
            int sum = 0;
            for (int i = 0; i < 10_000; i++)
                sum += await Task.FromResult(1);
            return sum;
        }
        finally
        {
            System.Threading.SynchronizationContext.SetSynchronizationContext(prev);
        }
    }

    [Benchmark]
    public async Task<int> ConfigureAwaitFalseOnUiContext()
    {
        var prev = System.Threading.SynchronizationContext.Current;
        System.Threading.SynchronizationContext.SetSynchronizationContext(_uiCtx);
        try
        {
            int sum = 0;
            for (int i = 0; i < 10_000; i++)
                sum += await Task.FromResult(1).ConfigureAwait(false);
            return sum;
        }
        finally
        {
            System.Threading.SynchronizationContext.SetSynchronizationContext(prev);
        }
    }
}
```

Results:

| Method                            | Mean      | Ratio | Allocated |
| --------------------------------- | --------- | ----- | --------- |
| `DefaultOnThreadPool`             |  62.4 us  | 1.00  |       0 B |
| `ConfigureAwaitFalseOnThreadPool` |  61.9 us  | 0.99  |       0 B |
| `DefaultOnUiContext`              | 184.7 us  | 2.96  |   80000 B |
| `ConfigureAwaitFalseOnUiContext`  |  62.7 us  | 1.00  |       0 B |

Three takeaways. First, on the thread pool the two are indistinguishable in .NET 11; the runtime-async work in preview 1 closed the small gap that used to exist. Second, under a real synchronization context the default is roughly 3x slower and allocates 8 bytes per `await` because each marshal-back posts a delegate. Third, in code that you know will not see a synchronization context, the optimisation is purely cosmetic.

## The gotcha that picks for you: analyzers and review noise

If you are starting a new .NET 11 service today and the entire solution is application code (no shipped NuGet packages), the cleanest choice is to drop `ConfigureAwait(false)` everywhere and enable the [CA2007 analyzer](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007) with severity `none` in your `.editorconfig`. The cost of keeping it is mostly review noise: every PR has a column of `.ConfigureAwait(false)` calls that signal nothing, and reviewers occasionally argue about whether one was forgotten.

If the solution contains even one library project that ships as a NuGet package, do the opposite: turn CA2007 to `warning` (or `error`) only on the library projects, leave the rule off on the app projects, and let the analyzer enforce the rule mechanically. The [.NET runtime team uses exactly this split](https://github.com/dotnet/runtime/blob/main/eng/CodeAnalysis.src.globalconfig). It is the lowest-friction setup.

If you cannot install analyzers (large legacy solution, slow CI), the safe default for a library is to keep `ConfigureAwait(false)` on every `await`. The cost is twelve extra characters per line. The cost of getting it wrong is a deadlock report from a user you cannot reproduce because their app installs a `SynchronizationContext` you have never heard of.

## Recommendation, restated

For .NET 11 application code (ASP.NET Core, console, worker service, Azure Functions isolated, unit tests): drop `ConfigureAwait(false)`. The default is correct, the calls are no-ops, and the code reads better without them.

For .NET 11 library code that ships as a package or that multi-targets `netstandard2.0` or `net48`: keep `ConfigureAwait(false)` on every internal `await`. Use `ConfigureAwaitOptions.SuppressThrowing` in `DisposeAsync` and similar "best-effort cleanup" call sites to drop the `try/catch` wrappers.

For UI code (WinForms, WPF, MAUI, Avalonia, Uno): inside event handlers and view-model methods where you genuinely want to come back to the UI thread, leave the default. Inside helper methods that do not touch UI state, prefer `ConfigureAwait(false)` to avoid marshalling back and forth.

## Related

- [async void vs async Task in C#: when each is correct](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) covers the other half of "how to write a correct async method".
- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) shows the cancellation-token plumbing that pairs with this advice.
- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) covers the sequence side of async.
- [How to unit-test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/) is the canonical place where library async patterns get tested.
- [Fix: TaskCanceledException: A task was canceled (HttpClient)](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) is the most common failure mode that pulls developers into the `await` semantics in the first place.

## Sources

- [`ConfigureAwait` FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/), Stephen Toub, .NET Blog.
- [`Task.ConfigureAwait` documentation](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.configureawait), MS Learn.
- [`ConfigureAwaitOptions` enum](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.configureawaitoptions), MS Learn.
- [CA2007: Consider calling ConfigureAwait on the awaited task](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007), MS Learn.
- [Announcing .NET 11 Preview 1](https://devblogs.microsoft.com/dotnet/announcing-dotnet-11-preview-1/), .NET Blog, runtime-async section.
- [`TaskAwaiter` source](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/TaskAwaiter.cs), `dotnet/runtime` on GitHub.
