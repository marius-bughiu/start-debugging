---
title: "Fix: CS1998 \"This async method lacks 'await' operators and will run synchronously\" in C#"
description: "CS1998 means an async method has no await, so it runs synchronously. Drop the async modifier and return Task.FromResult, or add the await you forgot."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-10"
  - "async"
---

`CS1998` fires when a method carries the `async` modifier but its body contains no `await` expression, so the whole method runs synchronously and you pay for the async machinery without getting any asynchrony back. The fix is almost always to remove `async` and return an already-completed task: `Task.CompletedTask`, `Task.FromResult(value)`, or `ValueTask.FromResult(value)`. If the method was supposed to await something, add the missing `await` instead. Do not silence it with `await Task.CompletedTask`, which keeps every cost the warning is complaining about. One thing that has changed and that most search results have not caught up with: starting with the .NET 10 SDK the C# compiler no longer emits `CS1998` at all. Everything below is verified against SDK 10.0.201 (Roslyn 5.3.0) and .NET 10.0.5.

## The warning in context

```
warning CS1998: This async method lacks 'await' operators and will run synchronously. Consider using the 'await' operator to await non-blocking API calls, or 'await Task.Run(...)' to do CPU-bound work on a background thread.
```

It is a warning, not an error, so the build succeeds unless you have `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` in the `.csproj`. Microsoft documents it as `WRN_AsyncLacksAwaits` in the [async and await compiler messages reference](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors), with the official guidance being "add at least one `await` expression to the method body, or remove the `async` modifier and return the task directly".

## Why the compiler flags it

An `async` method without an `await` never suspends. The body runs start to finish on the calling thread, exactly like a synchronous method, and then the compiler-generated state machine hands the caller a task that is already in the `RanToCompletion` state. Nothing moved to a background thread, nothing overlapped with anything else. The `async` keyword did not make the method asynchronous; it only changed how the method's result and exceptions are packaged.

That packaging is not free. Here is what it costs, measured on .NET 10.0.5, x64, Release, with a plain `Stopwatch` loop over two million calls and `GC.GetAllocatedBytesForCurrentThread` for allocation. These are not BenchmarkDotNet numbers, so treat them as orders of magnitude rather than precise figures:

| Shape | Bytes/call | ns/call |
| --- | --- | --- |
| `async Task` with no `await` | 0 | 12.1 |
| `Task.CompletedTask` | 0 | 2.3 |
| `async Task<string>` with no `await` | 72 | 27.9 |
| `Task.FromResult("ok")` | 72 | 16.0 |
| `async ValueTask<int>` with no `await` | 0 | 15.6 |
| `ValueTask.FromResult(42)` | 0 | 3.0 |

Two things stand out. The allocation column is identical in every pair, because a synchronously-completing async method never boxes its state machine (the struct stays on the stack when there is no suspension) and the non-generic `AsyncTaskMethodBuilder` hands back a cached completed task. So the "async allocates" folklore does not apply here. What you actually pay is roughly 10 to 15 nanoseconds of builder plumbing per call. That is negligible in a method that touches a database and meaningful in a hot loop, which is exactly why this was a warning and not an error.

## Minimal repro

The smallest code that produces the warning on any SDK up to and including .NET 9:

```csharp
// C# 14, .NET SDK 9.0.x or earlier
public class UserService
{
    private readonly Dictionary<int, User> _cache = new();

    public async Task<User> GetUserAsync(int id)   // CS1998
    {
        return _cache[id];
    }
}
```

The most common real-world shape is the one that started out correct and rotted:

```csharp
// C# 14
public async Task<Report> BuildReportAsync(int id)
{
    // var rows = await _db.QueryAsync(id);   <- deleted during a refactor
    var rows = _cachedRows[id];
    return new Report(rows);                  // CS1998, and the method is now
}                                             // async for no reason at all
```

Nobody writes the first version on purpose. The second one appears constantly, which is the entire argument for the warning: it is a rot detector, not a style rule.

## Fix 1: drop async and return a completed task

This is the right fix in the overwhelming majority of cases. Remove the modifier, keep the `Task`-returning signature, and wrap the value:

```csharp
// C# 14, .NET 10
public Task<User> GetUserAsync(int id)
{
    return Task.FromResult(_cache[id]);
}

public Task SaveAsync(User user)
{
    _cache[user.Id] = user;
    return Task.CompletedTask;          // the Task equivalent of FromResult
}

public ValueTask<int> CountAsync()
{
    return ValueTask.FromResult(_cache.Count);   // no Task allocation at all
}
```

The signature is unchanged, so no caller has to be touched, and the state machine disappears. If the method is on a hot path and its result is usually available synchronously, `ValueTask<T>` removes the 72-byte `Task<T>` allocation as well; the trade-offs are covered in [what ValueTask is and when it is worth it](/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

There is one behavioral change you must account for, and it is the reason this fix is not purely mechanical. In an `async` method, an exception thrown by the body is captured and placed on the returned task. Drop `async` and the exception is thrown synchronously, at the call site, before the caller ever gets a task to await. That is easy to demonstrate:

```csharp
// C# 14, .NET 10.0.5
static async Task ThrowsFromTaskAsync() => throw new InvalidOperationException("boom");
static Task ThrowsAtCallSiteAsync() => throw new InvalidOperationException("boom");

var t1 = ThrowsFromTaskAsync();   // returns a faulted task, no exception here
await t1;                          // InvalidOperationException surfaces here

var t2 = ThrowsAtCallSiteAsync();  // throws right here, before any await
```

For most code that difference is invisible, because the caller immediately awaits. It becomes visible when the call is not immediately awaited: collecting tasks into a list and passing them to `Task.WhenAll`, storing a task in a field, or wrapping the call in a `try`/`catch` that only guards the `await`. If your method can throw before it produces a value, keep the exception inside the task:

```csharp
// C# 14, .NET 10
public Task<Stream> OpenAsync(string path)
{
    try
    {
        return Task.FromResult<Stream>(new FileStream(path, FileMode.Open));
    }
    catch (Exception ex)
    {
        return Task.FromException<Stream>(ex);   // same shape as async would produce
    }
}
```

This exact scenario is what Stephen Toub raised in [dotnet/roslyn#77001](https://github.com/dotnet/roslyn/issues/77001) when arguing that a naive `Task.FromResult` rewrite is often incorrect.

## Fix 2: add the await you meant to write

If the warning appeared after a refactor, the honest fix is usually restoring the call that was supposed to be awaited:

```csharp
// C# 14, .NET 10
public async Task<Report> BuildReportAsync(int id, CancellationToken ct)
{
    var rows = await _db.QueryAsync(id, ct);
    return new Report(rows);
}
```

Look for a sibling [CS4014 "because this call is not awaited"](/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/) in the same file. The two warnings together, one saying you have no awaits and one saying you dropped a task, are a near-certain sign that an `await` went missing rather than that the method was never asynchronous.

## Fix 3: Task.Run, and why the message's own suggestion is usually wrong

The warning text suggests `await Task.Run(...)` for CPU-bound work. That advice is correct for a desktop client, where the point is to get work off the UI thread:

```csharp
// C# 14, .NET 10, WPF or MAUI
private async void OnCalculateClicked(object sender, EventArgs e)
{
    var result = await Task.Run(() => CrunchNumbers(_input));   // UI stays responsive
    ResultLabel.Text = result.ToString();
}
```

It is the wrong advice inside ASP.NET Core. There is no UI thread to free, and the request is already running on a thread-pool thread; `Task.Run` just hands the work to a different thread-pool thread and adds a context switch plus a task allocation, while shrinking the pool available to serve other requests. In a server app, a synchronous method should stay synchronous, or become genuinely asynchronous by awaiting real I/O.

## Fix 4: interface implementations and overrides you cannot change

The case the warning handled worst is an interface member or virtual method that must return `Task` even though your particular implementation has nothing to await:

```csharp
// C# 14, .NET 10
public interface INotifier
{
    Task NotifyAsync(string message);
}

public sealed class NullNotifier : INotifier
{
    public Task NotifyAsync(string message) => Task.CompletedTask;   // no async, no warning
}
```

Dropping `async` is still the answer. Where that is genuinely impossible, suppress narrowly rather than globally:

```csharp
// C# 14, .NET SDK 9.0.x or earlier
#pragma warning disable CS1998 // required by INotifier, nothing to await here
public async Task NotifyAsync(string message) { _log.Info(message); }
#pragma warning restore CS1998
```

Prefer `#pragma` with a reason comment over `<NoWarn>$(NoWarn);CS1998</NoWarn>` in the project file. Project-wide suppression hides every future occurrence, including the refactor-rot case that the warning is genuinely good at catching.

## Where the warning went in .NET 10

If you are reading this because the warning stopped appearing rather than because it appeared, this is the answer: it was deleted from the compiler. [dotnet/roslyn#80144](https://github.com/dotnet/roslyn/pull/80144), merged on 19 September 2025 for the 18.0 P2 milestone, removed `WRN_AsyncLacksAwaits` entirely, along with the C# "Remove async modifier" and "Make method synchronous" code fix providers. The reasoning, from [dotnet/roslyn#77001](https://github.com/dotnet/roslyn/issues/77001), is that the warning pushed people toward worse code: forced to satisfy a `Task`-returning contract, developers would write `await Task.FromResult(result)` to silence it, which keeps the state machine, adds an await, and makes the method strictly more expensive without making it any safer. The closing decision in that thread was blunt: "After discussion, and especially with runtime async, we will be removing this warning entirely."

You can verify the removal in one build. This project compiles clean on SDK 10.0.201:

```csharp
// C# 14, .NET SDK 10.0.201 -> 0 warnings
public class C
{
    public async Task Empty() { }
    public async Task<int> Value() { return 42; }
    public async void VoidMethod() { }
    public async IAsyncEnumerable<int> Stream() { yield return 1; }
}
```

Not one of those produces a diagnostic, and neither `-warnaserror:CS1998` nor `dotnet_diagnostic.CS1998.severity = error` in `.editorconfig` brings it back, because there is no diagnostic left to elevate. `CS4014` still fires from the same compiler, so this is specific to `CS1998` and not a general loss of async warnings.

The capability came back as opt-in IDE analyzers in [dotnet/roslyn#81835](https://github.com/dotnet/roslyn/pull/81835), merged 7 January 2026 for the 18.4 milestone, deliberately split into two diagnostic IDs so the interface-implementation case can be tuned separately:

- `IDE0390` (`RemoveUnnecessaryAsyncModifier`): normal methods and lambdas.
- `IDE0391` (`RemoveUnnecessaryAsyncModifierInterfaceImplementationOrOverride`): methods that implement an interface member or override a base method.

Both surface as "Make method synchronous" with the message "Method can be made synchronous", and neither is enabled by default. To get the old behavior back where you want it:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.IDE0390.severity = warning
dotnet_diagnostic.IDE0391.severity = suggestion
```

```xml
<!-- .csproj: required to see IDE rules in dotnet build, not just in the IDE -->
<PropertyGroup>
  <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
</PropertyGroup>
```

One caveat from testing this: on SDK 10.0.201 the two analyzers are not present yet. The configuration above produces nothing, while a control rule such as `IDE0161` configured the same way reports normally, so the plumbing is fine and the rules simply have not shipped in that SDK band. They target the 18.4 milestone, so a newer SDK or Visual Studio 2026 update is required.

## Gotchas and variants

- **CI fails, local build passes.** A `global.json` pinning SDK 9 on the build agent still emits `CS1998`, and with `TreatWarningsAsErrors` that is a red build for code that compiles clean on a developer machine running SDK 10. Align the SDK band before you go hunting for anything more exotic.

- **ReSharper and Rider still report it.** JetBrains' analysis is independent of Roslyn's, so the inspection can persist in the editor after the compiler stopped emitting it. Turn it off in the ReSharper inspection settings rather than expecting a compiler switch to affect it.

- **`await Task.CompletedTask` is the worst possible silencer.** It clears the warning by adding a real `await`, which means you keep the state machine, keep the builder cost, and add an awaiter round trip on top. It is strictly more expensive than the code that triggered the warning. The same goes for `await Task.FromResult(value)`.

- **`async void` with no awaits.** Removing `async` from `async void SomeHandler()` is a pure win: nothing to await means nothing benefits from the state machine, and you lose the [async void exception behavior](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) where a failure is rethrown on the synchronization context and can tear down the process.

- **It never meant "this method is blocking".** `CS1998` says there is no `await`, not that the body blocks. A method that calls `.Result` or `.Wait()` inside an `async` body silences the warning only if some other `await` exists, and is a far worse problem: see [the deadlock you get from calling .Result or .Wait()](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

- **Async iterators.** An `async IAsyncEnumerable<T>` method with `yield return` and no `await` is still a legitimate async stream, and the compiler's removal of the warning is a relief there. If you are consuming one, note that `await foreach` over a stream that never actually awaits gives you no concurrency, just an interface.

The mental model that survives the warning's removal: `async` is a compilation strategy, not an API contract. The contract is the `Task`-returning signature. When there is nothing to await, keep the contract and drop the strategy, taking care that anything which can throw still faults the task instead of throwing at the call site. That was the right answer when `CS1998` shouted at you, and it is still the right answer now that it has gone quiet.

## Related

- [Fix: CS4014 "Because this call is not awaited, execution of the current method continues" in C#](/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/) for the warning that usually shows up alongside a missing `await`.
- [async void vs async Task in C#: when each is correct](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) for why an `async void` method with no awaits is worth fixing first.
- [What is ValueTask and when is it worth it?](/2026/06/what-is-valuetask-and-when-is-it-worth-it/) for the synchronous-completion case where `ValueTask.FromResult` beats `Task.FromResult`.
- [Fix: deadlock when calling .Result or .Wait() on an async method in C#](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) for the genuinely dangerous variant of "this async method is not really async".
- [.NET 11 runtime async drops the EnablePreviewFeatures flag](/2026/07/dotnet-11-runtime-async-no-longer-needs-enablepreviewfeatures/) for the runtime-level change that made the compiler team comfortable dropping this warning.

## Sources

- Microsoft Learn, [Resolve errors and warnings that involve async, await and the task-asynchronous protocol](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors) (exact `CS1998` text and the official add-await-or-remove-async guidance).
- dotnet/roslyn, [PR #80144: Remove CS1998 warning entirely and remove dependent C# code fix providers](https://github.com/dotnet/roslyn/pull/80144) (merged 19 September 2025, milestone 18.0 P2).
- dotnet/roslyn, [Issue #77001: Consider not emitting CS1998 for interface implementations / method overrides](https://github.com/dotnet/roslyn/issues/77001) (the `await Task.FromResult` anti-pattern and the decision to remove the warning).
- dotnet/roslyn, [PR #81835: Add back async fixers](https://github.com/dotnet/roslyn/pull/81835) (the opt-in `IDE0390` and `IDE0391` analyzers, merged 7 January 2026, milestone 18.4).
- dotnet/roslyn, [Issue #82692: Warnings (at least CS1998) are not showing with SDK 10 compared to SDK 9](https://github.com/dotnet/roslyn/issues/82692) (confirmation that the behavior change lands with the SDK, not the target framework).
- Microsoft Learn, [Task.FromException method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.fromexception) (producing a faulted task without an `async` method).
