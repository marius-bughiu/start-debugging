---
title: "How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache"
description: "Wire HybridCache to a Redis L2 in ASP.NET Core 11: register the service, add the StackExchange Redis distributed cache, and let GetOrCreateAsync give you a two-tier cache with built-in stampede protection and tag invalidation."
pubDate: 2026-06-07
template: how-to
tags:
  - "aspnetcore"
  - "dotnet"
  - "performance"
---

To use HybridCache with Redis as the second-level cache in ASP.NET Core 11, install `Microsoft.Extensions.Caching.Hybrid`, call `builder.Services.AddHybridCache()`, then register a Redis-backed `IDistributedCache` with `AddStackExchangeRedisCache(...)`. HybridCache automatically picks up that `IDistributedCache` as its L2. After that, every `GetOrCreateAsync` call reads L1 (in-process memory) first, falls back to L2 (Redis), and only calls your factory on a full miss. You get cache-stampede protection and tag-based invalidation for free, with no cache-aside boilerplate. This post walks the full setup, the options that actually matter, and the multi-instance gotcha that trips people up.

All examples target .NET 11, ASP.NET Core 11, and C# 14, using `Microsoft.Extensions.Caching.Hybrid` 9.x (the package went GA with .NET 9 and is the same package you use on .NET 11). The library itself supports runtimes down to .NET Framework 4.7.2 and .NET Standard 2.0, so the same code works in older hosts.

## Why HybridCache exists at all

If you have shipped a distributed cache before, you have written this loop by hand: check `IMemoryCache`, miss, check `IDistributedCache` (Redis), miss, deserialize, call the database, serialize, write back to both layers, return. Multiply that by every cached value and you have a pile of near-identical cache-aside code, each copy with its own subtle bug. The two classic bugs are a missing stampede guard (a hundred requests hit an expired key at once and all hammer the database) and inconsistent serialization between the two layers.

HybridCache collapses all of that into one call. It is a two-tier cache: L1 is an in-process `MemoryCache` (fast, per-server, lost on restart), and L2 is whatever `IDistributedCache` you register (Redis, SQL Server, Postgres, Garnet). The key point for this article: you do not configure the L2 on HybridCache directly. HybridCache discovers the `IDistributedCache` from the DI container. Register a Redis distributed cache and HybridCache uses it as L2 automatically.

## Wire up Redis as the L2 cache

Here is the end-to-end setup as a numbered procedure.

1. Install the two packages. The first brings in HybridCache; the second is the StackExchange-based Redis `IDistributedCache`.

   ```dotnetcli
   dotnet add package Microsoft.Extensions.Caching.Hybrid
   dotnet add package Microsoft.Extensions.Caching.StackExchangeRedis
   ```

2. Store the Redis connection string in configuration. Keep it out of source control with a user-secrets file in development:

   ```json
   {
     "ConnectionStrings": {
       "RedisConnectionString": "localhost:6379"
     }
   }
   ```

3. Register the Redis `IDistributedCache`. This is the L2. `AddStackExchangeRedisCache` puts an `IDistributedCache` in DI backed by your Redis instance.

   ```csharp
   // .NET 11, ASP.NET Core 11, C# 14
   var builder = WebApplication.CreateBuilder(args);

   builder.Services.AddStackExchangeRedisCache(options =>
   {
       options.Configuration =
           builder.Configuration.GetConnectionString("RedisConnectionString");
   });
   ```

4. Register HybridCache. It will find the `IDistributedCache` from step 3 and use it as L2. With no `IDistributedCache` registered, HybridCache still works as an L1-only in-process cache, so this single line is the only thing that "turns on" two-tier behaviour.

   ```csharp
   // .NET 11, ASP.NET Core 11
   builder.Services.AddHybridCache();

   var app = builder.Build();
   ```

That is the whole wiring. Order does not matter between steps 3 and 4 because DI resolves the `IDistributedCache` lazily when HybridCache first needs it. There is no `UseRedis()` call on HybridCache and no L2 setting to point at Redis. The discovery is implicit through `IDistributedCache`, which is exactly why the same HybridCache code runs against Redis, SQL Server, or no L2 at all without changing a line.

## Reading and writing with GetOrCreateAsync

`GetOrCreateAsync` is the API you will use 95% of the time. Inject `HybridCache` and call it with a key and a factory:

```csharp
// .NET 11, C# 14
public sealed class ProductService(HybridCache cache, ProductDbContext db)
{
    public async Task<Product?> GetProductAsync(int id, CancellationToken ct = default)
    {
        return await cache.GetOrCreateAsync(
            $"product:{id}",                       // unique cache key
            async cancel => await db.Products
                .AsNoTracking()
                .FirstOrDefaultAsync(p => p.Id == id, cancel),
            cancellationToken: ct);
    }
}
```

On the first call for `product:42`, HybridCache misses L1, misses L2, runs the factory, serializes the result, writes it to both Redis and the in-process cache, and returns. The next call on the same server hits L1 and never touches Redis. A call on a different server in your cluster misses L1 but hits L2 (Redis), so it skips the database and back-fills its own L1. That is the two-tier payoff: hot keys stay in-process, warm keys stay in Redis, and the database sees a miss only when both layers are cold.

Notice the interpolated string passed directly inside the call. The docs recommend writing the key inline like this rather than building it into a local variable first, because it lets future versions of the library skip the string allocation in some cases. There is also a second `GetOrCreateAsync` overload that takes a `state` tuple plus a `static` lambda, which avoids closure allocations on hot paths:

```csharp
// .NET 11, C# 14 - allocation-conscious overload
return await cache.GetOrCreateAsync(
    $"product:{id}",
    (db, id),
    static async (state, cancel) => await state.db.Products
        .AsNoTracking()
        .FirstOrDefaultAsync(p => p.Id == state.id, cancel),
    cancellationToken: ct);
```

Use the stateless overload by default. Reach for the stateful one only when a profiler tells you the closure allocation matters, which is rare next to the cost of a database round trip.

## Stampede protection is the feature you are really buying

This is the part that is hard to get right by hand. When a popular key expires and a burst of requests arrives, a naive cache-aside lets every request miss and call the factory at once. HybridCache guarantees that for a given key on a given server, only one caller runs the factory. The rest await the same result.

```csharp
// 100 concurrent requests for the same cold key
// -> exactly 1 factory invocation, 99 awaiters share the result
var tasks = Enumerable.Range(0, 100)
    .Select(_ => service.GetProductAsync(42, ct));
var results = await Task.WhenAll(tasks);
```

One subtlety: the `CancellationToken` you pass represents the combined cancellation of all the queued callers. The factory keeps running as long as at least one caller still wants the result, so a single client disconnecting will not cancel the shared work for everyone else.

The honest caveat: this protection is per-instance. HybridCache does not ship a distributed lock, so on a three-server cluster a cold key can trigger up to three factory calls, one per server, not one across the whole fleet. For most workloads that is fine. If you genuinely need cluster-wide single-flight, you need an external distributed lock or a third-party cache like FusionCache that layers one on. Do not assume "stampede protection" means "one database query across all servers."

## Expiration: the two clocks you control

`HybridCacheEntryOptions` exposes two expiration settings, and conflating them is the most common configuration mistake:

- `Expiration` is the overall lifetime, including the L2 (Redis) copy.
- `LocalCacheExpiration` is the in-process L1 lifetime. It is usually shorter than `Expiration`.

```csharp
// .NET 11 - global defaults
builder.Services.AddHybridCache(options =>
{
    options.MaximumPayloadBytes = 1024 * 1024; // 1 MB, the default
    options.MaximumKeyLength = 1024;           // chars, the default
    options.DefaultEntryOptions = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(5),       // L2 + overall
        LocalCacheExpiration = TimeSpan.FromMinutes(1) // L1 only
    };
});
```

Keeping `LocalCacheExpiration` shorter than `Expiration` is a deliberate pattern: it bounds how long any one server can serve stale data from its own memory while still letting Redis hold the value longer for cross-server sharing. A short L1 plus a longer L2 means a server's stale window is small, but the cluster as a whole still avoids the database. You can override these per call by passing a `HybridCacheEntryOptions` to `GetOrCreateAsync`.

The `Flags` property on `HybridCacheEntryOptions` lets you disable a tier for a specific entry, for example `HybridCacheEntryFlags.DisableLocalCacheWrite` to skip L1 for a rarely-read but large value, or `DisableDistributedCache` to keep something in-process only. Reach for these surgically; the defaults are right for most entries.

## Invalidating by key and by tag

When the underlying data changes, evict the entry. By key:

```csharp
await cache.RemoveAsync($"product:{id}", ct);
```

Tags are the more powerful tool. Attach tags when you create an entry, then invalidate a whole group in one call:

```csharp
// .NET 11, C# 14
public async Task<Product?> GetProductAsync(int id, CancellationToken ct = default)
{
    var options = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(10),
        LocalCacheExpiration = TimeSpan.FromMinutes(2)
    };
    var tags = new[] { "products", $"category:{await GetCategoryAsync(id, ct)}" };

    return await cache.GetOrCreateAsync(
        $"product:{id}",
        async cancel => await db.Products
            .AsNoTracking()
            .FirstOrDefaultAsync(p => p.Id == id, cancel),
        options,
        tags,
        cancellationToken: ct);
}

// Invalidate every product in one category after a bulk price update
public ValueTask InvalidateCategoryAsync(int categoryId, CancellationToken ct = default)
    => cache.RemoveByTagAsync($"category:{categoryId}", ct);
```

This replaces the old pattern of tracking which keys belong to which group in a side dictionary. `RemoveByTagAsync("products")` invalidates everything tagged `products` in one call. There is a wildcard: `RemoveByTagAsync("*")` logically invalidates the entire cache, even untagged entries. Glob matching is not supported, so `RemoveByTagAsync("foo*")` does not remove keys starting with `foo`.

Here is the nuance that surprises people. Neither `IMemoryCache` nor `IDistributedCache` understands tags, so tag invalidation is a logical operation, not a physical delete. HybridCache does not reach into Redis and delete the tagged keys. Instead it records that the tag was invalidated, and on the next read of any entry carrying that tag it treats the value as a miss and re-fetches. The bytes linger in Redis and in memory until they expire naturally. For correctness this is fine. For Redis memory accounting it means tag invalidation does not immediately free space.

## The multi-instance gotcha that bites everyone

Read this twice if you run more than one server. When you call `RemoveAsync` or `RemoveByTagAsync`, the entry is invalidated on the current server and in the L2 (Redis). It is not invalidated in the L1 (in-process memory) of the other servers. Each of those servers will keep serving its own cached copy until that copy's `LocalCacheExpiration` elapses.

So if you have five servers and you remove `product:42` on server A, servers B through E can still return the old product from their local memory for up to `LocalCacheExpiration`. This is the single most important reason to keep `LocalCacheExpiration` short on data that gets invalidated explicitly. If you need near-instant cross-server invalidation, you have to broadcast it yourself, for example with a Redis pub/sub message that each server handles by calling its own `RemoveAsync`. HybridCache does not do this propagation for you out of the box.

## Serialization and large objects

For L2 storage, values must be serialized. HybridCache handles `string` and `byte[]` internally and uses `System.Text.Json` for everything else by default. You can swap in a type-specific or general serializer (protobuf, MessagePack, XML) by chaining off `AddHybridCache`:

```csharp
// .NET 11 - custom serializer for one type
builder.Services
    .AddHybridCache()
    .AddSerializer<Product, ProtobufProductSerializer>();
```

Two limits to remember. `MaximumPayloadBytes` defaults to 1 MB; values larger than that are logged and silently not cached, so an oversized object becomes a permanent miss that always hits your factory. `MaximumKeyLength` defaults to 1024 characters; longer keys bypass the cache entirely. If you build keys from user input, cap their length and never trust raw user strings as keys, both to stay under the limit and to avoid cache-flooding denial-of-service.

If your cached type is immutable, you can tell HybridCache to skip the defensive per-call deserialization and hand out a shared instance, which cuts CPU and allocations for large or hot objects. Mark the type `sealed` and apply `[ImmutableObject(true)]`:

```csharp
// .NET 11, C# 14 - safe to reuse the same instance across callers
[ImmutableObject(true)]
public sealed record Product(int Id, string Name, decimal Price);
```

Only do this when the object truly is never mutated after creation; otherwise you reintroduce the concurrency bugs that the default behaviour protects you from. For Redis specifically, the `Microsoft.Extensions.Caching.StackExchangeRedis` package can implement `IBufferDistributedCache`, which lets HybridCache avoid `byte[]` allocations on the L2 path. That is worth enabling on high-throughput services.

## Where HybridCache fits next to what you already use

HybridCache does not replace `IMemoryCache` or `IDistributedCache`; it sits on top of them and orchestrates both. If you are still hand-rolling cache-aside over `IMemoryCache`, or watching cache hit ratio with the new built-in meter described in [.NET 11's first-class MemoryCache OpenTelemetry metrics](/2026/06/dotnet-11-memorycache-opentelemetry-metrics/), HybridCache is the layer that ties the in-process and distributed tiers together with one consistent API. It pairs naturally with the resilience story in [Polly vs the built-in resilience handlers in .NET 11](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/), since caching and retry both protect a slow dependency.

Caching is also the cheapest fix for the query problems you can see in [detecting N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): once a query is correct, caching its result keeps it off the hot path, which complements [compiled queries for EF Core hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). And because L2 serialization runs through `System.Text.Json` by default, the same rules from [writing a custom JsonConverter in System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) apply to anything you cache that needs custom serialization.

The mental model to keep: HybridCache gives you a two-tier cache, stampede protection per server, and logical tag invalidation, all behind `GetOrCreateAsync`. Redis becomes the L2 the moment you register an `IDistributedCache`. The two things it does not do, cluster-wide single-flight and cross-server L1 invalidation, are exactly the two things to design around with a short `LocalCacheExpiration` and, if you need it, your own pub/sub invalidation.

## Sources

- [HybridCache library in ASP.NET Core, Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid?view=aspnetcore-10.0)
- [Hello HybridCache! Streamlining Cache Management for ASP.NET Core Applications, .NET Blog](https://devblogs.microsoft.com/dotnet/hybrid-cache-is-now-ga/)
- [IBufferDistributedCache API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.caching.distributed.ibufferdistributedcache)
- [FusionCache HybridCache integration](https://github.com/ZiggyCreatures/FusionCache/blob/main/docs/MicrosoftHybridCache.md)
</content>
</invoke>
