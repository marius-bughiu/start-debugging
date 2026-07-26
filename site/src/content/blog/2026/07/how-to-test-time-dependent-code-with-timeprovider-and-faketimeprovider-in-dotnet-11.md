---
title: "How to test time-dependent code with TimeProvider and FakeTimeProvider in .NET 11"
description: "Replace DateTime.UtcNow, Stopwatch, and Task.Delay with System.TimeProvider so tests can control the clock: DI registration, FakeTimeProvider.Advance and SetUtcNow, testing timeouts and PeriodicTimer-based BackgroundServices, plus the Advance-continuation and xUnit v2 gotchas."
pubDate: 2026-07-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "testing"
  - "async"
  - "timeprovider"
---

To test time-dependent code in .NET 11, stop calling `DateTime.UtcNow`, `Stopwatch`, and `Task.Delay(...)` directly and take a `System.TimeProvider` through the constructor instead. In production you register `TimeProvider.System` as a singleton; in tests you pass a `FakeTimeProvider` from the `Microsoft.Extensions.TimeProvider.Testing` package and drive the clock yourself with `Advance(TimeSpan)` and `SetUtcNow(DateTimeOffset)`. A trial-expiry check that used to need a 14-day wait becomes a two-line test. This post covers the whole pattern on .NET 11 (Preview 6 at the time of writing, GA in November 2026) with C# 14 and `Microsoft.Extensions.TimeProvider.Testing` 10.8.0, including the parts that bite: advancing past several timer periods at once, continuations that do not run after `Advance`, and the xUnit v2 synchronization context hang.

`TimeProvider` shipped in the box with .NET 8 (`System.Runtime.dll`), so everything here also runs unchanged on .NET 8, 9, and 10. For .NET Framework 4.6.2+, .NET 5-7, and netstandard2.0 there is the `Microsoft.Bcl.TimeProvider` package, with one API difference covered at the end.

## Why a static clock makes a test unrunnable

Here is the code that every codebase has somewhere:

```csharp
// .NET 11, C# 14 -- untestable
public sealed class TrialService
{
    private static readonly TimeSpan TrialLength = TimeSpan.FromDays(14);

    public bool IsTrialExpired(User user) =>
        DateTimeOffset.UtcNow - user.SignedUpAt >= TrialLength;
}
```

`DateTimeOffset.UtcNow` is a static property backed by the operating system clock. There is no seam. To exercise the expiry branch you have three bad options: wait two weeks, backdate `user.SignedUpAt` (which tests the subtraction but never the moment of transition), or reach for a mocking framework that patches statics, which drags in a profiler-based interceptor and slows the whole suite down.

The boundary is where the bugs live. Is day 14 expired or still active? What happens at exactly `SignedUpAt + 14 days`? What about the DST transition in the user's local zone? None of those questions are answerable while the clock belongs to the machine.

## What TimeProvider actually abstracts

`TimeProvider` is an abstract class with five capabilities, and it is worth knowing all of them because most people only adopt the first one:

- `GetUtcNow()` and `GetLocalNow()` return a `DateTimeOffset`. This replaces `DateTimeOffset.UtcNow` and `DateTime.Now`.
- `GetTimestamp()` returns a high-frequency tick count, and `GetElapsedTime(long)` / `GetElapsedTime(long, long)` turn two of those into a `TimeSpan`. This replaces `Stopwatch`.
- `CreateTimer(TimerCallback, object?, TimeSpan, TimeSpan)` returns an `ITimer`. This replaces `System.Threading.Timer`.
- `LocalTimeZone` returns a `TimeZoneInfo`. This replaces `TimeZoneInfo.Local`.
- `TimestampFrequency` reports the tick rate behind `GetTimestamp()`.

The default implementation is the static `TimeProvider.System` property: UTC comes from `DateTimeOffset.UtcNow`, the zone from `TimeZoneInfo.Local`, timestamps from `Stopwatch`, and timers from `System.Threading.Timer`. Using it costs nothing over the raw APIs, because it is a thin forwarding layer over exactly those calls.

The reason `CreateTimer` matters is that the BCL wired `TimeProvider` into the async primitives too. These overloads all take a `TimeProvider` and route their internal timer through it:

- `Task.Delay(TimeSpan, TimeProvider)` and `Task.Delay(TimeSpan, TimeProvider, CancellationToken)`
- `Task.WaitAsync(TimeSpan, TimeProvider)` and its `CancellationToken` overload
- `new CancellationTokenSource(TimeSpan, TimeProvider)`
- `new PeriodicTimer(TimeSpan, TimeProvider)`

So a retry loop with backoff, a request deadline, and a polling background service are all controllable from a test without a single `Thread.Sleep`.

## Steps to make a time-dependent class testable

1. Add a `TimeProvider` constructor parameter to the class that reads the clock. Do not give it a default value of `TimeProvider.System`, or the untestable path stays reachable by accident.
2. Replace every `DateTime.UtcNow`, `DateTimeOffset.Now`, `Stopwatch.StartNew()`, `new Timer(...)`, and bare `Task.Delay(...)` inside that class with the `TimeProvider` equivalent.
3. Register the real clock in the composition root: `builder.Services.AddSingleton(TimeProvider.System);`.
4. Add `Microsoft.Extensions.TimeProvider.Testing` to the test project.
5. In each test, construct a `FakeTimeProvider`, pin the starting instant, and move the clock with `Advance` or `SetUtcNow` between assertions.

The rest of this post expands each step into working code.

## Rewriting the service to take a clock

```csharp
// .NET 11, C# 14
public sealed class TrialService(TimeProvider timeProvider)
{
    private static readonly TimeSpan TrialLength = TimeSpan.FromDays(14);

    public bool IsTrialExpired(User user) =>
        timeProvider.GetUtcNow() - user.SignedUpAt >= TrialLength;
}
```

That is the entire production change. The primary constructor captures the provider, and the only difference at the call site is `timeProvider.GetUtcNow()` instead of `DateTimeOffset.UtcNow`.

Registration is one line, because `TimeProvider.System` is a singleton that is safe to share across the whole application:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddScoped<TrialService>();

var app = builder.Build();
```

ASP.NET Core's own components already look for this registration. Since .NET 8, `ISystemClock` is obsolete across the authentication and Identity stack and the options classes expose a settable `TimeProvider` instead, which resolves from the container when you have registered one. Registering `TimeProvider.System` therefore also makes token lifetime validation and cookie expiry testable.

## The first test with FakeTimeProvider

```
dotnet add package Microsoft.Extensions.TimeProvider.Testing
```

Version 10.8.0 is current as of July 2026. It targets .NET 8.0 and later plus .NET Framework 4.6.2 and later, and it carries no dependencies on modern .NET.

```csharp
// .NET 11, C# 14, xUnit v3, Microsoft.Extensions.TimeProvider.Testing 10.8.0
using Microsoft.Extensions.Time.Testing;

public class TrialServiceTests
{
    [Fact]
    public void Trial_is_active_on_day_13_and_expired_on_day_14()
    {
        var time = new FakeTimeProvider(
            new DateTimeOffset(2026, 7, 26, 12, 0, 0, TimeSpan.Zero));

        var user = new User(SignedUpAt: time.GetUtcNow());
        var sut = new TrialService(time);

        time.Advance(TimeSpan.FromDays(13));
        Assert.False(sut.IsTrialExpired(user));

        time.Advance(TimeSpan.FromDays(1));
        Assert.True(sut.IsTrialExpired(user));
    }
}
```

No sleeping, no backdating, and the day-14 boundary is asserted explicitly. Three details about `FakeTimeProvider` are worth internalising now:

**The parameterless constructor starts at midnight, 1 January 2000 UTC.** That is deliberate: a fixed, obviously-synthetic instant that never accidentally matches "today". Pass a `DateTimeOffset` to the constructor when the date itself is part of the behaviour under test, for example a leap-day or end-of-month rollover.

**`LocalTimeZone` defaults to `TimeZoneInfo.Utc`, not the machine's zone.** So `GetLocalNow()` equals `GetUtcNow()` until you call `SetLocalTimeZone(...)`. This is what makes zone-sensitive tests deterministic on a build agent in a different region than your laptop:

```csharp
// .NET 11, C# 14 -- pin the zone so a CI agent in UTC behaves like a user in Bucharest
var time = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 3, 30, 0, TimeSpan.Zero));
time.SetLocalTimeZone(TimeZoneInfo.FindSystemTimeZoneById("Europe/Bucharest"));

Assert.Equal(new TimeSpan(2, 0, 0), time.GetLocalNow().Offset); // after the DST fall-back
```

**`SetUtcNow` only moves forward.** Passing a value earlier than the current time throws `ArgumentOutOfRangeException` with the message "Cannot go back in time." If you genuinely need to simulate an operator or NTP daemon setting the clock backwards, use `AdjustTime(DateTimeOffset)`. `AdjustTime` shifts the current time without firing any pending timers, and it shifts every outstanding timer's wake-up point by the same delta, which is what a real system clock change does.

## Testing a timeout instead of waiting for one

The interesting cases are not timestamps, they are delays. A retry policy with exponential backoff normally takes seconds of real time to test. Route its waiting through the provider and it takes microseconds:

```csharp
// .NET 11, C# 14
public sealed class RetryingFetcher(HttpClient http, TimeProvider timeProvider)
{
    public async Task<string> FetchAsync(string url, CancellationToken ct = default)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                return await http.GetStringAsync(url, ct);
            }
            catch (HttpRequestException) when (attempt < 3)
            {
                var backoff = TimeSpan.FromSeconds(Math.Pow(2, attempt));
                await Task.Delay(backoff, timeProvider, ct);
            }
        }
    }
}
```

Deadlines work the same way. `new CancellationTokenSource(TimeSpan, TimeProvider)` gives you a token source whose internal timer is driven by the fake clock, so the whole `CancelAfter` pattern for enforcing an async deadline becomes assertable:

```csharp
// .NET 11, C# 14
[Fact]
public async Task Deadline_fires_after_five_seconds()
{
    var time = new FakeTimeProvider();
    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5), time);

    Assert.False(cts.IsCancellationRequested);

    time.Advance(TimeSpan.FromSeconds(5));

    Assert.True(cts.IsCancellationRequested);
}
```

## Testing a BackgroundService that polls on a timer

A polling worker built on `PeriodicTimer` is the classic "we do not unit-test this" component. With the `TimeProvider` overload it is ordinary code:

```csharp
// .NET 11, C# 14
public sealed class ExpiryWorker(IExpiryStore store, TimeProvider timeProvider)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5), timeProvider);

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await store.PurgeExpiredAsync(timeProvider.GetUtcNow(), stoppingToken);
        }
    }
}
```

The test has one subtlety: the worker has to reach `WaitForNextTickAsync` and register its timer before you advance, otherwise you advance past a tick that was never scheduled. Do not solve this with `Thread.Sleep`. Yield first, then advance, then await a signal that the work actually ran:

```csharp
// .NET 11, C# 14, xUnit v3
[Fact]
public async Task Worker_purges_once_per_five_minute_tick()
{
    var time = new FakeTimeProvider();
    var store = new RecordingExpiryStore(); // sets a TaskCompletionSource on each call
    var worker = new ExpiryWorker(store, time);

    await worker.StartAsync(CancellationToken.None);
    await Task.Yield(); // let ExecuteAsync reach WaitForNextTickAsync

    time.Advance(TimeSpan.FromMinutes(5));
    await store.NextPurge; // completes when PurgeExpiredAsync is entered

    Assert.Equal(1, store.PurgeCount);

    await worker.StopAsync(CancellationToken.None);
}
```

Waiting on a signal the production code raises, rather than on wall-clock time, is what keeps this test from being flaky on a loaded CI agent. The same discipline applies when the worker under test uses [scoped services inside a BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/): resolve the scope inside the loop, then assert against what the scope produced.

## Advance fires periodic timers once per elapsed period

This is the behaviour that surprises people most. `FakeTimeProvider.Advance` walks its waiter list, invokes every callback whose wake-up point has passed, and for a periodic timer it adds the period to the wake-up point and checks again. One call therefore fires a five-minute timer twelve times:

```csharp
// .NET 11, C# 14 -- twelve ticks, not one
time.Advance(TimeSpan.FromHours(1)); // PeriodicTimer period = 5 minutes
```

For `PeriodicTimer` specifically that does not mean twelve loop iterations, because `WaitForNextTickAsync` coalesces ticks that arrive while nobody is waiting. But for a raw `ITimer` from `CreateTimer` with a non-infinite period, you will get twelve callback invocations, synchronously, on the thread that called `Advance`. If you want exactly one tick, advance by exactly one period.

The synchronous part matters for a second reason: any exception thrown inside a timer callback propagates out of your `Advance` call, not out of some background thread where it would be swallowed. That is usually a gift, but it does mean an `Advance` line can throw an assertion failure from code several layers away.

## Continuations that do not run after Advance

The single most reported issue with `FakeTimeProvider` is a test that hangs or asserts too early after `Advance`, tracked as [dotnet/extensions#5326](https://github.com/dotnet/extensions/issues/5326). The shape is this:

```csharp
// .NET 11, C# 14 -- flaky: the continuation may not have run yet
var delayTask = Task.Delay(TimeSpan.FromSeconds(30), time);
time.Advance(TimeSpan.FromSeconds(30));
Assert.True(delayTask.IsCompleted); // not guaranteed
```

`Advance` completes the underlying task, but the continuation attached by an `await` elsewhere is scheduled, not executed inline. The fix is to await the thing you care about rather than poll a flag:

```csharp
// .NET 11, C# 14 -- deterministic
var delayTask = Task.Delay(TimeSpan.FromSeconds(30), time);
time.Advance(TimeSpan.FromSeconds(30));
await delayTask; // returns immediately, and orders the continuation
```

You will see `await Task.Delay(1)` after `Advance` in a lot of sample code. It works by giving the scheduler a real turn, but it reintroduces a real-time dependency into a test whose entire point was to remove one. Await the operation instead, or await a `TaskCompletionSource` the production code completes.

The related trap is `AutoAdvanceAmount`. Setting it makes the clock move forward on every *read* of `GetUtcNow()` or `GetTimestamp()`, which is handy for code that measures elapsed time between two reads:

```csharp
// .NET 11, C# 14 -- every clock read advances by 100ms
var time = new FakeTimeProvider { AutoAdvanceAmount = TimeSpan.FromMilliseconds(100) };

long start = time.GetTimestamp();
long end = time.GetTimestamp();

Assert.Equal(TimeSpan.FromMilliseconds(100), time.GetElapsedTime(start, end));
```

But auto-advance does not drive timers, because nothing reads the clock on a timer's behalf. A `Task.Delay(TimeSpan, TimeProvider)` will never complete on auto-advance alone; you still need an explicit `Advance`. That distinction is worth remembering before you spend an afternoon on it.

## The xUnit v2 synchronization context hang

If your test project is still on xUnit v2 and the code under test uses `ConfigureAwait(false)`, a `FakeTimeProvider` test can deadlock. xUnit v2 installs an `AsyncTestSyncContext` for the duration of each test, and the interaction between that context and the inline timer callbacks parks the test forever. The package README documents the workaround:

```csharp
// .NET 11, C# 14 -- xUnit v2 only
SynchronizationContext.SetSynchronizationContext(null);
```

Put that at the top of the affected test, or in the fixture constructor. xUnit v3 removed `AsyncTestSyncContext` entirely, so the problem does not exist there. If you are picking a test framework for a new project this is one more small argument for v3.

## What not to convert

`TimeProvider` is a seam, not a religion. Two rules keep it from spreading:

Inject it into the class that makes a *decision* based on time, not into every class that happens to pass a timestamp along. A DTO carrying a `CreatedAt` does not need a clock; the factory that stamps it does.

Do not read the clock twice in one method and expect the same value. `timeProvider.GetUtcNow()` is a method call, not a cached property, and with `AutoAdvanceAmount` set it deliberately returns something different each time. Read once into a local and use the local, which is good practice with `DateTime.UtcNow` too and becomes a correctness requirement here.

Finally, on .NET Framework and netstandard2.0 through `Microsoft.Bcl.TimeProvider`, the async overloads do not exist as instance methods. Use the extension methods in `System.Threading.Tasks.TimeProviderTaskExtensions` instead: `timeProvider.Delay(...)`, `timeProvider.CreateCancellationTokenSource(...)`, and `task.WaitAsync(timeout, timeProvider, ct)`. The behaviour is the same; only the call shape differs, so a multi-targeted library needs a small `#if` or a shared helper.

## Related

- The timeout mechanics this post makes testable are covered in full in the guide to [enforcing an async deadline with CancellationTokenSource.CancelAfter](/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/).
- Every one of these tests depends on a token reaching the operation, which is the subject of [propagating a CancellationToken through async methods](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).
- When the code under test needs a real database rather than a fake clock, see [integration tests against a real SQL Server with Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Choosing where the polling loop lives in the first place is covered in [BackgroundService vs IHostedService vs Hangfire](/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/).
- Blocking on an async call is the fastest way to make a `FakeTimeProvider` test hang for reasons that have nothing to do with the clock: see [the deadlock from calling .Result or .Wait()](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

## Sources

- [TimeProvider Class](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider) on Microsoft Learn
- [What is the TimeProvider class](https://learn.microsoft.com/en-us/dotnet/standard/datetime/timeprovider-overview) in the .NET fundamentals docs
- [FakeTimeProvider Class](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.time.testing.faketimeprovider) API reference
- [Microsoft.Extensions.TimeProvider.Testing README](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.TimeProvider.Testing/README.md) in dotnet/extensions
- [FakeTimeProvider.cs source](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.TimeProvider.Testing/FakeTimeProvider.cs)
- [dotnet/extensions#5326: continuations on Task.Delay do not run when Advance is called](https://github.com/dotnet/extensions/issues/5326)
- [Breaking change: ISystemClock is obsolete](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/8.0/isystemclock-obsolete)
