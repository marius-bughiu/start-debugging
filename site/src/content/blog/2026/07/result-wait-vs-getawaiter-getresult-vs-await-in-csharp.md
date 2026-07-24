---
title: ".Result vs .Wait() vs GetAwaiter().GetResult() vs await in C#: which should you use?"
description: "await is the right answer almost every time. When you truly must block, GetAwaiter().GetResult() beats .Result and .Wait() because it throws the original exception. A decision matrix for .NET 11 and C# 14."
pubDate: 2026-07-24
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
---

If you have a `Task<T>` and you want the `T` out of it, you have four options: `task.Result`, `task.Wait()`, `task.GetAwaiter().GetResult()`, and `await task`. Use `await`. It is the only one that does not block a thread, and it throws the exact exception your code threw instead of a wrapper. The other three all block the calling thread and risk a deadlock; among them, `GetAwaiter().GetResult()` is the least bad because it unwraps exceptions the way `await` does. Reach for it only when you are stuck in a synchronous method you cannot make `async`. This holds on .NET 11 (`Microsoft.NET.Sdk` 11.0.0) with C# 14, and the semantics have been stable since .NET Framework 4.5.

## The four at a glance

| Behaviour                         | `await`            | `GetAwaiter().GetResult()` | `.Result`           | `.Wait()`           |
| --------------------------------- | ------------------ | -------------------------- | ------------------- | ------------------- |
| Blocks the calling thread         | no                 | yes                        | yes                 | yes                 |
| Returns a value                   | yes (`T`)          | yes (`T`)                  | yes (`T`)           | no (void)           |
| Works on non-generic `Task`       | yes                | yes                        | no (`Task<T>` only) | yes                 |
| Exception thrown                  | original           | original                   | `AggregateException`| `AggregateException`|
| Deadlock risk (captured context)  | no                 | yes                        | yes                 | yes                 |
| Thread-pool starvation under load | no                 | yes                        | yes                 | yes                 |
| Safe on `ValueTask<T>`            | yes (once)         | no                         | only if completed   | n/a                 |

Read that table top to bottom for `await` and you get a clean column: no block, real value, original exception, no deadlock. Every other column has at least one "yes" in a row you do not want. That is the whole argument. The rest of this post is why each row is true and when the trade actually forces your hand.

## Why await wins by default

`await` is not a fancier way to call `.Result`. It is a different operation. When you `await` a task that has not completed, the method suspends and returns control to its caller. No thread sits and waits. The runtime schedules the rest of your method as a continuation that runs when the task finishes. A blocking member does the opposite: it parks the current thread and holds it until the task is done.

That single difference is why `await` scales and blocking does not. On a server, a blocked thread is a thread pool thread doing nothing but waiting, and under load you run out of them. On a UI thread, a blocked thread is a frozen window. `await` frees the thread to do other work (serve another request, pump the message loop) and picks your method back up later.

```csharp
// .NET 11, C# 14 -- the default: no thread is blocked while the I/O runs
public async Task<string> GetGreetingAsync(HttpClient http)
{
    string body = await http.GetStringAsync("https://example.com/greeting");
    return body.Trim();
}
```

`await` also gives you the exception you actually threw. If `GetStringAsync` throws an `HttpRequestException`, the `await` re-throws that `HttpRequestException`, with its original stack trace, exactly where you awaited. No unwrapping, no `catch (AggregateException)` gymnastics. Unless you have a concrete reason to block, this is the end of the decision.

## When GetAwaiter().GetResult() is the right blocking call

Sometimes you cannot be async. A class constructor cannot be `async`. A `Main` before C# 7.1, a `Dispose` (not `DisposeAsync`), an interface method whose signature you do not control, a third-party plugin entry point that hands you a synchronous delegate: these are genuinely synchronous seams. If you must call async code from inside one and cannot restructure, you have to block on something. Block on `GetAwaiter().GetResult()`.

The reason it beats `.Result` and `.Wait()` is exception fidelity. `Task.Result` and `Task.Wait()` predate `async`/`await`; they come from the .NET 4.0 Task Parallel Library, where a single `Task` (think `Task.WhenAll`) could fail with several exceptions at once. To represent that, they wrap whatever went wrong in an `AggregateException`, even when there is exactly one inner exception. `GetAwaiter().GetResult()` was added with `async`/`await` in .NET 4.5 and follows the `await` convention: it throws the first exception directly, unwrapped.

```csharp
// .NET 11, C# 14 -- same failing task, three different exceptions surfaced
static async Task<int> FailAsync()
{
    await Task.Yield();
    throw new InvalidOperationException("boom");
}

// .Result -> throws AggregateException wrapping InvalidOperationException
try { _ = FailAsync().Result; }
catch (Exception ex) { Console.WriteLine(ex.GetType().Name); } // AggregateException

// GetAwaiter().GetResult() -> throws InvalidOperationException directly
try { _ = FailAsync().GetAwaiter().GetResult(); }
catch (Exception ex) { Console.WriteLine(ex.GetType().Name); } // InvalidOperationException
```

If your `catch` blocks are written for `InvalidOperationException` (as they should be), `.Result` silently routes around them because the exception arrives wrapped. You end up catching `AggregateException` and calling `.InnerException`, or worse, the exception goes unhandled because nobody expected the wrapper. `GetAwaiter().GetResult()` avoids all of that. This is why the standard guidance, going back to Stephen Cleary's "A Tour of Task" series, is: if you have no choice but to block, block with `GetAwaiter().GetResult()`.

It also works on a non-generic `Task`, so it is the one blocking call that covers both "run this and wait" and "run this and give me the value":

```csharp
// .NET 11, C# 14 -- blocks and unwraps, whether or not there is a return value
SaveAsync().GetAwaiter().GetResult();               // Task, no value
int count = CountAsync().GetAwaiter().GetResult();   // Task<int>, value
```

## Why .Result and .Wait() are strictly worse

`.Result` and `.Wait()` do everything `GetAwaiter().GetResult()` does (block the thread, same deadlock exposure) and add the `AggregateException` wrapper on top. There is no scenario where the wrapper helps you when the task is a single logical operation. The only place `.Result` reads acceptably is on a task you already know is completed, where it will not block:

```csharp
// .NET 11, C# 14 -- .Result on a known-completed task does not block
if (task.IsCompletedSuccessfully)
{
    var value = task.Result;   // safe: completed, so no wait, no deadlock
}
```

Even there, `GetAwaiter().GetResult()` is a fine substitute and keeps your exception handling uniform if the assumption about completion is ever wrong. `.Wait()` has the narrowest legitimate use: waiting on a fire-and-forget `Task` where you deliberately do not want a return value and are handling `AggregateException` explicitly. In practice that is rare, and it is usually a sign the work should have been structured as a proper background job. If you are running work off the request thread, do it with the patterns in [running fire-and-forget work safely with BackgroundService](/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) rather than blocking on a loose task.

There is a real trap with `.Wait(timeout)` and `.Wait(cancellationToken)`. They make the wait give up early, which looks like resilience but is not. A `Wait(5000)` that returns `false` did not cancel the underlying operation; the task is still running, its continuation is still queued, and you have simply stopped waiting for it. You have papered over a hang with a magic number. If you need to bound an operation, cancel it properly, as covered in [timing out an async operation with CancellationTokenSource.CancelAfter](/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/).

## The gotcha that decides it for you: deadlocks and ValueTask

Two things can remove the choice entirely.

**A captured `SynchronizationContext`.** If the thread you block on owns a single-threaded context (a WPF or WinForms UI thread, a classic ASP.NET request thread), every blocking option in this comparison can deadlock, and switching between them does not help. `GetAwaiter().GetResult()` deadlocks in exactly the same spot as `.Result`; the better exception behaviour is cold comfort when the app hangs. The mechanism, and every fix in order of preference, is in [why blocking on an async method deadlocks and how to fix it](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/). The short version: on a UI or classic-ASP.NET thread, do not block at all. On ASP.NET Core there is no `SynchronizationContext`, so you will not get this specific deadlock, but blocking still causes thread-pool starvation under load, which is harder to diagnose because it only shows up at concurrency.

**A `ValueTask<T>`.** If the method returns `ValueTask<T>` rather than `Task<T>`, none of the blocking members are safe to use directly. A `ValueTask` may be backed by an `IValueTaskSource` that can be reused after the value is consumed, and it may only be consumed once. Calling `.Result` or `.GetAwaiter().GetResult()` on a `ValueTask` that has not completed is undefined behaviour, and awaiting it twice is a bug. If you are handed a `ValueTask<T>` and truly cannot await it, convert it to a `Task<T>` first with `.AsTask()` and block on that:

```csharp
// .NET 11, C# 14 -- never block a ValueTask directly; materialize a Task first
ValueTask<int> vt = ReadValueAsync();
int value = vt.AsTask().GetAwaiter().GetResult();   // safe
// int bad = vt.Result;                              // undefined if not completed
```

The cleaner rule is: `await` a `ValueTask` exactly once and never store it. Blocking on one is a design smell on top of a design smell. For the full set of restrictions, see the note on [when ValueTask is worth it](/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

## Making the block impossible to need

Most of the time the honest fix is to delete the blocking call, not to pick the least-harmful one. Blocking almost always exists because someone stopped propagating `async` at a layer that could have kept going. A synchronous controller action calling an async repository, a `void` event handler that "just needs the value now": both can usually become `async Task` (or `async void` for the handler, the one place it is legitimate). The boundary between a correct `async void` and a bug is laid out in [when async void is correct and when it is a trap](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

When you make a chain async all the way up, the entire comparison in this post evaporates. You never touch `.Result`, `.Wait()`, or `GetAwaiter().GetResult()`, because you always have an `await` available. That is the actual recommendation hiding behind the decision matrix: the best blocking call is the one you refactored away.

## The recommendation, restated

- **Default to `await`.** It does not block, it scales, and it throws the original exception. If the enclosing method can be `async`, this is the answer, full stop.
- **If you truly cannot be async, block with `GetAwaiter().GetResult()`.** It blocks like the others but throws the real exception instead of an `AggregateException`, and it works on both `Task` and `Task<T>`.
- **Avoid `.Result` and `.Wait()`** except on a task you already know has completed. They add the `AggregateException` wrapper for no benefit on single operations.
- **Never block on a UI or classic-ASP.NET thread**, and never block a `ValueTask` directly. The first deadlocks; the second is undefined behaviour. Convert the `ValueTask` to a `Task` with `.AsTask()` if you have no alternative.

Treat every blocking call as a `TODO` to make the caller async. The version of your code that never blocks is faster, deadlock-proof, and has cleaner exceptions for free.

## Related

- [Fix: deadlock when calling .Result or .Wait() on an async method in C#](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [When async void is correct and when it is a trap in C#](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [ConfigureAwait(false) versus the default in .NET 11: does it still matter?](/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [What is ValueTask and when is it worth it?](/2026/06/what-is-valuetask-and-when-is-it-worth-it/)
- [How to time out an async operation with CancellationTokenSource.CancelAfter in C#](/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)

## Sources

- [A Tour of Task, Part 6: Results](https://blog.stephencleary.com/2014/12/a-tour-of-task-part-6-results.html) -- Stephen Cleary
- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
- [TaskAwaiter.GetResult Method](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.taskawaiter.getresult) -- Microsoft Learn
- [Task exception handling in .NET](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/task-exception-handling) -- Microsoft Learn
- [ValueTask Restrictions](https://blog.stephencleary.com/2020/03/valuetask.html) -- Stephen Cleary
