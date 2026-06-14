---
title: "HybridCache vs IMemoryCache vs IDistributedCache in .NET 11: which should you pick?"
description: "Default to HybridCache for new caching code in .NET 11. Reach for IMemoryCache only when you need raw single-server speed with no serialization, and IDistributedCache only as a backing store. Here is the decision matrix."
pubDate: 2026-06-14
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "caching"
  - "performance"
---

For new caching code in .NET 11, default to `HybridCache`. It gives you the in-process speed of `IMemoryCache`, the cross-server reach of `IDistributedCache`, and stampede protection plus tag invalidation that neither of the older APIs has, all behind one `GetOrCreateAsync` call. Reach for raw `IMemoryCache` only when you need single-server latency with zero serialization and fine-grained eviction control, and reach for raw `IDistributedCache` mainly when you need a distributed store without an L1 tier (or as `HybridCache`'s backing layer). This post backs that recommendation with the full feature matrix, the API differences that actually bite, and the gotcha that picks for you.

Everything here targets .NET 11, ASP.NET Core 11, and C# 14. `HybridCache` ships in the `Microsoft.Extensions.Caching.Hybrid` package, which went GA alongside .NET 9 and is the same package you use on .NET 11. It supports runtimes down to .NET Framework 4.7.2 and .NET Standard 2.0, so the comparison below is not limited to the newest TFM.

## The feature matrix

| Feature                         | IMemoryCache              | IDistributedCache               | HybridCache                          |
| ------------------------------- | ------------------------- | ------------------------------- | ------------------------------------ |
| Tier                            | L1 (in-process)           | L2 (out-of-process)             | L1 + optional L2                     |
| Shared across servers           | No                        | Yes                             | Yes (via L2)                         |
| Survives process restart        | No                        | Yes                             | L2 survives, L1 does not             |
| Stored as                       | live object               | `byte[]`                        | object in L1, serialized in L2       |
| Serialization                   | none                      | you write it                    | built-in (`System.Text.Json` + more) |
| Stampede protection             | no                        | no                              | yes                                  |
| Tag-based invalidation          | no                        | no                              | yes (`RemoveByTagAsync`)             |
| Get-or-create in one call       | extension only, unguarded | no                              | yes (`GetOrCreateAsync`)             |
| Per-entry expiration control    | full                      | absolute + sliding              | overall + local (`LocalCacheExpiration`) |
| Built-in OpenTelemetry metrics  | yes (.NET 11)             | depends on backend              | yes                                  |
| In box (no NuGet)               | yes                       | abstraction yes, backends no    | no (one package)                     |
| Min runtime                     | broad                     | broad                           | .NET Framework 4.7.2 / netstandard2.0 |

All three are registered through DI and resolved by interface (or, for `HybridCache`, an abstract class). The differences that matter are not in registration, they are in what each one does on a cache miss and under concurrency.

## What each API actually is

`IMemoryCache` stores live object references in a `ConcurrentDictionary`-backed store inside your process. There is no serialization: you put a `Customer` in, you get the same `Customer` reference out. That makes it the fastest of the three and the only one where a cache hit costs essentially a dictionary lookup. The cost is that it is per-process: two instances behind a load balancer have two independent caches, and a restart empties it.

```csharp
// .NET 11, C# 14
builder.Services.AddMemoryCache();

public class ProductService(IMemoryCache cache, ProductDb db)
{
    public Task<Product> GetAsync(int id) =>
        cache.GetOrCreateAsync($"product:{id}", entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5);
            return db.LoadProductAsync(id);
        })!;
}
```

`IDistributedCache` is a deliberately low-level abstraction over an out-of-process store. Its surface is `GetAsync`, `SetAsync`, `RefreshAsync`, and `RemoveAsync` (plus synchronous variants), and every value is a `byte[]`. There is no `GetOrCreate`, no object model, and no concurrency control. You own serialization, key naming, expiration policy, and the read-through pattern.

```csharp
// .NET 11, C# 14
builder.Services.AddStackExchangeRedisCache(o =>
    o.Configuration = builder.Configuration.GetConnectionString("Redis"));

public class ProductService(IDistributedCache cache, ProductDb db)
{
    public async Task<Product> GetAsync(int id)
    {
        var key = $"product:{id}";
        var bytes = await cache.GetAsync(key);
        if (bytes is not null)
            return JsonSerializer.Deserialize<Product>(bytes)!;

        var product = await db.LoadProductAsync(id);
        await cache.SetAsync(key, JsonSerializer.SerializeToUtf8Bytes(product),
            new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5)
            });
        return product;
    }
}
```

That is roughly fifteen lines of boilerplate per cached value, and every copy of it is a chance to forget expiration, mishandle a null, or pick a slightly different serializer. The built-in implementations include in-memory (`AddDistributedMemoryCache`, for dev and tests only, since it is not actually distributed), Redis (`AddStackExchangeRedisCache`), SQL Server (`AddDistributedSqlServerCache`), Azure Cache for Redis, and third-party stores such as NCache.

`HybridCache` is the abstraction Microsoft added to collapse the two patterns above into one. It keeps an in-process L1 (a `MemoryCache` by default) and, if you have registered an `IDistributedCache`, uses it automatically as the L2. A `GetOrCreateAsync` call checks L1, then L2, then runs your factory and writes back to both tiers. You never touch serialization unless you want to.

```csharp
// .NET 11, C# 14
builder.Services.AddHybridCache();
// If an IDistributedCache is also registered, it becomes the L2 automatically.

public class ProductService(HybridCache cache, ProductDb db)
{
    public ValueTask<Product> GetAsync(int id, CancellationToken ct = default) =>
        cache.GetOrCreateAsync(
            $"product:{id}",
            async token => await db.LoadProductAsync(id, token),
            cancellationToken: ct);
}
```

Same outcome as the `IDistributedCache` block, three lines instead of fifteen, with stampede protection and an L1 tier you did not have to wire up.

## When to pick IMemoryCache directly

- **Single-server or per-node caches where the data is cheap to recompute on restart.** A lookup table loaded once per process, a parsed config, a rate-limiter bucket. There is no benefit to serializing these out of process. Pair it with the new .NET 11 built-in OpenTelemetry meter so you still get hit-ratio and eviction metrics without a custom poller, as covered in [the .NET 11 MemoryCache metrics writeup](/2026/06/dotnet-11-memorycache-opentelemetry-metrics/).
- **Hot paths where even one round of serialization is too much.** Because `IMemoryCache` hands back the live object, a hit is a dictionary read. If you are caching a value read thousands of times per second on one box, that matters. This is the same reasoning behind keeping a query plan resident, as in [compiled queries for EF Core hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).
- **You need eviction features `HybridCache` does not surface.** Size-based limits (`SizeLimit` plus per-entry `Size`), eviction priority, and `PostEvictionCallbacks` are `IMemoryCache` concepts. `HybridCache` does not expose them on its API.

The catch you accept by going direct: `GetOrCreateAsync` on `IMemoryCache` is an extension method with no stampede guard. Under a cold-cache burst, every concurrent caller runs the factory.

## When to pick IDistributedCache directly

- **You need a shared store but explicitly do not want an L1 tier.** If correctness depends on every node seeing the same value the instant it changes, an in-process L1 with its own expiration is a liability, because invalidating a key does not reach the L1 of other servers (more on that below). Going straight to Redis removes the staleness window L1 introduces.
- **You are not really caching.** `IDistributedCache` backs ASP.NET Core session state and can hold Data Protection keys. Those are storage use cases, not read-through caches, and `HybridCache` is the wrong shape for them.
- **You need total control over the serialized bytes.** Custom binary formats, compression you manage, or interop with another system reading the same Redis keys. `HybridCache` can take a custom serializer, but if the bytes are the contract, the lower-level API is more honest.

## When to pick HybridCache (the default)

- **Any new read-through cache in an app that might scale past one instance.** You get L1 speed today and L2 correctness the moment you register a Redis cache, with no code change at the call site. This is exactly the setup described in [using HybridCache with Redis as the L2 cache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/).
- **Anywhere a cache stampede would hurt.** `HybridCache` guarantees that for a given key, only one concurrent caller runs the factory while the rest await that single result. A cold cache hit by a hundred requests issues one backing query, not a hundred, which is the same problem you fight when chasing [N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/).
- **You want grouped invalidation.** Tag a set of entries (`tags: ["product", $"category:{categoryId}"]`) and drop them together with `RemoveByTagAsync("category:42")`. Neither older API has any tag concept.

## The stampede benchmark, concretely

This is the difference that shows up in production, so it is worth measuring rather than asserting. Take a factory that simulates a 200 ms database read and fire 100 concurrent `GetOrCreateAsync` calls for the same key against a cold cache.

```csharp
// .NET 11, BenchmarkDotNet 0.15.x style harness (simplified)
async Task<int> Factory(CancellationToken _)
{
    Interlocked.Increment(ref _factoryCalls);
    await Task.Delay(200);          // stand-in for a DB / HTTP round trip
    return 42;
}

var tasks = Enumerable.Range(0, 100)
    .Select(_ => hybrid.GetOrCreateAsync("k", Factory).AsTask());
await Task.WhenAll(tasks);
```

With `HybridCache`, `_factoryCalls` is **1**: one caller runs the 200 ms factory and the other 99 await its result, so the whole burst clears in roughly 200 ms with a single backing call. Swap in the `IMemoryCache` `GetOrCreateAsync` extension and `_factoryCalls` is up to **100**, because nothing serializes the cold-miss callers. Against a real database that is the difference between one query and a hundred-deep connection-pool pileup. The exact count for the `IMemoryCache` case varies with timing (some callers may land after the first write completes), which is precisely the point: it is unbounded and non-deterministic, whereas `HybridCache` pins it at one. Numbers measured on .NET 11 (11.0.x), Windows 11, with the in-box L1 only and no L2 configured.

## Expiration: the option names differ in a way that bites

The three APIs name expiration differently, and mixing them up is the most common configuration bug.

`IMemoryCache` uses `MemoryCacheEntryOptions` with `AbsoluteExpiration`, `AbsoluteExpirationRelativeToNow`, and `SlidingExpiration`. `IDistributedCache` uses `DistributedCacheEntryOptions` with the same three names. `HybridCache` uses `HybridCacheEntryOptions` with two properties that mean something different:

```csharp
// .NET 11, C# 14
var options = new HybridCacheEntryOptions
{
    Expiration = TimeSpan.FromMinutes(5),        // overall lifetime (drives L2)
    LocalCacheExpiration = TimeSpan.FromMinutes(1) // how long the L1 copy is trusted
};
```

`Expiration` is the total lifetime of the entry, and it governs the L2 copy. `LocalCacheExpiration` is how long the in-process L1 copy is considered valid before the entry is re-fetched from L2. Setting `LocalCacheExpiration` shorter than `Expiration` is how you bound L1 staleness in a multi-server deployment: each node trusts its local copy for at most a minute, then revalidates against the shared L2. There is no sliding-expiration concept in `HybridCache`; if you depend on sliding windows, that is a reason to stay on the lower-level API.

Other defaults worth knowing: `HybridCacheOptions.MaximumPayloadBytes` defaults to 1 MB and `MaximumKeyLength` to 1024 characters. Values or keys over the limit are logged and silently not cached, which is a quiet failure mode if you cache large blobs.

## The gotcha that picks for you

Tag and key invalidation in `HybridCache` does not reach the L1 of other servers. When you call `RemoveByTagAsync` or `RemoveAsync`, the entry is removed from the local L1 and from the shared L2, but every other node keeps serving its own L1 copy until that copy expires on its own `LocalCacheExpiration`. The docs are explicit: tag invalidation is a logical operation that marks future reads as misses, it does not actively purge other nodes.

That single behavior decides several designs:

- If you can tolerate a bounded staleness window (set `LocalCacheExpiration` to the window you accept), `HybridCache` is ideal and you keep L1 speed.
- If you cannot tolerate any window, because a stale authorization or pricing value is a correctness bug, then an L1 tier is the wrong tool, and you should go straight to `IDistributedCache` (or set `LocalCacheExpiration` to zero, which mostly defeats the purpose of the L1).

The other forcing function is **serialization safety**. `HybridCache` deserializes a fresh object per caller by default to preserve `IDistributedCache`'s thread-safety guarantees. If your cached type is immutable, you can opt into instance reuse by sealing the type and applying `[ImmutableObject(true)]`, which removes per-call deserialization overhead. If your cached objects are mutable and shared, do not apply that attribute, or you will introduce data races.

## The recommendation, restated

In .NET 11, write new caching code against `HybridCache` unless you have a specific reason not to. It is a near drop-in for both older APIs, it eliminates the cache-aside boilerplate that `IDistributedCache` forces on you, and it closes the stampede hole that unguarded `IMemoryCache.GetOrCreateAsync` leaves open. Drop to raw `IMemoryCache` when you need single-server speed, zero serialization, or eviction features (size limits, priority, eviction callbacks) that `HybridCache` does not expose. Drop to raw `IDistributedCache` when you need a shared store with no L1 staleness window, when the serialized bytes are a contract with another system, or when you are using it for session and key storage rather than caching. For everything in between, which is most caching, `HybridCache` is the answer.

## Related

- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [.NET 11 gives MemoryCache first-class OpenTelemetry metrics](/2026/06/dotnet-11-memorycache-opentelemetry-metrics/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)

## Sources

- [HybridCache library in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid?view=aspnetcore-10.0)
- [Distributed caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/distributed?view=aspnetcore-10.0)
- [Cache in-memory in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/memory?view=aspnetcore-10.0)
- [Hello HybridCache! (Microsoft .NET Blog, GA announcement)](https://devblogs.microsoft.com/dotnet/hybrid-cache-is-now-ga/)
- [Overview of caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview?view=aspnetcore-10.0)
