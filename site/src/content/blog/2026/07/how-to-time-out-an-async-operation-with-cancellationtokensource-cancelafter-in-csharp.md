---
title: "How to time out an async operation with CancellationTokenSource.CancelAfter in C#"
description: "Use CancellationTokenSource.CancelAfter to enforce an async deadline in .NET 11: constructor vs CancelAfter, linked tokens for composing timeouts with caller tokens, exception disambiguation, Task.WaitAsync, TryReset for pooling, and testable timeouts with TimeProvider."
pubDate: 2026-07-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
---

Setting a deadline on an async operation requires three things: a `CancellationTokenSource`, a call to `cts.CancelAfter(TimeSpan.FromSeconds(5))`, and passing `cts.Token` into every async method in the chain. When the deadline expires the token fires, any downstream `await` throws `OperationCanceledException`, and you catch it. This post covers the full pattern on .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14): when to use the constructor overload instead of `CancelAfter`, how to compose a timeout with an outer `CancellationToken`, how to tell a timeout from a caller cancel, `Task.WaitAsync` for code you cannot modify, `TryReset` for pooling, and making timeouts testable with `TimeProvider`.

## The operation that hangs forever

An `HttpClient` call with no explicit deadline waits as long as the server takes. `HttpClient.Timeout` defaults to 100 seconds, which is long enough to back up a request queue under load. More importantly, `HttpClient.Timeout` cannot be combined with a caller's `CancellationToken`, and when it fires it throws `TaskCanceledException` with an `InnerException` that is `TimeoutException` -- a different shape from a cooperative cancellation. The manual `CancelAfter` pattern gives you both deadline enforcement and composition.

```csharp
// .NET 11, C# 14 -- dangerous: HttpClient.Timeout defaults to 100 seconds
using HttpClient http = new();
string json = await http.GetStringAsync("https://slow-api.example.com/data");
```

## CancelAfter in one step

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(5));

try
{
    using HttpClient http = new();
    string json = await http.GetStringAsync(
        "https://slow-api.example.com/data", cts.Token);
    Console.WriteLine(json);
}
catch (OperationCanceledException) when (cts.IsCancellationRequested)
{
    Console.WriteLine("Request timed out after 5 seconds.");
}
```

`CancelAfter` schedules a one-shot internal timer. When the timer fires it calls `Cancel()` on the CTS, which flips the token's state from "not requested" to "requested". Any `await` inside `GetStringAsync` that checks the token throws `OperationCanceledException`. The `when` clause ensures you only absorb the exception if your own CTS is the one that fired -- not if some other cancellation the framework or a caller injects reaches you.

## Constructor overload vs CancelAfter

```csharp
// .NET 11, C# 14 -- these are equivalent for a fixed fire-once deadline:
using var cts1 = new CancellationTokenSource(TimeSpan.FromSeconds(5));

using var cts2 = new CancellationTokenSource();
cts2.CancelAfter(TimeSpan.FromSeconds(5));
```

Use the constructor when the deadline is fixed at object creation and will never change. Prefer `CancelAfter` when you create the CTS upfront and decide the deadline later, or when you need to reset it during the operation -- for example, a watchdog that renews its window on every successful heartbeat:

```csharp
// .NET 11, C# 14 -- reset the deadline on every packet arrival
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(10));

await foreach (Packet packet in ReadPacketsAsync(cts.Token))
{
    Process(packet);
    cts.CancelAfter(TimeSpan.FromSeconds(10));  // restart the 10-second window
}
```

Each `CancelAfter` call replaces the previously scheduled time using `ITimer.Change` internally -- no new allocation. The new countdown starts from the moment of the call.

## Composing a timeout with an outer CancellationToken

In ASP.NET Core, `HttpContext.RequestAborted` fires when the client disconnects. In a `BackgroundService`, `stoppingToken` fires on shutdown. Your timeout should cancel if either the deadline fires or the caller aborts. Use `CancellationTokenSource.CreateLinkedTokenSource`:

```csharp
// .NET 11, C# 14
public async Task<string> FetchWithDeadlineAsync(
    string url,
    CancellationToken callerToken = default)
{
    using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(
        callerToken, timeoutCts.Token);

    using HttpClient http = new();
    return await http.GetStringAsync(url, linked.Token);
}
```

Pass `linked.Token` to every downstream call. The linked token cancels if either source fires. `CreateLinkedTokenSource` accepts any number of tokens; the returned CTS is cancelled as soon as any of them is cancelled.

Always `Dispose` both the timeout CTS and the linked CTS. Undisposed CTS instances with pending timers are not garbage-collected until the timer fires.

## Telling a timeout from a caller cancel

Both paths throw `OperationCanceledException`. To give callers meaningful error information, convert a true timeout into a `TimeoutException`:

```csharp
// .NET 11, C# 14
catch (OperationCanceledException ex)
{
    if (timeoutCts.IsCancellationRequested)
        throw new TimeoutException(
            "The fetch timed out after 5 seconds.", ex);

    // Caller cancelled -- rethrow without wrapping so the caller's token
    // bubbles up unchanged
    throw;
}
```

This matters when calling code does not know about the internal `CancellationTokenSource`. A caller that catches `TimeoutException` does not need to inspect tokens it never created.

When using a linked CTS, check `timeoutCts.IsCancellationRequested` directly. Do not compare `ex.CancellationToken` with the linked token -- `ex.CancellationToken` holds whichever constituent token fired first (caller, timeout, or linked), which varies by race.

## Task.WaitAsync for code that does not accept a token

Not every API accepts a `CancellationToken`. .NET 6 added `Task.WaitAsync` for that case:

```csharp
// .NET 11, C# 14 -- wrapping a tokenless legacy API
Task<string> slowWork = LegacyApiAsync();

try
{
    string result = await slowWork.WaitAsync(TimeSpan.FromSeconds(5));
}
catch (TimeoutException)
{
    // Deadline passed. slowWork is STILL RUNNING in the background.
    Console.WriteLine("Gave up waiting after 5 seconds.");
}
```

`WaitAsync(TimeSpan)` throws `TimeoutException` (not `OperationCanceledException`) and does not cancel the underlying `Task`. The work keeps running until it completes on its own. Use `WaitAsync` only when you cannot pass a token to the called code; the resource consumption continues regardless.

A combined overload accepts both a deadline and a `CancellationToken`:

```csharp
// .NET 11, C# 14 -- cancellable AND time-bounded
await slowWork.WaitAsync(TimeSpan.FromSeconds(5), callerToken);
```

This overload throws `TimeoutException` if the deadline fires first, or `TaskCanceledException` (a subclass of `OperationCanceledException`) if the token fires first.

## Resetting and disabling an existing timeout

`CancelAfter` can be called multiple times. Each call replaces the previously scheduled deadline:

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(10));   // initial deadline: 10s

// Extend: restart the timer with a 5-second window from now
cts.CancelAfter(TimeSpan.FromSeconds(5));

// Disable the timeout entirely without cancelling the CTS:
cts.CancelAfter(Timeout.InfiniteTimeSpan);   // no longer fires
```

`Timeout.InfiniteTimeSpan` is `-1` milliseconds, which disables the internal timer without putting the CTS into the cancelled state.

Once a CTS is cancelled, calling `CancelAfter` has no effect. Check `IsCancellationRequested` first if cancellation may have already occurred.

## TryReset for pooling

In high-throughput code that issues many short operations, creating a new `CancellationTokenSource` per request generates allocations. .NET 6 added `TryReset` for reuse:

```csharp
// .NET 11, C# 14 -- pooled CTS pattern
private CancellationTokenSource _cts = new();

public async Task ProcessRequestAsync()
{
    if (!_cts.TryReset())
        _cts = new CancellationTokenSource();

    _cts.CancelAfter(TimeSpan.FromSeconds(5));

    await DoWorkAsync(_cts.Token);
}
```

`TryReset` returns `true` if the CTS has not been cancelled and is safe to reuse; `false` if it was cancelled and a new instance is required. It is not thread-safe with concurrent cancellation requests -- call it only after the previous operation has completed, from a single owner. ASP.NET Core uses this pattern internally in Kestrel.

## Testable timeouts with TimeProvider

Waiting 5 real seconds in a unit test is slow and flaky. `TimeProvider`, introduced in .NET 8 and stable in .NET 11, makes the internal timer injectable:

```csharp
// .NET 11, C# 14
public async Task<string> FetchAsync(
    string url,
    TimeProvider? clock = null)
{
    clock ??= TimeProvider.System;
    using var cts = clock.CreateCancellationTokenSource(TimeSpan.FromSeconds(5));

    using HttpClient http = new();
    return await http.GetStringAsync(url, cts.Token);
}
```

In tests, inject `FakeTimeProvider` from the `Microsoft.Extensions.TimeProvider.Testing` NuGet package:

```csharp
// xUnit, .NET 11, C# 14
[Fact]
public async Task FetchAsync_ThrowsOnTimeout()
{
    var clock = new FakeTimeProvider();
    Task<string> fetch = FetchAsync("https://slow.example.com", clock);

    clock.Advance(TimeSpan.FromSeconds(10));  // jump 10 seconds instantly

    await Assert.ThrowsAsync<OperationCanceledException>(() => fetch);
}
```

The cancellation fires synchronously when you advance the clock. No `Task.Delay`. No flaky timing.

## Dispose the CTS

`CancellationTokenSource` implements `IDisposable`, not `IAsyncDisposable`. There is no `DisposeAsync`. When you call `CancelAfter`, a timer is registered against the thread pool timer queue. That timer holds a reference to the CTS, preventing garbage collection until it fires.

Always dispose:

```csharp
// Good: guaranteed cleanup even if an exception is thrown
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
await DoWorkAsync(cts.Token);
// cts.Dispose() is called here; the timer is cancelled and released
```

Disposal cancels the pending timer, releases wait handles, and removes the CTS from any `CreateLinkedTokenSource` chain it belongs to. In a server handling thousands of concurrent requests, leaking CTS instances causes timer accumulation.

## Gotchas

**HttpClient.Timeout competes with your token.** `HttpClient.Timeout` defaults to 100 seconds. If you also pass a `CancelAfter` token, both timers are running. When `HttpClient.Timeout` fires it throws `TaskCanceledException` where `ex.InnerException is TimeoutException`; when your token fires it throws `OperationCanceledException` where `ex.CancellationToken == cts.Token`. Either disable `HttpClient.Timeout` by setting it to `Timeout.InfiniteTimeSpan` and manage the deadline yourself, or rely on `HttpClient.Timeout` and skip the manual CTS. See [Fix: TaskCanceledException in HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) for the full disambiguation.

**CancelAfter after Cancel is a no-op.** Once a CTS is in the cancelled state, calling `CancelAfter` does nothing. Cancellation is a one-way transition.

**UI thread marshaling.** On WinForms, WPF, or MAUI, the continuation after a cancelled `await` runs on whatever thread pool thread picks up the completion -- not the UI thread. If you update UI elements in the catch block, marshal back explicitly. In ASP.NET Core there is no `SynchronizationContext`, so [ConfigureAwait(false) has no effect](/2026/05/configureawait-false-vs-default-in-dotnet-11/).

**Do not share a token across parallel branches.** If you fan out work with `Task.WhenAll` and pass the same `cts.Token` to all branches, the first cancellation cancels all of them. That is usually what you want for a shared deadline, but be deliberate about it.

## Related

- Threading a single `CancellationToken` through every async layer: [How to propagate a CancellationToken through async methods in .NET 11](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- Manual cancel without a deadline: [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- Three reasons HttpClient throws TaskCanceledException: [Fix: TaskCanceledException in HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- ConfigureAwait(false) in library code that ships to UI targets: [ConfigureAwait(false) vs default in .NET 11](/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- async void vs async Task -- which one can surface exceptions: [async void vs async Task in C#: when each is correct](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)

## Source links

- [CancellationTokenSource.CancelAfter -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.cancelafter)
- [CancellationTokenSource.TryReset -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.tryreset)
- [Task.WaitAsync -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync)
- [TimeProvider.CreateCancellationTokenSource -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider.createcancellationtokensource)
- [Microsoft.Extensions.TimeProvider.Testing on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.TimeProvider.Testing)
