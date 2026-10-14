---
title: "Thread.Sleep vs Task.Delay vs SpinWait for waiting in C#"
description: "Use await Task.Delay for any timed wait in async code, Thread.Sleep only on a dedicated thread you own, and SpinWait only for sub-microsecond waits inside lock-free code. To wait for a condition, use a signal (ManualResetEventSlim, SemaphoreSlim, TaskCompletionSource) instead of any of the three. Measured on .NET 10.0.10."
pubDate: 2026-10-14
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "async"
  - "performance"
---

For a timed pause, use `await Task.Delay(...)` in anything async, because it releases the thread while it waits. Use `Thread.Sleep` only on a thread you created yourself (a console loop, a dedicated worker), never on a thread pool or UI thread. Use `SpinWait` only when you expect the wait to end within a few microseconds, typically inside lock-free code. And if you are actually waiting for **something to happen** rather than for time to pass, none of the three is the right tool: use a signal such as `ManualResetEventSlim`, `SemaphoreSlim`, or a `TaskCompletionSource`, which in my measurements woke up roughly 50 times faster than any polling loop.

Every number in this post was measured on .NET 10.0.10 (SDK 10.0.302), C# 14, on an Apple M4 with 10 cores running macOS 26.6. The APIs themselves have not changed in years: `Task.Delay` has existed since .NET Framework 4.5, `SpinWait` since 4.0, and everything here applies equally to .NET 8, 9, and the .NET 11 previews.

## The comparison at a glance

| | `Thread.Sleep` | `await Task.Delay` | `SpinWait` |
| --- | --- | --- | --- |
| Holds the thread while waiting | Yes, blocked | No, thread returns to the pool | Yes, running or yielding |
| CPU while waiting (500 ms, measured) | 0 ms | 0 ms | 4 ms with `SpinUntil`, 500 ms with `SpinOnce(-1)` |
| Shortest real wait (`1` ms requested, macOS) | ~1.5 ms | ~1.3 ms | ~1 us per early spin |
| Shortest real wait on Windows (default timer) | ~1-15.6 ms | ~15.6 ms | ~1 us per early spin |
| Cancellable | No | Yes, via `CancellationToken` | Only by your own condition |
| Testable with fake time | No | Yes, `Task.Delay(TimeSpan, TimeProvider)` (.NET 8+) | No |
| Safe on a thread pool thread | No | Yes | Only for microseconds |
| Safe on a UI thread | No, freezes the UI | Yes | No |
| Typical use | Dedicated thread loops, quick console tools | Retry backoff, throttling, polling in async code | Lock-free retry loops, spin-then-block primitives |

## What each one actually does to your thread

`Thread.Sleep(ms)` suspends the calling OS thread. The scheduler takes it off the CPU and does not consider it again until the interval elapses. No CPU is burned, but the thread still exists, still holds its stack, and cannot do anything else. That is fine for a thread whose only job is to wait. It is a problem for a thread that belongs to a shared resource.

`Task.Delay(ms)` returns a `Task` that completes when an internal `TimerQueueTimer` fires. When you `await` it, your method returns to its caller, the thread goes back to the pool (or back to the UI message loop), and the rest of the method is scheduled as a continuation when the timer fires. While the delay is pending, no thread is associated with your method at all.

`SpinWait` keeps the thread on the CPU and checks again. It is a struct with one method that matters, `SpinOnce()`, and its behavior depends on how many times you have called it. Reading the [.NET 10 source](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Threading/SpinWait.cs), the constants are `YieldThreshold = 10`, `Sleep0EveryHowManyYields = 5`, and `DefaultSleep1Threshold = 20`:

- Calls 0 to 9 execute `Thread.SpinWait(n)`, a busy loop of CPU pause instructions that grows each iteration.
- From call 10 on, every other call yields the time slice with `Thread.Yield()` or `Thread.Sleep(0)`.
- From call 20 on, every call does `Thread.Sleep(1)`.
- On a single-processor machine it skips spinning entirely and yields from the first call, because spinning there only delays the thread you are waiting for.

So "`SpinWait`" is less a spin than an escalation ladder. That detail decides most of its trade-offs below.

## Measured: how long does "wait 1 ms" really take?

This probe times 200 calls of each and prints the median and the 99th percentile:

```csharp
// .NET 10.0.10, C# 14, dotnet run probe.cs
using System.Diagnostics;

foreach (var ms in new[] { 0, 1, 10, 15 })
{
    var sleep = new List<double>();
    for (int i = 0; i < 200; i++)
    {
        var t = Stopwatch.GetTimestamp();
        Thread.Sleep(ms);
        sleep.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
    }

    var delay = new List<double>();
    for (int i = 0; i < 200; i++)
    {
        var t = Stopwatch.GetTimestamp();
        await Task.Delay(ms);
        delay.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
    }

    sleep.Sort(); delay.Sort();
    Console.WriteLine($"{ms} ms: Sleep p50={sleep[100]:F3} | Delay p50={delay[100]:F3}");
}
```

| Requested | `Thread.Sleep` p50 | `Thread.Sleep` p99 | `Task.Delay` p50 | `Task.Delay` p99 |
| --- | --- | --- | --- | --- |
| 0 ms | 0.000 ms | 0.015 ms | 0.000 ms | 0.001 ms |
| 1 ms | 1.510 ms | 1.633 ms | 1.297 ms | 1.513 ms |
| 10 ms | 12.012 ms | 12.033 ms | 12.043 ms | 12.083 ms |
| 15 ms | 16.763 ms | 17.071 ms | 17.023 ms | 17.215 ms |

Two things to take from this. First, both are "at least this long", never "exactly this long". On macOS the overshoot was a steady 0.3 to 2 ms. Second, `Task.Delay(0)` completes synchronously: it returns an already-completed task, so `await Task.Delay(0)` does not yield at all. If you want to yield in async code, `await Task.Yield()` is the API that does that.

On Windows the gap is much larger. The [`Task.Delay` documentation](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.delay) states that the delay depends on the system clock, whose resolution is about 15 ms on Windows, so `Task.Delay(1)` there typically takes around 15.6 ms. `Thread.Sleep(1)` on Windows can be close to 1 ms or close to 15.6 ms depending on whether some process on the machine has raised the global timer resolution. Neither API is a precision timer. If your loop depends on a 1 ms tick, it will run at a fraction of the rate you expect on a default Windows box.

## Measured: what `Thread.Sleep` does to the thread pool

The real reason `Thread.Sleep` is dangerous is not CPU or precision. It is what it does to a shared pool. This probe queues 200 work items that each wait one second, then measures from a dedicated thread how long a brand-new work item waits before it even starts:

```csharp
// .NET 10.0.10, C# 14, dotnet run probe3.cs -- sleep|delay
using System.Diagnostics;

string mode = args[0];
var sw = Stopwatch.StartNew();

var tasks = Enumerable.Range(0, 200).Select(_ => Task.Run(async () =>
{
    if (mode == "sleep") Thread.Sleep(1000);
    else await Task.Delay(1000);
})).ToArray();

var sampler = new Thread(() =>
{
    using var started = new ManualResetEventSlim();
    var t = Stopwatch.GetTimestamp();
    ThreadPool.UnsafeQueueUserWorkItem(_ => started.Set(), null);
    started.Wait();
    Console.WriteLine($"new work item waited {Stopwatch.GetElapsedTime(t).TotalMilliseconds:F0} ms");
});
sampler.Start();

Task.WaitAll(tasks);
sampler.Join();
Console.WriteLine($"{mode}: 200 waits done in {sw.ElapsedMilliseconds} ms, pool threads = {ThreadPool.ThreadCount}");
```

| | `Thread.Sleep(1000)` | `await Task.Delay(1000)` |
| --- | --- | --- |
| Time for all 200 one-second waits | 18,034 ms | 1,005 ms |
| Pool threads at the end | 12 | 11 |
| Delay before an unrelated work item started | 17,030 ms | 1 ms |

With `Task.Delay`, all 200 waits overlap and the whole batch takes one second on ten threads. With `Thread.Sleep`, the pool can only run as many sleeps at once as it has threads, so the batch is serialized in groups of roughly ten, and every other piece of work queued behind it, in this case a trivial `started.Set()`, sat in the queue for **17 seconds**. Note that the pool did not rescue the situation by adding threads: work items kept completing every second, so its hill-climbing logic grew it from 10 to only 12 threads.

In an ASP.NET Core app that queued work item is the next HTTP request. This is the classic thread pool starvation pattern, and a `Thread.Sleep` inside a request handler or a `BackgroundService` is one of the easiest ways to trigger it. The same thing happens with `Task.Delay(1000).Wait()`, which is just `Thread.Sleep` with extra allocations. If that pattern looks familiar, the post on [fixing deadlocks from `.Result` and `.Wait()`](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) covers the sync-over-async side of it.

## Measured: CPU cost and wake-up latency of `SpinWait`

`SpinWait.SpinUntil(condition)` sounds like it would burn a core for as long as you wait. Thanks to the escalation ladder, it does not:

| Wait strategy, 500 ms of wall time | CPU time used |
| --- | --- |
| `Thread.Sleep(500)` | 0 ms |
| `await Task.Delay(500)` | 0 ms |
| `SpinWait.SpinUntil(...)` | 4 ms |
| `SpinOnce(sleep1Threshold: -1)` loop | 500 ms (one full core) |
| empty `while` loop | 499 ms |

The first 10 pure spins took 9.8 us in total and spins 10 to 19 another 10 us. After that, every `SpinOnce()` is a `Thread.Sleep(1)`, which I measured at about 1,265 us each. Pass `sleep1Threshold: -1` to disable the `Sleep(1)` stage and you get exactly what the name suggests: a pegged core.

The other half of the trade-off is how fast each strategy notices that the thing it waits for has happened. Here a second thread sets a flag after a random 0 to 3 ms, and the main thread measures the time from the flag being set to noticing it (200 runs each):

```csharp
// .NET 10.0.10, C# 14
int flag = 0;
using var ev = new ManualResetEventSlim();
// setter thread: busy-waits a random 0-3 ms, then
//   Volatile.Write(ref flag, 1); ev.Set();

SpinWait.SpinUntil(() => Volatile.Read(ref flag) == 1);       // "spinuntil"
while (Volatile.Read(ref flag) == 0) Thread.Sleep(1);         // "sleep1"
while (Volatile.Read(ref flag) == 0) await Task.Delay(1);     // "delay1"
ev.Wait();                                                    // "mres"
```

| Strategy | p50 wake-up lag | p90 wake-up lag |
| --- | --- | --- |
| `SpinWait.SpinUntil` | 745 us | 1,182 us |
| `Thread.Sleep(1)` polling | 710 us | 1,158 us |
| `await Task.Delay(1)` polling | 836 us | 1,205 us |
| `ManualResetEventSlim.Wait()` | 15 us | 37 us |

Once the wait lasts longer than about 20 us, `SpinUntil` is just a `Thread.Sleep(1)` polling loop with a nicer name, and it wakes up no faster. The event-based wait was 50 times quicker at the median, and it used no CPU while waiting. `ManualResetEventSlim` and `SemaphoreSlim` already spin briefly before they block, so they give you the cheap fast path of `SpinWait` and the efficient slow path of a kernel wait in one call.

## When to pick `await Task.Delay`

- **Retry and backoff in async code.** An HTTP client retrying after a 429, a database reconnect loop. Pass the request's `CancellationToken` so shutdown or a client disconnect cancels the wait instead of leaving it pending.
- **Periodic work in a `BackgroundService`.** `await Task.Delay(interval, stoppingToken)` in a loop is fine. If you want ticks that do not drift by the duration of the work, `PeriodicTimer` (.NET 6+) is the better fit.
- **Throttling or debouncing on a UI thread.** WPF, WinForms, MAUI, and Blazor all stay responsive because the UI thread is free while the delay is pending.
- **Anything you want to unit test.** The overload `Task.Delay(TimeSpan, TimeProvider, CancellationToken)` (.NET 8+) lets a test advance time instantly with `FakeTimeProvider`, which I walked through in the post on [testing time-dependent code with `TimeProvider`](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).

```csharp
// .NET 10, C# 14
async Task<HttpResponseMessage> GetWithRetryAsync(
    HttpClient http, string url, TimeProvider time, CancellationToken ct)
{
    for (int attempt = 0; ; attempt++)
    {
        var response = await http.GetAsync(url, ct);
        if (response.StatusCode != System.Net.HttpStatusCode.TooManyRequests || attempt == 4)
            return response;

        response.Dispose();
        var backoff = TimeSpan.FromMilliseconds(200 * Math.Pow(2, attempt));
        await Task.Delay(backoff, time, ct); // cancellable, testable, holds no thread
    }
}
```

## When to pick `Thread.Sleep`

- **A thread you created and own.** A `new Thread(...)` that polls hardware or a file every second, where nothing else is scheduled on that thread. Blocking it costs nothing that anyone else needs.
- **A synchronous console tool or a script.** A `Main` that is not async and simply needs to pause between steps. There is no pool or UI thread to starve.
- **Deliberately reproducing blocking.** Tests or demos that need to simulate a slow synchronous call, such as the pool starvation probe above.

Even on a dedicated thread, consider `WaitHandle.WaitOne(timeout)` or `CancellationToken.WaitHandle.WaitOne(timeout)` instead. It waits for the same interval but returns early when someone asks the thread to stop, which `Thread.Sleep` cannot do:

```csharp
// .NET 10, C# 14: a dedicated worker thread that can be stopped promptly
void PollLoop(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
    {
        PollDevice();
        ct.WaitHandle.WaitOne(TimeSpan.FromSeconds(1)); // returns immediately on Cancel()
    }
}
```

## When to pick `SpinWait`

- **Lock-free retry loops.** A compare-and-swap loop that failed because another thread is mid-update. The other thread will finish in nanoseconds, so a context switch would cost more than the wait.
- **The fast path of your own synchronization primitive.** Spin a few times with `SpinOnce()` while `NextSpinWillYield` is false, then fall back to a real blocking wait. This is the same structure `ManualResetEventSlim` uses internally.

```csharp
// .NET 10, C# 14: spin briefly, then block
var spinner = new SpinWait();
while (!IsReady())
{
    if (spinner.NextSpinWillYield)
    {
        readyEvent.Wait(); // stop spinning, let the OS park the thread
        break;
    }
    spinner.SpinOnce();
}
```

Do not use `SpinWait` for waits measured in milliseconds, and do not use `Thread.SpinWait(n)` directly with a large `n`. The [`SpinWait` documentation](https://learn.microsoft.com/dotnet/api/system.threading.spinwait) positions it as a low-level building block for synchronization code, and spinning only pays off when the expected wait is shorter than the cost of a context switch. If you are not writing a lock-free data structure or a synchronization primitive, you probably do not need it. The post on [`lock` vs `Monitor` vs `SemaphoreSlim` vs `System.Threading.Lock`](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) covers the higher-level primitives that already do this spinning for you.

## The gotcha that picks for you: are you waiting for time or for an event?

Most `Thread.Sleep` and `Task.Delay` calls I see in code reviews are not really timed waits. They are polling loops: "sleep 100 ms, check if the job finished, repeat". That pattern always loses on both axes. It adds up to one interval of latency after the event, and it wakes up for nothing in the meantime.

If another part of your program causes the event, signal it directly:

```csharp
// .NET 10, C# 14: replace "while (!done) await Task.Delay(100);"
var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

_ = Task.Run(async () =>
{
    await DoWorkAsync();
    completion.TrySetResult();
});

await completion.Task.WaitAsync(TimeSpan.FromSeconds(30)); // a real timeout, no polling
```

`RunContinuationsAsynchronously` keeps the code that awaits `completion.Task` from running inline on the thread that calls `TrySetResult`. `WaitAsync(TimeSpan)` (.NET 6+) gives you the timeout without a hand-rolled `Task.WhenAny(task, Task.Delay(...))`. For producer/consumer handoffs use a `Channel<T>`, and for "at most N at once" use `SemaphoreSlim.WaitAsync`. Only poll when the event happens outside your process and nothing can notify you, such as a remote job status endpoint. Then `await Task.Delay` with a `CancellationToken` is the right poll interval.

## Recommendation

Default to `await Task.Delay(interval, cancellationToken)`. It holds no thread, uses no CPU, can be cancelled, and with a `TimeProvider` it can be tested without real waiting. In the measurement above it finished 200 one-second waits in 1 second, where `Thread.Sleep` took 18 seconds and stalled unrelated work for 17 of them.

Use `Thread.Sleep` only on a thread that nothing else shares, and prefer a cancellable `WaitHandle.WaitOne(timeout)` even there. Use `SpinWait` only for waits shorter than a context switch inside lock-free or synchronization code; for anything longer it degrades into a `Sleep(1)` loop anyway. And before you choose any of them, ask whether you are waiting for time or for something to happen. If it is the latter, a `TaskCompletionSource`, `ManualResetEventSlim`, `SemaphoreSlim`, or `Channel<T>` will wake you up about 50 times sooner.

### Read next

- [How to time out an async operation with `CancellationTokenSource.CancelAfter`](/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)
- [How to cancel a long-running task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [`Task.Run` vs `Task.Factory.StartNew` vs `ThreadPool.QueueUserWorkItem`](/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/)
- [`Volatile.Read` vs `Volatile.ReadBarrier` in .NET 10](/2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10/)

### Sources

- [`Thread.Sleep` API reference](https://learn.microsoft.com/dotnet/api/system.threading.thread.sleep), Microsoft Learn
- [`Task.Delay` API reference](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.delay), including the note on system clock resolution
- [`SpinWait` API reference](https://learn.microsoft.com/dotnet/api/system.threading.spinwait), Microsoft Learn
- [`SpinWait.cs` at v10.0.0](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Threading/SpinWait.cs), dotnet/runtime
- [Debug thread pool starvation](https://learn.microsoft.com/dotnet/core/diagnostics/debug-threadpool-starvation), .NET diagnostics docs
- [`TimeProvider` overview](https://learn.microsoft.com/dotnet/standard/datetime/timeprovider-overview), Microsoft Learn
