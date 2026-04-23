---
title: "How to cancel a long-running Task in C# without deadlocking"
description: "Cooperative cancellation with CancellationToken, CancelAsync, Task.WaitAsync, and linked tokens in .NET 11. Plus the blocking patterns that turn a clean cancel into a deadlock."
pubDate: 2026-04-23
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
---

You have a `Task` that runs for a long time, a user clicks Cancel, and the app either hangs or the task keeps running until it finishes on its own. Both outcomes point to the same misunderstanding: in .NET, cancellation is cooperative, and the pieces that make it work are `CancellationTokenSource`, `CancellationToken`, and your willingness to actually check the token. This post walks through how to set that up cleanly on .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14), and how to avoid the blocking patterns that turn a clean cancel into a `Wait`-forever deadlock. Every sample compiles against .NET 11.

## Cooperative cancellation, the one-paragraph mental model

.NET has no `Task.Kill()`. The CLR will not yank a thread out of the middle of your code. When you want to cancel work, you create a `CancellationTokenSource`, hand its `Token` to every function in the call chain, and those functions either check `token.IsCancellationRequested`, call `token.ThrowIfCancellationRequested()`, or pass the token into an async API that respects it. When `cts.Cancel()` (or `await cts.CancelAsync()`) fires, the token flips and every checked site reacts. Nothing is cancelled that has not been asked to check.

This is why `Task.Run(() => LongLoop())` without a token cannot be cancelled. The compiler does not inject cancellation for you.

## The minimal correct pattern

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();

Task work = DoWorkAsync(cts.Token);

// Later, from a Cancel button, a timeout, whatever:
await cts.CancelAsync();

try
{
    await work;
}
catch (OperationCanceledException)
{
    // Expected when cts triggers. Not an error.
}

static async Task DoWorkAsync(CancellationToken ct)
{
    for (int i = 0; i < 1_000_000; i++)
    {
        ct.ThrowIfCancellationRequested();
        await Task.Delay(10, ct); // async APIs should take the token
    }
}
```

Three rules are doing the work here:

1. The `CancellationTokenSource` is disposed (`using var`) so its internal timer and wait handle are released.
2. Every level of the call chain accepts a `CancellationToken` and either checks it or forwards it.
3. The caller awaits the task and catches `OperationCanceledException`. Cancellation surfaces as an exception so that cleanup in `finally` blocks still runs.

## CPU-bound loops: ThrowIfCancellationRequested

For CPU-bound work, sprinkle `ct.ThrowIfCancellationRequested()` at a rate that makes responsiveness acceptable without turning the check into the hot path. The check is cheap (`Volatile.Read` on an `int`), but inside a tight inner loop processing tens of millions of items it still shows up in profiles. A good default is once per outer iteration of whatever loop does "one unit of work".

```csharp
// .NET 11, C# 14
static long SumPrimes(int max, CancellationToken ct)
{
    long sum = 0;
    for (int n = 2; n <= max; n++)
    {
        if ((n & 0xFFFF) == 0) ct.ThrowIfCancellationRequested(); // every 65536 iterations
        if (IsPrime(n)) sum += n;
    }
    return sum;
}
```

When the work lives in a background thread started with `Task.Run`, also pass the token to `Task.Run` itself:

```csharp
var task = Task.Run(() => SumPrimes(10_000_000, cts.Token), cts.Token);
```

Passing the token to `Task.Run` means that if the token is cancelled **before** the delegate starts running, the task transitions directly to `Canceled` without executing. Without it, the delegate runs to completion and only the internal check would stop it.

## I/O-bound work: forward the token to every async API

Every modern .NET I/O API takes a `CancellationToken`. `HttpClient.GetAsync`, `Stream.ReadAsync`, `DbCommand.ExecuteReaderAsync`, `SqlConnection.OpenAsync`, `File.ReadAllTextAsync`, `Channel.Reader.ReadAsync`. If you do not pass the token down, cancellation stops at your layer and the underlying I/O continues until the OS or the remote side gives up.

```csharp
// .NET 11, C# 14
static async Task<string> FetchWithTimeoutAsync(string url, TimeSpan timeout, CancellationToken outer)
{
    using var http = new HttpClient();
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(outer);
    linked.CancelAfter(timeout);

    using HttpResponseMessage resp = await http.GetAsync(url, linked.Token);
    resp.EnsureSuccessStatusCode();
    return await resp.Content.ReadAsStringAsync(linked.Token);
}
```

Two things are worth calling out in that snippet. `CreateLinkedTokenSource` combines "the caller wants to cancel" with "we gave up after `timeout`" into one token. And `CancelAfter` is the right way to express a timeout, not `Task.Delay` racing against the work, because it uses a single timer queue entry rather than allocating a full `Task`.

## The deadlock traps, in order of how often I see them

### Trap 1: blocking on an async method from a context that captures

```csharp
// BAD on WinForms, WPF, or any SynchronizationContext that runs on one thread
string html = FetchAsync(url).Result;
```

`FetchAsync` awaits inside, which posts the continuation back to the captured `SynchronizationContext`. That context is the UI thread. The UI thread is blocked on `.Result`. The continuation cannot run. Deadlock. Cancellation does not help here, because the task is never going to complete.

The fix is not `ConfigureAwait(false)` in your code. The fix is not blocking in the first place. Make the caller async:

```csharp
string html = await FetchAsync(url);
```

If you absolutely cannot await (for example, a constructor), use `Task.Run` to move off the captured context first. That is a surrender, not a solution.

### Trap 2: ConfigureAwait(false) only on the outer await

A library author wraps one call in `ConfigureAwait(false)`, sees the deadlock go away in their unit test, ships it. Then a caller wraps the whole thing in `.Result` and the deadlock comes back, because an inner `await` in a callee did capture the context.

`ConfigureAwait(false)` is a per-await setting. Either every `await` in every library method uses it, or none do. The `Nullable` annotation world has it easy; this one does not. On .NET 11 with C# 14, you can turn on the `CA2007` analyzer to enforce `ConfigureAwait(false)` in libraries, and use `ConfigureAwaitOptions.SuppressThrowing` when you want to await a task purely for completion without caring about its exception.

### Trap 3: CancellationTokenSource.Cancel() called from a callback registered on the same token

`CancellationTokenSource.Cancel()` runs registered callbacks **synchronously** on the calling thread by default. If one of those callbacks calls `Cancel()` on the same source, or blocks on a lock that another callback holds, you get a recursive or reentrant deadlock. On .NET 11, prefer `await cts.CancelAsync()` when you hold any lock, when you are on a `SynchronizationContext`, or when callbacks are non-trivial. `CancelAsync` dispatches callbacks asynchronously so `Cancel` returns to you first.

```csharp
// .NET 11, C# 14
lock (_state)
{
    _state.MarkStopping();
}
await _cts.CancelAsync(); // callbacks fire after we are out of the lock
```

### Trap 4: a task that ignores its token

The most common cause of "cancel does nothing" is not a deadlock at all, it is a task that never checks. Fix it at the source:

```csharp
static async Task BadAsync(CancellationToken ct)
{
    await Task.Delay(5000); // no token, so unaffected by cancel
}

static async Task GoodAsync(CancellationToken ct)
{
    await Task.Delay(5000, ct); // throws OperationCanceledException on cancel
}
```

If you cannot modify the callee (third-party code without a token parameter), `Task.WaitAsync(CancellationToken)` from .NET 6+ gives you an escape hatch: the wait becomes cancellable even though the underlying work is not.

```csharp
// .NET 11, C# 14
Task<string> hardcoded = LegacyFetchThatIgnoresTokensAsync();
string result = await hardcoded.WaitAsync(ct); // returns immediately on cancel; the underlying work keeps running
```

Be honest about what this does: it unblocks you, it does not stop the work. On .NET 11 the underlying `HttpClient`, file handle, or whatever the legacy code is doing continues until it finishes, and its result is discarded. For a long-running loop that holds exclusive resources, this is a leak, not a cancel.

## Linked tokens: caller cancel + timeout + shutdown

A realistic server endpoint wants to cancel for three reasons: the caller disconnected, the per-request timeout elapsed, or the host is shutting down. `CreateLinkedTokenSource` composes them.

```csharp
// .NET 11, C# 14 - ASP.NET Core 11 minimal API
app.MapGet("/report", async (HttpContext ctx, IHostApplicationLifetime life, CancellationToken requestCt) =>
{
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(requestCt, life.ApplicationStopping);
    linked.CancelAfter(TimeSpan.FromSeconds(30));

    string report = await BuildReportAsync(linked.Token);
    return Results.Text(report);
});
```

ASP.NET Core already gives you `HttpContext.RequestAborted` (exposed as the `CancellationToken` parameter when you accept one). Link it with `IHostApplicationLifetime.ApplicationStopping` so that a graceful shutdown also cancels in-flight work, and add a per-endpoint timeout on top. If any of those three fires, `linked.Token` flips.

## OperationCanceledException vs TaskCanceledException

Both exist. `TaskCanceledException` inherits from `OperationCanceledException`. Catch `OperationCanceledException` unless you specifically need to distinguish "the task was canceled" from "the caller canceled a different operation". In practice, always catch the base class.

One subtle point: when you `await` a task that was canceled, the exception you get back may not carry the original token. If you need to know which token fired, check `ex.CancellationToken == ct` rather than inspecting which token you passed to which API.

## Dispose your CancellationTokenSource, especially when you use CancelAfter

`CancellationTokenSource.CancelAfter` schedules work on the internal timer. Forgetting to dispose the CTS keeps that timer entry alive until the GC reaches it, which on a busy server is a memory-and-timer leak that does not crash but shows up as slow growth in `dotnet-counters`. `using var cts = ...;` or `using (var cts = ...) { ... }` every time.

If you want to hand the CTS to a background owner, make sure exactly one place is responsible for disposing it, and dispose only after everyone who holds its token has released it.

## Background services: stoppingToken is your friend

In a `BackgroundService`, `ExecuteAsync` receives a `CancellationToken stoppingToken` that flips when the host begins shutting down. Use it as the root of every cancellation chain inside the service. Do not create fresh CTS instances that are disconnected from shutdown, or a graceful `Ctrl+C` will time out and the host will tear the process down the hard way.

```csharp
// .NET 11, C# 14
public sealed class Crawler(IHttpClientFactory http, ILogger<Crawler> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var perItem = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                perItem.CancelAfter(TimeSpan.FromSeconds(10));

                await CrawlNextAsync(http.CreateClient(), perItem.Token);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break; // host is stopping; exit cleanly
            }
            catch (OperationCanceledException)
            {
                log.LogWarning("Per-item timeout elapsed, continuing.");
            }
        }
    }
}
```

The `catch` with a `when` filter distinguishes "we are shutting down" from "we timed out a single unit of work". Shutdown breaks the outer loop. A per-item timeout logs and moves on.

## What about Thread.Abort, Task.Dispose, or a hard kill?

`Thread.Abort` is not supported on .NET Core and throws `PlatformNotSupportedException` on .NET 11. `Task.Dispose` exists but is not what you think it is, it only releases a `WaitHandle`, it does not cancel the task. There is no "kill this task" API by design. The closest escape valve is to run truly uncancellable work in a separate process (`Process.Start` + `Process.Kill`) and live with the cross-process overhead. For everything else, cooperative cancellation is the API.

## Pulling it together

A cancel button that works is nine times out of ten the result of three small habits: every async method takes a `CancellationToken` and forwards it, every long loop calls `ThrowIfCancellationRequested` at a sensible cadence, and nothing anywhere in the call chain blocks on `.Result` or `.Wait()`. Add `using` on your CTS, `CancelAfter` for timeouts, `await CancelAsync()` inside locks, and `WaitAsync` as the escape hatch for code you cannot change.

## Related reading

- [Streaming rows from the database with IAsyncEnumerable](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/), which leans heavily on the same token plumbing.
- [Cleaner async stack traces in the .NET 11 runtime](/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/), useful when an `OperationCanceledException` surfaces deep in a pipeline.
- [How to return multiple values from a method in C# 14](/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) pairs well with async methods that want to return "result or cancellation reason".
- [The end of `lock (object)` in .NET 9](/2026/01/net-9-the-end-of-lockobject/) for the broader threading context your cancellation code runs inside.

## Source links

- [Task Cancellation](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/task-cancellation), MS Learn.
- [Cancellation in Managed Threads](https://learn.microsoft.com/en-us/dotnet/standard/threading/cancellation-in-managed-threads), MS Learn.
- [Coalesce cancellation tokens from timeouts](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/coalesce-cancellation-tokens-from-timeouts), MS Learn.
- [`CancellationTokenSource.CancelAsync`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.cancelasync), API reference.
- [`Task.WaitAsync(CancellationToken)`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync), API reference.
