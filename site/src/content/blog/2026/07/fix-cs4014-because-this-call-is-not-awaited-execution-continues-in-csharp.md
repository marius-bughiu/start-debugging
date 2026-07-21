---
title: "Fix: CS4014 \"Because this call is not awaited, execution of the current method continues\" in C#"
description: "CS4014 means you called a Task-returning method without awaiting it. Add await, or discard with _ = if fire-and-forget is truly intended, and handle exceptions."
pubDate: 2026-07-21
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "async"
---

`CS4014` fires when you call a method that returns a `Task` or `Task<T>` from inside an `async` method but do not `await` it. The compiler warns that the current method keeps running before the call finishes. Fix it by adding `await` to the call, which is what you want the vast majority of the time. If the fire-and-forget behavior is genuinely intended, make that explicit by assigning the result to a discard (`_ = SomeAsyncCall();`), and make sure something handles the exceptions the task might throw. This is verified against C# 14 on .NET 11; the diagnostic has behaved this way since `async`/`await` shipped in C# 5, so the guidance applies to every modern .NET version.

## The error in context

The compiler emits this as a warning, not an error:

```
warning CS4014: Because this call is not awaited, execution of the current method continues before the call is completed. Consider applying the 'await' operator to the result of the call.
```

Note the word *warning*. `CS4014` does not stop the build by default, which is exactly why it is dangerous: it is easy to ignore, and the bug it points at (a task running unobserved, its exceptions silently swallowed) does not show up until production. Many teams promote it to an error with `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` or the narrower `<WarningsAsErrors>CS4014</WarningsAsErrors>` in the `.csproj` precisely so that an accidentally-dropped `await` cannot slip through code review.

The warning only appears inside an `async` method. The compiler reasons that if you bothered to mark the enclosing method `async`, an unawaited task call is almost certainly a mistake. Call the same method from a non-`async` method and you get no `CS4014` at all, which is a related trap covered below.

## Why this happens

An `async` method that returns `Task` starts running synchronously and returns a task object the moment it hits its first incomplete `await`. The task represents the still-running operation. When you write `DoWorkAsync();` as a bare statement, you throw that task object away. Two things follow, and both are bad.

First, execution does not wait. The line after your call runs immediately, before `DoWorkAsync` has finished. Any code that depends on the operation completing, a database write, a file flush, a cache update, now races against it. This is the "execution of the current method continues" half of the message.

Second, and worse, exceptions vanish. When you `await` a task, any exception it captured is re-thrown into your method so your `try`/`catch` can see it. Drop the task and there is nothing to re-throw into. The exception sits on the discarded task object, unobserved, until the garbage collector eventually finalizes it. In .NET Framework 4.0 that would crash the process; since 4.5 and on all of modern .NET the default is to swallow it entirely. So an unawaited task that fails looks exactly like success from the caller's point of view. That silent failure is the real reason `CS4014` exists, and why "just suppress the warning" is almost never the right move.

The one case the compiler cannot help with: `async void`. If `DoWorkAsync` returns `void` instead of `Task`, there is no task to await and no `CS4014`, but all the same problems apply plus one more, an exception from an `async void` method is raised on the synchronization context and typically tears down the process. That is a separate diagnosis, covered in [async void vs async Task in C#](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Minimal repro

The smallest code that triggers `CS4014`:

```csharp
// .NET 11, C# 14
public class OrderService
{
    public async Task PlaceOrderAsync(Order order)
    {
        SaveAsync(order);          // CS4014: not awaited
        Console.WriteLine("Order placed");   // runs before SaveAsync finishes
    }

    private async Task SaveAsync(Order order)
    {
        await Task.Delay(100);     // stand-in for a real DB write
        throw new InvalidOperationException("DB down");
    }
}
```

Two bugs in four lines. `"Order placed"` prints before the save has run, and the `InvalidOperationException` is never seen by anyone: `PlaceOrderAsync` completes successfully as far as its caller can tell. The warning is the only signal you get at compile time that the order was never actually saved.

A common variant hides the call inside a `Task.Run` or an event handler, where it is easier to miss:

```csharp
// .NET 11, C# 14
button.Clicked += async (s, e) =>
{
    RefreshAsync();   // CS4014: fire-and-forget by accident
};
```

## Fix, in detail

Work through these in order. The first fix is correct for almost every real occurrence; the rest are for the genuine exceptions.

### 1. Add await (the fix you want 95% of the time)

If you are inside an `async` method, the intent is nearly always to wait for the call. Add `await`:

```csharp
// .NET 11, C# 14
public async Task PlaceOrderAsync(Order order)
{
    await SaveAsync(order);        // waits, and re-throws any exception
    Console.WriteLine("Order placed");
}
```

Now `"Order placed"` prints only after the save completes, and if `SaveAsync` throws, the exception propagates out of `PlaceOrderAsync` so a caller's `try`/`catch` (or the ASP.NET Core pipeline) can handle it. This single change fixes both the ordering bug and the swallowed-exception bug at once. Reach for the other options only when you can articulate why waiting is wrong.

### 2. Await multiple calls together with Task.WhenAll

If the reason you did not `await` was that you wanted several operations to run concurrently, do not drop the tasks, collect them and `await` them together:

```csharp
// .NET 11, C# 14
public async Task NotifyAllAsync(IEnumerable<User> users)
{
    var tasks = users.Select(u => SendEmailAsync(u));
    await Task.WhenAll(tasks);     // all run concurrently, all awaited
}
```

`Task.WhenAll` gives you the concurrency without giving up observation: it starts every task, then completes when the last one does, and re-throws if any of them failed. This is the correct pattern for fan-out work and it clears `CS4014` because the tasks are awaited. For the trade-offs between this and other parallel approaches, see [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/).

### 3. Return the task instead of awaiting it

If your method is a thin pass-through that does nothing after the call, you often do not need `async`/`await` at all. Drop both and return the task:

```csharp
// .NET 11, C# 14
public Task PlaceOrderAsync(Order order)
{
    return SaveAsync(order);       // caller awaits; no state machine here
}
```

This removes the `async` modifier, so `CS4014` no longer applies (the warning is only raised inside `async` methods), and it skips the overhead of generating a state machine for a method that does not need one. The caller still gets a task to `await`. The one caveat: without `await`, exceptions surface when the caller awaits the returned task rather than at the point of the call, and a `using` block would dispose its resource before the returned task completes. Use this only for genuine pass-throughs.

### 4. Explicitly discard, only when fire-and-forget is truly intended

Sometimes you really do want to start work and not wait, logging a metric, warming a cache, kicking off a best-effort notification. In that case make the intent unmistakable with a discard, and handle the exceptions yourself so they are not lost:

```csharp
// .NET 11, C# 14
public void OnUserLoggedIn(User user)
{
    _ = LogAnalyticsAsync(user);   // intentional fire-and-forget, warning cleared
}

private async Task LogAnalyticsAsync(User user)
{
    try
    {
        await _analytics.RecordAsync(user.Id);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Analytics failed for {UserId}", user.Id);
    }
}
```

The `_ =` discard tells both the compiler and the next reader "yes, I meant to not await this." Critically, the discard clears the warning but does *not* fix the swallowed-exception problem, so the `try`/`catch` inside `LogAnalyticsAsync` is doing the real work. A fire-and-forget task with no internal exception handling is a crash or a silent data-loss bug waiting to happen.

Even with a discard, raw fire-and-forget in a web app is fragile: the request can complete and the host can start shutting down while your task is mid-flight, cancelling or killing it. For anything that must actually finish, do not fire-and-forget from a request at all; hand the work to a background queue. That pattern is covered in [how to run fire-and-forget work safely in ASP.NET Core with BackgroundService](/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Gotchas and variants

A few situations produce `CS4014`, or hide it, for reasons the message does not spell out:

- **No warning outside an `async` method.** The exact same unawaited call in a plain (non-`async`) method produces no `CS4014`. The compiler assumes a non-async method might legitimately be starting background work. This is why bugs slip in when someone removes an `await` and the enclosing `async` modifier at the same time: the warning that would have caught it disappears with the modifier. If you rely on the warning as a safety net, keep `<WarningsAsErrors>CS4014</WarningsAsErrors>` on and be suspicious of any bare Task-returning call.

- **The discard silences the warning but not the bug.** `_ = DoAsync();` clears `CS4014`, but if `DoAsync` throws and nothing inside it catches, the exception is still lost. The discard is a statement of intent, not a fix for unobserved exceptions. Always pair fire-and-forget with internal `try`/`catch`.

- **Blocking with `.Result` or `.Wait()` is not the fix.** Replacing the missing `await` with `SaveAsync(order).Result` makes the warning go away and blocks until the task finishes, but on a UI or classic ASP.NET synchronization context it deadlocks, and everywhere else it wastes a thread. If you are tempted to block because you cannot make the caller `async`, read [the deadlock you get from calling .Result or .Wait() on an async method](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) first.

- **`Task.Run(() => FooAsync())` swallows the inner task.** Passing an `async` lambda to `Task.Run` where the delegate returns `void` (an `async void` lambda) gives you a `Task` that completes when the lambda *starts* its first await, not when the inner work finishes. Prefer `Task.Run(FooAsync)` or `Task.Run(async () => await FooAsync())` so the returned task tracks the real work, then `await` that.

- **A `CancellationToken` you never pass through.** A frequent cause of a lingering fire-and-forget task is that the method has no way to be cancelled, so it keeps running after the caller has moved on. If your unawaited call is background work, thread a token into it so it can be stopped cleanly; see [how to propagate a CancellationToken through async methods](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

- **Analyzer overlap with CA2012 and VSTHRD110.** Beyond the compiler's `CS4014`, the .NET analyzers (`CA2012` for `ValueTask`) and the Visual Studio threading analyzers (`VSTHRD110`, "observe the awaitable result") flag the same class of mistake in more places, including some non-`async` methods where `CS4014` stays silent. If you want the unawaited-task check everywhere, not just inside `async` methods, enabling those analyzers closes the gap the compiler warning leaves open.

The mental model to keep: `CS4014` is the compiler telling you a task is about to run unobserved. Decide which is actually true, then act on it. You meant to wait (add `await`), you meant to run several things concurrently (`Task.WhenAll`), the method is a pass-through (return the task), or you genuinely want fire-and-forget (discard with `_ =` and handle exceptions inside). Suppressing the warning with a discard while leaving the exceptions unhandled just converts a compile-time nudge into a silent runtime failure, which is the exact bug the warning exists to prevent.

## Related

- [async void vs async Task in C#: when each is correct](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) for why the `void`-returning version of this call is even more dangerous and produces no warning.
- [Fix: deadlock when calling .Result or .Wait() on an async method in C#](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) for why blocking is not a valid way to silence CS4014.
- [How to run fire-and-forget work safely in ASP.NET Core with BackgroundService](/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) for the right way to start work that must outlive a request.
- [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) for choosing how to run many async operations concurrently.
- [How to propagate a CancellationToken through async methods in .NET 11](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) for making background work cancellable instead of orphaned.

## Sources

- Microsoft Learn, [Resolve errors and warnings that involve async, await and the task-asynchronous protocol (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/cs4014) (exact `CS4014` text and the guidance to await or explicitly discard with `_ =`).
- Microsoft Learn, [Asynchronous programming with async and await](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/) (how a Task-returning async method runs and where exceptions are captured).
- Microsoft Learn, [Task.WhenAll method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.whenall) (completing when all awaited tasks finish and re-throwing aggregated failures).
- Microsoft Learn, [CA2012: Use ValueTasks correctly](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012) (the analyzer that catches unobserved awaitables the compiler warning misses).
