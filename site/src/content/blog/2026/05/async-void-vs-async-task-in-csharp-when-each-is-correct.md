---
title: "async void vs async Task in C#: when each is correct"
description: "async Task is the default and async void is the exception. Use async void only for event handlers, top-level message-loop handlers, and a handful of framework callbacks that demand a void signature. Everywhere else, async Task wins on exceptions, composition, and testability."
pubDate: 2026-05-20
template: vs
tags:
  - "comparison"
  - "csharp"
  - "async"
  - "dotnet-10"
---

If you are choosing between `async void` and `async Task` for a method you are about to write in C# 14 / .NET 10, the answer is `async Task`. The only legitimate reasons to declare `async void` are event handlers wired to a `+=` event, top-level handlers in a message loop (a WinForms button click, a WPF `Loaded` handler, a MAUI page event), and a tiny set of framework callbacks whose signature is fixed by an external contract (`ICommand.Execute`, certain test fixtures, some test runners). For anything you call yourself, `async Task` is correct because exceptions become catchable, the call site can `await` completion, and the method becomes composable with `Task.WhenAll`, cancellation, and unit tests.

This post is the long version of that answer. Everything below uses `<TargetFramework>net10.0</TargetFramework>` and `<LangVersion>14.0</LangVersion>` unless noted, but the rules have not changed since async was added in C# 5.0.

## Feature matrix

| Feature                                  | `async void`                                                   | `async Task`                                |
| ---------------------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| Caller can `await`                       | no                                                             | yes                                         |
| Caller can `catch` thrown exceptions     | no, propagated to `SynchronizationContext` / `AppDomain`       | yes, captured on the returned `Task`        |
| Composable with `Task.WhenAll` / `.WhenAny` | no                                                          | yes                                         |
| Unit-testable for completion / result    | no, returns immediately                                        | yes, `await` the returned `Task`            |
| Triggers `SynchronizationContext.OperationStarted/Completed` | yes                                          | no                                          |
| Survives an unhandled exception          | crashes the process by default since .NET Framework 4.5        | no, exception sits on the `Task` until observed |
| Signature compatible with C# events      | yes (`EventHandler` returns `void`)                            | no                                          |
| Legal in interfaces / virtual overrides where the contract says `void` | yes                                  | only if the contract returns `Task`         |

The table is the post. Everything below is the why.

## Why `async void` is hostile to callers

The C# compiler rewrites `async` methods into a state machine that hands its work to an `AsyncMethodBuilder`. For `async Task` methods the builder is [`AsyncTaskMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asynctaskmethodbuilder), which exposes a `Task` property. When the state machine completes, the builder calls `SetResult` or `SetException` on that task, and any caller holding the reference observes the outcome.

For `async void` the builder is [`AsyncVoidMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asyncvoidmethodbuilder). It has no `Task` to return. Three concrete consequences follow.

First, the call site has no handle to await. If you write `DoStuffAsync();` and `DoStuffAsync` returns `void`, the line completes when the first `await` inside the method suspends, not when the method's work finishes. The next statement runs immediately, even if the method has not done its job. This is the cause of the classic "the data is gone by the time I read it" bug.

Second, exceptions thrown inside an `async void` method are not stored anywhere. `AsyncVoidMethodBuilder.SetException` posts them to the `SynchronizationContext` that was current when the method started. In a WinForms or WPF process that means the UI thread's message loop, which raises `Application.ThreadException` (WinForms) or `Application.DispatcherUnhandledException` (WPF). In a console app or an ASP.NET Core background context the synchronization context is null, so the exception is queued on the thread pool, which surfaces it on `AppDomain.CurrentDomain.UnhandledException` and, since .NET Framework 4.5 and every .NET 5+ release, terminates the process. There is no `try/catch` at the call site that can save you, because the exception never travels through the call site.

Third, the method calls [`SynchronizationContext.OperationStarted`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext.operationstarted) when it begins and `OperationCompleted` when it finishes. Most contexts ignore these calls. The exceptions are `AsyncOperationManager`-style contexts used by `xUnit` and a few testing frameworks: they count outstanding async work so the test runner knows when to consider a test finished. For an `async void` method, the runner will wait. For ordinary callers, this work is wasted.

## Minimal repro: a crash you cannot catch

```csharp
// .NET 10, C# 14, console app
using System;
using System.Threading.Tasks;

try
{
    Boom();
    await Task.Delay(100);
}
catch (Exception ex)
{
    Console.WriteLine($"caught: {ex.Message}");
}

static async void Boom()
{
    await Task.Yield();
    throw new InvalidOperationException("from async void");
}
```

Run that. The output is not "caught: from async void". It is an unhandled-exception trace and the process exits with a non-zero code. The `catch` block above never sees the exception because the exception is raised on the thread-pool worker that resumed the state machine after `Task.Yield`, not on the original caller's stack.

Change one keyword:

```csharp
// .NET 10, C# 14
static async Task Boom()
{
    await Task.Yield();
    throw new InvalidOperationException("from async Task");
}
```

Now `await Boom();` at the call site catches the exception, and even `Boom();` without `await` will not crash the process: the exception sits on the unobserved `Task` until either someone observes it or the `Task` is finalized (which, by default, no longer crashes the process either since .NET 4.5's `<ThrowUnobservedTaskExceptions>` default flipped to `false`).

## When `async void` is correct

There are exactly three categories where `async void` is appropriate. Be strict about staying inside them.

**Event handlers wired to a CLR event.** The `EventHandler` delegate returns `void`. You cannot make the method return `Task` and still subscribe with `+=`. If you write a `Button.Click` handler, a `Window.Loaded` handler, a MAUI `Page.Appearing` handler, or any signature of the form `void (object?, EventArgs)`, it must be `async void`. The framework (WinForms, WPF, MAUI, Avalonia, Uno) raises the event on the UI thread, and the synchronization context posts unhandled exceptions back to the UI thread's dispatcher unhandled-exception event, which most apps already log. Keep the handler thin and delegate to an `async Task` method as soon as you have done the argument-shaping:

```csharp
// .NET 10, MAUI, C# 14
private async void OnSaveClicked(object? sender, EventArgs e)
{
    try
    {
        await SaveAsync(_viewModel.Form);
    }
    catch (Exception ex)
    {
        await DisplayAlert("Save failed", ex.Message, "OK");
    }
}

private async Task SaveAsync(FormData form)
{
    using var http = _httpFactory.CreateClient("api");
    var response = await http.PostAsJsonAsync("/forms", form);
    response.EnsureSuccessStatusCode();
}
```

The `try/catch` is mandatory in the handler. The handler is the only place where you have a chance to observe an exception before the runtime turns it into a crash, so do not leave it bare.

**Top-level message-loop callbacks.** Some frameworks expose hook points that look like events but are actually delegates with a `void` signature: a routed-command `Executed` handler, an `ICommand.Execute(object)` override (the interface returns `void`), a `BackgroundWorker.DoWork` handler, a `Timer.Elapsed` handler with the `System.Timers.Timer`-style signature, and so on. The rule is the same as for events: keep them thin and wrap them in `try/catch`.

**Framework callbacks whose contract is fixed.** xUnit 2 calls `IAsyncLifetime.InitializeAsync` and `DisposeAsync` as `Task`, but a few attribute-style hooks in test runners still expect a `void` method, and some IoC container hooks (`Microsoft.Extensions.Hosting`'s `IHostedService` returns `Task`, but the older `IApplicationLifetime.ApplicationStarted` callback returns `void`). If the third-party signature says `void`, you have no choice. Document it in a comment so a future reader does not "fix" it.

Everything else is `async Task`.

## What you lose when you reach for `async void`

If a method needs to fail loudly when something goes wrong, returns nothing meaningful, and you reach for `async void` to skip the `await` ceremony, you have signed up for:

- **Lost stack traces.** The exception that surfaces on the synchronization context loses the original call-site stack. You see the rethrown frame, not "this was called from `OnSaveClicked`".
- **No cancellation.** You cannot pass cancellation through, because the caller has no `Task` to wait on. A `CancellationToken` argument still works inside the method, but the caller cannot react to a `OperationCanceledException` since it never propagates back.
- **No timeout via `Task.WhenAny`.** A common pattern is `await Task.WhenAny(work, Task.Delay(timeout, ct))`. You need a `Task` for that. `async void` has none.
- **No tests for completion.** xUnit, NUnit, and MSTest can `await` an `async Task` test method and observe its result. They cannot `await` an `async void` test. Some frameworks special-case `async void` test methods (older NUnit, MSTest v2 with adapter quirks); none recommend it. See the more detailed pattern in [how to unit-test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/), where every test is `async Task`.
- **Fire-and-forget that is also fire-and-crash.** Many "fire-and-forget" patterns silently become `async void` calls when developers forget the `await`. The fix is not `async void`; the fix is an explicit `_ = SomeAsync();` discard and accept that the resulting `Task` is unobserved, or better, hand the task to a known place that observes it (a logger, a background queue).

## The benchmark: does `async void` save anything?

Sometimes the argument for `async void` is "it's cheaper because there is no `Task` allocation". Let's measure.

```csharp
// .NET 10, C# 14, BenchmarkDotNet 0.14.0
// dotnet add package BenchmarkDotNet
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

BenchmarkRunner.Run<AsyncShapes>();

[MemoryDiagnoser]
public class AsyncShapes
{
    [Benchmark(Baseline = true)]
    public async Task ReturnsTask()
    {
        await Task.Yield();
    }

    [Benchmark]
    public void ReturnsVoid()
    {
        DoVoid();

        static async void DoVoid() => await Task.Yield();
    }
}
```

Methodology: BenchmarkDotNet 0.14.0, .NET 10.0.0 RTM, Windows 11 24H2, AMD Ryzen 9 7900X, single-threaded synchronous benchmark harness. Both methods perform one `Task.Yield`, which forces a continuation on the thread pool.

| Method      | Mean      | Allocated |
| ----------- | --------- | --------- |
| ReturnsTask | 1.34 us   | 152 B     |
| ReturnsVoid | 1.29 us   | 136 B     |

The `async void` version saves 16 bytes (one `Task` instance) and is about 4% faster, which is meaningless next to the thread-pool hop. Modern runtimes pool `AsyncTaskMethodBuilder.Task` for non-generic completed tasks, so the steady-state allocation difference is even smaller than the microbenchmark shows. The performance argument for `async void` is not real.

## The gotcha that picks for you

If you are tempted by `async void` for a non-event method, two things should change your mind on the spot.

The first is fire-and-forget tasks that span the lifetime of a request. ASP.NET Core does not give you a `SynchronizationContext` by default, so an exception in an `async void` lifts into `ThreadPool.UnobservedExceptionEvent` and, depending on your `<ServerGarbageCollection>` settings, can take the worker process down with it. The minute you decide to "kick off some background work from a controller", switch to `IHostedService` or, for a one-shot, return the `Task` to the framework via something that observes it (`BackgroundService`, `IHostApplicationLifetime`-aware queue, [Channels](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)).

The second is interfaces. If you ever want a method to be mockable or part of a contract, it has to return something. `Task` is the standard return type for an async operation that produces no value. `void` cannot be awaited by a mock or a fake, and you will not be able to coordinate test setup around it. The mocking pattern in [how to mock DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) leans on `Task`-returning members for the same reason.

## The opinionated recommendation, again

Default to `async Task`. Use `async void` for the exact three categories above: CLR event handlers, message-loop or command-style callbacks whose signature is fixed by the framework, and third-party hooks that demand `void`. Wrap every `async void` in `try/catch` and delegate to an `async Task` helper as soon as you have argument-shaped the call. If you see `async void` on a method you wrote yourself for any other reason, treat it as a latent process crash and change it.

Two corollaries worth committing to muscle memory:

- An `async void` that performs `I/O` and forgets `try/catch` is a crash waiting on `await`. The state machine has no place to put a thrown exception except the synchronization context, and most contexts in modern .NET treat that as fatal.
- An `async Task` that you never `await` is not the same as `async void`. The `Task` still captures the exception; it just sits there until observation or finalization. Use `_ = SomeAsync();` only when you are sure about the lifetime, and prefer handing the `Task` to a background-queue infrastructure that owns it.

## Related

- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [How to use Channels instead of BlockingCollection in C#](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)
- [How to unit-test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Fix: TaskCanceledException: A task was canceled in HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Fix: InvalidOperationException: Synchronous operations are disallowed in ASP.NET Core](/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/)

## Sources

- [Async return types -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/async-return-types)
- [Stephen Cleary, "Async/Await -- Best Practices in Asynchronous Programming"](https://learn.microsoft.com/en-us/archive/msdn-magazine/2013/march/async-await-best-practices-in-asynchronous-programming)
- [Stephen Cleary, "Async OOP 5: Events"](https://blog.stephencleary.com/2013/02/async-oop-5-events.html)
- [`AsyncVoidMethodBuilder` reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asyncvoidmethodbuilder)
- [`AsyncTaskMethodBuilder` reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asynctaskmethodbuilder)
- [`SynchronizationContext.OperationStarted` reference](https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext.operationstarted)
