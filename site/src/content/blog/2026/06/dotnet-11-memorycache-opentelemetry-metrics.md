---
title: ".NET 11 Gives MemoryCache First-Class OpenTelemetry Metrics"
description: ".NET 11 Preview 4 ships a built-in meter for Microsoft.Extensions.Caching.Memory, so cache hit ratio and evictions flow into OpenTelemetry without a background poller."
pubDate: 2026-06-06
tags:
  - "dotnet"
  - "dotnet-11"
  - "opentelemetry"
  - "caching"
---

The single most useful number for any read-heavy service is the cache hit ratio, and until now `Microsoft.Extensions.Caching.Memory` made you fish for it. .NET 11 Preview 4, released on June 2, 2026, fixes that: `MemoryCache` now emits OpenTelemetry metrics from a built-in meter, so hits, misses, evictions, and size land in your dashboards without a single line of custom plumbing.

## What TrackStatistics Used to Cost You

`TrackStatistics` and `GetCurrentStatistics()` have existed since .NET 8, but they only handed you a snapshot object. To turn that into a time series you had to write a hosted service that polled the cache on a timer and republished the numbers through your own `Meter`:

```csharp
// Pre-.NET 11: poll the snapshot yourself
public class CacheStatsReporter(IMemoryCache cache) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var stats = ((MemoryCache)cache).GetCurrentStatistics();
            // manually push stats.TotalHits, stats.TotalMisses, ...
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }
}
```

That works, but the cast is ugly, the polling interval is a guess, and every project reinvents the same boilerplate.

## The Built-In Meter

Preview 4 adds a meter named `Microsoft.Extensions.Caching.Memory` with four observable instruments:

| Instrument | Type | Reports |
| --- | --- | --- |
| `dotnet.cache.requests` | counter | hits and misses, split by tag |
| `dotnet.cache.entries` | up-down counter | current entry count |
| `dotnet.cache.estimated_size` | gauge | current estimated size |
| `dotnet.cache.evictions` | counter | total evictions since startup |

`dotnet.cache.requests` carries a `cache.request.type` tag valued `hit` or `miss`, which is exactly what you need to compute hit ratio in the dashboard rather than in the app. Every instrument also carries a `cache.name` tag, so multiple caches in one process stay distinct.

## Wiring It Up

Two steps: turn on statistics and register the meter with OpenTelemetry.

```csharp
builder.Services.AddMemoryCache(options =>
{
    options.TrackStatistics = true;
    options.Name = "catalog";
});

builder.Services.AddOpenTelemetry()
    .WithMetrics(metrics =>
    {
        metrics.AddMeter("Microsoft.Extensions.Caching.Memory");
    });
```

The instruments stay dormant until `TrackStatistics` is set, so there is no overhead if you never opt in. Give each cache a `Name` and the `cache.name` tag makes the catalog cache trivially separable from the session cache in Grafana or Azure Monitor.

The metrics slot in next to the [native OpenTelemetry tracing](/2026/04/aspnetcore-11-native-opentelemetry-tracing/) ASP.NET Core picked up earlier in the .NET 11 cycle, which means a request trace and the cache behavior behind it now share the same pipeline. Grab [.NET 11 Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) and delete your cache-stats `BackgroundService`.
