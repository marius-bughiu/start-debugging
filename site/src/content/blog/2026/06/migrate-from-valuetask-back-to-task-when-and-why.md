---
title: "Migrate from ValueTask<T> back to Task<T>: when and why (.NET 11, C# 14)"
description: "A practical checklist for reverting ValueTask and ValueTask<T> return types to Task and Task<T>, what breaks at the call sites, how to verify each change, and how to know whether the swap was ever worth it."
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
---

Reverting a `ValueTask<T>` API back to `Task<T>` is usually a half-day job and almost always safe, because `Task<T>` is the more forgiving type: anything that compiled against `ValueTask<T>` will keep compiling, and several latent bugs in your callers disappear the moment you make the swap. The work that takes time is not the return-type change itself but auditing the call sites that relied on `ValueTask` semantics: a method awaited twice, a result cached in a field, a `.GetAwaiter().GetResult()` on a hot path. This guide covers when the revert is the right call, the exact edits at the declaration and at every caller, how to verify each step, and how to confirm afterward that you did not regress the allocation profile you originally adopted `ValueTask` to fix.

This targets .NET 11 and C# 14, current as of June 2026, but nothing here is version-specific: the `ValueTask` contract has been stable since it shipped in .NET Core 2.1. The advice tracks Stephen Toub's canonical guidance in [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/), whose bottom line is blunt: "the default choice is still `Task` / `Task<TResult>`." If you adopted `ValueTask` without a profiler telling you to, this is the post that walks you back.

## Why revert at all

`ValueTask<T>` exists to avoid one specific allocation: the `Task<T>` object that an async method heap-allocates even when it completes synchronously. That is a real cost on hot paths that almost always finish without awaiting (a cache hit, a buffered read, a memoized computation). But the type pays for that win with a contract that is easy to violate, and most codebases that reach for it never had the allocation problem in the first place. Concrete reasons to go back:

- **The call sites keep tripping CA2012.** If your team repeatedly awaits the same `ValueTask` twice, stores it in a field, or blocks on it, the type is actively costing you correctness. `Task<T>` makes all of those operations legal.
- **You never measured a win.** `ValueTask` is a profiler-driven optimization. If you adopted it by reflex and a benchmark shows no allocation difference, the added caution is pure overhead.
- **The method now usually completes asynchronously.** `ValueTask` only pays off when synchronous completion is the common case. If the method started awaiting real I/O on most calls, you are allocating a backing object anyway plus carrying the struct's restrictions for nothing.
- **You want `WhenAll` / `WhenAny` ergonomics.** Combinators take `Task`, so a `ValueTask`-returning API forces every caller to write `.AsTask()` before fanning out. Reverting removes that friction.

If you are weighing the reverse direction, or still deciding whether `ValueTask` belongs in your code at all, the rules below double as a decision aid.

## What breaks (spoiler: very little)

| Area | Change | Severity |
| --- | --- | --- |
| Method declaration | `ValueTask<T>` becomes `Task<T>`; `ValueTask` becomes `Task` | low |
| Direct `await` call sites | No change needed; both types are awaitable | none |
| `.AsTask()` calls | Now redundant; remove them | low |
| `IValueTaskSource<T>` implementations | Must be replaced with a real `Task` source or `TaskCompletionSource<T>` | high |
| Synchronous fast-path returns | `return new ValueTask<T>(value)` becomes `return Task.FromResult(value)` | medium |
| Interface / base-class signatures | Every implementer and override must change together | medium |
| Public API surface | Binary-breaking change for external consumers | high |

The only genuinely hard cases are a hand-rolled `IValueTaskSource<T>` (rare, and if you have one you adopted `ValueTask` deliberately, so think twice) and a public NuGet surface where the return-type change is a binary break. Everything else is mechanical.

## Pre-flight checklist

Before touching a single signature:

- Confirm the analyzer is on. `ValueTask` correctness rule **CA2012** is enabled as a suggestion by default in .NET 10 and later. Promote it to a warning so the compiler shows you exactly which call sites were relying on `ValueTask` semantics: add `dotnet_diagnostic.CA2012.severity = warning` to your `.editorconfig`.
- Capture a baseline. If allocation was ever the reason for `ValueTask`, run a `BenchmarkDotNet` `[MemoryDiagnoser]` pass on the hot path now, so you can compare after.
- Identify the contract boundary. If the method implements an interface or overrides a base member, every related declaration changes in the same commit. Grep for the method name across the solution first.
- Check the public surface. If this type ships in a NuGet package, a return-type change is binary-breaking even though it is source-compatible. Plan a major version bump.

## Migration steps

Each step below is a discrete change with a verification line. Do them in order; expect intermediate states where the build is red until the contract is updated everywhere.

1. **Turn CA2012 into a warning and build.** Make the analyzer loud before you change anything, so the build surfaces every risky consumption pattern while the `ValueTask` signature is still in place.

   ```ini
   # .editorconfig - .NET 11 SDK, CA2012 ships in the built-in analyzers
   [*.cs]
   dotnet_diagnostic.CA2012.severity = warning
   ```

   Run `dotnet build`. Every CA2012 warning is a call site that double-awaited, stored, or blocked on the `ValueTask` -- exactly the code that becomes trivially correct once you revert. Note each one; you will delete the workarounds in step 4. **Verify:** the build completes and you have a written list of CA2012 hits (often zero, which is itself useful information).

2. **Change the declaration.** Swap the return type. The method body usually needs one edit per `return` of a materialized value.

   ```csharp
   // Before: .NET 11, C# 14
   public ValueTask<User> GetUserAsync(int id)
   {
       if (_cache.TryGetValue(id, out var user))
           return new ValueTask<User>(user);          // synchronous fast path

       return new ValueTask<User>(LoadFromDbAsync(id)); // wraps a Task
   }

   // After: .NET 11, C# 14
   public Task<User> GetUserAsync(int id)
   {
       if (_cache.TryGetValue(id, out var user))
           return Task.FromResult(user);              // synchronous fast path

       return LoadFromDbAsync(id);                     // already a Task<User>
   }
   ```

   For an `async`-keyword method, the change is just the signature; the compiler rewrites the rest:

   ```csharp
   // Before
   public async ValueTask<int> CountAsync(CancellationToken ct)
   {
       await Task.Delay(5, ct);
       return 42;
   }

   // After: only the return type changed
   public async Task<int> CountAsync(CancellationToken ct)
   {
       await Task.Delay(5, ct);
       return 42;
   }
   ```

   **Verify:** the project compiles. The async-keyword form needs no further edits; the manual form needs every `new ValueTask<T>(...)` rewritten to `Task.FromResult(...)` or to returning the inner `Task` directly.

3. **Update interface and base-class declarations together.** If the method came from a contract, change the contract and every implementer in the same pass, or the build breaks half-finished.

   ```csharp
   // Before
   public interface IUserRepository
   {
       ValueTask<User> GetUserAsync(int id);
   }

   // After
   public interface IUserRepository
   {
       Task<User> GetUserAsync(int id);
   }
   ```

   **Verify:** `dotnet build` across the whole solution, not just the one project. A missed implementer surfaces as `CS0535` (does not implement interface member) or `CS0508` (return type mismatch on override).

4. **Delete the `.AsTask()` workarounds and the double-await fixes.** This is where the revert pays off. Anywhere a caller defended against `ValueTask`'s single-await rule, the defense is now dead code.

   ```csharp
   // Before: caller had to convert because it awaited twice / fanned out
   ValueTask<User> vt = repo.GetUserAsync(id);
   Task<User> safe = vt.AsTask();        // required for ValueTask
   var a = await safe;
   var b = await safe;

   // After: Task is awaitable repeatedly; no conversion needed
   Task<User> t = repo.GetUserAsync(id);
   var a = await t;
   var b = await t;
   ```

   `Task.WhenAll` and `Task.WhenAny` now take the results directly:

   ```csharp
   // Before: each ValueTask needed .AsTask() before combining
   await Task.WhenAll(ids.Select(id => repo.GetUserAsync(id).AsTask()));

   // After
   await Task.WhenAll(ids.Select(id => repo.GetUserAsync(id)));
   ```

   **Verify:** every CA2012 warning from step 1 is gone, and you removed at least as many `.AsTask()` calls as you had warnings.

5. **Replace any `IValueTaskSource<T>` plumbing.** If a method returned a pooled `ValueTask<T>` backed by a custom `IValueTaskSource<T>` (the pattern `ManualResetValueTaskSourceCore<T>` enables), there is no drop-in. You are giving up the pooling, so use a `TaskCompletionSource<T>` instead and accept the allocation you are choosing to reintroduce.

   ```csharp
   // After: a Task source replaces the pooled IValueTaskSource<T>
   private readonly TaskCompletionSource<int> _tcs =
       new(TaskCreationOptions.RunContinuationsAsynchronously);

   public Task<int> WaitForValueAsync() => _tcs.Task;

   public void Complete(int value) => _tcs.TrySetResult(value);
   ```

   The `RunContinuationsAsynchronously` flag matters: without it, `TrySetResult` runs the continuation inline on the completing thread, which can deadlock or starve a thread pool the same way a synchronous block does. This is the one step where reverting genuinely costs you something, so only do it if the pooling was never justified by a benchmark. **Verify:** the type no longer implements `IValueTaskSource<T>`, and a stress test that completes the operation thousands of times still passes without reentrancy issues.

## Verification after the swap

Run this checklist end to end before you call the migration done:

- `dotnet build` is clean with CA2012 at `warning` and zero hits.
- `dotnet test` passes with no new failures, especially around any code that previously cached the awaitable.
- The `BenchmarkDotNet` `[MemoryDiagnoser]` run from pre-flight shows the allocation delta you expected. If a synchronously-completing hot path now allocates one `Task<T>` per call (24 bytes on 64-bit) and that path runs millions of times a second, you have your evidence that `ValueTask` was earning its keep and the revert was a mistake. If the numbers are flat, the revert was free correctness.
- Grep the diff for any leftover `new ValueTask`, `.AsTask()`, or `ValueTask<` you missed.

## Rollback plan

This migration is fully reversible at the source level and low risk to undo: changing `Task<T>` back to `ValueTask<T>` is the same mechanical edit in reverse. The one caveat is the public-API case. If you shipped the `Task<T>` version in a released NuGet package, flipping back to `ValueTask<T>` is another binary-breaking change, so external consumers recompile twice. Internal code has no such constraint; keep the migration on a branch and revert the commit if the benchmark says you regressed.

## Gotchas we hit

**`Task.FromResult` is not free for reference types you allocate anyway.** `Task.FromResult(value)` still allocates a `Task<T>` for an arbitrary value. The runtime caches the tasks for `Task.FromResult(true)`, `false`, and small integers, but not for your `User`. If you are reverting precisely because the method now rarely completes synchronously, this does not matter; if it still completes synchronously most of the time, that allocation is the thing `ValueTask` was avoiding. Measure before you assume the revert is harmless.

**`async` over a synchronous body reintroduces the state machine.** Rewriting `return new ValueTask<T>(cachedValue)` as an `async` method that returns `cachedValue` adds a state-machine allocation on top of the `Task<T>`. Keep the fast path non-`async`: return `Task.FromResult(...)` from a plain method, exactly as in step 2. The same reasoning that makes [ConfigureAwait still matter in .NET 11](/2026/05/configureawait-false-vs-default-in-dotnet-11/) applies here -- the cheapest async path is the one that never builds a state machine at all.

**Cancellation semantics are unchanged, but verify them anyway.** Both `Task<T>` and `ValueTask<T>` surface cancellation as a faulted/canceled awaitable; the revert does not change how a `CancellationToken` flows. Still, retest your cancellation paths, because the rewrite touches every return statement. If your cancellation handling was already fragile, see [how to cancel a long-running Task without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

**`IAsyncEnumerable<T>` is the one place to keep `ValueTask`.** `IAsyncEnumerator<T>.MoveNextAsync` returns `ValueTask<bool>` by design, and `DisposeAsync` returns `ValueTask`. Do not "revert" these; the async-streams machinery is built to reuse the backing source across iterations, which is the textbook case where `ValueTask` pays off. If you are working with streams, [using IAsyncEnumerable<T> with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) shows the pattern in context.

**Fire-and-forget hid a double-consume.** A pattern we found while reverting: a `ValueTask` was assigned to a field and observed later, which is illegal and was silently corrupting results under load. Switching to `Task<T>` made it legal, but the right fix was to stop fire-and-forgetting at all. If you see this, read [running fire-and-forget work safely](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) before you paper over it with a type change, and watch for the [ObjectDisposedException on a disposed context](/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) that the same fire-and-forget pattern tends to produce.

The honest summary: reverting `ValueTask<T>` to `Task<T>` is the correct default for code that adopted the struct without a profiler in hand. You trade a micro-optimization you probably were not getting for a type that your whole team can use without reading a rules list. Keep `ValueTask` exactly where the data says it earns its place -- hot synchronous-completion paths and async streams -- and let `Task<T>` carry everything else.

## Sources

- [Understanding the Whys, Whats, and Whens of ValueTask -- .NET Blog (Stephen Toub)](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/)
- [CA2012: Use ValueTasks correctly -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012)
- [ValueTask&lt;TResult&gt; Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1)
- [ValueTask Restrictions -- Stephen Cleary](https://blog.stephencleary.com/2020/03/valuetask.html)
