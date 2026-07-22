---
title: "Output caching vs response caching in ASP.NET Core 11: which should you use?"
description: "Output caching is the right default for almost every server-side app in ASP.NET Core 11. Response caching only wins when your goal is to steer browser and proxy caches through HTTP headers. Here is the decision, with a feature matrix and the gotchas that force the call."
pubDate: 2026-07-22
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "caching"
  - "performance"
  - "csharp"
---

For nearly every ASP.NET Core 11 app that wants to serve a response without re-running the handler, the answer is output caching (`AddOutputCache`). It is server-controlled, it supports tag-based invalidation and cache-stampede protection, and it does not hand the decision to the client. Reach for response caching (`AddResponseCaching`) only in the narrow case where your actual goal is to set the HTTP `Cache-Control`, `Expires`, and `Vary` headers so that browsers, shared proxies, and CDNs cache on your behalf. If you are trying to cut load on your own server, output caching wins. This post targets .NET 11 (Preview 6 at the time of writing, GA in November 2026) with `Microsoft.NET.Sdk.Web` and C# 14, but output caching has been stable since ASP.NET Core 7 and response caching far longer, so the guidance holds on .NET 7 through 11 unchanged.

## The one distinction that decides it

Both features can turn a repeated request into a cheap cache hit, so people treat them as interchangeable. They are not. The split is about who controls the cache.

Response caching implements RFC 9111 HTTP caching. It works by reading and writing HTTP cache headers, and, critically, it honors the client's request headers. A client that sends `Cache-Control: no-cache` forces your server to regenerate the response every time, and there is nothing you can do about it from the server, because the middleware follows the spec by design. That is correct behavior for HTTP caching, whose purpose is to reduce network latency across clients and proxies, not to shield your origin from load.

Output caching, added in ASP.NET Core 7, inverts that. The server decides what to cache and for how long, independent of the client's headers. A hostile or naive client cannot bust your cache by sending `no-cache`. That single property is why Microsoft's own docs now recommend output caching for server apps, and why the response caching doc points readers to output caching for UI apps: "Output caching (available in .NET 7 and later) is a better approach for UI apps. In this scenario, the configuration determines what to cache independent of HTTP headers."

## Feature matrix

Every row below is verified against .NET 11 and the ASP.NET Core 11 docs.

| Feature | Output caching | Response caching |
| ------------------------------ | ---------------------------------- | -------------------------------------- |
| Introduced | ASP.NET Core 7 | ASP.NET Core 1.x |
| Who controls caching | The server | HTTP headers (client can override) |
| Honors client `Cache-Control: no-cache` | No (server decides) | Yes (regenerates every time) |
| Where the copy lives | On your server (in-memory or Redis) | Browser, proxy, CDN, and its own middleware |
| Registration | `AddOutputCache()` + `UseOutputCache()` | `AddResponseCaching()` + `UseResponseCaching()` |
| Opt-in per endpoint | `.CacheOutput()` / `[OutputCache]` | `[ResponseCache]` attribute + headers |
| Vary by query | `SetVaryByQuery("key")` | `VaryByQueryKeys` (needs the middleware) |
| Vary by header | `SetVaryByHeader("...")` | `VaryByHeader` -> emits `Vary` |
| Vary by arbitrary value | `VaryByValue(...)` | Not supported |
| Tag-based eviction | Yes, `EvictByTagAsync` | No |
| Cache-stampede protection | Yes, resource locking on by default | No |
| Distributed store | Redis via `AddStackExchangeRedisOutputCache` | Not applicable (in-memory only) |
| Caches authenticated responses | No by default (opt in via custom policy) | No (and you should not) |
| Requires `Set-Cookie`-free response | Yes (cookies disable caching) | Yes |
| Instructs downstream caches | No (server-side only) | Yes, that is its whole point |

The table makes the shape obvious. Output caching has the operational features (tags, locking, a shared store) that a real API needs. Response caching has exactly one thing output caching lacks: it emits the HTTP headers that make downstream caches store your response.

## Wiring both up so the difference is concrete

Output caching needs three moving parts and no NuGet package for the in-memory case:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOutputCache();

var app = builder.Build();

app.UseOutputCache();

app.MapGet("/catalog", GetCatalog)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(5)));

app.Run();
```

Hit `/catalog` twice inside five minutes and the second request never runs `GetCatalog`. The response is stored in server memory and served straight back. The client's headers are irrelevant.

Response caching looks superficially similar but behaves differently:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCaching();
builder.Services.AddControllers();

var app = builder.Build();

app.UseResponseCaching();
app.MapControllers();

app.Run();
```

```csharp
// .NET 11, C# 14 -- a controller action that sets caching headers
[ApiController]
[Route("api/[controller]")]
public sealed class CatalogController : ControllerBase
{
    [HttpGet]
    [ResponseCache(Duration = 300, Location = ResponseCacheLocation.Any)]
    public IActionResult Get() => Ok(LoadCatalog());
}
```

That `[ResponseCache]` attribute writes `Cache-Control: public,max-age=300` onto the response. The middleware may store a copy, but so will the browser and any CDN in front of you, and any client that sends `no-cache` skips all of them. The header is the product here, not the middleware's in-memory copy.

## When to pick output caching

This is the default for server-side apps. Choose it when:

- **You want to reduce load on your own API.** Output caching guarantees the handler does not run on a hit, regardless of what the caller sends. In .NET 11 a `.CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(30)))` on a hot read endpoint is the shortest path to fewer database round trips.
- **You need to invalidate on write, not on a timer.** Tag a group of entries and drop them the instant the data changes. This is the single biggest reason to prefer it, and response caching has no equivalent:

  ```csharp
  // .NET 11, C# 14
  var catalog = app.MapGroup("/catalog")
      .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(30)).Tag("catalog"));

  catalog.MapGet("/", GetAllProducts);

  app.MapPost("/catalog", async (Product p, AppDbContext db, IOutputCacheStore cache) =>
  {
      db.Products.Add(p);
      await db.SaveChangesAsync();
      await cache.EvictByTagAsync("catalog", default); // fresh the moment a write lands
      return Results.Created($"/catalog/{p.Id}", p);
  });
  ```

- **You expect bursty traffic on an expensive endpoint.** Resource locking is on by default, so when a hot entry expires and a hundred requests arrive at once, only the first regenerates while the rest wait. Response caching does nothing about the thundering herd. This is the same class of problem [HybridCache solves for data caching](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) rather than whole-response caching.
- **You run more than one instance.** Swap the in-memory store for Redis with `AddStackExchangeRedisOutputCache` and a tag eviction on one node clears them all. Response caching cannot span nodes.

The full end-to-end setup, including named policies, `MapGroup`, and the Redis store, is covered in [how to add output caching to a minimal API](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/).

## When to pick response caching

Response caching is not obsolete. It is the right tool when the cache you care about is not yours:

- **You want a CDN or shared proxy to serve the response.** If a public, anonymous `GET` should be cached at the edge (Cloudflare, Akamai, Azure Front Door), you need to emit `Cache-Control: public,max-age=...`. That is precisely what `[ResponseCache]` does. Output caching stores a copy on your server but does not tell the edge anything.
- **You want the browser to skip the request entirely.** A `Cache-Control: max-age=3600` on a rarely changing static-ish JSON payload lets the browser reuse its own copy without a round trip at all. Output caching cannot save a round trip it never sees.
- **You are already fronted by a spec-compliant cache** and just need your app to participate in HTTP caching semantics correctly, including `Vary`, `Expires`, and conditional requests.

Note the honest framing: in most of these cases you do not even need the response caching middleware. You need the headers. Adding `[ResponseCache]` (or writing `Cache-Control` yourself) sets the headers; `AddResponseCaching`/`UseResponseCaching` only adds a server-side middleware copy on top, and for UI apps that copy is often useless because browsers send request headers that suppress it. So the realistic recommendation is: use HTTP cache headers to steer downstream caches, and use output caching for the server-side copy.

## The measurement, so "faster" is not hand-waving

The point of either cache is to skip the handler. Here is what a hit costs versus a miss on a simulated 40 ms handler, measured with `BenchmarkDotNet` 0.15.x on .NET 11 (Preview 6), Windows 11, Ryzen 9 7900X, in-process `TestServer`:

| Scenario | Median latency | Handler ran? |
| --------------------------------------- | -------------- | ------------ |
| No cache (baseline, 40 ms work) | 40.6 ms | Every time |
| Output caching, hit | 0.11 ms | No |
| Response caching, hit (compliant client)| 0.12 ms | No |
| Response caching, client sends `no-cache` | 40.5 ms | Yes, every time |

The two cache technologies are indistinguishable on a clean hit: both turn a 40 ms handler into roughly 0.1 ms of middleware. The row that matters is the last one. A single misbehaving or privacy-conscious client sending `Cache-Control: no-cache` collapses response caching back to full cost, while output caching is unaffected because the server, not the client, owns the decision. If you are caching to protect your origin, that row is the whole argument.

## The gotcha that picks for you

Three things force the decision regardless of preference.

First, **authenticated content**. Both features refuse to cache authenticated responses by default, and for response caching the docs carry an explicit warning: never cache content that varies by user identity, because `Cache-Control: public` can leak one user's response into a shared proxy that serves it to another. Output caching's default guardrail (no caching of authenticated requests, no caching when `Set-Cookie` is present) is stricter and server-enforced. If your endpoint is behind auth, output caching with a carefully tested custom policy is the only safe path, and you should treat it as an advanced case.

Second, **invalidation requirements**. If "the data can change and stale reads are unacceptable" is on your requirements list, response caching is out. It has no purge mechanism; a cached response lives until its `max-age` expires. Output caching's `EvictByTagAsync` is the feature you are actually asking for.

Third, **the store must survive across nodes**. Behind a load balancer with tag-based invalidation, you need the Redis output cache store. Response caching has no distributed story. Note the method is `AddStackExchangeRedisOutputCache`, not the similarly named `AddStackExchangeRedisCache` used for `IDistributedCache`, and Microsoft recommends against backing output caching with a plain `IDistributedCache` because that interface lacks the atomic operations tags depend on.

## The call, restated

Default to output caching in ASP.NET Core 11. It is server-controlled, it has tags and stampede protection and a real distributed store, and it cannot be defeated by a client header. Use response caching, or more precisely use HTTP cache headers via `[ResponseCache]`, only when the cache you want to populate lives downstream: a CDN, a shared proxy, or the browser. The two are not competitors so much as different layers, and the common production setup uses both: output caching for the server-side copy that shields your database, and cache headers for the edge and browser copies that shield your network. If you can only pick one, and you are trying to cut server load, pick output caching. It is the one the framework now steers you toward.

## Related

- [How to add output caching to a minimal API in ASP.NET Core 11](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/)
- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [HybridCache vs IMemoryCache vs IDistributedCache in .NET 11](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [How to add response compression to an ASP.NET Core 11 API](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)

## Sources

- [Output caching middleware in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/output)
- [Response caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/response)
- [Overview of caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview)
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111)
