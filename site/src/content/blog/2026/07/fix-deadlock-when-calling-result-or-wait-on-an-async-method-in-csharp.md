---
title: "Fix: deadlock when calling .Result or .Wait() on an async method in C#"
description: "Blocking on an async Task with .Result or .Wait() deadlocks when a SynchronizationContext is present. Here is why it hangs and how to fix it in .NET 11 and C# 14."
pubDate: 2026-07-20
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "deadlock"
---

If a call to `task.Result`, `task.Wait()`, or `task.GetAwaiter().GetResult()` hangs forever and never throws, you have a sync-over-async deadlock. It happens when you block a thread that owns a single-threaded `SynchronizationContext` (a WPF or WinForms UI thread, a classic ASP.NET request thread) while the async method you are blocking on is trying to resume its continuation back on that same thread. The thread is stuck waiting for the task; the task is stuck waiting for the thread. The fix is to stop blocking: make the call chain async all the way up so you `await` instead of `.Result`. This post explains the mechanism on .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14) and walks through every fix in order of preference, including the ones that look right but do not work.

## Why the thread waits on itself

An `await` does two things people forget about. Before it suspends, it captures the current `SynchronizationContext` (via `SynchronizationContext.Current`). When the awaited task completes, it does not just resume on any thread: by default it posts the continuation, the code after the `await`, back to that captured context. On a general thread pool worker there is no context, so the continuation runs on any free pool thread and nothing special happens. But on a UI thread or a classic ASP.NET request, the context is single-threaded. It has exactly one thread that is allowed to run its queued work.

Now put those two facts next to a blocking call:

1. Your UI thread calls `GetDataAsync().Result`. That blocks the UI thread and holds it.
2. Inside `GetDataAsync`, an `await SomeIoAsync()` captured the UI `SynchronizationContext` before it suspended.
3. `SomeIoAsync` finishes. The runtime tries to post `GetDataAsync`'s continuation back to the UI context so it can run the rest of the method and complete the task.
4. The UI context has one thread. That thread is blocked at step 1, waiting for the task to complete. It will never pick up the continuation.
5. The task cannot complete until the continuation runs. The continuation cannot run until the thread frees up. The thread will not free up until the task completes. Deadlock.

Stephen Cleary named this pattern years ago in [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html), and the mechanism has not changed. The runtime is not buggy. Blocking on a task whose continuation needs the thread you are blocking is a genuine circular wait.

## The smallest repro that hangs

You need two things: a single-threaded `SynchronizationContext`, and a blocking call over an `await` that captures it. A WinForms button handler is the classic reproduction, but you do not need a UI project. You can install a single-threaded context by hand and watch it hang.

```csharp
// .NET 11, C# 14 -- this deadlocks
using System.Threading;

var context = new SingleThreadedSyncContext();
SynchronizationContext.SetSynchronizationContext(context);

// Block on an async method from the context-owning thread:
string result = GetGreetingAsync().Result;   // hangs forever
Console.WriteLine(result);

static async Task<string> GetGreetingAsync()
{
    // Captures the current (single-threaded) context here:
    await Task.Delay(100);
    // The runtime tries to post THIS line back to the captured context,
    // but that thread is blocked on .Result above.
    return "hello";
}
```

In a real WPF or WinForms app you do not write `SetSynchronizationContext` yourself. The framework installs a `DispatcherSynchronizationContext` (WPF) or `WindowsFormsSynchronizationContext` (WinForms) on the UI thread before your event handlers run, so any handler that does `SomethingAsync().Result` reproduces this instantly. Classic ASP.NET (System.Web, not ASP.NET Core) installs `AspNetSynchronizationContext` on the request thread with the same single-threaded behaviour.

## The one real fix: async all the way

The deadlock exists because you blocked. Remove the block and it is gone. Propagate `async`/`await` up the call chain until the outermost caller can `await` instead of reading `.Result`.

```csharp
// .NET 11, C# 14 -- no block, no deadlock
private async void OnLoadClick(object sender, EventArgs e)
{
    string greeting = await GetGreetingAsync();   // await, not .Result
    label.Text = greeting;
}
```

Here `await` still captures the UI context, but nothing is blocking the UI thread. The handler suspends, the UI thread returns to the message loop and stays free, and when `GetGreetingAsync` completes its continuation is posted back and runs cleanly on the now-idle UI thread. That is exactly what a UI `SynchronizationContext` is for. The continuation lands back on the UI thread, so you can touch `label.Text` without marshalling.

Event handlers are the one sanctioned place for `async void` precisely because they are the top of the call stack and have no caller to await them. Everything below them should be `async Task`. If you are unsure where `async void` is legitimate and where it is a bug, the split is covered in [when async void is correct and when it is a trap](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

The same rule applies on the server. A classic ASP.NET MVC action, a Razor page handler, a SignalR hub method: make them `async Task` and `await` the work rather than blocking. There is no partial credit here. One `.Result` anywhere in the synchronous path can reintroduce the deadlock even if every other layer is async.

## The library fix: ConfigureAwait(false)

Sometimes you cannot make the whole chain async, because the blocking call lives in code you do not own. If you are the author of the async library being blocked on, you can defuse the deadlock from your side by telling every `await` not to capture the context:

```csharp
// .NET 11, C# 14 -- library code that stays deadlock-safe under a blocking caller
public async Task<string> GetGreetingAsync()
{
    await Task.Delay(100).ConfigureAwait(false);
    // No captured context, so this continuation runs on a thread pool
    // thread, not the caller's blocked UI/request thread.
    return "hello";
}
```

`ConfigureAwait(false)` says "I do not need to resume on the captured context." The continuation runs on a thread pool thread instead, which is not the blocked one, so the circular wait never forms and the task can complete. This is why the guidance for shared libraries is to put `.ConfigureAwait(false)` on every await, as Microsoft spells out in the [ConfigureAwait FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/).

Two caveats keep this from being a blanket cure. First, it only helps if it is applied on every `await` in the entire transitive closure of the blocked call. Miss one await deep in a dependency and the deadlock returns, which is exactly why it is a library discipline and not a fix you sprinkle at the call site. Second, in your own application code you should not be blocking in the first place, so `ConfigureAwait(false)` in app code is treating a symptom. The nuance of when it still matters, and when the compiler analyzers nudge you toward it, is in [ConfigureAwait(false) versus the default in .NET 11](/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## Fixes that look right but do not work

**Switching `.Result` for `.GetAwaiter().GetResult()`.** People reach for this because it unwraps the exception instead of wrapping it in `AggregateException`. It changes nothing about the deadlock. `GetAwaiter().GetResult()` still blocks the calling thread until the task completes, and the task still cannot complete because its continuation is queued behind the block. Better exceptions, identical hang.

**Adding a timeout with `Wait(TimeSpan)`.** `task.Wait(5000)` will return `false` after five seconds instead of hanging forever, but that is not a fix, it is a slower failure. The operation still did not complete, and you have now papered over a design problem with a magic number. The underlying continuation is still stuck.

**Wrapping the async method in `Task.Run` and blocking on that.** This one actually breaks the deadlock, and that is why it is dangerous. `Task.Run(() => GetGreetingAsync()).GetAwaiter().GetResult()` starts the async method on a thread pool thread, which has no single-threaded context, so its continuations no longer target your blocked UI thread. The hang disappears.

```csharp
// .NET 11, C# 14 -- avoids the deadlock, but it is a smell, not a solution
string greeting = Task.Run(() => GetGreetingAsync()).GetAwaiter().GetResult();
```

It works, but you are now burning a thread pool thread to block another thread, you have lost the UI context for any continuation that legitimately needed it, and you have hidden the fact that the call should have been async. Microsoft documents this offload pattern under [synchronous wrappers for asynchronous methods](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/synchronous-wrappers-for-asynchronous-methods) with the same warning: treat it as a last resort for a genuinely sync-only entry point, not as a way to keep writing blocking code.

## Why ASP.NET Core does not deadlock here (and how it bites differently)

If you moved from classic ASP.NET to ASP.NET Core and your old deadlocks vanished, this is why: ASP.NET Core has no `SynchronizationContext`. `SynchronizationContext.Current` is `null` inside a request, so `await` never captures a single-threaded context, continuations always run on thread pool threads, and the specific circular wait described above cannot form. That is also why `ConfigureAwait(false)` has no effect in an ASP.NET Core request handler: there is no context to opt out of.

This does not make blocking safe on ASP.NET Core. It trades a deterministic deadlock for a probabilistic one called thread pool starvation. Every request that blocks on `.Result` parks a thread pool thread doing nothing but waiting. Under load, the pool hands out threads faster than the (default, gradual) injection rate can replace the parked ones, so new requests queue with no thread to run on. The app does not hang on request one; it falls over at concurrency you cannot reproduce on your laptop. The cure is identical: do not block, go async all the way. If your blocking was there to bound a long operation, do it with cancellation instead, as in [cancelling a long-running Task without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), and make sure the token actually reaches the leaf call by [propagating the CancellationToken through the chain](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

## A checklist for hunting the block that hangs

When something hangs and you suspect this, look for the block, not the async method:

1. **Search the synchronous path for `.Result`, `.Wait(`, and `.GetAwaiter().GetResult()`.** One of them is on a thread that owns a context. That is your culprit, not the innocent `await` it is blocking on.
2. **Confirm a single-threaded context is in play.** UI thread, classic ASP.NET request, or a custom context. If you are on ASP.NET Core or a plain console app with no installed context, the symptom is starvation or a slow response, not a hard hang.
3. **Replace the block with `await` and make the enclosing method `async Task`.** Repeat up the stack until you reach an entry point that can be async (an event handler, a `Main`, a controller action).
4. **If a layer genuinely cannot be async**, and you own the async library, add `ConfigureAwait(false)` throughout that library. If you do not own it, the `Task.Run` offload is the last resort, with the costs above.
5. **Never "fix" it with a timeout.** A `Wait(timeout)` that returns false is a deadlock that gives up, not a design that works.

The through-line is simple: async code wants to stay async. The moment you block on it from a thread that its continuation needs, you have built a circular wait by hand. Stop blocking and the deadlock cannot exist. Everything else on this page is damage control for the cases where you cannot stop blocking yet.

## Related

- [When async void is correct and when it is a trap in C#](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [ConfigureAwait(false) versus the default in .NET 11: does it still matter?](/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [How to propagate a CancellationToken through async methods in .NET 11](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)

## Sources

- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
- [ConfigureAwait FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/) -- .NET Blog
- [ASP.NET Core SynchronizationContext](https://blog.stephencleary.com/2017/03/aspnetcore-synchronization-context.html) -- Stephen Cleary
- [Synchronous wrappers for asynchronous methods](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/synchronous-wrappers-for-asynchronous-methods) -- Microsoft Learn
- [CA2007: Do not directly await a Task](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007) -- Microsoft Learn
