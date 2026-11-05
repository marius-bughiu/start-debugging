---
title: "Why is the first limiter in PartitionedRateLimiter.CreateChained called twice per request?"
description: "ChainedPartitionedRateLimiter walks each limiter once, but the ASP.NET Core rate limiting middleware calls the chain twice when the first pass fails: AttemptAcquire, then AcquireAsync. With fixed window or token bucket limiters a rejected request burns two permits from the first limiter, and a queued request does too. Reproduced on ASP.NET Core 10.0.10 and 11.0 RC3, with a wrapper that makes the middleware walk the chain once."
pubDate: 2026-11-05
tags:
  - "aspnetcore"
  - "dotnet"
  - "rate-limiting"
  - "csharp"
---

**Short answer:** the chain is not the one calling twice. `ChainedPartitionedRateLimiter` walks its limiters exactly once per call. The ASP.NET Core rate limiting middleware is what calls the chain twice: it first tries the synchronous `AttemptAcquire`, and if that lease is not acquired, it always tries again with `AcquireAsync` so queueing limiters get a chance. The first limiter in the chain grants a permit on the first pass, the second limiter rejects, the chain disposes the first lease, and then the whole walk starts over. With a `ConcurrencyLimiter` that is harmless, because disposing the lease gives the permit back. With a fixed window, sliding window or token bucket limiter, disposing a lease returns nothing, so every request rejected by a later limiter (and every request that has to queue on a later limiter) costs two permits from the first one, and the partition delegate runs twice. The fixes are to order the chain so the limiter most likely to reject comes first, or to wrap the chain so the middleware only ever goes through `AcquireAsync`.

Everything below was run for this post on macOS 27.0 (Apple M4, arm64) against two runtimes: ASP.NET Core 10.0.10 with the .NET 10 SDK 10.0.302, and ASP.NET Core 11.0.0 RC3 with SDK 11.0.100-rc.3.26522.148. Both produced identical output. The source excerpts come from the `main` branches of [dotnet/runtime](https://github.com/dotnet/runtime) and [dotnet/aspnetcore](https://github.com/dotnet/aspnetcore) as of November 2026.

## What the chained limiter actually does

`PartitionedRateLimiter.CreateChained` returns an internal `ChainedPartitionedRateLimiter<TResource>`. Its synchronous path is a plain loop:

```csharp
// dotnet/runtime, main, ChainedPartitionedRateLimiter.cs (trimmed)
protected override RateLimitLease AttemptAcquireCore(TResource resource, int permitCount)
{
    RateLimitLease[]? leases = null;
    for (int i = 0; i < _limiters.Length; i++)
    {
        RateLimitLease? lease = null;
        Exception? exception = null;
        try
        {
            lease = _limiters[i].AttemptAcquire(resource, permitCount);
        }
        catch (Exception ex)
        {
            exception = ex;
        }

        RateLimitLease? notAcquiredLease =
            ChainedRateLimiterShared.CommonAcquireLogic(exception, lease, ref leases, i, _limiters.Length);
        if (notAcquiredLease is not null)
        {
            return notAcquiredLease;
        }
    }
    return new CombinedRateLimitLease(leases!);
}
```

`AcquireAsyncCore` is the same loop with `await _limiters[i].AcquireAsync(...)`. The class comment describes the contract: limiters are tried in order, and if one fails, "the already acquired leases are disposed in reverse order and the failing lease is returned". Nothing here calls a limiter twice. One call to the chain means one call per limiter, stopping at the first rejection.

Two details of that contract matter later:

1. A limiter later in the chain is only consulted after every earlier limiter granted its permit.
2. A failure "rolls back" the earlier leases by disposing them. Whether disposal actually returns anything depends on the limiter type.

## The middleware calls the chain twice

`RateLimitingMiddleware` in `Microsoft.AspNetCore.RateLimiting` acquires a lease like this:

```csharp
// dotnet/aspnetcore, main, RateLimitingMiddleware.cs (trimmed)
private async ValueTask<LeaseContext> TryAcquireAsync(HttpContext context, MetricsContext metricsContext)
{
    var leaseContext = CombinedAcquire(context);          // AttemptAcquire on global, then endpoint
    if (leaseContext.Lease?.IsAcquired == true)
    {
        return leaseContext;
    }

    var waitTask = CombinedWaitAsync(context, context.RequestAborted);   // AcquireAsync on global, then endpoint
    if (waitTask.IsCompleted)
    {
        return await waitTask;
    }
    // ... queue metrics, then await waitTask
}
```

`CombinedAcquire` calls `_globalLimiter.AttemptAcquire(context)` and then the endpoint limiter's `AttemptAcquire`. If either returns a lease with `IsAcquired == false`, the result is not treated as a rejection. The middleware falls through to `CombinedWaitAsync`, which calls `AcquireAsync` on the same limiters. That design makes sense in isolation: `AttemptAcquire` never queues, so the only way to let a limiter with `QueueLimit > 0` hold a request is to try the async path. The fast path is just an optimization for the common "permit available" case.

The middleware does not know or care that its global limiter is a chain. So on any request where the synchronous pass fails, the sequence is:

1. Middleware calls `chain.AttemptAcquire`. Limiter 0 grants a permit. Limiter 1 rejects. The chain disposes limiter 0's lease and returns the rejection.
2. Middleware ignores that rejection and calls `chain.AcquireAsync`. Limiter 0 is asked again and grants another permit (if it has one). Limiter 1 is asked again.

That is why the first limiter's partition delegate shows up twice in logs or breakpoints. The second limiter is called twice too, but its double call is rarely visible because a rejecting limiter does not consume anything.

## Why the double call burns permits

The double call alone would only be a bit of wasted work. The real problem is step 1's rollback. `ConcurrencyLimiter` leases release their permits when disposed, so for a concurrency limiter the rollback is real. `FixedWindowRateLimiter`, `SlidingWindowRateLimiter` and `TokenBucketRateLimiter` count permits per window or per refill period: once a permit is handed out, disposing the lease does not put it back. The "rollback" in the chain is a no-op for them.

Put that together with the middleware's second pass and you get a per-client fixed window limiter that drains twice as fast as configured whenever the global limiter is saturated.

## Reproducing it with the real middleware

This is the whole program. It runs Kestrel on a random loopback port, chains a per-client fixed window (5 per minute) in front of a global fixed window (2 per minute), counts how often each partition delegate runs, and reads the per-client limiter's statistics after every request.

```csharp
// .NET 10 (ASP.NET Core 10.0.10) and .NET 11 RC3, C# 14
// repro.csproj: <Project Sdk="Microsoft.NET.Sdk.Web">, TargetFramework net10.0 or net11.0,
// ImplicitUsings and Nullable enabled.
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

var scenario = args.Length > 0 ? args[0] : "burn";
int perClientCalls = 0, globalCalls = 0;

static string Client(HttpContext c) => c.Request.Headers["X-Client"].ToString();

// Limiter 0: per client, 5 requests per minute.
var perClient = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
{
    Interlocked.Increment(ref perClientCalls);
    return RateLimitPartition.GetFixedWindowLimiter(Client(ctx), _ => new FixedWindowRateLimiterOptions
    {
        PermitLimit = 5, Window = TimeSpan.FromMinutes(1), QueueLimit = 0
    });
});

// Limiter 1: whole app, 2 requests per minute (or a concurrency limiter with a queue).
var global = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
{
    Interlocked.Increment(ref globalCalls);
    return scenario == "queue"
        ? RateLimitPartition.GetConcurrencyLimiter("all", _ => new ConcurrencyLimiterOptions
            { PermitLimit = 1, QueueLimit = 10, QueueProcessingOrder = QueueProcessingOrder.OldestFirst })
        : RateLimitPartition.GetFixedWindowLimiter("all", _ => new FixedWindowRateLimiterOptions
            { PermitLimit = 2, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 });
});

PartitionedRateLimiter<HttpContext> chain = scenario == "order"
    ? PartitionedRateLimiter.CreateChained(global, perClient)
    : PartitionedRateLimiter.CreateChained(perClient, global);
if (scenario == "fixed") chain = new AsyncOnlyPartitionedRateLimiter<HttpContext>(chain);

var builder = WebApplication.CreateBuilder();
builder.Logging.ClearProviders();
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddRateLimiter(o =>
{
    o.GlobalLimiter = chain;
    o.RejectionStatusCode = 429;
});
var app = builder.Build();
app.UseRateLimiter();
app.MapGet("/", async () => { if (scenario == "queue") await Task.Delay(200); return "ok"; });
await app.StartAsync();

var http = new HttpClient { BaseAddress = new Uri(app.Urls.First()) };
var probe = new DefaultHttpContext();
probe.Request.Headers["X-Client"] = "alice";

Console.WriteLine($"Scenario: {scenario}, runtime {Environment.Version}");
if (scenario == "queue")
{
    // Three concurrent requests from alice: the 2nd and 3rd must queue on the concurrency limiter.
    var tasks = Enumerable.Range(1, 3).Select(async i =>
    {
        var req = new HttpRequestMessage(HttpMethod.Get, "/");
        req.Headers.Add("X-Client", "alice");
        var r = await http.SendAsync(req);
        return (i, (int)r.StatusCode);
    }).ToArray();
    foreach (var (i, code) in await Task.WhenAll(tasks)) Console.WriteLine($"request {i}: {code}");
    Console.WriteLine($"alice permits left: {perClient.GetStatistics(probe)!.CurrentAvailablePermits} of 5 after 3 requests");
}
else
{
    for (int i = 1; i <= 5; i++)
    {
        int pc0 = perClientCalls, gc0 = globalCalls;
        var req = new HttpRequestMessage(HttpMethod.Get, "/");
        req.Headers.Add("X-Client", "alice");
        var r = await http.SendAsync(req);
        Console.WriteLine($"request {i}: {(int)r.StatusCode}  perClient partitioner +{perClientCalls - pc0}, " +
            $"global partitioner +{globalCalls - gc0}, alice permits left {perClient.GetStatistics(probe)!.CurrentAvailablePermits}");
    }
}
await app.StopAsync();
```

The `AsyncOnlyPartitionedRateLimiter<T>` class used by the `fixed` scenario is shown in the fix section below; paste it at the bottom of the same file. Run each scenario with `dotnet run -c Release -- <scenario>`.

### Scenario "burn": per-client first, global second

```text
Scenario: burn, runtime 10.0.10
request 1: 200  perClient partitioner +1, global partitioner +1, alice permits left 4
request 2: 200  perClient partitioner +1, global partitioner +1, alice permits left 3
request 3: 429  perClient partitioner +2, global partitioner +2, alice permits left 1
request 4: 429  perClient partitioner +2, global partitioner +1, alice permits left 0
request 5: 429  perClient partitioner +2, global partitioner +0, alice permits left 0
```

Request 3 is the interesting one. The global window is already full, so the request is rejected, yet alice's budget drops from 3 to 1. Both passes of the middleware took a permit from her fixed window, then the global limiter rejected both times. Request 4 takes her last permit on the synchronous pass, and the async pass is rejected by her own limiter, which is why the global partitioner only runs once. By request 5 alice is locked out of her own quota for the rest of the minute, even though only two of her requests were ever served. The .NET 11 RC3 run (`runtime 11.0.0`) printed the same five lines.

### Scenario "queue": the double charge also hits successful requests

Here the second limiter is a `ConcurrencyLimiter` with one permit and a queue of 10, and three requests from alice arrive at the same time:

```text
Scenario: queue, runtime 10.0.10
request 1: 200
request 2: 200
request 3: 200
alice permits left: 0 of 5 after 3 requests
```

All three requests succeeded, and five permits are gone. Request 1 got through on the synchronous pass and cost one. Requests 2 and 3 failed `AttemptAcquire` on the concurrency limiter (the synchronous path never queues), which burned one fixed window permit each, then queued successfully through `AcquireAsync`, which burned a second one each. This is the variant that is hard to spot in production: nothing is rejected, the per-client limit simply behaves as if it were set to roughly half its value whenever the global limiter is busy.

## How to stop the double charge

### Fix 1: make the middleware use only AcquireAsync

The middleware treats a failed synchronous lease as "try the async path", so a wrapper that never satisfies `AttemptAcquire` turns the two passes into one. For limiters with `QueueLimit = 0` the async path completes synchronously anyway, so the cost is a `ValueTask` wrapper per request.

```csharp
// .NET 10 / .NET 11, C# 14
// Makes RateLimitingMiddleware walk the chain once, through AcquireAsync.
sealed class AsyncOnlyPartitionedRateLimiter<T>(PartitionedRateLimiter<T> inner) : PartitionedRateLimiter<T>
{
    public override RateLimiterStatistics? GetStatistics(T resource) => inner.GetStatistics(resource);

    protected override RateLimitLease AttemptAcquireCore(T resource, int permitCount) => NotAttemptedLease.Instance;

    protected override ValueTask<RateLimitLease> AcquireAsyncCore(T resource, int permitCount, CancellationToken cancellationToken)
        => inner.AcquireAsync(resource, permitCount, cancellationToken);

    protected override void Dispose(bool disposing) { if (disposing) inner.Dispose(); }
    protected override ValueTask DisposeAsyncCore() => inner.DisposeAsync();

    private sealed class NotAttemptedLease : RateLimitLease
    {
        public static readonly NotAttemptedLease Instance = new();
        public override bool IsAcquired => false;
        public override IEnumerable<string> MetadataNames => [];
        public override bool TryGetMetadata(string metadataName, out object? metadata) { metadata = null; return false; }
    }
}
```

Register it as `o.GlobalLimiter = new AsyncOnlyPartitionedRateLimiter<HttpContext>(PartitionedRateLimiter.CreateChained(perClient, global));`. The same five sequential requests now cost one permit each:

```text
Scenario: fixed, runtime 10.0.10
request 1: 200  perClient partitioner +1, global partitioner +1, alice permits left 4
request 2: 200  perClient partitioner +1, global partitioner +1, alice permits left 3
request 3: 429  perClient partitioner +1, global partitioner +1, alice permits left 2
request 4: 429  perClient partitioner +1, global partitioner +1, alice permits left 1
request 5: 429  perClient partitioner +1, global partitioner +1, alice permits left 0
```

Each partition delegate now runs once per request. Two caveats:

- The wrapper deliberately lies from `AttemptAcquire`. Only hand it to the middleware. Any other code that calls `AttemptAcquire` on it will see every request rejected.
- It fixes the double charge, not the chain's rollback semantics. Request 3 still costs alice one permit even though the global limiter rejected it, because a fixed window cannot give a permit back. That is how `CreateChained` behaves with window-based limiters regardless of the middleware.

Reading `CombinedAcquire`, the wrapper should also fix the same double pass when you combine a `GlobalLimiter` with an endpoint policy from `[EnableRateLimiting]` or `RequireRateLimiting`. `CombinedAcquire` treats those two exactly like a two-element chain: if the endpoint limiter rejects synchronously, the global lease is disposed and both are asked again on the async path. Because the wrapped global limiter fails `AttemptAcquire` immediately, the endpoint limiter's synchronous call is never reached and both run once. That global-plus-endpoint combination follows from the source; the repro above only exercises a chained `GlobalLimiter`.

### Fix 2: put the limiter most likely to reject first

A permit is only burned when an earlier limiter grants and a later one rejects. If the first limiter rejects, nothing was granted, and the second pass rejects at the same place for free. Reversing the chain in the repro (`CreateChained(global, perClient)`) gives:

```text
Scenario: order, runtime 10.0.10
request 1: 200  perClient partitioner +1, global partitioner +1, alice permits left 4
request 2: 200  perClient partitioner +1, global partitioner +1, alice permits left 3
request 3: 429  perClient partitioner +0, global partitioner +2, alice permits left 3
request 4: 429  perClient partitioner +0, global partitioner +2, alice permits left 3
request 5: 429  perClient partitioner +0, global partitioner +2, alice permits left 3
```

Alice keeps her three permits, and the global limiter's delegate still runs twice per rejection, which is the harmless kind of double call. The trade-off moves rather than disappears: now a request rejected by the per-client limiter burns two permits from the global window. Ordering works well when one limiter is clearly the bottleneck. It does not work when either limiter can be the one that says no.

### Fix 3: put a concurrency limiter first

If the first limiter is a `ConcurrencyLimiter`, the rollback is real: the disposed lease returns its permit before the async pass, so the double call costs nothing. This only helps when "requests in flight" is the limit you actually want for that tier.

## Gotchas and edge cases

- **Side effects in the partition delegate run twice.** `PartitionedRateLimiter.Create` calls your delegate on every `AttemptAcquire` and `AcquireAsync`; the factory inside `RateLimitPartition.GetFixedWindowLimiter` runs only once per key, but the outer lambda does not. If it logs, increments a metric, resolves a scoped service, or hits a cache, expect two invocations on any request that fails the synchronous pass. Keep the delegate pure and cheap, and do your counting in `OnRejected` or with the middleware's built-in `aspnetcore.rate_limiting.*` metrics instead.
- **Successful requests are affected when a later limiter queues.** The "queue" scenario above returned 200 three times and still charged five permits. If you chain a queueing limiter behind a window-based one, assume the window drains up to twice as fast under load.
- **`GetStatistics` on a chain does not show it.** The chained limiter reports the lowest `CurrentAvailablePermits` across its limiters and the innermost limiter's `TotalSuccessfulLeases`. To see the burn, query the individual limiters you passed to `CreateChained`, as the repro does.
- **The third-party advice that "the quota is not consumed twice" is only true for concurrency limiters.** It is easy to find claims that the double invocation is cosmetic. The repro shows it is cosmetic for `ConcurrencyLimiter` and real for fixed window limiters. The same reasoning applies to sliding window and token bucket limiters, since their leases also return nothing on dispose, but only the fixed window case was executed for this post.
- **This is not specific to .NET 10.** The middleware's attempt-then-wait structure and the chain's loop are the same on the current `main` branches, and the .NET 11 RC3 run matched .NET 10.0.10 line for line.

## Related

- The basics of policies, partitions and `OnRejected` are in [how to add per-endpoint rate limiting in ASP.NET Core 11](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/).
- Why the async path costs almost nothing when it completes synchronously: [what ValueTask is and when it is worth it](/2026/06/what-is-valuetask-and-when-is-it-worth-it/).
- Where rate limiting sits relative to other request processing: [endpoint filters vs middleware in ASP.NET Core 11](/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/).
- If the wrapper's `DisposeAsyncCore` override looks unfamiliar, see [how to implement and consume IAsyncDisposable](/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/).
- The client side of a 429: [Polly vs the built-in resilience handlers in .NET 11](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/).

## Sources

- [`ChainedPartitionedRateLimiter.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Threading.RateLimiting/src/System/Threading/RateLimiting/ChainedPartitionedRateLimiter.cs) in dotnet/runtime.
- [`RateLimitingMiddleware.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/RateLimiting/src/RateLimitingMiddleware.cs) in dotnet/aspnetcore.
- [`PartitionedRateLimiter.CreateChained<TResource>`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.ratelimiting.partitionedratelimiter.createchained) API reference on Microsoft Learn.
- [Rate limiting middleware in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/performance/rate-limit) on Microsoft Learn.
