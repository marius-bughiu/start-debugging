---
title: "Fix: AggregateException \"One or more errors occurred\" when awaiting Task.WhenAll in C#"
description: "await Task.WhenAll rethrows only one of the failures. Keep the WhenAll task in a variable and read its Exception.InnerExceptions to see every error instead of one."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
---

If several tasks in a `Task.WhenAll` fail, the returned task faults with an `AggregateException` whose message is "One or more errors occurred", but `await` unwraps it and rethrows exactly one of the inner exceptions. Every other failure is silently discarded from your `catch` block. The fix is to keep the task `Task.WhenAll` returns in a local, `await` it inside a `try`, and read `whenAll.Exception.InnerExceptions` in the `catch` to get all of them. If you are seeing the literal `AggregateException` type in a `catch`, you are blocking with `.Wait()` or `.Result` instead of awaiting, which is a separate and worse problem. Verified on .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14), with the runtime behaviour measured on .NET 10.0.5; the relevant runtime code is byte-identical on the `release/10.0` and `main` branches.

## The error in context

Blocking on the `WhenAll` task gives you the wrapper directly:

```
Unhandled exception. System.AggregateException: One or more errors occurred. (Connection refused) (The operation has timed out.)
 ---> System.Net.Http.HttpRequestException: Connection refused
   at OrderSync.FetchAsync(String url)
   --- End of inner exception stack trace ---
   at System.Threading.Tasks.Task.ThrowIfExceptional(Boolean includeTaskCanceledExceptions)
   at System.Threading.Tasks.Task.Wait(Int32 millisecondsTimeout, CancellationToken cancellationToken)
```

Awaiting it gives you no `AggregateException` at all, just one of the inner exceptions:

```
Unhandled exception. System.Net.Http.HttpRequestException: Connection refused
   at OrderSync.FetchAsync(String url)
   at OrderSync.SyncAllAsync()
```

Both are the same underlying situation. The two shapes are why searches for this error land on contradictory advice.

## Why await hides all but one failure

`Task.WhenAll` is documented to complete in the `Faulted` state "where its exceptions will contain the aggregation of the set of unwrapped exceptions from each of the supplied tasks". That aggregation lives on the returned task's `Exception` property, and it really does contain every failure.

The loss happens one layer up. `await` is specified to rethrow a task's exception unwrapped, so you catch `HttpRequestException` rather than `AggregateException` on a single failing task. That unwrapping is the right default: almost every async API produces at most one error, and `catch (AggregateException ae) { ae.InnerException ... }` around every await would be miserable. `Task.WhenAll` is the main API where the assumption breaks, and the awaiter has no way to signal "there were four". It takes one exception dispatch info off the list and rethrows it. This was raised as [dotnet/runtime#31494](https://github.com/dotnet/runtime/issues/31494) and again as [dotnet/runtime#47605](https://github.com/dotnet/runtime/issues/47605), asking for an opt-in await that propagates the whole aggregate. Neither shipped, so the workaround below is still the answer.

The corollary matters for your `catch` clauses: after `await Task.WhenAll(...)`, a `catch (AggregateException)` never fires. If you wrote one, it is dead code, and the real exception escapes past it.

## Minimal repro

```csharp
// .NET 11, C# 14
static async Task FailAsync(string message)
{
    await Task.Delay(10);
    throw new InvalidOperationException(message);
}

try
{
    await Task.WhenAll(FailAsync("first"), FailAsync("second"), FailAsync("third"));
}
catch (Exception ex)
{
    Console.WriteLine(ex.Message);   // prints one message, not three
}
```

Three failures go in, one comes out. Nothing in the `catch` block can recover the other two, because the only reference to the aggregate was the temporary that `Task.WhenAll` returned and `await` consumed.

## Fix 1: keep the WhenAll task and read InnerExceptions

This is the fix for the overwhelming majority of cases, and the only change is a local variable:

```csharp
// .NET 11, C# 14
Task whenAll = Task.WhenAll(FailAsync("first"), FailAsync("second"), FailAsync("third"));

try
{
    await whenAll;
}
catch
{
    // whenAll.Exception is the AggregateException the await threw away
    foreach (Exception inner in whenAll.Exception!.InnerExceptions)
    {
        _logger.LogError(inner, "Sync step failed");
    }
    throw;
}
```

`whenAll.Exception` is non-null exactly when `whenAll.Status == TaskStatus.Faulted`, and its `InnerExceptions` collection holds one entry per failed task, each with its original stack trace intact. The bare `catch` with a `throw` preserves the existing behaviour for callers (they still see a single unwrapped exception) while giving you full fidelity in the log.

Two details make this safe to apply mechanically. First, do not put the `Task.WhenAll(...)` call itself inside the `try`: it is the `await` that throws, not the call, but keeping the assignment outside makes the variable visible in the `catch`. Second, use `catch` or `catch (Exception)`, not `catch (AggregateException)`, for the reason in the previous section.

## Fix 2: never let the WhenAll task fault at all

If your fan-out is a batch where partial failure is normal, the cleaner design is to stop exceptions from escaping the individual tasks. Wrap each unit of work so it returns its outcome instead of throwing:

```csharp
// .NET 11, C# 14
static async Task<(int Id, Exception? Error)> RunSafeAsync(int id, Func<Task> work)
{
    try
    {
        await work();
        return (id, null);
    }
    catch (Exception ex)
    {
        return (id, ex);
    }
}

var results = await Task.WhenAll(orders.Select(o => RunSafeAsync(o.Id, () => SyncAsync(o))));

foreach (var (id, error) in results.Where(r => r.Error is not null))
{
    _logger.LogError(error, "Order {OrderId} failed", id);
}
```

`Task.WhenAll` now always runs to completion, so there is no aggregate to unpack, no exception filter to get right, and the association between each failure and the item that caused it survives. That association is the part Fix 1 cannot give you: `InnerExceptions` is a flat list of exceptions with no back-pointer to the task that produced them. When you need to retry the failures or report which records were rejected, use this shape.

The cost is that a genuinely fatal error no longer propagates by itself. Decide explicitly what to do when `results` contains errors, or you have built a silent failure.

## Fix 3: rethrow the whole aggregate on purpose

When the caller genuinely should see every failure, rethrow the aggregate rather than letting `await` pick one. `ExceptionDispatchInfo` keeps the original stack traces:

```csharp
// .NET 11, C# 14
using System.Runtime.ExceptionServices;

public static async Task WhenAllWithAggregateAsync(IEnumerable<Task> tasks)
{
    Task whenAll = Task.WhenAll(tasks);
    try
    {
        await whenAll;
    }
    catch
    {
        ExceptionDispatchInfo.Capture(whenAll.Exception!).Throw();
    }
}
```

Callers of that helper get an `AggregateException` with every inner exception, which is what people are usually reaching for when they write `catch (AggregateException)` after an `await`. Use it at a boundary where a single logical operation really did fail in several ways at once, such as a batch import that must report all validation errors. Do not make it your default: it pushes `AggregateException` handling into every caller, which is exactly the ergonomic problem `await` unwrapping was designed to remove.

## Which exception does await actually throw?

Here is where most existing answers are wrong, including the ones that say "the first exception". It depends on which overload you called, and the difference is deterministic.

```csharp
// .NET 10.0.5, C# 14 -- three tasks that fail at staggered times,
// slowest one first in argument order
static async Task FailAfterAsync(int ms, string message)
{
    await Task.Delay(ms);
    throw new InvalidOperationException(message);
}

static async Task<int> FailAfterIntAsync(int ms, string message)
{
    await Task.Delay(ms);
    throw new InvalidOperationException(message);
}

// non-generic overload -> Task
var nonGeneric = Task.WhenAll(
    FailAfterAsync(150, "index0-slow"),
    FailAfterAsync(80,  "index1-medium"),
    FailAfterAsync(10,  "index2-fast"));
// await throws:    index2-fast
// InnerExceptions: index2-fast, index1-medium, index0-slow

// generic overload -> Task<int[]>
var generic = Task.WhenAll(
    FailAfterIntAsync(150, "index0-slow"),
    FailAfterIntAsync(80,  "index1-medium"),
    FailAfterIntAsync(10,  "index2-fast"));
// await throws:    index0-slow
// InnerExceptions: index0-slow, index1-medium, index2-fast
```

Non-generic `Task.WhenAll` orders `InnerExceptions` by **completion time**. Generic `Task.WhenAll<TResult>` orders them by **argument position**. Both throw `InnerExceptions[0]`. That result was stable across repeated runs on .NET 10.0.5.

The cause is visible in the runtime source. Both promises are in [`Task.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/Task.cs). The non-generic `WhenAllPromise` deliberately does not retain the input array; its `Invoke` completion callback appends each failed task to a list as it completes, then walks that list:

```csharp
// dotnet/runtime, Task.WhenAllPromise.Invoke
if (failedOrCanceled is List<Task> list)
{
    foreach (Task task in list) { HandleTask(task); }
}
```

The generic `WhenAllPromise<T>` keeps the array because it has to produce `T[]` results in order, and iterates it by index:

```csharp
// dotnet/runtime, Task.WhenAllPromise<T>.Invoke
for (int i = 0; i < m_tasks.Length; i++)
{
    Task<T>? task = m_tasks[i];
    if (task.IsFaulted) { observedExceptions ??= new(); observedExceptions.AddRange(task.GetExceptionDispatchInfos()); }
    ...
}
```

This divergence appeared in .NET 8 and was reported as [dotnet/runtime#93504](https://github.com/dotnet/runtime/issues/93504) after the non-generic path was rewritten for allocation reasons. It was closed as not planned and is not in the breaking-change docs. Practically: never write code that depends on which failure surfaces from an `await Task.WhenAll`. Read the whole list, per Fix 1.

## Cancellation disappears when anything faults

The other silent loss is cancellation. If one task is canceled and another faults, the canceled task contributes nothing:

```csharp
// .NET 10.0.5
var mixed = Task.WhenAll(canceledTask, faultingTask);
try { await mixed; } catch (Exception ex) { /* InvalidOperationException */ }

// mixed.Status                          -> Faulted
// mixed.Exception.InnerExceptions.Count -> 1   (the cancellation is gone)
```

Both promise implementations track `canceledTask` in a separate local and only call `TrySetCanceled` when the exception list is empty, which matches the documented rule: faulted wins over canceled, and canceled wins over success. If nothing faults and at least one task is canceled, the `WhenAll` task ends `Canceled`, its `Exception` property is `null`, and `await` throws a `TaskCanceledException`. Code that does `whenAll.Exception!.InnerExceptions` without checking `Status` will hit a `NullReferenceException` in exactly that case, so guard it:

```csharp
// .NET 11, C# 14
catch (Exception ex)
{
    if (whenAll.Exception is { } aggregate)
    {
        foreach (var inner in aggregate.InnerExceptions) _logger.LogError(inner, "Step failed");
    }
    else
    {
        _logger.LogWarning(ex, "Batch was canceled");
    }
    throw;
}
```

Telling a genuine cancellation apart from a timeout dressed up as one is its own trap, covered in [why HttpClient throws TaskCanceledException](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

## Gotchas and variants

- **You are catching `AggregateException` and it works.** Then you are not awaiting. `.Wait()`, `.Result`, and `Task.WaitAll` all throw the wrapper as-is, which is the only reason the type name appears in a `catch`. That also means you are blocking a thread, with everything that implies: see [.Result vs .Wait() vs GetAwaiter().GetResult() vs await](/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/).

- **`Flatten()` is a no-op here.** `AggregateException.Flatten` exists for nested aggregates, but `Task.WhenAll` already unwraps its constituents, so even a `WhenAll` over a `WhenAll` produces a flat list. Verified: three failures nested two levels deep gave three inner exceptions before and after `Flatten()`. Keep `Flatten()` for `Parallel.ForEach` and PLINQ, where nesting is real.

- **A lazy LINQ query enumerated twice starts the work twice.** `Enumerable.Range(0, 3).Select(_ => DoAsync())` is a query, not a list. `Task.WhenAll` enumerates it once, but passing the same query to a second `WhenAll` (or to `.Count()` for a log line) runs everything again. Measured: three tasks started after the first `WhenAll`, six after the second. Call `.ToArray()` before you pass a projection to `WhenAll`.

- **`Task.WhenAll` does not stop on first failure.** Every task runs to completion even after one throws, which is why you get several exceptions in the first place. If you want the fan-out to abandon the rest, you need a `CancellationTokenSource` that the tasks honour, wired up as in [propagating a CancellationToken through async methods](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

- **`Task.WhenAll` has no concurrency limit.** If the aggregate is full of socket exceptions and timeouts, the real bug may be that you started 5,000 requests at once. The concurrency-capped alternatives are compared in [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/).

- **Failures arrive late.** `WhenAll` tells you nothing until the slowest task finishes, so a fast failure sits invisible behind a slow success. If you want to react to each result as it lands, [Task.WhenEach](/2026/01/streaming-tasks-with-net-9-task-wheneach/) gives you an `IAsyncEnumerable<Task>` in completion order.

- **An empty collection succeeds.** `Task.WhenAll(Array.Empty<Task>())` transitions straight to `RanToCompletion`. A batch job that reports success on an empty input is usually a filtering bug upstream, not a `WhenAll` bug.

- **Awaiting the `WhenAll` task observes every inner exception.** You will not get a `TaskScheduler.UnobservedTaskException` for the failures you did not see, because `WhenAll` already observed them on your behalf. Convenient, and also why the losses are so quiet.

The one-line mental model: `Task.WhenAll` collects every failure faithfully, and `await` is the lossy step. Give the returned task a name, and nothing is lost.

## Related

- [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll in C#](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) for choosing the right fan-out primitive and capping concurrency.
- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await in C#](/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) for why blocking is what surfaces the raw `AggregateException`.
- [Fix: TaskCanceledException: A task was canceled in HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) for the cancellation case that a faulted `WhenAll` swallows.
- [Streaming Tasks with .NET 9 Task.WhenEach](/2026/01/streaming-tasks-with-net-9-task-wheneach/) for handling each result as it completes instead of waiting for the slowest.
- [How to propagate a CancellationToken through async methods in .NET 11](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) for making a fan-out abandon its remaining work.

## Sources

- Microsoft Learn, [Task.WhenAll method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.whenall) (the faulted, canceled, and `RanToCompletion` rules quoted above).
- Microsoft Learn, [AggregateException class](https://learn.microsoft.com/en-us/dotnet/api/system.aggregateexception) (`InnerExceptions`, `Flatten`, `Handle`, and the "One or more errors occurred" message).
- Microsoft Learn, [Task exception handling](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/task-exception-handling) and [Exception handling in the TPL](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/exception-handling-task-parallel-library).
- dotnet/runtime, [`Task.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/Task.cs) (`WhenAllPromise` and `WhenAllPromise<T>`, the completion-order versus argument-order difference).
- dotnet/runtime, [Issue #93504: Awaiting nongeneric Task.WhenAll changes behavior in .NET 8](https://github.com/dotnet/runtime/issues/93504) (closed as not planned, undocumented).
- dotnet/runtime, [Issue #31494: Task.WhenAll inner exceptions are lost](https://github.com/dotnet/runtime/issues/31494) and [Issue #47605: Configure an await to propagate all errors](https://github.com/dotnet/runtime/issues/47605).
