---
title: "What is AsyncLocal<T>, and why doesn't a value set inside an awaited method flow back to the caller?"
description: "AsyncLocal<T> stores a value in the ExecutionContext, which flows down into awaits, Task.Run and continuations but never back up: every async method restores the caller's context when it returns. Verified on .NET 10: eleven cases with real output, the runtime code that does the restore, and three patterns that do get a value back to the caller."
pubDate: 2026-11-04
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "asynclocal"
---

**Short answer:** `AsyncLocal<T>` stores its value in the current `ExecutionContext`, an immutable snapshot that is copied into every `await` continuation, `Task.Run` and timer callback started from that point. Setting the value does not edit the snapshot, it swaps in a new one, and every `async` method saves the caller's snapshot on entry and puts it back when it returns to the caller. So a value set inside `await SetTenantAsync()` is visible to the rest of that method and to anything it starts, but the caller still sees its old value afterwards. That is by design: data flows down the async call tree, never up. If you need a value back, return it, set it in a non-`async` method, or put a mutable holder in the `AsyncLocal` before the call and change the holder's contents instead. Everything below was run on the .NET 10 SDK 10.0.302 (runtime 10.0.10, C# 14); the behaviour has been the same since .NET Core 1.0 and .NET Framework 4.6.

## The surprise in five lines

```csharp
// .NET 10 (SDK 10.0.302), C# 14: dotnet run probe.cs
var tenant = new AsyncLocal<string?>();

tenant.Value = "outer";
await SetAsync("inner");
Console.WriteLine(tenant.Value); // prints "outer", not "inner"

async Task SetAsync(string v)
{
    tenant.Value = v;
    await Task.Yield();
    Console.WriteLine(tenant.Value); // prints "inner"
}
```

Inside `SetAsync` the new value is there, before and after its own `await`. Back in the caller it is gone. People usually hit this when they write an "ambient context" helper (a tenant id, a correlation id, a unit of work) with an `async` initializer, call it from middleware or a test setup method, and find the value `null` everywhere afterwards.

## Why the value does not come back

Two pieces of runtime behaviour combine to produce this.

**The context is copy-on-write.** `ExecutionContext` is immutable. The setter of `AsyncLocal<T>.Value` builds a new `ExecutionContext` containing the new value and installs it on the current thread. Any task or continuation that already captured the old context keeps the old one. That is what makes `AsyncLocal<T>` safe across parallel branches: two `Task.Run` calls that each set the value cannot see each other's writes.

**Every async method restores its caller's context.** When you call an `async` method, the compiler-generated code calls `AsyncMethodBuilderCore.Start`, which runs the method synchronously up to its first incomplete `await`. In the [.NET 10 source](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/AsyncMethodBuilderCore.cs) it looks like this (trimmed):

```csharp
// System.Private.CoreLib, AsyncMethodBuilderCore.Start, .NET 10.0.0
ExecutionContext? previousExecutionCtx = currentThread._executionContext;
try
{
    stateMachine.MoveNext();
}
finally
{
    ExecutionContext? currentExecutionCtx = currentThread._executionContext;
    if (previousExecutionCtx != currentExecutionCtx)
    {
        ExecutionContext.RestoreChangedContextToThread(currentThread, previousExecutionCtx, currentExecutionCtx);
    }
}
```

The comment above that block in the runtime says it plainly: the restore exists so that context changes "won't 'leak' out of the first await". The part of the method that runs after the first real `await` is a continuation, and continuations run on the context that was captured at the `await`, then the thread goes back to whatever it had. So there is no path by which the callee's new snapshot ever becomes the caller's snapshot.

The design reason is the one above: an `async` method is a logical child of its caller, and a child must not rewrite the parent's ambient state, because the parent may have other children running concurrently. `Thread`-local storage has the opposite problem (values stay behind on a pool thread and leak into the next unrelated work item), and `AsyncLocal<T>` was introduced in .NET Framework 4.6 to replace `CallContext.LogicalSetData` with exactly these "flow down only" semantics.

## Eleven cases, measured

This single-file program covers the variants people ask about. Save it as `probe.cs` and run `dotnet run probe.cs` with the .NET 10 SDK.

```csharp
// .NET 10 (SDK 10.0.302), C# 14: dotnet run probe.cs
using System.Runtime.CompilerServices;

var tenant = new AsyncLocal<string?>();
void Show(string label) => Console.WriteLine($"{label,-48} {tenant.Value ?? "(null)"}");

tenant.Value = "outer";
await SetAsync("inner-async");
Show("1. after await SetAsync:");

await SetNoAwaitAsync("inner-sync-completing");
Show("2. after await SetNoAwaitAsync (no real await):");

SetSync("inner-plain-sync");
Show("3. after plain sync SetSync:");
tenant.Value = "outer";

await SetValueTaskAsync("inner-valuetask");
Show("4. after await SetValueTaskAsync:");

await SetAsync("inner-cafalse").ConfigureAwait(false);
Show("5. after ConfigureAwait(false):");

await Task.Run(() => { tenant.Value = "inside-task-run"; });
Show("6. after Task.Run sets:");

var box = new AsyncLocal<StrongBox<string?>>();
box.Value = new StrongBox<string?>("outer");
await MutateBoxAsync(box, "mutated-inside");
Console.WriteLine($"{"7. holder after await MutateBoxAsync:",-48} {box.Value!.Value}");

var box2 = new AsyncLocal<StrongBox<string?>>();
await CreateBoxAsync(box2, "created-inside");
Console.WriteLine($"{"8. holder created inside callee:",-48} {box2.Value?.Value ?? "(null)"}");

tenant.Value = "consumer";
Console.WriteLine("10. async iterator:");
await foreach (var s in IterAsync())
{
    Console.WriteLine($"   consumer got {s}, sees {tenant.Value}");
    tenant.Value = "consumer-changed";
}

tenant.Value = "outer";
Task t;
using (ExecutionContext.SuppressFlow())
    t = Task.Run(() => Console.WriteLine($"{"11. Task.Run under SuppressFlow sees:",-48} {tenant.Value ?? "(null)"}"));
await t;

async Task SetAsync(string v) { tenant.Value = v; await Task.Yield(); Show("   inside SetAsync after its own await:"); }
#pragma warning disable CS1998
async Task SetNoAwaitAsync(string v) { tenant.Value = v; }
#pragma warning restore CS1998
void SetSync(string v) => tenant.Value = v;
async ValueTask SetValueTaskAsync(string v) { tenant.Value = v; await Task.Delay(1); }
async Task MutateBoxAsync(AsyncLocal<StrongBox<string?>> b, string v) { await Task.Delay(1); b.Value!.Value = v; }
async Task CreateBoxAsync(AsyncLocal<StrongBox<string?>> b, string v) { b.Value = new StrongBox<string?>(v); await Task.Delay(1); }
async IAsyncEnumerable<string> IterAsync()
{
    tenant.Value = "iterator";
    Console.WriteLine($"   iterator set, sees {tenant.Value}");
    yield return "a";
    Console.WriteLine($"   iterator resumed, sees {tenant.Value}");
    await Task.Delay(1);
    yield return "b";
}
```

Output on macOS arm64, runtime 10.0.10 (case 9, change notifications, has its own section below):

```text
   inside SetAsync after its own await:          inner-async
1. after await SetAsync:                         outer
2. after await SetNoAwaitAsync (no real await):  outer
3. after plain sync SetSync:                     inner-plain-sync
4. after await SetValueTaskAsync:                outer
   inside SetAsync after its own await:          inner-cafalse
5. after ConfigureAwait(false):                  outer
6. after Task.Run sets:                          outer
7. holder after await MutateBoxAsync:            mutated-inside
8. holder created inside callee:                 (null)
10. async iterator:
   iterator set, sees iterator
   consumer got a, sees consumer
   iterator resumed, sees consumer-changed
   consumer got b, sees consumer-changed
11. Task.Run under SuppressFlow sees:            (null)
```

What each line tells you:

1. **Async method, real await:** the caller keeps `outer`. This is the base case.
2. **Async method that never awaits:** still `outer`. People expect "it completed synchronously, so it ran on my context", but the restore in `Start` runs in a `finally` no matter how the method finishes. The `async` keyword alone is enough to isolate the write.
3. **Plain synchronous method:** the value does flow back. There is no state machine and no `Start`, so the write lands on the caller's thread context directly. This is the basis of the first workaround below.
4. **`ValueTask`:** same as `Task`. `AsyncValueTaskMethodBuilder` uses the same `AsyncMethodBuilderCore.Start`.
5. **`ConfigureAwait(false)`:** no effect on any of this. `ConfigureAwait` controls the `SynchronizationContext` (where the continuation runs), not the `ExecutionContext` (what ambient data it sees). The two are separate and both flow independently; see [ConfigureAwait(false) vs the default](/2026/05/configureawait-false-vs-default-in-dotnet-11/) for the other half.
6. **`Task.Run`:** the delegate gets a copy of the caller's context. Its write stays inside the task. The same goes for `Task.Factory.StartNew`, `ThreadPool.QueueUserWorkItem`, `Timer` and `new Thread(...).Start()`, all of which capture the context (the unsafe variants such as `UnsafeQueueUserWorkItem` do not). The [Task.Run vs StartNew vs QueueUserWorkItem](/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/) comparison covers which APIs capture what.
7. **Mutable holder set before the call:** the callee mutates the object, the caller sees the change, because both contexts point at the same object.
8. **Holder created inside the callee:** `(null)`. Assigning a new holder is a write to the `AsyncLocal` and is reverted like any other.
10. **Async iterators:** each `MoveNextAsync` is its own async step that starts from the *consumer's* current context. The iterator's own `tenant.Value = "iterator"` is gone after the first `yield return`, and when it resumes it sees whatever the consumer set in the loop body. If an iterator needs ambient state across yields, capture it into a local at the top. More on how iterators are driven in [what IAsyncEnumerable is and when to use it](/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/).
11. **`ExecutionContext.SuppressFlow()`:** work started inside the `using` block gets no context at all, so it sees `null`, not `outer`. This is the tool for the opposite problem, values flowing somewhere they should not, which is what [Polly 8.8.1 fixed in its circuit breaker](/2026/10/polly-8-8-1-circuit-breaker-no-longer-keeps-the-first-callers-asynclocal-values-alive/).

## Three ways to get a value back to the caller

### 1. Return it

The boring answer is usually the right one. If an async method computes something the caller needs, make it the return value and let the caller set the `AsyncLocal` in its own scope:

```csharp
// .NET 10, C# 14
tenant.Value = await ResolveTenantAsync(request);
await next(context); // everything downstream sees the tenant
```

The write happens in the caller's frame, so it flows down into `next` and everything below it.

### 2. Set it in a non-async method that returns the task

If you want the "call one method and the context is set" ergonomics, drop the `async` keyword from the outer method. Do the write synchronously, then return the inner task:

```csharp
// .NET 10 (SDK 10.0.302), C# 14: dotnet run probe2.cs
var tenant = new AsyncLocal<string?>();
tenant.Value = "outer";
await BeginTenantAsync("acme");
Console.WriteLine($"after non-async wrapper: {tenant.Value}");

Task BeginTenantAsync(string id)
{
    tenant.Value = id;          // runs on the caller's ExecutionContext
    return WarmCacheAsync(id);  // the async work still gets its own copy
}

async Task WarmCacheAsync(string id)
{
    await Task.Delay(1);
    Console.WriteLine($"inside WarmCacheAsync: {tenant.Value}");
}
```

```text
inside WarmCacheAsync: acme
after non-async wrapper: acme
```

The catch: only the synchronous write before `return` escapes. Anything `WarmCacheAsync` sets after its first `await` stays inside it. And the value is now set for the rest of the caller's method, so pair it with a scope that resets it (see the `IDisposable` pattern below) rather than leaving it dangling.

### 3. Put a mutable holder in the AsyncLocal first

When the value is only known deep inside the call tree (an authenticated user resolved by a downstream handler, say), set an empty holder at the top and fill it in further down. Case 7 above is exactly this. ASP.NET Core's own `IHttpContextAccessor` uses the holder pattern, for the reverse reason: the [.NET 10 source](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Http/Http/src/HttpContextAccessor.cs) stores an `AsyncLocal<HttpContextHolder>` and, when the request ends, sets `holder.Context = null` so that every copied context sees the clear, including fire-and-forget tasks that still hold a copy:

```csharp
// Microsoft.AspNetCore.Http.HttpContextAccessor, ASP.NET Core 10.0.0 (trimmed)
private static readonly AsyncLocal<HttpContextHolder> _httpContextCurrent = new();

set
{
    // Clear current HttpContext trapped in the AsyncLocals, as its done.
    _httpContextCurrent.Value?.Context = null;
    if (value != null)
        _httpContextCurrent.Value = new HttpContextHolder { Context = value };
}

private sealed class HttpContextHolder { public HttpContext? Context; }
```

Two rules make holders safe. First, create the holder in the outermost frame that should see the result (case 8 shows what happens otherwise). Second, the holder is shared mutable state: if the code below it runs branches in parallel (`Task.WhenAll`, `Parallel.ForEachAsync`), they all write to the same object, so either make the writes idempotent or use a thread-safe type inside the holder.

## Scoping an ambient value correctly

Most `AsyncLocal` bugs in application code are not about flow-back but about values outliving the scope they were meant for. The usual shape is a disposable scope that restores the previous value, set from a synchronous method so that it applies to the caller:

```csharp
// .NET 10, C# 14
public static class TenantContext
{
    private static readonly AsyncLocal<string?> _current = new();
    public static string? Current => _current.Value;

    // Not async on purpose: the write must land on the caller's context.
    public static IDisposable Begin(string tenantId)
    {
        var previous = _current.Value;
        _current.Value = tenantId;
        return new Scope(previous);
    }

    private sealed class Scope(string? previous) : IDisposable
    {
        public void Dispose() => _current.Value = previous;
    }
}

// usage, in middleware or a message handler
using (TenantContext.Begin(tenantId))
{
    await next(context);
}
```

`ILogger.BeginScope` works the same way, which is why log scopes attach to calls made while the `using` block is open and to tasks started inside it, but not to log lines written after the block exits. The post on [adding the current user id to every log entry](/2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core/) runs into exactly that boundary.

One subtlety: `Dispose` itself is a write. If you dispose the scope inside an async method other than the one that called `Begin`, the reset is local to that method and the outer frame keeps the tenant. Keep `Begin` and `Dispose` in the same method, which a `using` statement does for you.

## Watching it happen with change notifications

`AsyncLocal<T>` has a constructor that takes an `Action<AsyncLocalValueChangedArgs<T>>`. It fires on explicit writes and also every time a thread switches to a context where the value differs, which makes the save-and-restore visible:

```csharp
// .NET 10 (SDK 10.0.302), C# 14: dotnet run probe3.cs
var watched = new AsyncLocal<int>(a =>
    Console.WriteLine($"{a.PreviousValue} -> {a.CurrentValue}  ThreadContextChanged={a.ThreadContextChanged}"));

await WorkAsync();
Console.WriteLine($"caller sees {watched.Value}");

async Task WorkAsync()
{
    watched.Value = 1;
    await Task.Delay(1);
    watched.Value = 2;
}
```

```text
0 -> 1  ThreadContextChanged=False
1 -> 0  ThreadContextChanged=True
0 -> 1  ThreadContextChanged=True
1 -> 2  ThreadContextChanged=False
2 -> 0  ThreadContextChanged=True
caller sees 0
0 -> 2  ThreadContextChanged=True
2 -> 0  ThreadContextChanged=True
```

Read it top to bottom: the explicit write to 1 (`False`), the restore when `WorkAsync` hits its first `await` and hands control back (`1 -> 0`, `True`), the pool thread switching into `WorkAsync`'s captured context for the continuation (`0 -> 1`), the explicit write to 2, and the switch back to the caller's context for its continuation (`2 -> 0`). The last two lines are the pool thread unwinding after the caller's code finishes. Every `True` line is a context switch, not a write. That is also why the callback is a diagnostic tool, not an event to build logic on: it fires on unrelated thread hops and runs on hot paths, so a slow handler slows down every `await`.

## Gotchas that look like the same bug

- **Values set in a constructor or `Configure` callback at startup** are captured by whatever starts work there. A hosted service started from a context that had a value set keeps that value for its lifetime. Use `ExecutionContext.SuppressFlow()` around long-lived background loops that should not inherit the caller's ambient state.
- **`async void` event handlers** get a copy of the context of whoever raised the event, and nothing they set comes back. Combined with the other reasons in [async void vs async Task](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/), it is another argument for keeping ambient writes out of handlers.
- **Unit tests with an async `[SetUp]` / `InitializeAsync`**: an `AsyncLocal` set inside an `async` setup method is reverted when that method returns, exactly like case 1, so the test body does not see it unless the framework deliberately captures and replays the setup's context. Check what your test framework version does before relying on it; the portable fix is to set ambient values synchronously or inside the test method.
- **Large or many values** make every context switch more expensive, because each write allocates a new `ExecutionContext` and the runtime switches to a different internal storage shape as the number of `AsyncLocal` instances with values grows. Keep the count small and store one object rather than five separate locals.
- **`AsyncLocal` is not `ThreadLocal`.** If a value stays visible on the same thread after your work finished, you are probably looking at a `[ThreadStatic]` field or `ThreadLocal<T>`, which have the leak-to-next-work-item problem that `AsyncLocal` avoids.

## Sources

- [`AsyncLocal<T>` class](https://learn.microsoft.com/dotnet/api/system.threading.asynclocal-1) and [`AsyncLocalValueChangedArgs<T>`](https://learn.microsoft.com/dotnet/api/system.threading.asynclocalvaluechangedargs-1) on MS Learn
- [`ExecutionContext.SuppressFlow`](https://learn.microsoft.com/dotnet/api/system.threading.executioncontext.suppressflow) on MS Learn
- [`AsyncMethodBuilderCore.cs` at v10.0.0](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/AsyncMethodBuilderCore.cs), dotnet/runtime
- [`HttpContextAccessor.cs` at v10.0.0](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Http/Http/src/HttpContextAccessor.cs), dotnet/aspnetcore
- Stephen Toub, [ExecutionContext vs SynchronizationContext](https://devblogs.microsoft.com/dotnet/executioncontext-vs-synchronizationcontext/), .NET Blog
