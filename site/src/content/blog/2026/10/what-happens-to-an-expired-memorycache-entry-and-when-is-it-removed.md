---
title: "What happens to an expired MemoryCache entry, and when is it actually removed from memory?"
description: "An expired MemoryCache entry is not removed on a timer. It stays in the dictionary until a read touches it, a throttled background scan runs, or compaction kicks in. Here is exactly when each happens, and how to get eager eviction."
pubDate: 2026-10-21
tags:
  - "dotnet"
  - "dotnet-10"
  - "caching"
  - "memorycache"
  - "performance"
---

Nothing happens to an expired `MemoryCache` entry at the moment it expires. `Microsoft.Extensions.Caching.Memory` has no timer per entry and no background thread watching the clock, so the entry, its value, and everything the value references stay in the cache's dictionary until one of three things touches it: a read of that key (`TryGetValue`, `Get`, `GetOrCreate`), a background scan for expired items that is only started by some other cache operation and at most once per `ExpirationScanFrequency` (1 minute by default), or a compaction (`Compact()` or the `SizeLimit` overflow path). Only after the entry leaves the dictionary can the GC reclaim the value. The one exception is an expiration token such as `CancellationChangeToken`: when it fires, the entry is removed right away, with no read needed.

Everything below was verified against `Microsoft.Extensions.Caching.Memory` 10.0.13 and 11.0.0-rc.2.26504.105 on .NET 10.0.10 (SDK 10.0.302), with the source read from the `dotnet/runtime` `main` branch. Both packages printed identical output for every scenario, and this part of the design has not changed in years.

## Why there is no expiry timer

`MemoryCache` stores entries in a `ConcurrentDictionary`. Every `CacheEntry` knows its absolute expiration, sliding expiration, and expiration tokens, but it does not schedule anything. Expiration is a lazy check, `CacheEntry.CheckExpired(DateTime utcNow)`, that the cache calls whenever it happens to look at an entry:

```csharp
// dotnet/runtime main, CacheEntry.cs (abridged)
internal bool CheckExpired(DateTime utcNow)
    => EvictionReason != EvictionReason.None
        || CheckForExpiredTime(utcNow)
        || (_tokens != null && _tokens.CheckForExpiredTokens(this));
```

That is a deliberate trade-off. A cache with a million entries and a timer per entry would spend real CPU and memory on timers. A single periodic timer would wake up an otherwise idle process forever. The lazy design costs nothing when the cache is quiet, at the price of keeping stale data around longer than you might assume.

So the real question is never "when does it expire" but "when does the cache next look at it". There are four answers.

## Path 1: a read of the same key removes it immediately

`TryGetValue` (which `Get`, `GetOrCreate`, and `GetOrCreateAsync` all go through) checks the entry it found. If it is expired, the entry is removed from the dictionary on the spot and the call reports a miss:

```csharp
// dotnet/runtime main, MemoryCache.PostProcessTryGetValue (abridged)
if (!entry.CheckExpired(utcNow) || entry.EvictionReason == EvictionReason.Replaced)
{
    entry.LastAccessed = utcNow;
    result = entry.Value;
    StartScanForExpiredItemsIfNeeded(utcNow);
    return true; // hit
}
else
{
    coherentState.RemoveEntry(entry, _options); // expired: removed right here
}
```

You never get an expired value back from a read, so correctness is not the issue. The issue is everything you did not read.

## Path 2: the throttled background scan

Almost every cache operation (a hit, a miss, a `Set`, a `Remove`, a token-triggered expiry) ends with a call to `StartScanForExpiredItemsIfNeeded`:

```csharp
// dotnet/runtime main, MemoryCache.cs
private void StartScanForExpiredItemsIfNeeded(DateTime utcNow)
{
    if (_options.ExpirationScanFrequency < utcNow - _lastExpirationScan)
    {
        _lastExpirationScan = utcNow;
        Task.Factory.StartNew(state => ((MemoryCache)state!).ScanForExpiredItems(), this,
            CancellationToken.None, TaskCreationOptions.DenyChildAttach, TaskScheduler.Default);
    }
}
```

`ScanForExpiredItems` walks every entry on a thread-pool thread and removes the expired ones. Two consequences follow directly from this code:

1. **The scan is triggered, not scheduled.** If nothing calls into the cache, no scan ever starts. An idle cache full of expired entries keeps all of them indefinitely.
2. **The scan is throttled.** Even on a busy cache, a full sweep starts at most once per `ExpirationScanFrequency`, which defaults to `TimeSpan.FromMinutes(1)`. An entry that expires right after a scan can survive for up to a minute of continuous traffic, and arbitrarily long without traffic.

## Path 3: compaction

When you set `SizeLimit` and an insert would push the total `Size` over it, the cache queues an overcapacity compaction on the thread pool. You can also call `Compact(double percentage)` yourself. Both go through the same private `Compact` method, whose first step is to collect every expired entry for removal before it starts evicting live entries by priority (`Low`, then `Normal`, then `High`, each bucket ordered by `LastAccessed`; `NeverRemove` is never touched). `Compact(0)` therefore removes all expired entries and nothing else, which is a handy manual sweep.

## Path 4: expiration tokens are the only eager path

If an entry has an `IChangeToken` with `ActiveChangeCallbacks == true` (a `CancellationChangeToken`, a file-provider token, a configuration reload token), the cache registers a callback on it. When the token fires, the callback queues work that marks the entry `EvictionReason.TokenExpired` and removes it from the dictionary, with no read required:

```csharp
// dotnet/runtime main, CacheEntry.cs
private static void ExpirationTokensExpired(object obj)
{
    // start a new thread to avoid issues with callbacks called from RegisterChangeCallback
    Task.Factory.StartNew(state =>
    {
        var entry = (CacheEntry)state!;
        entry.SetExpired(EvictionReason.TokenExpired);
        entry._cache.EntryExpired(entry);
    }, obj, CancellationToken.None, TaskCreationOptions.DenyChildAttach, TaskScheduler.Default);
}
```

Time-based expiration (`AbsoluteExpiration`, `AbsoluteExpirationRelativeToNow`, `SlidingExpiration`) never takes this path.

## A probe that shows all four paths

The easiest way to see this without waiting minutes is to give the cache a manual clock. `MemoryCacheOptions.Clock` takes an `ISystemClock` (not a `TimeProvider`), and `MemoryCache.Count` returns the raw dictionary count, expired entries included. Save this as `probe.cs` and run it with `dotnet run probe.cs`:

```csharp
#:package Microsoft.Extensions.Caching.Memory@10.0.13
#:property PublishAot=false
// .NET 10, C# 14, Microsoft.Extensions.Caching.Memory 10.0.13
using System.Runtime.CompilerServices;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Internal;
using Microsoft.Extensions.Primitives;

var clock = new ManualClock();
var cache = new MemoryCache(new MemoryCacheOptions
{
    Clock = clock,
    ExpirationScanFrequency = TimeSpan.FromMinutes(1),
});

// 1. Expired entries stay until something touches them
cache.Set("a", "A", TimeSpan.FromSeconds(10));
clock.Advance(TimeSpan.FromSeconds(30));
Console.WriteLine($"[1] after expiry, Count = {cache.Count}");
Console.WriteLine($"[1] TryGetValue = {cache.TryGetValue("a", out _)}, Count = {cache.Count}");

// 2. Idle cache: nobody reads, nothing is removed
for (int i = 0; i < 1000; i++)
    cache.Set($"k{i}", new byte[1024], TimeSpan.FromSeconds(10));
clock.Advance(TimeSpan.FromMinutes(10));
Thread.Sleep(500);
Console.WriteLine($"[2] 10 min later, nobody touched the cache, Count = {cache.Count}");
cache.TryGetValue("unrelated", out _); // any operation; >1 min since last scan
Thread.Sleep(200);
Console.WriteLine($"[2] after one unrelated TryGetValue, Count = {cache.Count}");

// 3. Scan throttling: a second expiry within ExpirationScanFrequency is not scanned
cache.Set("b", "B", TimeSpan.FromSeconds(10));
clock.Advance(TimeSpan.FromSeconds(30));
cache.TryGetValue("unrelated", out _);
Thread.Sleep(200);
Console.WriteLine($"[3] 30 s later (< scan frequency), Count = {cache.Count}");
clock.Advance(TimeSpan.FromSeconds(31));
cache.TryGetValue("unrelated", out _);
Thread.Sleep(200);
Console.WriteLine($"[3] 61 s since last scan, Count = {cache.Count}");

// 4. Post-eviction callback runs later, on a thread-pool thread
var done = new ManualResetEventSlim();
int callerThread = Environment.CurrentManagedThreadId;
cache.Set("c", "C", new MemoryCacheEntryOptions()
    .SetAbsoluteExpiration(TimeSpan.FromSeconds(10))
    .RegisterPostEvictionCallback((k, v, reason, _) =>
    {
        Console.WriteLine($"[4] callback key={k} reason={reason} thread={Environment.CurrentManagedThreadId} (caller {callerThread}) pool={Thread.CurrentThread.IsThreadPoolThread}");
        done.Set();
    }));
clock.Advance(TimeSpan.FromSeconds(30));
Console.WriteLine($"[4] TryGetValue = {cache.TryGetValue("c", out _)} returned before callback ran: {!done.IsSet}");
done.Wait(2000);

// 5. Expiration token: removed eagerly, no read required
var cts = new CancellationTokenSource();
var tokenDone = new ManualResetEventSlim();
cache.Set("d", "D", new MemoryCacheEntryOptions()
    .AddExpirationToken(new CancellationChangeToken(cts.Token))
    .RegisterPostEvictionCallback((k, _, reason, _) => { Console.WriteLine($"[5] callback key={k} reason={reason}"); tokenDone.Set(); }));
int before = cache.Count;
cts.Cancel();
tokenDone.Wait(2000);
Console.WriteLine($"[5] Count before cancel = {before}, after cancel (no reads) = {cache.Count}");

// 6. Memory: the value is reachable until the entry leaves the dictionary
var weak = Store(cache, clock);
clock.Advance(TimeSpan.FromSeconds(30));
GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
Console.WriteLine($"[6] expired but not removed, value alive after GC = {weak.IsAlive}");
cache.TryGetValue("big", out _);
GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
Console.WriteLine($"[6] removed by read, value alive after GC = {weak.IsAlive}");

// 7. Sliding expiration is measured from the last read
cache.Set("s", "S", new MemoryCacheEntryOptions { SlidingExpiration = TimeSpan.FromSeconds(20) });
for (int i = 0; i < 5; i++) { clock.Advance(TimeSpan.FromSeconds(15)); cache.TryGetValue("s", out _); }
Console.WriteLine($"[7] read every 15 s for 75 s with 20 s sliding: still there = {cache.TryGetValue("s", out _)}");
clock.Advance(TimeSpan.FromSeconds(21));
Console.WriteLine($"[7] after 21 s idle: still there = {cache.TryGetValue("s", out _)}");

// 8. Compact(0) removes expired entries only
cache.Set("e1", 1, TimeSpan.FromSeconds(5));
cache.Set("e2", 2, TimeSpan.FromSeconds(5));
cache.Set("live", 3, TimeSpan.FromHours(1));
clock.Advance(TimeSpan.FromSeconds(10));
Console.WriteLine($"[8] before Compact(0): Count = {cache.Count}");
cache.Compact(0);
Console.WriteLine($"[8] after Compact(0): Count = {cache.Count}");

[MethodImpl(MethodImplOptions.NoInlining)]
static WeakReference Store(MemoryCache cache, ManualClock clock)
{
    var value = new byte[10_000_000];
    cache.Set("big", value, TimeSpan.FromSeconds(10));
    return new WeakReference(value);
}

sealed class ManualClock : ISystemClock
{
    private DateTimeOffset _now = new(2026, 10, 21, 12, 0, 0, TimeSpan.Zero);
    public DateTimeOffset UtcNow => _now;
    public void Advance(TimeSpan by) => _now += by;
}
```

Output, identical with package 10.0.13 and 11.0.0-rc.2.26504.105:

```text
[1] after expiry, Count = 1
[1] TryGetValue = False, Count = 0
[2] 10 min later, nobody touched the cache, Count = 1000
[2] after one unrelated TryGetValue, Count = 0
[3] 30 s later (< scan frequency), Count = 1
[3] 61 s since last scan, Count = 0
[4] TryGetValue = False returned before callback ran: True
[4] callback key=c reason=Expired thread=4 (caller 1) pool=True
[5] callback key=d reason=TokenExpired
[5] Count before cancel = 1, after cancel (no reads) = 0
[6] expired but not removed, value alive after GC = True
[6] removed by read, value alive after GC = False
[7] read every 15 s for 75 s with 20 s sliding: still there = True
[7] after 21 s idle: still there = False
[8] before Compact(0): Count = 3
[8] after Compact(0): Count = 1
```

Line `[2]` is the one that surprises people: a thousand expired entries, ten minutes past their expiry, still in the cache, until a lookup for a completely unrelated key kicks off the scan. Line `[6]` is the memory consequence: a 10 MB array that expired is still reachable, and a full blocking GC cannot collect it, because the cache's dictionary still references it.

## What "removed from memory" really means

Removal from the cache and reclamation by the GC are two separate events:

1. The entry is removed from the `ConcurrentDictionary` by one of the four paths above. From this point the cache no longer roots the value.
2. If the entry has post-eviction callbacks, the cache queues them on the thread pool with `Task.Factory.StartNew`. The `CacheEntry` (and so its `Value`) stays reachable from that queued work item until every callback has run, and of course for as long as any callback stores the value somewhere.
3. The GC reclaims the value at its next collection of whatever generation the value lives in. A long-lived cache value has usually been promoted to gen 2, or sits on the Large Object Heap if it is 85,000 bytes or more, so "next collection" can be a while on a server that rarely does full GCs.

If a heap dump shows your cached type dominating memory long after you expected it to expire, check the roots: a path through `MemoryCache` and `CoherentState` means the entry is simply still in the dictionary, which is a scan problem, not a leak. The [dotnet-gcdump and dotnet-dump walkthrough](/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) shows how to read those root paths.

## Post-eviction callbacks are late and off-thread

`RegisterPostEvictionCallback` is the usual way people try to observe expiry, and it inherits all of the laziness above. A callback for a time-expired entry does not fire at the expiry time. It fires when the entry is actually removed, which is during a read, a scan, or a compaction, and even then it runs later on a thread-pool thread (line `[4]`: the read returned a miss before the callback had run). The callback receives the `EvictionReason`: `Expired` for time-based expiry, `TokenExpired` for tokens, `Capacity` for size-based compaction, `Removed` for an explicit `Remove`, and `Replaced` when you `Set` the same key again.

Exceptions thrown from a callback are caught and logged as `EvictionCallback invoked failed` through the cache's `ILogger`, so they never crash the process, but they also never surface unless you look at the logs.

Do not build "refresh on expiry" on top of these callbacks with time-based expiration. On a quiet server, the refresh would not happen until some request first observes the miss, which defeats the point.

## Getting eager, on-time eviction

If you need an entry to leave the cache close to its expiry time, without depending on traffic, attach a token that fires on a timer. A `CancellationTokenSource` with a delay is the simplest one:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.Memory 10.0.13
public static void SetWithEagerExpiry<T>(IMemoryCache cache, object key, T value, TimeSpan ttl)
{
    var cts = new CancellationTokenSource(ttl);
    var options = new MemoryCacheEntryOptions()
        .SetAbsoluteExpiration(ttl) // still enforced lazily on reads
        .AddExpirationToken(new CancellationChangeToken(cts.Token))
        .RegisterPostEvictionCallback(static (_, _, _, state) => ((CancellationTokenSource)state!).Dispose(), cts);

    cache.Set(key, value, options);
}
```

When the delay elapses, the token fires, the cache removes the entry, and the post-eviction callback disposes the `CancellationTokenSource` (it also runs if the entry is replaced or removed earlier, so the timer does not leak). The cost is one timer per entry, so use this for the handful of large or sensitive entries that must go on time, not for a cache with a million small items.

For everything else, two knobs are usually enough:

- **Lower `ExpirationScanFrequency`.** In ASP.NET Core, `services.AddMemoryCache(o => o.ExpirationScanFrequency = TimeSpan.FromSeconds(10));`. Each scan walks the whole dictionary, so on a very large cache this trades CPU for promptness. It still needs some operation to trigger the scan.
- **Sweep on your own schedule.** A `BackgroundService` or `PeriodicTimer` that calls `cache.Compact(0)` every N seconds removes all expired entries even when the cache is idle. `Compact` is defined on the concrete `MemoryCache` class, not on `IMemoryCache`, so cast or inject `MemoryCache`.

## Gotchas worth knowing

**`Count` includes expired entries.** `MemoryCache.Count`, `MemoryCache.Keys` (added in .NET 9), and `GetCurrentStatistics().CurrentEntryCount` all report the raw dictionary, so a dashboard can show thousands of "live" entries that are all past their expiry. The built-in OpenTelemetry meter described in [the .NET 11 MemoryCache metrics post](/2026/06/dotnet-11-memorycache-opentelemetry-metrics/) reads the same statistics, with the same caveat.

**Sliding expiration resets on reads, not on scans.** Each hit updates `LastAccessed`, which is what sliding expiration measures against (line `[7]`). A scan does not count as an access, but it does remove the entry once the sliding window has passed.

**Setting an already-expired entry does not add it.** If the options you pass to `Set` are already expired at insert time (for example an absolute expiration in the past), the entry never enters the dictionary and its callbacks fire straight away with `EvictionReason.Expired`.

**`SizeLimit` compaction is also asynchronous.** The insert that crosses the limit is rejected (its callbacks fire with `EvictionReason.Capacity`), and compaction is queued on the thread pool. Until it runs, further inserts that do not fit are rejected too. Expired entries are removed first, so a cache full of stale entries is reclaimed before any live entry is evicted.

**Testing expiry with `FakeTimeProvider` does not plug straight in.** `MemoryCacheOptions.Clock` is an `ISystemClock` (from `Microsoft.Extensions.Internal`), not a `TimeProvider`. A five-line adapter like `ManualClock` above, or one that wraps `FakeTimeProvider.GetUtcNow()`, is the bridge; [testing time-dependent code with TimeProvider and FakeTimeProvider](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/) covers the rest of that toolbox. Remember that the scan and callbacks still run on the real thread pool, so tests need a short wait or a signal, as the probe does.

**HybridCache does not change any of this for L1.** `HybridCache`'s default in-process tier is built on `IMemoryCache`, so expired L1 entries follow exactly the same lifecycle. If you are choosing between the APIs, the [HybridCache vs IMemoryCache vs IDistributedCache comparison](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) explains which eviction controls each one exposes.

## Related

- [HybridCache vs IMemoryCache vs IDistributedCache in .NET 11](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [.NET 11 adds OpenTelemetry metrics to MemoryCache](/2026/06/dotnet-11-memorycache-opentelemetry-metrics/)
- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [How to diagnose a managed memory leak with dotnet-gcdump and dotnet-dump](/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)
- [How to test time-dependent code with TimeProvider and FakeTimeProvider in .NET 11](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)

## Sources

- [`MemoryCache.cs` in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/MemoryCache.cs) (`PostProcessTryGetValue`, `StartScanForExpiredItemsIfNeeded`, `ScanForExpiredItems`, `Compact`)
- [`CacheEntry.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/CacheEntry.cs) and [`CacheEntry.CacheEntryTokens.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/CacheEntry.CacheEntryTokens.cs) (`CheckExpired`, token callbacks, post-eviction callback dispatch)
- [`MemoryCacheOptions.ExpirationScanFrequency`](https://learn.microsoft.com/dotnet/api/microsoft.extensions.caching.memory.memorycacheoptions.expirationscanfrequency) on MS Learn
- [Caching in .NET](https://learn.microsoft.com/dotnet/core/extensions/caching) on MS Learn
- [Microsoft.Extensions.Caching.Memory on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Caching.Memory)
