---
title: "Returning a Task directly vs async/await passthrough in a C# repository method: which should you use?"
description: "Eliding async/await in a repository passthrough saves about 6 ns and 72 bytes, and costs you a stack frame, try/catch semantics, and safe disposal. Keep return await unless the method is a pure passthrough on a measured hot path."
pubDate: 2026-09-01
template: vs
tags:
  - "comparison"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "performance"
---

You have a repository method that does nothing but forward to EF Core, Dapper, or an `HttpClient`. You can write it as `public Task<Order> GetAsync(int id) => _db.Orders.FindAsync(id).AsTask();` and skip the state machine, or as `public async Task<Order> GetAsync(int id) => await _db.Orders.FindAsync(id);` and keep it. **Keep the `await`.** Eliding it buys roughly 6 nanoseconds and 72 bytes per call on .NET 10, which is invisible next to any database round trip, and it costs you a frame in every stack trace plus three behaviours that silently change if the method ever grows a `using`, a `try`, or a `lock`. Elide only when the method is a genuine one-line passthrough on a path you have profiled. All measurements below are on .NET 10.0.10 with C# 14; the .NET 11 story (Preview 7, GA on November 10, 2026) is at the end and it makes the case for eliding weaker, not stronger.

## The two forms at a glance

| Behaviour                                   | `return await inner()` (async) | `return inner()` (elided) |
| ------------------------------------------- | ------------------------------ | ------------------------- |
| State machine generated                     | yes                            | no                        |
| Appears in the exception stack trace        | yes                            | **no**                    |
| Overhead, inner completes synchronously     | 8.5 ns / 144 B                 | 2.6 ns / 72 B             |
| Overhead, inner actually suspends           | 1111 ns / 286 B                | 1010 ns / 191 B           |
| Safe inside `using` / `await using`         | yes                            | **no**                    |
| `try`/`catch` around the call actually works| yes                            | **no**                    |
| Argument-validation throws surface          | on `await`                     | at the call site          |
| Return type may differ from inner's         | yes (covariance, `ValueTask`)  | no (CS0029)               |
| Can apply `ConfigureAwait(false)`           | yes                            | n/a (inherits inner's)    |
| Triggers CS1998 if you drop the last await  | yes                            | n/a                       |

Two rows in that table are compile-time facts and the rest are runtime behaviour you will only discover in production. That asymmetry is the whole argument for the default.

## What the compiler actually emits

`async` is not a calling convention, it is a rewrite. When you mark a method `async`, Roslyn turns it into a struct implementing `IAsyncStateMachine`, hoists every local into a field on that struct, and replaces the body with a `MoveNext()` switch. The method itself becomes a stub that creates an `AsyncTaskMethodBuilder<T>`, starts the machine, and returns `builder.Task`. That returned `Task<T>` is a **new** task, distinct from the one the inner call produced, and the builder is responsible for completing it when the inner task finishes.

Elide the `async` and none of that happens. The method compiles to a plain call plus a return, and the caller receives the *same* `Task<T>` instance the inner method created. There is no builder, no boxed state machine, no continuation registration, and no second task.

```csharp
// .NET 10, C# 14
public sealed class OrderRepository(AppDbContext db)
{
    // elided: the caller gets the exact Task instance EF Core created
    public Task<List<Order>> GetOpenAsync(CancellationToken ct) =>
        db.Orders.Where(o => o.Status == OrderStatus.Open).ToListAsync(ct);

    // await passthrough: EF Core's task is awaited, and a second task is handed out
    public async Task<List<Order>> GetOpenAwaitedAsync(CancellationToken ct) =>
        await db.Orders.Where(o => o.Status == OrderStatus.Open).ToListAsync(ct);
}
```

Both compile. Both are correct *for this exact body*. The differences start the moment the body is not exactly this.

## What the extra await actually costs

I benchmarked the two shapes with BenchmarkDotNet 0.15.8 on an Apple M4 (10 cores), macOS 26.6.2, .NET SDK 10.0.302, host runtime .NET 10.0.10, Arm64 RyuJIT, `MemoryDiagnoser` on, workstation GC. Two scenarios: an inner method that completes synchronously (`Task.FromResult`, the EF Core first-level-cache hit case) and one that genuinely suspends (`await Task.Yield()`, the real I/O case).

| Method              | Mean       | Ratio | Allocated | Alloc ratio |
| ------------------- | ---------- | ----- | --------- | ----------- |
| `Elided_Completed`  | 2.63 ns    | 1.00  | 72 B      | 1.00        |
| `Awaited_Completed` | 8.47 ns    | 3.22  | 144 B     | 2.00        |
| `Elided_Suspends`   | 1009.95 ns | 383.5 | 191 B     | 2.65        |
| `Awaited_Suspends`  | 1110.81 ns | 421.8 | 286 B     | 3.97        |

Read the ratios and eliding looks like a 3x win. Read the absolute numbers and it is 5.8 nanoseconds and 72 bytes on the synchronous path, 101 nanoseconds and 95 bytes on the suspending path. The 72 bytes on the fast path is the second `Task<int>` the builder allocates; the 95 bytes on the slow path is the boxed state machine plus that task.

Now put that next to what a repository method actually does. A local PostgreSQL round trip is 200 to 500 microseconds. A cross-AZ one is a few milliseconds. 101 nanoseconds is between 0.002% and 0.05% of a single query. You would need on the order of ten thousand elided passthroughs to claw back the time of one query. The synchronous-completion case is the only one where the ratio is not swallowed whole, and that case matters exactly where you would expect: a tight loop over an already-cached value, a `ValueTask` fast path, a serializer hot loop. Not `GetOrderByIdAsync`.

## Where eliding silently changes behaviour

### The stack frame disappears

This is the cost you pay every day and only notice at 3am. A method that returns a task without awaiting it is finished the instant it returns; by the time the exception is thrown, its frame is long gone. Stack traces in async code are a record of pending continuations, not of who called whom.

```csharp
// .NET 10, C# 14
static Task ElidedPassthroughAsync() => ThrowAsync();
static async Task AwaitedPassthroughAsync() => await ThrowAsync();

static async Task ThrowAsync()
{
    await Task.Yield();
    throw new InvalidOperationException("boom");
}
```

Catching at the top and printing `ex.StackTrace` gives two different pictures:

```text
=== ELIDED ===
   at Program.<<Main>$>g__ThrowAsync|0_2() in Program.cs:line 16
   at Program.<Main>$(String[] args) in Program.cs:line 4

=== AWAITED ===
   at Program.<<Main>$>g__ThrowAsync|0_2() in Program.cs:line 16
   at Program.<<Main>$>g__AwaitedPassthroughAsync|0_1() in Program.cs:line 11
   at Program.<Main>$(String[] args) in Program.cs:line 7
```

`ElidedPassthroughAsync` is not in the trace at all. On a two-method sample that is a curiosity. On a real service where the same `ThrowAsync`-equivalent (`SqlException` out of `ToListAsync`) is reached from eleven different repository methods, the elided frames are the ones that would have told you which feature broke. If you have already read about how [Runtime Async in .NET 11 cleans up async stack traces](/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/), note that it makes the frames you *do* have far more readable, but it cannot resurrect a frame that never registered a continuation.

### `using` disposes before the work finishes

This is the bug, not a trade-off. `using var` compiles to a `try`/`finally` around the rest of the scope, and `finally` runs when the method returns. An elided method returns as soon as the inner call hands back an incomplete task.

```csharp
// .NET 10, C# 14 -- broken: the resource is disposed while the task is still running
static Task<int> BadAsync()
{
    using var res = new Resource();
    return res.UseAsync();
}

// correct: the finally runs after the awaited work completes
static async Task<int> GoodAsync()
{
    using var res = new Resource();
    return await res.UseAsync();
}
```

`BadAsync` throws `ObjectDisposedException: Cannot access a disposed object. Object name: 'Resource'` every time; `GoodAsync` completes. The same applies to `await using` over an `IAsyncDisposable`, to `SemaphoreSlim` released in a `finally`, and to any transaction scope. If your repository opens a connection, begins a transaction, or rents from a pool, eliding is not an optimization, it is a use-after-free. The disposal ordering rules are worked through in more detail in [implementing and consuming IAsyncDisposable with await using](/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/).

### `try`/`catch` stops catching

Same mechanism, different symptom. A `catch` block only catches exceptions thrown while the frame is on the stack. An exception thrown after the inner method suspends is delivered on the returned task, long after your `try` block exited.

```csharp
// .NET 10, C# 14
static Task<string> ElidedTryAsync()
{
    try { return ThrowAsync(); }                              // catch never runs
    catch (InvalidOperationException) { return Task.FromResult("caught"); }
}

static async Task<string> AwaitedTryAsync()
{
    try { return await ThrowAsync(); }                        // catch runs
    catch (InvalidOperationException) { return "caught"; }
}
```

The elided version lets `InvalidOperationException` escape to the caller; the awaited version returns `"caught"`. This is the version of the bug that survives code review, because the `try`/`catch` is *right there* and looks like it is doing something.

### Validation throws move to the call site

An `async` method never throws synchronously. Every exception, including one from the first line, is captured and placed on the returned task. An elided method has no builder to capture into, so a guard clause throws immediately, at the call expression, before the caller has a task to await.

```csharp
// .NET 10, C# 14
static Task<int> ElidedValidateAsync(string? id)
{
    ArgumentNullException.ThrowIfNull(id);   // throws at the call site
    return Task.FromResult(id.Length);
}

static async Task<int> AsyncValidateAsync(string? id)
{
    ArgumentNullException.ThrowIfNull(id);   // throws when the task is awaited
    await Task.Yield();
    return id.Length;
}
```

Callers that do `var t = repo.GetAsync(null); /* ... */ await t;`, or that hand the method to `Task.WhenAll` inside a `Select`, behave differently between the two. With the elided form, `Select(x => repo.GetAsync(x)).ToList()` can throw *during materialization*, before `WhenAll` is ever reached, and none of the already-started tasks are observed. Neither behaviour is wrong in isolation, but flipping between them by adding or removing an `await` is not a refactor readers expect.

## The cases where eliding does not compile at all

`Task<T>` is a class, so it is invariant. `Task<Dog>` is not a `Task<Animal>`, and the compiler will tell you so:

```text
error CS0029: Cannot implicitly convert type 'System.Threading.Tasks.Task<Dog>'
              to 'System.Threading.Tasks.Task<Animal>'
```

The same wall appears when the inner method returns `ValueTask<int>` and your contract is `Task<int>`, which is common the moment you touch `FindAsync` or any `IAsyncEnumerable` bridge:

```text
error CS0029: Cannot implicitly convert type 'System.Threading.Tasks.ValueTask<int>'
              to 'System.Threading.Tasks.Task<int>'
```

`await` performs the conversion for free. Without it you need `.AsTask()` (an allocation, wiping out the saving) or an explicit cast that does not exist. Since a repository interface almost always exposes the abstraction (`Task<IReadOnlyList<Order>>`) rather than the provider's concrete return type (`Task<List<Order>>`), this is not an edge case, it is most of the interface. And if you were considering pushing `ValueTask` up through the layers instead, read [when ValueTask is worth it](/2026/06/what-is-valuetask-and-when-is-it-worth-it/) first: the restrictions cost more than the allocation.

Eliding also removes the seam where you would put `ConfigureAwait(false)`. In a library that still targets a `SynchronizationContext`-bearing host, an elided passthrough inherits whatever the inner method configured, which may be nothing. It is one fewer place to annotate, but also one fewer place to fix. Whether that seam is still worth having in 2026 is covered in [ConfigureAwait(false) versus the default in .NET 11](/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## What .NET 11 runtime async does to the trade

Runtime async, which no longer needs `<EnablePreviewFeatures>` on `net11.0` projects, moves suspension out of compiler-generated state machines and into the CLR. Preview 7 added two things that hit this comparison directly. Async methods now go through tiered compilation instead of permanently running tier0 code, and the JIT gained a **tail-await optimization**: when an async method's last act is to await a call whose returned task matches the method's own return type, the runtime can emit an implicit tailcall, "reducing code size and instruction count significantly". That optimization describes `async Task<T> M() => await Inner();` exactly. It is elision, applied by the runtime, without your source giving up the frame semantics.

The same release notes report the tier0 tail-await work dropping the max allocation rate during TechEmpower `platform-json` warmup from 110,580,952 B/sec to 8,030,616 B/sec. The direction is unambiguous: the runtime is closing the gap you would be hand-optimizing. Writing `return inner()` today to save 72 bytes is writing off a compiler optimization that ships in November, while keeping every behavioural hazard permanently.

## The analyzers that will push you the wrong way

Two popular analyzers flag `return await` as redundant. Roslynator's **RCS1174 "Remove redundant async/await"** is the one you will hit first, and there is a long-running request to turn it off by default precisely because Stephen Cleary and the .NET team consider the transformation unsafe as a blanket rule. **AsyncFixer01 "Unnecessary async/await usage"** makes the same suggestion. Neither analyzer can see whether your method will grow a `using` next sprint, and neither knows that you rely on the frame in production traces.

The practical setting is to leave both off, or set them to `suggestion` and never auto-fix across a solution. A bulk "apply RCS1174 to all documents" is one of the few refactors that can introduce `ObjectDisposedException` into a working codebase. Note that this is the opposite direction from CS1998: that warning fires when an `async` method has *no* `await` at all, and there the right fix genuinely is to drop the modifier, as described in [fixing CS1998 without breaking the method](/2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously/).

## The rule I use in repository code

- **Default to `return await`.** The 6 nanoseconds are not real; the missing stack frame and the disposal hazard are.
- **Elide only when all four hold**: the method body is exactly one `return` statement, there is no `using`, `try`, `lock`, or `finally` anywhere in it, the return type is identical to the inner call's, and you have a profile showing the passthrough on a hot path. Three of those are checkable by reading; the fourth is the one people skip.
- **Never bulk-apply RCS1174 or AsyncFixer01.** Suppress at the project level rather than fixing method by method.
- **On .NET 11, stop eliding entirely.** The tail-await optimization gives you the codegen for free, and the elided form gives up frames the runtime would otherwise have kept.

The uncomfortable part of this comparison is that the elided form is not slower, uglier, or wrong. It is genuinely faster, by an amount no repository will ever notice, in exchange for a method whose semantics change if anyone edits it. That is a bad trade at any exchange rate, and .NET 11 is about to make the numerator zero.

## Related

- [.NET 11 Runtime Async replaces state machines with cleaner stack traces](/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/)
- [Fix: CS1998 "This async method lacks 'await' operators and will run synchronously"](/2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously/)
- [ConfigureAwait(false) versus the default in .NET 11: does it still matter?](/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [What is ValueTask and when is it worth it?](/2026/06/what-is-valuetask-and-when-is-it-worth-it/)
- [How to implement and consume IAsyncDisposable with await using in C#](/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)
- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await in C#](/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)

## Sources

- [Eliding Async and Await](https://blog.stephencleary.com/2016/12/eliding-async-await.html) -- Stephen Cleary
- [.NET 11 Preview 7 runtime release notes: runtime-async tiering and tail-await optimizations](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/runtime.md) -- dotnet/core
- [.NET 11 Preview 7 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/) -- .NET Blog
- [RCS1174: Remove redundant async/await](https://josefpihrt.github.io/docs/roslynator/analyzers/RCS1174/) -- Roslynator
- [Disable by default RCS1174 (issue #429)](https://github.com/JosefPihrt/Roslynator/issues/429) -- dotnet/roslynator
- [AsyncFixer: async/await analyzers and code fixes](https://github.com/semihokur/AsyncFixer) -- semihokur
- [Async and await compiler messages reference](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors) -- Microsoft Learn
