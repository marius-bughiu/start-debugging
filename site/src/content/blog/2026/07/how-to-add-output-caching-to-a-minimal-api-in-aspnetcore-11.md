---
title: "How to add output caching to a minimal API in ASP.NET Core 11"
description: "A complete, working guide to output caching in an ASP.NET Core 11 minimal API: AddOutputCache and UseOutputCache, CacheOutput on endpoints and MapGroup, named and base policies, Expire, VaryByQuery and VaryByHeader, tag-based eviction with EvictByTagAsync, cache stampede protection, ETag revalidation, and a Redis backing store."
pubDate: 2026-07-12
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "performance"
  - "caching"
---

To add output caching to a minimal API in ASP.NET Core 11 you need exactly three moving parts: register the services with `builder.Services.AddOutputCache()`, add the middleware with `app.UseOutputCache()`, and mark the endpoints you want cached with `.CacheOutput()`. That is enough to cache a whole HTTP response in memory and serve it back without re-running your handler. Everything past that (expiration windows, per-query cache keys, tag-based invalidation, a Redis backing store) is refinement. This post walks the full path end to end. It targets .NET 11 (Preview 5 at the time of writing, GA in November 2026) with `Microsoft.NET.Sdk.Web` and C# 14, but the output caching API has been stable since ASP.NET Core 7, so every step here works unchanged on .NET 8, 9, and 10.

## Output caching is not response caching

The first thing to get straight, because it trips up almost everyone: output caching and response caching are different features that solve different problems.

Response caching (`AddResponseCaching`) is the older middleware. It participates in HTTP caching: it reads and writes `Cache-Control`, `Vary`, and `Expires` headers, and it only caches when the response opts in with the right headers. It is really a shared-proxy cache that lives inside your app, and it is easy to get wrong because a stray `Set-Cookie` or a missing `Cache-Control: public` silently disables it.

Output caching (`AddOutputCache`, added in ASP.NET Core 7) is server-controlled. The server decides what to cache and for how long, regardless of the client's request headers. It supports cache key variation on arbitrary values, tag-based eviction so you can purge a group of entries when the underlying data changes, and built-in protection against cache stampede. For an API where you own both ends, output caching is almost always the one you want. This post is entirely about output caching.

## Wire up the three moving parts

Output caching lives in the shared framework, so there is no NuGet package to install for the in-memory case. Register the services and add the middleware:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOutputCache();

var app = builder.Build();

app.UseOutputCache();

app.MapGet("/time", () => new { now = DateTime.UtcNow })
    .CacheOutput();

app.Run();
```

Three things to notice. First, `AddOutputCache()` and `UseOutputCache()` on their own do nothing: they make caching available but do not cache anything until an endpoint opts in. Second, `.CacheOutput()` with no arguments applies the default policy, which caches for 60 seconds. Hit `/time` twice within a minute and you will get the same timestamp back, because the second request never runs your lambda.

Third, and this is the one that causes production bugs: middleware order matters. `UseOutputCache()` must sit after `UseCors()`, after `UseAuthentication()`, and after `UseAuthorization()`. If it runs before authorization, the middleware can serve a response cached for an anonymous user to an authenticated one, or vice versa. In Razor Pages and controller apps it must also come after `UseRouting()`. The minimal `WebApplication` host wires routing for you, but if you add auth you are responsible for the ordering:

```csharp
// .NET 11, C# 14 -- correct ordering with auth
app.UseAuthentication();
app.UseAuthorization();
app.UseOutputCache();   // after auth, not before
```

## Set an expiration window with a named policy

The default 60-second window is rarely what you want. To control it, call `.CacheOutput()` with an inline builder, or define a named policy once and reference it by name. Named policies keep `Program.cs` readable when several endpoints share the same settings:

```csharp
// .NET 11, C# 14
builder.Services.AddOutputCache(options =>
{
    options.AddPolicy("Short", policy => policy.Expire(TimeSpan.FromSeconds(10)));
    options.AddPolicy("Long", policy => policy.Expire(TimeSpan.FromMinutes(30)));
});
```

Then select a policy per endpoint by name:

```csharp
// .NET 11, C# 14
app.MapGet("/prices", GetPrices).CacheOutput("Short");
app.MapGet("/catalog", GetCatalog).CacheOutput("Long");
```

If you would rather keep the configuration next to the endpoint, the inline form does the same thing without a registered policy:

```csharp
// .NET 11, C# 14
app.MapGet("/prices", GetPrices)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(10)));
```

There is also an `[OutputCache]` attribute if you prefer attributes on a handler, which is the form controllers use. On a minimal API endpoint it looks like `app.MapGet("/x", [OutputCache(PolicyName = "Short")] () => ...)`, but the fluent `.CacheOutput("Short")` reads better and is the convention most minimal API code follows.

## Cache a whole route group at once

Repeating `.CacheOutput()` on every endpoint gets old fast. Because `MapGroup` returns a `RouteGroupBuilder` that shares conventions, you can attach output caching to the group and every endpoint inside inherits it. This composes cleanly with the per-resource endpoint modules covered in [organizing minimal API endpoints with MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/):

```csharp
// .NET 11, C# 14
var catalog = app.MapGroup("/catalog")
    .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(5)).Tag("catalog"));

catalog.MapGet("/", GetAllProducts);
catalog.MapGet("/{id:int}", GetProduct);
```

Both endpoints now cache for five minutes and carry the `catalog` tag, which matters for the invalidation step below.

## Control the cache key so you do not serve the wrong response

By default the cache key is the full URL: scheme, host, port, path, and the entire query string. That means `/search?q=widgets` and `/search?q=gadgets` are separate entries automatically, which is usually correct. But two cases need explicit handling.

The first: you want to vary on a specific query value and ignore the rest. `SetVaryByQuery` restricts the key to the query keys you name, so tracking parameters like `utm_source` do not fragment your cache into thousands of near-identical entries:

```csharp
// .NET 11, C# 14 -- cache per culture, ignore everything else in the query
app.MapGet("/articles", GetArticles)
    .CacheOutput(policy => policy
        .Expire(TimeSpan.FromMinutes(10))
        .SetVaryByQuery("culture"));
```

The second: you serve different content based on a request header, such as `Accept-Language` or a custom API version header. Use `SetVaryByHeader` so each header value gets its own entry:

```csharp
// .NET 11, C# 14
app.MapGet("/articles", GetArticles)
    .CacheOutput(policy => policy.SetVaryByHeader("Accept-Language"));
```

For anything the URL and headers cannot express, `VaryByValue` lets you compute a key fragment from the `HttpContext`. This is how you vary on a tenant id resolved from a claim, or on an A/B bucket:

```csharp
// .NET 11, C# 14 -- separate cache entry per tenant
app.MapGet("/dashboard", GetDashboard)
    .CacheOutput(policy => policy.VaryByValue(context =>
        new KeyValuePair<string, string>(
            "tenant", context.User.FindFirst("tenant")?.Value ?? "public")));
```

One caution with `VaryByValue` on user-specific data: output caching by default refuses to cache responses to authenticated requests at all, precisely to avoid leaking one user's response to another. If you deliberately override that (see the custom policy section), varying by a per-user value is what keeps the entries separate, and getting it wrong is a data-leak bug, not a performance bug. Treat authenticated output caching as an advanced case and test it hard.

## Invalidate on demand with tags

Time-based expiration is a blunt instrument. If your catalog changes twice a day but you cache for five minutes, you are serving stale data for up to five minutes every time and re-fetching pointlessly the rest of the time. Tags fix this: attach a tag to the cache entries, then evict by tag the moment the underlying data changes.

You saw `.Tag("catalog")` on the group above. To purge it, inject `IOutputCacheStore` and call `EvictByTagAsync`. The natural place for this is inside the write operation that changed the data, not a separate admin endpoint:

```csharp
// .NET 11, C# 14
app.MapPost("/catalog", async (Product product, AppDbContext db, IOutputCacheStore cache) =>
{
    db.Products.Add(product);
    await db.SaveChangesAsync();

    // The catalog changed, so drop every cached catalog response.
    await cache.EvictByTagAsync("catalog", default);

    return Results.Created($"/catalog/{product.Id}", product);
});
```

Now the cache serves instant reads and stays fresh: a five-minute (or even one-hour) expiration is a safety net, and the real invalidation happens exactly when a write lands. If you tie the `EvictByTagAsync` call to the same `SaveChanges` that mutates the row, readers never see data older than the last successful write. This pairs well with tracking down the queries behind those writes; if a read endpoint is slow enough that you are reaching for caching, it is worth ruling out an [N+1 query in EF Core](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) first, because caching a slow query just hides the problem.

You can register tags declaratively on a base policy too, which tags every matching endpoint without touching each one:

```csharp
// .NET 11, C# 14
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy
        .With(c => c.HttpContext.Request.Path.StartsWithSegments("/catalog"))
        .Tag("catalog"));
});
```

## Base policies apply everywhere by default

`AddBasePolicy` differs from `AddPolicy` in one important way: a base policy applies to all endpoints (or all endpoints matching its `With` predicate) without any `.CacheOutput()` call on the endpoint. It is how you set a default expiration or tagging scheme across the whole app:

```csharp
// .NET 11, C# 14 -- cache everything for 30 seconds unless overridden
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy.Expire(TimeSpan.FromSeconds(30)));
});
```

Be deliberate here. A blanket base policy will happily cache endpoints you never meant to cache. Scope it with `.With(...)` to a path prefix, or prefer explicit per-endpoint `.CacheOutput()` calls if your API mixes cacheable reads and non-cacheable writes, which most do.

## What the default policy will and will not cache

Even after you opt an endpoint in, output caching applies guardrails. Out of the box it caches only when:

- The response status is `HTTP 200`.
- The request method is `GET` or `HEAD`.
- The response sets no cookies (any `Set-Cookie` disables caching for that response).
- The request is not authenticated.

These rules are why `.CacheOutput()` on a `POST` endpoint appears to do nothing: `POST` is excluded by default. They exist to keep you from caching something unsafe by accident. If you genuinely need to cache a `POST`, or cache `301` responses, or cache authenticated responses, you write a custom `IOutputCachePolicy` and opt in explicitly:

```csharp
// .NET 11, C# 14 -- excerpt of a custom policy that allows POST
public sealed class CachePostPolicy : IOutputCachePolicy
{
    public static readonly CachePostPolicy Instance = new();

    ValueTask IOutputCachePolicy.CacheRequestAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
    {
        var request = context.HttpContext.Request;
        var attempt = HttpMethods.IsGet(request.Method)
                   || HttpMethods.IsHead(request.Method)
                   || HttpMethods.IsPost(request.Method);

        context.EnableOutputCaching = true;
        context.AllowCacheLookup = attempt;
        context.AllowCacheStorage = attempt;
        context.AllowLocking = true;
        context.CacheVaryByRules.QueryKeys = "*";
        return ValueTask.CompletedTask;
    }

    ValueTask IOutputCachePolicy.ServeFromCacheAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;

    ValueTask IOutputCachePolicy.ServeResponseAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;
}
```

Register it as a named policy with `options.AddPolicy("CachePost", CachePostPolicy.Instance)` and select it with `.CacheOutput("CachePost")`. Caching a `POST` is unusual and you should have a specific reason, but the extension point is there.

## Stampede protection is on by default

When a hot cache entry expires and a hundred requests arrive at once, a naive cache lets all hundred miss and hammer your database simultaneously. That is a cache stampede, or thundering herd. Output caching mitigates it with resource locking: when an entry is being generated, concurrent requests for the same key wait for the first one to finish rather than each generating their own. This is on by default and is one of the concrete advantages over hand-rolled `IMemoryCache` code, which does not do this unless you build it yourself.

You can turn locking off per policy with `SetLocking(false)` if an endpoint is cheap to generate and you would rather not have requests wait:

```csharp
// .NET 11, C# 14
app.MapGet("/cheap", GetCheapThing)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(5)).SetLocking(false));
```

Leave it on for anything expensive. Stampede protection is exactly what you want under load, and it is the same class of problem [HybridCache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) solves for data caching rather than whole-response caching.

## Cheap revalidation with ETags

Output caching also cooperates with HTTP conditional requests. If your handler sets an `ETag` header, the middleware will answer a matching `If-None-Match` with a `304 Not Modified` and an empty body instead of resending the whole payload. For a large response served to a client that already has it, that turns a full transfer into a few bytes:

```csharp
// .NET 11, C# 14
app.MapGet("/report", async (HttpContext context) =>
{
    context.Response.Headers.ETag = $"\"{ComputeReportVersion()}\"";
    await WriteReport(context);
}).CacheOutput();
```

No extra configuration is needed beyond enabling output caching. The same works with `If-Modified-Since` against the cache entry's creation time.

## Tune the limits and, when you scale out, move to Redis

Two `OutputCacheOptions` limits are worth knowing before you ship. `MaximumBodySize` defaults to 64 MB: a response larger than that is never cached, which is a sensible default but a silent one if you wondered why a big export never caches. `SizeLimit` defaults to 100 MB of total cache storage, after which new entries wait for old ones to evict. `DefaultExpirationTimeSpan` is the 60 seconds you get when a policy sets no explicit `Expire`.

The default store is in-process memory, which means each server instance has its own cache and it evaporates on restart. Behind a load balancer with several instances, that is often fine for read-heavy endpoints, but it does mean a `tag` eviction on one node does not clear the others. When you need a shared cache that survives restarts and evicts consistently across nodes, add the Redis store. It is a separate package:

```bash
dotnet add package Microsoft.AspNetCore.OutputCaching.StackExchangeRedis
```

```csharp
// .NET 11, C# 14
builder.Services.AddStackExchangeRedisOutputCache(options =>
{
    options.Configuration = builder.Configuration.GetConnectionString("Redis");
    options.InstanceName = "MyApp";
});

builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy.Expire(TimeSpan.FromSeconds(30)));
});
```

Note the method is `AddStackExchangeRedisOutputCache`, not the similarly named `AddStackExchangeRedisCache` used for `IDistributedCache`. That distinction matters, because Microsoft explicitly recommends against backing output caching with a plain `IDistributedCache`: that interface lacks the atomic operations tag-based eviction depends on, so tags would not evict reliably. Use the built-in Redis output cache store or a custom `IOutputCacheStore`, not `IDistributedCache`.

## The shape to remember

Output caching in a minimal API comes down to a small, composable set of pieces. Register with `AddOutputCache`, insert `UseOutputCache` after your auth middleware, and opt endpoints in with `.CacheOutput()` or a group-level `.CacheOutput()`. Reach for `Expire` to set the window, `SetVaryByQuery` and `SetVaryByHeader` to keep keys correct, and `Tag` plus `EvictByTagAsync` to invalidate the instant your data changes rather than waiting out a timer. Leave stampede protection on for expensive work, respect the default guardrails that keep authenticated and cookie-bearing responses out of the cache, and swap the in-memory store for Redis only when you actually run more than one instance. That covers the large majority of real APIs, and every line above runs on .NET 8 through .NET 11 unchanged.

## Related

- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [HybridCache vs IMemoryCache vs IDistributedCache in .NET 11](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [How to add per-endpoint rate limiting in ASP.NET Core 11](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/)

## Sources

- [Output caching middleware in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/output)
- [Overview of caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview)
- [IOutputCacheStore.EvictByTagAsync (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.outputcaching.ioutputcachestore.evictbytagasync)
- [OutputCachePolicyBuilder (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.outputcaching.outputcachepolicybuilder)
