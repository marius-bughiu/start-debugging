---
title: "Redis key prefix vs separate database vs separate instance for multi-tenant caching in ASP.NET Core"
description: "Use a tenant key prefix on one shared Redis for almost every multi-tenant ASP.NET Core app, move only tenants with contractual isolation or noisy workloads to their own instance, and skip numbered databases: Redis Cluster, Azure Managed Redis and Redis Cloud only have database 0."
pubDate: 2026-10-07
template: vs
tags:
  - "comparison"
  - "redis"
  - "aspnetcore"
  - "dotnet"
  - "caching"
  - "multi-tenancy"
---

For a multi-tenant ASP.NET Core app, put every tenant on one shared Redis and isolate them with a key prefix such as `t:{tenantId}:`. It works on every Redis topology, plugs straight into `HybridCache` and `IDistributedCache`, and the prefix is something you need anyway because `HybridCache`'s in-process L1 is shared across tenants. Give a tenant its own Redis instance only when a contract, a compliance boundary, or a noisy workload demands it. Avoid numbered databases (`SELECT 3`): Redis Cluster, Azure Managed Redis and Redis Cloud only support database 0, and the isolation they offer is weaker than it looks.

Everything below was compile-checked on .NET SDK 10.0.302 targeting `net10.0`, with `Microsoft.Extensions.Caching.StackExchangeRedis` 10.0.12, `Microsoft.Extensions.Caching.Hybrid` 10.10.0 and `StackExchange.Redis` 3.3.1. The same APIs exist in the 11.0.0-rc.1 packages for .NET 11.

## The three options side by side

| | Key prefix, shared instance | Numbered database per tenant | Instance per tenant |
| --- | --- | --- | --- |
| How a tenant is separated | `t:42:` in front of every key | `SELECT 42` on the connection | Different host and credentials |
| Works on Redis Cluster / Azure Managed Redis / Redis Cloud | Yes | No, database 0 only | Yes |
| Max tenants | Unlimited | 16 by default (`databases` config) | Your budget |
| Memory limit and eviction | Shared | Shared (`maxmemory` is per server) | Separate |
| CPU and latency isolation | None | None | Full |
| Access control per tenant | ACL key patterns `~t:42:*` (Redis 7+) | Only Valkey 9.1+ (`db=` rule) | Separate credentials |
| Wipe one tenant | `SCAN` + `DEL`, or `HybridCache` tag | `FLUSHDB` | Delete the instance |
| Works with one `AddHybridCache()` | Yes | Needs a routing `IDistributedCache` | Needs a routing `IDistributedCache` |
| Connections per app instance | 1 multiplexer | 1 multiplexer per database in use | 1 multiplexer per tenant |
| Cost | Lowest | Lowest | Highest |

Numbered databases look like the middle ground. In practice they share every limit that matters with the prefix approach and add restrictions the prefix approach does not have.

## Why numbered databases are the trap

Redis's own [`SELECT` documentation](https://redis.io/docs/latest/commands/select/) is blunt: databases are for separating keys "within the same application", not for running unrelated workloads on one server. Then it adds that "Redis Cluster only supports database zero". That single sentence rules out a large part of the managed market:

- **Azure Managed Redis** is "internally configured to use clustering, across all tiers and SKUs" per its [architecture page](https://learn.microsoft.com/en-us/azure/redis/architecture), and runs on Redis Enterprise.
- **Redis Software and Redis Cloud** do not support shared databases at all. The `SELECT` page says the command is "supported solely for compatibility" and does not perform any operations there. If your code relies on `SELECT` for isolation and you migrate to one of these, every tenant silently lands in the same keyspace. That is the worst possible failure mode for multi-tenancy: no error, just data leaking across tenants.
- **Redis OSS in cluster mode** (including most cluster-mode managed offerings) rejects anything other than database 0.

The only exception is Valkey: [Valkey 9.0](https://www.linuxfoundation.org/press/valkey-9.0-delivers-performance-and-resiliency-for-real-time-workloads) added numbered databases in cluster mode, and [Valkey 9.1 added `db=` ACL rules](https://valkey.io/commands/acl-setuser/) so a user can be restricted to specific databases. If you run Valkey 9.1+ and never plan to move off it, databases become defensible. Everywhere else, picking databases ties your tenancy model to one hosting topology.

Even where databases work, they do not isolate the things tenants actually fight over. `maxmemory` and the eviction policy apply to the whole server, so one tenant filling its database evicts keys from everyone else's. Redis executes commands on one main thread, so a tenant running a slow `KEYS *` stalls all databases. And with the default `databases 16`, you run out of tenants before you run out of customers.

The other practical problem is on the .NET side. `RedisCache`, the `IDistributedCache` implementation behind `AddStackExchangeRedisCache`, calls `connection.GetDatabase()` with no argument, as you can see in [RedisCache.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCache.cs). It always talks to the connection's `DefaultDatabase`. To reach database 7 you need a `RedisCache` built from a `ConfigurationOptions` with `DefaultDatabase = 7`, which means a separate `ConnectionMultiplexer` per database in use, which is exactly the overhead the shared multiplexer is supposed to avoid.

## The key prefix approach, done properly

`RedisCacheOptions.InstanceName` is documented as a way to partition "a single backend cache for use with multiple apps/services". It is a process-wide prefix, so use it for the app name and put the tenant into each key:

```csharp
// .NET 10, ASP.NET Core 10
// Microsoft.Extensions.Caching.StackExchangeRedis 10.0.12
// Microsoft.Extensions.Caching.Hybrid 10.10.0, StackExchange.Redis 3.3.1
using Microsoft.Extensions.Caching.Hybrid;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

var mux = await ConnectionMultiplexer.ConnectAsync(
    builder.Configuration.GetConnectionString("redis")!);
builder.Services.AddSingleton<IConnectionMultiplexer>(mux);

builder.Services.AddStackExchangeRedisCache(o =>
{
    // share the multiplexer instead of opening a second connection
    o.ConnectionMultiplexerFactory = () => Task.FromResult<IConnectionMultiplexer>(mux);
    o.InstanceName = "myapp:"; // note the trailing delimiter
});
builder.Services.AddHybridCache();

builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ITenantContext, ClaimTenantContext>();
builder.Services.AddScoped<TenantCache>();

var app = builder.Build();

app.MapGet("/products/{id:int}", async (int id, TenantCache cache) =>
    await cache.GetOrCreateAsync($"product:{id}",
        ct => ValueTask.FromResult($"product {id}")));

app.Run();
```

The tenant comes from a trusted source, never from a header or query string the client controls. Here it is a claim on the authenticated user:

```csharp
// .NET 10, C# 14
public interface ITenantContext { string TenantId { get; } }

public sealed class ClaimTenantContext(IHttpContextAccessor accessor) : ITenantContext
{
    public string TenantId =>
        accessor.HttpContext?.User.FindFirst("tenant_id")?.Value
        ?? throw new InvalidOperationException("No tenant on this request.");
}
```

The important part is that application code never builds a raw cache key. It goes through a scoped wrapper that adds the tenant every time, so a developer cannot forget it:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.Hybrid 10.10.0
public sealed class TenantCache(HybridCache cache, ITenantContext tenant)
{
    private string Key(string key) => $"t:{tenant.TenantId}:{key}";
    private string TenantTag => $"tenant:{tenant.TenantId}";

    public ValueTask<T> GetOrCreateAsync<T>(
        string key,
        Func<CancellationToken, ValueTask<T>> factory,
        HybridCacheEntryOptions? options = null,
        IEnumerable<string>? tags = null,
        CancellationToken ct = default) =>
        cache.GetOrCreateAsync(
            Key(key),
            factory,
            static (f, c) => f(c),
            options,
            [TenantTag, .. (tags ?? []).Select(t => $"{TenantTag}:{t}")],
            ct);

    public ValueTask RemoveAsync(string key, CancellationToken ct = default) =>
        cache.RemoveAsync(Key(key), ct);

    // logical wipe of everything this tenant cached
    public ValueTask InvalidateTenantAsync(CancellationToken ct = default) =>
        cache.RemoveByTagAsync(TenantTag, ct);
}
```

In Redis the product entry for tenant 42 ends up as the hash `myapp:t:42:product:7`. Tags are prefixed too: `HybridCache` tags are global strings, so an unprefixed `RemoveByTagAsync("products")` from one tenant would invalidate every tenant's product entries.

If you use `IDatabase` directly for counters, locks or sets, StackExchange.Redis has the same idea built in through `StackExchange.Redis.KeyspaceIsolation`:

```csharp
// StackExchange.Redis 3.3.1
using StackExchange.Redis.KeyspaceIsolation;

IDatabase tenantDb = mux.GetDatabase().WithKeyPrefix($"myapp:t:{tenantId}:");
await tenantDb.StringIncrementAsync("logins"); // writes myapp:t:42:logins
```

## The L1 problem that settles the debate

Here is the detail that makes the prefix mandatory, whichever option you pick. `HybridCache` is a two-level cache, and its L1 is an in-process `MemoryCache` shared by every request in the process. Suppose you route tenant 42 to its own Redis instance and keep the cache key as plain `product:7`. The L2 lookup goes to the right server, but the L1 lookup happens first, and `product:7` from tenant 41 is already sitting in memory. Tenant 42 gets tenant 41's product.

So separate databases and separate instances do not remove the need for tenant-scoped keys. They add a second isolation mechanism on top of the one you still have to build. Once the prefix exists, the remaining question is only whether some tenants need more than key-level separation.

The same applies to output caching. `AddStackExchangeRedisOutputCache` has its own `InstanceName`, and the cache key must vary by tenant (`VaryByValue` on the tenant claim) regardless of where the entries are stored.

## When a separate instance is the right call

A separate Redis per tenant is not the default, but it is a legitimate tier. Pick it when:

- **A contract or regulator requires it.** Data residency in a specific region, a customer-managed encryption key, or "no shared infrastructure" in an enterprise agreement. Key prefixes do not satisfy an auditor asking for physical separation.
- **One tenant's workload is big enough to hurt the others.** A tenant with 40 GB of hot data or a bursty batch job will evict everyone else's keys on a shared `maxmemory`. Moving it out restores predictable hit rates for the rest.
- **You need per-tenant eviction policy or persistence.** `maxmemory-policy`, AOF and RDB settings are server-wide.
- **Tenant offboarding must be provably complete.** Deleting an instance is easier to prove than "we scanned and deleted every key".

The usual shape is a pool model with a premium silo: everyone on the shared, prefixed instance, a short list of tenants mapped to dedicated instances. Because `AddHybridCache()` wires exactly one L2, the routing has to live in an `IDistributedCache` that picks the backend per call:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.StackExchangeRedis 10.0.12
using System.Collections.Concurrent;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Caching.StackExchangeRedis;

public sealed class TenantRoutingCache(
    IHttpContextAccessor accessor,
    IConfiguration config,
    [FromKeyedServices("shared")] IDistributedCache shared) : IDistributedCache
{
    private readonly ConcurrentDictionary<string, IDistributedCache> _dedicated = new();

    private IDistributedCache Current()
    {
        var tenant = accessor.HttpContext?.User.FindFirst("tenant_id")?.Value;
        var cs = tenant is null ? null : config[$"Tenants:{tenant}:Redis"];
        if (cs is null) return shared;

        return _dedicated.GetOrAdd(tenant!, _ => new RedisCache(
            new RedisCacheOptions { Configuration = cs, InstanceName = "myapp:" }));
    }

    public byte[]? Get(string key) => Current().Get(key);
    public Task<byte[]?> GetAsync(string key, CancellationToken token = default) =>
        Current().GetAsync(key, token);
    public void Set(string key, byte[] value, DistributedCacheEntryOptions options) =>
        Current().Set(key, value, options);
    public Task SetAsync(string key, byte[] value, DistributedCacheEntryOptions options,
        CancellationToken token = default) => Current().SetAsync(key, value, options, token);
    public void Refresh(string key) => Current().Refresh(key);
    public Task RefreshAsync(string key, CancellationToken token = default) =>
        Current().RefreshAsync(key, token);
    public void Remove(string key) => Current().Remove(key);
    public Task RemoveAsync(string key, CancellationToken token = default) =>
        Current().RemoveAsync(key, token);
}
```

Register the shared `RedisCache` as a keyed service and the router as the unkeyed `IDistributedCache` that `HybridCache` resolves. The keys still carry the tenant prefix from `TenantCache`, which keeps L1 safe. Two things to know about this router: it depends on `HttpContext`, so background jobs must establish the tenant some other way (an `AsyncLocal` set by the job runner works), and it bypasses `RedisCache`'s `IBufferDistributedCache` fast path because it only implements the base interface. For a handful of premium tenants that trade-off is fine.

Each dedicated `RedisCache` owns one multiplexer. A multiplexer is designed to be shared and long-lived, so cache these instances for the life of the process and never create them per request. With 20 dedicated tenants and 10 app pods you are holding 200 extra Redis connections, which is where the per-tenant instance model stops scaling and why it should stay a tier rather than the default.

## Gotchas with key prefixes

**Always end the prefix with a delimiter.** `RedisCache` concatenates `InstanceName` and the key with no separator. The [HybridCache key guidance](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid) gives the classic example: `order{customerId}{orderId}` makes customer 42 with order 123 and customer 421 with order 23 both `order42123`. The same thing happens with tenants: tenant `7` plus key `42:profile` and tenant `74` plus key `2:profile` collide if you write `t{tenant}{key}`. Use `t:{tenant}:` and make sure tenant ids cannot contain `:`.

**Deleting a tenant's keys is a scan, not a command.** `RemoveByTagAsync($"tenant:{id}")` is the cheap option, but it is a logical invalidation: the docs say values stay in Redis "until they expire in the usual way". When you must physically remove data (offboarding, GDPR erasure), scan every primary:

```csharp
// StackExchange.Redis 3.3.1
public static async Task<long> PurgeTenantAsync(IConnectionMultiplexer mux, string tenantId)
{
    var db = mux.GetDatabase();
    long deleted = 0;
    foreach (var endpoint in mux.GetEndPoints())
    {
        var server = mux.GetServer(endpoint);
        if (server.IsReplica) continue;

        await foreach (var key in server.KeysAsync(pattern: $"myapp:t:{tenantId}:*", pageSize: 500))
        {
            // one DEL per key: in a cluster, keys from one node can span many hash slots
            if (await db.KeyDeleteAsync(key)) deleted++;
        }
    }
    return deleted;
}
```

`KeysAsync` uses `SCAN` under the hood, and in a cluster it only sees keys on that node, which is why the loop goes over every endpoint. The [StackExchange.Redis docs](https://seredis.dev/KeysScan) still warn against running it on busy production servers, so do it in a background job with a modest page size.

**Do not use hash tags for tenants.** Writing keys as `{t:42}:product:7` forces all of a tenant's keys into one hash slot, which allows multi-key operations but also pins the whole tenant to one shard. Your largest tenant becomes a hot shard. Leave the tenant out of braces unless you really need cross-key transactions.

**Add ACLs if tenants have direct Redis access.** Normally only your app talks to Redis, so the prefix is enforced by code review and the `TenantCache` wrapper. If a tenant-specific worker gets its own credentials, Redis 7 ACL key patterns enforce the prefix server-side: `ACL SETUSER tenant42 on >secret ~myapp:t:42:* +@read +@write`.

**Prefix length is overhead on every key.** `myapp:t:` plus a GUID tenant id is 44 bytes before the actual key. On a cache with tens of millions of small entries that is real memory. A short integer or base-36 tenant id keeps it negligible, and keeps you far from `HybridCache`'s 1024-character `MaximumKeyLength`.

## The recommendation, with the reasons

Use a key prefix on a shared Redis. It runs on every topology from a local container to Azure Managed Redis with OSS clustering, it is the only option that composes with a single `AddHybridCache()` call, and the tenant has to be in the key anyway because of the shared L1. Add a dedicated-instance tier, routed through an `IDistributedCache` like the one above, for the tenants whose contracts or workloads justify paying for isolation. Skip numbered databases unless you are committed to Valkey 9.1+: they give you `FLUSHDB` and per-database key counts in `INFO keyspace`, but they share memory and CPU with every other tenant and they disappear the moment you move to a clustered or enterprise Redis.

## Related

- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) covers the base wiring this post builds on.
- [HybridCache vs IMemoryCache vs IDistributedCache in .NET 11](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) explains the L1/L2 split that makes tenant keys mandatory.
- [Output caching in a minimal API](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) shows `VaryByValue` for per-tenant output cache entries.
- [Keyed services in .NET dependency injection](/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) is how the shared and routed caches are registered side by side.
- [Named query filters in EF Core 11](/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/) is the database-side counterpart for tenant isolation.

## Sources

- [Redis `SELECT` command](https://redis.io/docs/latest/commands/select/), including the cluster and Redis Software notes.
- [Azure Managed Redis architecture](https://learn.microsoft.com/en-us/azure/redis/architecture) for the clustering and cluster policy details.
- [Valkey `ACL SETUSER`](https://valkey.io/commands/acl-setuser/) for key patterns and the 9.1 `db=` rules.
- [RedisCacheOptions.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCacheOptions.cs) and [RedisCache.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCache.cs) for how `InstanceName` and the database are applied.
- [HybridCache library in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid) for key guidance and tag invalidation semantics.
- [StackExchange.Redis: KEYS, SCAN, FLUSHDB etc](https://seredis.dev/KeysScan) for scanning in clusters.
