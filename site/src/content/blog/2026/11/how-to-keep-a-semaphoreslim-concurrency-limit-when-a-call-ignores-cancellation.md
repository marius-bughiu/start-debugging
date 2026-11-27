---
title: "How to keep a SemaphoreSlim concurrency limit when an async call ignores its CancellationToken and hangs"
description: "A timeout around a call that ignores cancellation does not stop it. Releasing the SemaphoreSlim on timeout breaks the limit, releasing on completion deadlocks. Measured on .NET 11: why both fail, and the three fixes that work (abort below the client, a zombie budget, process isolation)."
pubDate: 2026-11-27
tags:
  - "dotnet"
  - "csharp"
  - "async"
  - "concurrency"
  - "httpclient"
---

**Short answer:** in .NET 11 there is no way to stop a `Task` from the outside. `Task.WhenAny` with a delay, `Task.WaitAsync(timeout)` and a cancelled token all stop *your wait*; the operation keeps running and keeps its socket. So with a `SemaphoreSlim` you have to choose: release the permit on timeout and the real concurrency grows without bound (21 open connections against a limit of 5 in the run below), or release it when the work actually ends and the pipeline deadlocks once every permit is held by a hung call. The fixes that work are (1) make the call really stop by enforcing the deadline *below* the client, for example a `DelegatingHandler` that cancels the HTTP request, (2) keep the permit for abandoned calls but give them a budget and fail fast when it is spent, then recycle, or (3) run the call in a child process and kill it on timeout, which is the only general way to get the resources back. `ControlledExecution.Run` is not a fix: in this test it wedged the whole process.

This came up in [a Stack Overflow question](https://stackoverflow.com/questions/80019004) about a third-party async API that sometimes hangs forever and ignores its `CancellationToken`. The asker caps concurrency at five with a `SemaphoreSlim`, wraps the call in `Task.WhenAny(work, Task.Delay(5000))`, and finds that both places to call `Release()` are wrong. The only answer explains in prose why there is no idiomatic fix and suggests process isolation. This post reproduces the problem with a real hanging HTTP server, measures each strategy (including the ones that fail), and gives code for the three that hold up. Everything below ran on .NET 11.0.0 (SDK 11.0.100, C# 15) on macOS 27 arm64.

## Why a timeout cannot stop the task

A `Task` is a promise, not a thread handle. It has no `Abort`, no `Kill`, and no way for a caller to force it into a completed state. Cancellation in .NET is cooperative: a `CancellationToken` is a flag the operation is supposed to check, and an operation that never looks at it is not affected by it at all.

Every timeout primitive you can put *around* a call works on the waiter:

- `Task.WhenAny(work, Task.Delay(t))` returns when either finishes. `work` is untouched.
- `work.WaitAsync(t)` throws `TimeoutException` after `t`. The [docs](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync) are explicit that this does not cancel the underlying operation.
- Cancelling a `CancellationTokenSource` whose token the operation ignores does nothing to the operation.

That is the whole root cause. If a third-party `ExecuteAsync` opens a socket, sends a request, and then awaits a response that never comes, the state machine is parked on that socket read until the connection dies. Your code moved on; the socket did not. The semaphore was counting the wrong thing: it limits how many *callers are waiting*, not how many *operations are running*, and a timeout makes those two numbers diverge.

## The repro: a client that ignores its token and a server that never answers

To measure this instead of arguing about it, the test harness has three parts:

1. A tiny TCP server on `127.0.0.1` that answers `/ok/*` after 50 ms and, for `/hang/*`, accepts the connection and never sends a byte. It counts open server-side connections, which is the resource that actually leaks.
2. A "third-party" client that wraps `HttpClient` with `Timeout = Timeout.InfiniteTimeSpan` and never passes its `CancellationToken` down. It counts its own in-flight calls.
3. 140 work items, concurrency limit 5, a 1 second timeout. Every item with `itemId % 7 == 3` (20 of them) hangs forever.

The client looks like this (the full harness is at the end of the post):

```csharp
// .NET 11.0.0, C# 15
sealed class ThirdPartyClient(int port, HttpMessageHandler? handler = null)
{
    public static int InFlight, MaxInFlight;
    readonly HttpClient _http = new(handler ?? new SocketsHttpHandler())
    { BaseAddress = new Uri($"http://127.0.0.1:{port}/"), Timeout = Timeout.InfiniteTimeSpan };

    public async Task<string> ExecuteAsync(int itemId, CancellationToken ct) // ct ignored on purpose
    {
        var now = Interlocked.Increment(ref InFlight);
        int max;
        while (now > (max = Volatile.Read(ref MaxInFlight)) && Interlocked.CompareExchange(ref MaxInFlight, now, max) != max) { }
        try
        {
            var path = itemId % 7 == 3 ? "hang" : "ok";
            return await _http.GetStringAsync($"{path}/{itemId}");
        }
        finally { Interlocked.Decrement(ref InFlight); }
    }
}
```

It is a fair stand-in for a real SDK: plenty of client libraries either forget to forward the token to one inner call or set their own long timeout and ignore yours.

## Release in `finally`: the limit is a fiction

This is the asker's code, unchanged apart from the timeout length:

```csharp
// .NET 11.0.0, C# 15
await semaphore.WaitAsync(ct);
try
{
    var work = client.ExecuteAsync(itemId, ct);
    if (await Task.WhenAny(work, Task.Delay(timeout, ct)) != work) throw new TimeoutException();
    await work;
}
finally { semaphore.Release(); }
```

Result:

```text
mode=finally      elapsed=  6.1s ok=120 timeout=20 rejected=  0 stuck/failed=  0 finished=True maxInFlight=21 inFlightNow=20 serverMaxOpen=21 serverOpenNow=20
```

The pipeline never stalls, which is why this version looks fine in a demo. But the client peaked at 21 concurrent calls against a limit of 5, and when the run ended 20 calls were still in flight, holding 20 open TCP connections on the server. Every hang adds one permanent connection. In production that is the socket and port exhaustion the asker described, and if the limit of five exists because the vendor enforces it, you are now over their quota too.

## Release on completion: correct limit, guaranteed deadlock

The asker's second attempt moves `Release()` into a continuation, so the permit comes back only when the call really ends:

```csharp
// .NET 11.0.0, C# 15
await semaphore.WaitAsync(ct);
var work = client.ExecuteAsync(itemId, ct);
_ = work.ContinueWith(_ => semaphore.Release(), TaskScheduler.Default);
await work.WaitAsync(timeout, ct);
```

Result, with a 15 second watchdog cancelling the whole run:

```text
mode=continuewith elapsed= 15.3s ok=27 timeout= 5 rejected=  0 stuck/failed=108 finished=False maxInFlight=5 inFlightNow=5 serverMaxOpen=5 serverOpenNow=5
```

The limit held exactly (never more than five calls, never more than five connections). But the first five hung items took all five permits, 27 calls succeeded before that, and the remaining 108 sat in `WaitAsync` until the watchdog cancelled them. Without the watchdog they would wait forever. This is not a bug in the code; it is the honest consequence of counting hung calls against the limit. Five hangs and you are at zero capacity.

So the question "where do I put `Release()`" has no right answer. Either the limit is violated or the capacity is. The fixes below change the problem instead.

## Fix 1: enforce the deadline below the client so the call really stops

If the hung work is an HTTP request, it can be cancelled at the transport level even when the client library ignores your token. `HttpClient` passes a token into its handler pipeline for every request, and a `DelegatingHandler` can link its own deadline into that token. When it fires, `SocketsHttpHandler` aborts the request and closes the connection, the client's `await` throws, and `ExecuteAsync` completes. The task ends for real, so the plain `finally { Release(); }` is correct again.

```csharp
// .NET 11.0.0, C# 15
sealed class TimeoutHandler(TimeSpan timeout) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try { return await base.SendAsync(request, cts.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        { throw new TimeoutException($"{request.RequestUri} exceeded {timeout.TotalSeconds}s"); }
    }
}

// The client is built with the handler in its pipeline:
var client = new ThirdPartyClient(port, new TimeoutHandler(TimeSpan.FromSeconds(1))
{
    InnerHandler = new SocketsHttpHandler()
});

// ...and the caller goes back to the simple pattern:
await semaphore.WaitAsync(ct);
try { await client.ExecuteAsync(itemId, ct); }
finally { semaphore.Release(); }
```

Result:

```text
mode=handler      elapsed=  6.1s ok=120 timeout=20 rejected=  0 stuck/failed=  0 finished=True maxInFlight=5 inFlightNow=0 serverMaxOpen=5 serverOpenNow=0
```

Same throughput as the `finally` version (6.1 s, 120 successes, 20 timeouts), but the limit held at 5 and zero connections were left open at the end. This is the fix to reach for first, because it is the only one that gives you both the limit and the capacity.

Whether you can apply it depends on the client. Look for any of these:

- A constructor or options overload that accepts an `HttpClient` or `HttpMessageHandler`. Many SDKs have one for testing or proxy support. Azure SDK clients take a custom transport through their client options.
- Registration through `IHttpClientFactory` (`AddHttpClient<T>`), where you can add your own handler with `AddHttpMessageHandler`, or use the attempt and total request timeouts of `AddStandardResilienceHandler`, which work the same way: they cancel the token the inner handler sees. If you go that route, the [Polly vs resilience handlers](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) comparison covers which knob does what.
- A transport-level timeout you can set even if you cannot inject a handler, such as `SocketsHttpHandler.ConnectTimeout` plus a server-side or proxy-side idle timeout.

The same idea applies outside HTTP: a database command timeout, a `NetworkStream.ReadTimeout` on a raw socket, a gRPC deadline. Find the lowest layer that owns the resource and put the deadline there, because that layer can actually release it. If you own the code, the better long-term fix is to [propagate the CancellationToken through every async method](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) so the problem does not exist in the first place.

## Fix 2: count abandoned calls against the limit, and trip when they pile up

When the client is a black box (no handler injection, no transport options), you cannot make the hung call stop. What you can do is stop pretending it stopped. The design that follows keeps the permit with the hung call, so the limit is never exceeded, but caps how many such "zombies" you tolerate. Once the budget is spent, queued and new callers get an immediate `BulkheadRejectedException` instead of waiting forever, and that exception is your signal to recycle the client or the process.

```csharp
// .NET 11.0.0, C# 15
sealed class BulkheadRejectedException(string m) : Exception(m);

sealed class BulkheadWithZombieBudget(int limit, int zombieBudget)
{
    readonly SemaphoreSlim _permits = new(limit);
    readonly CancellationTokenSource _tripped = new();
    int _zombies;
    public int Zombies => Volatile.Read(ref _zombies);

    public async Task RunAsync(Func<CancellationToken, Task> op, TimeSpan timeout, CancellationToken ct)
    {
        using (var wait = CancellationTokenSource.CreateLinkedTokenSource(ct, _tripped.Token))
        {
            try { await _permits.WaitAsync(wait.Token); }
            catch (OperationCanceledException) when (_tripped.IsCancellationRequested && !ct.IsCancellationRequested)
            { throw new BulkheadRejectedException($"{Zombies} abandoned calls hold permits; recycle the client or the process"); }
        }

        Task work;
        try { work = op(ct); }
        catch { _permits.Release(); throw; }

        try
        {
            await work.WaitAsync(timeout, ct);
        }
        catch (Exception ex) when (ex is TimeoutException or OperationCanceledException && !work.IsCompleted)
        {
            // The caller gives up, the permit stays with the still-running call.
            if (Interlocked.Increment(ref _zombies) >= zombieBudget) _tripped.Cancel();
            _ = work.ContinueWith(_ => { Interlocked.Decrement(ref _zombies); _permits.Release(); },
                                  TaskScheduler.Default);
            throw;
        }
        catch { _permits.Release(); throw; }
        _permits.Release();
    }
}
```

The important detail is the `_tripped` token linked into `WaitAsync`. Checking the zombie count only on entry is not enough: in the first version of this harness all 140 callers passed that check at time zero, queued on the semaphore, and deadlocked exactly like the `ContinueWith` version. Cancelling the queued waiters is what turns a stall into a fast failure.

Result with a limit of 5 and a budget of 3:

```text
mode=budget       elapsed=  2.1s ok=27 timeout= 5 rejected=108 stuck/failed=  0 finished=True maxInFlight=5 inFlightNow=5 serverMaxOpen=5 serverOpenNow=5
```

The limit held, and the run finished in 2.1 s with 108 explicit rejections instead of hanging until a watchdog killed it. Note that it tripped at five zombies, not three: the five hung items were all in flight before the first timeout fired, so the budget could not stop calls that had already started. A budget limits *new* exposure, not calls already running. Also note `serverOpenNow=5`: the five zombie connections are still open. This pattern contains the damage; it does not repair it. Pair it with whatever recycling the client allows, such as disposing and recreating the client instance (disposing an `HttpClient` cancels its pending requests, if the library disposes its inner client) or a health check that restarts the worker.

A budget smaller than the limit is the useful setting. With a budget equal to the limit, the trip fires at the same moment capacity hits zero, so you get the error but lose the chance to keep serving with the remaining permits while you recycle.

## Fix 3: process isolation, the only general way to reclaim the socket

When the client is a black box *and* the leaked resources matter, put the call in a process you can kill. The operating system closes every handle a process owned when it exits, sockets included, regardless of what the managed code inside was doing.

```csharp
// .NET 11.0.0, C# 15
static class ChildRunner
{
    public static async Task RunAsync(int itemId, int port, TimeSpan timeout, CancellationToken ct)
    {
        using var p = Process.Start(new ProcessStartInfo(Environment.ProcessPath!, $"child {itemId} {port}")
        { RedirectStandardOutput = true, UseShellExecute = false })!;
        try { await p.WaitForExitAsync(ct).WaitAsync(timeout, ct); }
        catch (Exception ex) when (ex is TimeoutException or OperationCanceledException)
        {
            p.Kill(entireProcessTree: true);
            throw;
        }
        if (p.ExitCode != 0) throw new HttpRequestException($"child exited with {p.ExitCode}");
    }
}

// Caller: the permit is held until the child has exited or been killed.
await semaphore.WaitAsync(ct);
try { await ChildRunner.RunAsync(itemId, port, timeout, ct); }
finally { semaphore.Release(); }
```

Result:

```text
mode=process      elapsed=  7.6s ok=120 timeout=20 rejected=  0 stuck/failed=  0 finished=True maxInFlight=0 inFlightNow=0 serverMaxOpen=5 serverOpenNow=0
```

(`maxInFlight=0` because the client counters live in the children; the server-side numbers are the ones that matter here.) The limit held at 5 open connections and zero were left behind. The cost in this run was 7.6 s instead of 6.1 s for 140 calls, about 1.5 s of extra process start-up spread over five lanes. Starting a process per call is the crude version. In production you would keep a small pool of long-lived worker processes, each running one call at a time, talk to them over stdin/stdout or a named pipe, and kill and replace a worker only when its call times out. That keeps the start-up cost off the hot path and the kill semantics intact.

## Why `ControlledExecution.Run` is not the answer

.NET 7 added `System.Runtime.ControlledExecution.Run(Action, CancellationToken)`, which aborts a thread non-cooperatively, roughly what `Thread.Abort` did on .NET Framework. It is the obvious thing to try, so the harness tried it: each call ran synchronously inside `ControlledExecution.Run(() => client.ExecuteAsync(...).GetAwaiter().GetResult(), cts.Token)` on a thread-pool thread, with the token set to the 1 second timeout.

The call is marked obsolete, and the build says so:

```text
warning SYSLIB0046: 'ControlledExecution.Run(Action, CancellationToken)' is obsolete: 'ControlledExecution.Run method may corrupt the process and should not be used in production code.'
```

The run never finished. A watchdog thread printed the counters every two seconds and then killed the process. Two runs with 140 items printed exactly this (a third run with 40 items stalled the same way after two aborts):

```text
[watchdog 2s] ok=27 timeout=1 failed=0 inFlightNow=5 serverOpenNow=5 poolThreads=15 pending=0
[watchdog 12s] ok=27 timeout=1 failed=0 inFlightNow=5 serverOpenNow=5 poolThreads=15 pending=0
```

One abort succeeded, then nothing in the process made progress again, not even the harness's own 15 second cancellation. A separate probe showed the mechanics: aborting a thread blocked in `GetResult()` on a hung task did throw `OperationCanceledException` after 1 s, aborting a thread in `Thread.Sleep(Timeout.Infinite)` did not abort it at all within 5 s. The [API docs](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.controlledexecution.run) warn that aborting code at an unexpected location "may corrupt the state of data structures in the process", and that is consistent with what happened here, although this test did not track down which lock the abort left behind. Even in the best case, the abort only unblocks the waiting thread: the hung request is an `await` on a socket, not code running on that thread, so the socket stays open. It gives you none of what process isolation gives you and adds a way to hang the whole app.

## Gotchas and variants

- **The leak is not only sockets.** A hung call can also hold a pooled connection, a database transaction, a lock, or a vendor-side rate-limit slot. Fix 1 and Fix 3 release them; Fix 2 only bounds them. Pick based on which resource you cannot afford to leak.
- **`Parallel.ForEachAsync` has the same problem.** Its `MaxDegreeOfParallelism` counts body invocations, so a body that times out and returns frees a slot while the abandoned task keeps running, which is exactly the `finally` case. See [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) for how its limit is applied.
- **Observe the abandoned task's exception.** When a zombie eventually faults, nobody awaits it. The `ContinueWith` in Fix 2 observes it implicitly; if you abandon tasks some other way, attach a continuation that reads `t.Exception`, or `TaskScheduler.UnobservedTaskException` will fire later with no context.
- **Timeouts at both levels need distinct exceptions.** In Fix 1 the handler throws `TimeoutException` while a caller-requested cancellation stays an `OperationCanceledException`. Without that split, retry logic cannot tell "the vendor hung" from "the user went away". The same disambiguation is covered in depth in [how to time out an async operation with CancellationTokenSource.CancelAfter](/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/).
- **`SemaphoreSlim` itself is not the problem.** Any counting primitive, including `System.Threading.RateLimiting.ConcurrencyLimiter`, has the same choice to make about when a lease is returned. If you are choosing between primitives for other reasons, [lock vs Monitor vs SemaphoreSlim vs Lock](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) compares them.
- **Measure the hang before designing around it.** If the client hangs because it never sets a read timeout on its own connection, a proxy or load balancer idle timeout may end the hang from the outside, which turns every option above into the easy case where the task eventually completes.

## The full harness

Save this as `Program.cs` next to a console project targeting `net11.0` (`<Nullable>enable</Nullable>`, `<ImplicitUsings>enable</ImplicitUsings>`), build in Release, and run `bin/Release/net11.0/<name> <mode> [items]` with `mode` one of `finally`, `continuewith`, `handler`, `budget`, `process`, `controlled`. The `controlled` mode is expected to hang; its watchdog kills the process after 12 seconds.

```csharp
// .NET 11.0.0, C# 15 -- SemaphoreSlim vs. calls that ignore their CancellationToken
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;

System.Globalization.CultureInfo.CurrentCulture = System.Globalization.CultureInfo.InvariantCulture;

if (args[0] == "child") { await Child.RunAsync(int.Parse(args[1]), int.Parse(args[2])); return; }

var server = new HangServer();
server.Start();
var mode = args[0];
const int Limit = 5;
var Items = args.Length > 1 ? int.Parse(args[1]) : 140;
var timeout = TimeSpan.FromSeconds(1);
var sw = Stopwatch.StartNew();
int ok = 0, timedOut = 0, rejected = 0, failed = 0;

var client = mode == "handler"
    ? new ThirdPartyClient(server.Port, new TimeoutHandler(timeout) { InnerHandler = new SocketsHttpHandler() })
    : new ThirdPartyClient(server.Port);
var guard = mode == "budget" ? new BulkheadWithZombieBudget(Limit, zombieBudget: 3) : null;
var semaphore = new SemaphoreSlim(Limit);

async Task ProcessAsync(int itemId, CancellationToken ct)
{
    try
    {
        switch (mode)
        {
            case "finally": // the question's code
                await semaphore.WaitAsync(ct);
                try
                {
                    var work = client.ExecuteAsync(itemId, ct);
                    if (await Task.WhenAny(work, Task.Delay(timeout, ct)) != work) throw new TimeoutException();
                    await work;
                }
                finally { semaphore.Release(); }
                break;

            case "continuewith": // release only when the work really ends
                await semaphore.WaitAsync(ct);
                var w = client.ExecuteAsync(itemId, ct);
                _ = w.ContinueWith(_ => semaphore.Release(), TaskScheduler.Default);
                await w.WaitAsync(timeout, ct);
                break;

            case "handler": // the timeout is enforced inside the HTTP pipeline
                await semaphore.WaitAsync(ct);
                try { await client.ExecuteAsync(itemId, ct); }
                finally { semaphore.Release(); }
                break;

            case "budget":
                await guard!.RunAsync(t => client.ExecuteAsync(itemId, t), timeout, ct);
                break;

            case "controlled": // ControlledExecution.Run aborts the thread, not the socket
                await semaphore.WaitAsync(ct);
                try
                {
                    using var cts = new CancellationTokenSource(timeout);
                    await Task.Run(() =>
                    {
#pragma warning disable SYSLIB0046
                        try { System.Runtime.ControlledExecution.Run(() => client.ExecuteAsync(itemId, ct).GetAwaiter().GetResult(), cts.Token); }
#pragma warning restore SYSLIB0046
                        catch (OperationCanceledException) { throw new TimeoutException(); }
                    });
                }
                finally { semaphore.Release(); }
                break;

            case "process":
                await semaphore.WaitAsync(ct);
                try { await ChildRunner.RunAsync(itemId, server.Port, timeout, ct); }
                finally { semaphore.Release(); }
                break;
        }
        Interlocked.Increment(ref ok);
    }
    catch (TimeoutException) { Interlocked.Increment(ref timedOut); }
    catch (BulkheadRejectedException) { Interlocked.Increment(ref rejected); }
    catch (Exception ex) when (ex is OperationCanceledException or HttpRequestException)
    { Interlocked.Increment(ref failed); }
    catch (Exception ex) { Console.WriteLine($"item {itemId}: {ex.GetType().Name}: {ex.Message}"); Interlocked.Increment(ref failed); }
}

if (mode == "controlled")
    new Thread(() =>
    {
        for (var i = 1; i <= 6; i++)
        {
            Thread.Sleep(2000);
            var line = $"[watchdog {i * 2}s] ok={ok} timeout={timedOut} failed={failed} inFlightNow={ThirdPartyClient.InFlight} serverOpenNow={server.Open} poolThreads={ThreadPool.ThreadCount} pending={ThreadPool.PendingWorkItemCount}\n";
            using var err = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(2, false), FileAccess.Write);
            err.Write(Encoding.ASCII.GetBytes(line));
        }
        Environment.FailFast("watchdog");
    }) { IsBackground = true }.Start();

using var runCts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
var all = Task.WhenAll(Enumerable.Range(0, Items).Select(i => ProcessAsync(i, runCts.Token)));
try { await all; } catch { }
var allDone = all.IsCompleted && !runCts.IsCancellationRequested;
await Task.Delay(300); // let socket teardown settle before sampling
Console.WriteLine($"mode={mode,-12} elapsed={sw.Elapsed.TotalSeconds,5:F1}s ok={ok,2} timeout={timedOut,2} rejected={rejected,3} stuck/failed={failed,3} " +
    $"finished={allDone} maxInFlight={ThirdPartyClient.MaxInFlight} inFlightNow={ThirdPartyClient.InFlight} " +
    $"serverMaxOpen={server.MaxOpen} serverOpenNow={server.Open}");

// A "third-party" client: wraps HttpClient, never forwards the CancellationToken, no timeout.
sealed class ThirdPartyClient(int port, HttpMessageHandler? handler = null)
{
    public static int InFlight, MaxInFlight;
    readonly HttpClient _http = new(handler ?? new SocketsHttpHandler())
    { BaseAddress = new Uri($"http://127.0.0.1:{port}/"), Timeout = Timeout.InfiniteTimeSpan };

    public async Task<string> ExecuteAsync(int itemId, CancellationToken ct) // ct ignored on purpose
    {
        var now = Interlocked.Increment(ref InFlight);
        int max;
        while (now > (max = Volatile.Read(ref MaxInFlight)) && Interlocked.CompareExchange(ref MaxInFlight, now, max) != max) { }
        try
        {
            var path = itemId % 7 == 3 ? "hang" : "ok"; // items 3, 10, 17, 24, 31, 38... hang forever
            return await _http.GetStringAsync($"{path}/{itemId}");
        }
        finally { Interlocked.Decrement(ref InFlight); }
    }
}

// Enforces a per-request deadline below the client, so the hung request is really aborted.
sealed class TimeoutHandler(TimeSpan timeout) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try { return await base.SendAsync(request, cts.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        { throw new TimeoutException($"{request.RequestUri} exceeded {timeout.TotalSeconds}s"); }
    }
}

sealed class BulkheadRejectedException(string m) : Exception(m);

// A timed-out call keeps its permit until it truly finishes (a "zombie"), so the limit is never
// exceeded. Once zombies reach the budget the bulkhead trips and queued callers fail fast.
sealed class BulkheadWithZombieBudget(int limit, int zombieBudget)
{
    readonly SemaphoreSlim _permits = new(limit);
    readonly CancellationTokenSource _tripped = new();
    int _zombies;
    public int Zombies => Volatile.Read(ref _zombies);

    public async Task RunAsync(Func<CancellationToken, Task> op, TimeSpan timeout, CancellationToken ct)
    {
        using (var wait = CancellationTokenSource.CreateLinkedTokenSource(ct, _tripped.Token))
        {
            try { await _permits.WaitAsync(wait.Token); }
            catch (OperationCanceledException) when (_tripped.IsCancellationRequested && !ct.IsCancellationRequested)
            { throw new BulkheadRejectedException($"{Zombies} abandoned calls hold permits; recycle the client or the process"); }
        }

        Task work;
        try { work = op(ct); }
        catch { _permits.Release(); throw; }

        try
        {
            await work.WaitAsync(timeout, ct);
        }
        catch (Exception ex) when (ex is TimeoutException or OperationCanceledException && !work.IsCompleted)
        {
            if (Interlocked.Increment(ref _zombies) >= zombieBudget) _tripped.Cancel();
            _ = work.ContinueWith(_ => { Interlocked.Decrement(ref _zombies); _permits.Release(); },
                                  TaskScheduler.Default);
            throw;
        }
        catch { _permits.Release(); throw; }
        _permits.Release();
    }
}

// Process isolation: the call runs in a child process that is killed on timeout, so the OS closes its sockets.
static class ChildRunner
{
    public static async Task RunAsync(int itemId, int port, TimeSpan timeout, CancellationToken ct)
    {
        using var p = Process.Start(new ProcessStartInfo(Environment.ProcessPath!, $"child {itemId} {port}")
        { RedirectStandardOutput = true, UseShellExecute = false })!;
        try { await p.WaitForExitAsync(ct).WaitAsync(timeout, ct); }
        catch (Exception ex) when (ex is TimeoutException or OperationCanceledException)
        {
            p.Kill(entireProcessTree: true);
            throw;
        }
        if (p.ExitCode != 0) throw new HttpRequestException($"child exited with {p.ExitCode}");
    }
}

static class Child
{
    public static async Task RunAsync(int itemId, int port)
    {
        var client = new ThirdPartyClient(port);
        Console.WriteLine(await client.ExecuteAsync(itemId, CancellationToken.None));
    }
}

// Tiny HTTP/1.1 server: /ok/* answers after 50 ms, /hang/* accepts and never answers.
sealed class HangServer
{
    readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;
    public int Open, MaxOpen;

    public void Start()
    {
        _listener.Start(512);
        _ = Task.Run(async () =>
        {
            while (true) { var s = await _listener.AcceptSocketAsync(); _ = HandleAsync(s); }
        });
    }

    async Task HandleAsync(Socket s)
    {
        var now = Interlocked.Increment(ref Open);
        int max;
        while (now > (max = Volatile.Read(ref MaxOpen)) && Interlocked.CompareExchange(ref MaxOpen, now, max) != max) { }
        try
        {
            var buf = new byte[4096];
            var n = await s.ReceiveAsync(buf);
            var head = Encoding.ASCII.GetString(buf, 0, n);
            if (head.Contains(" /hang/"))
            {
                while (await s.ReceiveAsync(buf) > 0) { } // hold the connection until the peer closes it
                return;
            }
            await Task.Delay(50);
            await s.SendAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"));
            s.Shutdown(SocketShutdown.Both);
        }
        catch (SocketException) { }
        finally { s.Dispose(); Interlocked.Decrement(ref Open); }
    }
}
```

All numbers in this post come from single runs of this file on one machine (Apple Silicon, macOS 27, .NET 11.0.0), apart from the `controlled` mode, which was run three times with the same outcome. Timings will differ on other hardware; the in-flight and open-connection counts are deterministic for this input.

## Read next

- [How to time out an async operation with CancellationTokenSource.CancelAfter in C#](/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)
- [How to propagate a CancellationToken through async methods in .NET 11](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [Polly vs resilience handlers in .NET 11](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/)
- [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll in C#](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/)
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock in C#](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)

## Sources

- [Stack Overflow: hard timeout for async operations with SemaphoreSlim without leakage](https://stackoverflow.com/questions/80019004)
- [Task.WaitAsync (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync)
- [ControlledExecution.Run (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.controlledexecution.run)
- [SYSLIB0046 obsoletion warning](https://learn.microsoft.com/en-us/dotnet/fundamentals/syslib-diagnostics/syslib0046)
- [DelegatingHandler (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.delegatinghandler)
- [Cancellation in managed threads](https://learn.microsoft.com/en-us/dotnet/standard/threading/cancellation-in-managed-threads)
- [Build resilient HTTP apps with Microsoft.Extensions.Http.Resilience](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience)
