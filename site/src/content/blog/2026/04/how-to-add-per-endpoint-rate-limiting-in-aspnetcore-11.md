---
title: "How to add per-endpoint rate limiting in ASP.NET Core 11"
description: "A complete guide to per-endpoint rate limiting in ASP.NET Core 11: when to pick fixed window vs sliding window vs token bucket vs concurrency, how RequireRateLimiting and [EnableRateLimiting] differ, partitioning by user or IP, the OnRejected handler, and the distributed deployment pitfall everyone hits."
pubDate: 2026-04-30
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "rate-limiting"
---

To rate limit a specific endpoint in ASP.NET Core 11, register a named policy in `AddRateLimiter`, call `app.UseRateLimiter()` after routing, and attach the policy to the endpoint with `RequireRateLimiting("name")` on a minimal API or `[EnableRateLimiting("name")]` on an MVC action. The runtime ships four built-in algorithms in `Microsoft.AspNetCore.RateLimiting`: fixed window, sliding window, token bucket, and concurrency. The middleware returns `429 Too Many Requests` when a request is rejected and exposes an `OnRejected` callback for custom responses, including `Retry-After`. This guide covers .NET 11 preview 3 with C# 14, but the API has been stable since .NET 7 and every code sample compiles unchanged on .NET 8, 9, and 10.

## Why "global" rate limiting is rarely what you want

The simplest setup, a single global limiter that drops requests when the whole process is over budget, is appealing for about ten seconds. Then you realise the login endpoint and the static health probe share that budget. A botnet hammering `/login` will gladly take down `/health`, and your load balancer will pull the instance out of rotation because the cheap probe started returning 429s.

Per-endpoint limiting fixes that. Each endpoint declares its own policy with limits tuned to its actual cost: `/login` gets a tight per-IP token bucket, `/api/search` gets a generous sliding window, the file-upload endpoint gets a concurrency limiter, and `/health` gets nothing. The global limiter, if you keep one, becomes a backstop for protocol-level abuse rather than the primary defense.

The `Microsoft.AspNetCore.RateLimiting` middleware was promoted out of preview in .NET 7 and has only had quality-of-life refinements since. It is a first-class part of the framework in .NET 11, with no extra NuGet package to install.

## The minimal Program.cs

Here is the smallest setup that adds two distinct per-endpoint policies, applies one to a minimal API endpoint, and lets the rest of the app run unthrottled.

```csharp
// .NET 11 preview 3, C# 14
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddFixedWindowLimiter(policyName: "search", o =>
    {
        o.PermitLimit = 30;
        o.Window = TimeSpan.FromSeconds(10);
        o.QueueLimit = 0;
    });

    options.AddTokenBucketLimiter(policyName: "login", o =>
    {
        o.TokenLimit = 5;
        o.TokensPerPeriod = 5;
        o.ReplenishmentPeriod = TimeSpan.FromMinutes(1);
        o.QueueLimit = 0;
        o.AutoReplenishment = true;
    });
});

var app = builder.Build();

app.UseRateLimiter();

app.MapGet("/api/search", (string q) => Results.Ok(new { q }))
   .RequireRateLimiting("search");

app.MapPost("/api/login", (LoginRequest body) => Results.Ok())
   .RequireRateLimiting("login");

app.MapGet("/health", () => Results.Ok("ok"));

app.Run();

record LoginRequest(string Email, string Password);
```

Two things to notice. First, `RejectionStatusCode` defaults to `503 Service Unavailable`, which is wrong for almost every public API. Set it to `429` once, in `AddRateLimiter`, and forget it. Second, `app.UseRateLimiter()` must come after `app.UseRouting()` if you call routing explicitly, because the middleware reads endpoint metadata to decide which policy applies. The built-in `WebApplication` adds routing automatically before terminal middleware, so the explicit `UseRouting` call is only required if you have other middleware that needs to sit between routing and rate limiting.

## RequireRateLimiting vs [EnableRateLimiting]

ASP.NET Core has two equally valid ways to attach a policy to an endpoint, and they exist because minimal APIs and MVC have different metadata stories.

For minimal APIs and endpoint groups, the fluent `RequireRateLimiting` method on `IEndpointConventionBuilder` is the right call:

```csharp
// .NET 11, C# 14
var api = app.MapGroup("/api/v1").RequireRateLimiting("search");

api.MapGet("/products", (...) => ...);          // inherits "search"
api.MapGet("/orders", (...) => ...);            // inherits "search"
api.MapPost("/login", (...) => ...)
   .RequireRateLimiting("login");               // overrides to "login"
```

Endpoint-level metadata wins over group-level metadata, so the override on `/login` does what you would expect: only the most specific policy on the endpoint is applied.

For MVC controllers, the attribute form is the right call:

```csharp
// .NET 11, C# 14
[ApiController]
[Route("api/[controller]")]
[EnableRateLimiting("search")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok(/* ... */);

    [HttpGet("{id}")]
    [EnableRateLimiting("hot")]    // narrower policy for a hot endpoint
    public IActionResult Get(int id) => Ok(/* ... */);

    [HttpPost("import")]
    [DisableRateLimiting]          // bypass entirely for an internal endpoint
    public IActionResult Import() => Ok();
}
```

`[EnableRateLimiting]` and `[DisableRateLimiting]` follow the standard ASP.NET Core attribute-resolution rules: action-level wins over controller-level, and `DisableRateLimiting` always wins. Mixing the fluent and attribute styles is fine, the metadata pipeline reads them the same way.

A common mistake is putting `[EnableRateLimiting]` on a minimal API endpoint with `.WithMetadata(new EnableRateLimitingAttribute("search"))`. It works, but `RequireRateLimiting("search")` is shorter and clearer.

## Picking an algorithm

The four built-in algorithms answer four different shapes of "how often is too often", and choosing wrongly shows up as either traffic spikes that punch through your limit or legitimate users getting 429s during normal bursts.

**Fixed window** counts requests in non-overlapping time buckets. `PermitLimit = 100, Window = 1s` means up to 100 requests in each clock-aligned second. Cheap to compute and easy to reason about, but it allows a 200-request burst at a window boundary: 100 in the last millisecond of one window, 100 in the first millisecond of the next. Use it for cost limits where the burst is acceptable, or for non-critical anti-abuse where you do not want to spend CPU on tracking.

**Sliding window** divides the window into segments and rolls them forward. `PermitLimit = 100, Window = 1s, SegmentsPerWindow = 10` means 100 requests in any 1-second slice, evaluated in 100ms increments. It eliminates the boundary burst at the cost of more bookkeeping per request. This is the sane default for public-facing read endpoints.

**Token bucket** refills `TokensPerPeriod` tokens every `ReplenishmentPeriod`, up to `TokenLimit`. Each request takes a token. Bursting is allowed up to `TokenLimit`, then the rate steadies at the replenishment rate. This is the right model for any endpoint where you want to allow a small burst (a logged-in user opens five tabs) but cap the sustained rate (no scraping). Login, password reset, and email-sending endpoints are all token bucket candidates.

**Concurrency** limits the number of requests in flight at the same time, regardless of duration. `PermitLimit = 4` means at most four concurrent requests; the fifth either queues or is rejected. Use it for endpoints that hit a slow downstream resource: large file uploads, expensive report generation, or any endpoint where the cost is wall-clock time on a worker rather than request count.

The `QueueLimit` and `QueueProcessingOrder` options are shared across all four. `QueueLimit = 0` means "reject immediately when at capacity", which is what you want for most HTTP APIs because clients will retry on 429 anyway. Non-zero queue limits make sense for concurrency limiters where the work is short and queueing for 200ms is cheaper than sending the client through a retry loop.

## Partitioning: per user, per IP, per tenant

A single shared bucket per endpoint is rarely what you want. If `/api/search` allows 30 requests per 10 seconds globally, one noisy client locks out everyone else. Partitioned limiters give each "key" its own bucket.

The fluent `AddPolicy` overload takes a `HttpContext` and returns a `RateLimitPartition<TKey>`:

```csharp
// .NET 11, C# 14
options.AddPolicy("per-user-search", context =>
{
    var key = context.User.Identity?.IsAuthenticated == true
        ? context.User.FindFirst("sub")?.Value ?? "anon"
        : context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    return RateLimitPartition.GetSlidingWindowLimiter(key, _ => new SlidingWindowRateLimiterOptions
    {
        PermitLimit = 60,
        Window = TimeSpan.FromMinutes(1),
        SegmentsPerWindow = 6,
        QueueLimit = 0
    });
});
```

The factory is called once per partition key. The runtime caches the resulting limiter in a `PartitionedRateLimiter`, so subsequent requests with the same key reuse the same limiter instance. Memory use scales with the number of distinct keys you ever see, which is why you should evict idle limiters: the framework does this automatically when a limiter has been idle for `IdleTimeout` (default 1 minute), but you can tune it with `RateLimitPartition.GetSlidingWindowLimiter(key, factory)` overloads.

Two partitioning gotchas:

1. **`RemoteIpAddress` is `null` behind a reverse proxy** unless you call `app.UseForwardedHeaders()` with `ForwardedHeaders.XForwardedFor` configured and a `KnownProxies` or `KnownNetworks` list. Without that, every request gets the partition key `"unknown"` and you have a global limiter again.
2. **Authenticated and anonymous users mix in the same partition** if you only key on `sub`. Use a prefix like `"user:"` or `"ip:"` so a logged-out attacker cannot collide with a real user's bucket.

For more complex policies (per-tenant, per-API-key, multiple limiters chained together), implement `IRateLimiterPolicy<TKey>` and register it with `options.AddPolicy<string, MyPolicy>("name")`. The policy interface gives you the same `GetPartition` method plus an `OnRejected` callback scoped to that policy.

## Customising the rejection response

The default 429 response is an empty body with no `Retry-After` header. That is fine for internal APIs, but public clients (browsers, SDKs, third-party integrations) expect a hint. The `OnRejected` callback runs after the limiter rejects but before the response is written:

```csharp
// .NET 11, C# 14
options.OnRejected = async (context, cancellationToken) =>
{
    if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
    {
        context.HttpContext.Response.Headers.RetryAfter =
            ((int)retryAfter.TotalSeconds).ToString();
    }

    context.HttpContext.Response.ContentType = "application/problem+json";
    await context.HttpContext.Response.WriteAsJsonAsync(new
    {
        type = "https://tools.ietf.org/html/rfc6585#section-4",
        title = "Too Many Requests",
        status = 429,
        detail = "Rate limit exceeded. Retry after the indicated period."
    }, cancellationToken);
};
```

Two details that are easy to get wrong. First, `MetadataName.RetryAfter` is only populated by token bucket and replenishing limiters, not by fixed window or sliding window. Sliding window limiters can compute a retry-after from `Window / SegmentsPerWindow`, but you have to do the math yourself. Second, the `OnRejected` callback runs on the rate-limiter middleware's path, not inside the endpoint, so accessing endpoint-specific services through `context.HttpContext.RequestServices` works but accessing controller filters or action context does not, those are not yet bound.

If you want a per-policy `OnRejected` instead of a global one, implement `IRateLimiterPolicy<TKey>` and override `OnRejected` on the policy. The policy-level callback runs in addition to the global one, so be careful not to write the response body twice.

## The distributed deployment pitfall

Every code sample above stores rate-limit state in process memory. That is fine when you run a single instance, and catastrophic when you scale out. Three replicas behind a load balancer with `PermitLimit = 100` per 10 seconds actually allow 300 requests per 10 seconds, because each replica counts independently. Sticky sessions help only if your hash distributes the partition keys evenly, which they typically do not.

There is no built-in distributed rate limiter in `Microsoft.AspNetCore.RateLimiting`. The maintained options as of .NET 11 are:

- **Push the limit to the load balancer.** NGINX `limit_req`, AWS WAF rate-based rules, Azure Front Door rate limiting, Cloudflare Rate Limiting Rules. This is the right answer for coarse anti-abuse at the network edge.
- **Use a Redis-backed library.** `RateLimit.Redis` (Microsoft sample on GitHub) and `AspNetCoreRateLimit.Redis` both implement `PartitionedRateLimiter<HttpContext>` against a Redis sorted set or atomic increment. The Redis round-trip adds 0.5-2ms per request, which is acceptable for endpoints that are not in the hot path.
- **Combine both.** Edge enforces a generous limit; the application enforces a per-user limit in Redis; in-process is reserved for backpressure on slow downstreams via the concurrency limiter.

Do not implement your own distributed limiter on top of `IDistributedCache` and `INCRBY` unless you have read [the Cloudflare blog post on sliding window distributed counters](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) and have a strong opinion about clock skew.

## Testing rate-limited endpoints

Integration tests with `WebApplicationFactory<TEntryPoint>` work, but the rate limiter does not reset between tests by default. Two strategies:

1. **Override the policy in the test host.** Inject a permissive limiter (`PermitLimit = int.MaxValue`) for the test environment, and write a separate set of tests that hit the limiter explicitly with a real policy.
2. **Disable the limiter for the endpoint under test.** Wrap your `MapGroup`/`RequireRateLimiting` calls in `if (!env.IsEnvironment("Testing"))`, or use `[DisableRateLimiting]` in test overrides.

The middleware also exposes `RateLimiterOptions.GlobalLimiter` for a top-level partitioned limiter that runs on every request before per-endpoint policies. It is the right place for a per-IP "you are obviously a bot" gate, and the right place to add a `Retry-After` header on every rejection regardless of which named policy fired. Do not use it as a substitute for per-endpoint policies; the two compose, they do not replace each other.

## When the built-in middleware is not enough

The middleware covers 90% of cases. The remaining 10% usually involve one of:

- **Cost-based limits**: each request consumes N tokens depending on its computed cost (a search with 5 facets costs more than a flat list). The middleware does not have a hook for variable token consumption, so you wrap the endpoint with a manual `RateLimiter.AcquireAsync(permitCount)` call inside the handler.
- **Soft limits with degradation**: instead of returning 429, you serve a cached or down-sampled response. Implement this in the endpoint, not the middleware: check `context.Features.Get<IRateLimitFeature>()` (added by the middleware in .NET 9) and branch on it.
- **Per-route metric exposition**: the middleware emits `aspnetcore.rate_limiting.request_lease.duration` and similar metrics via `Microsoft.AspNetCore.RateLimiting` meter. Wire it through `OpenTelemetry` to get per-policy 429 counts in your dashboard. The built-in counters do not break out by endpoint; if you need that, tag the meter yourself in `OnRejected`.

## Related

- [How to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) covers the middleware-ordering rules that also apply to `UseRateLimiter`.
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) for the trim-safety implications of `IRateLimiterPolicy<T>`.
- [How to unit-test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/) for the test-host pattern referenced above.
- [How to add OpenAPI authentication flows to Swagger UI in .NET 11](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) for the partition-key story when API keys carry the user identity.
- [How to generate strongly-typed client code from an OpenAPI spec in .NET 11](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) for the consumer side of the 429 contract.

## Sources

- [Rate limiting middleware in ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/rate-limit) on MS Learn.
- [`Microsoft.AspNetCore.RateLimiting` API reference](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.ratelimiting).
- [`System.Threading.RateLimiting` package source](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Threading.RateLimiting) for the underlying limiter primitives.
- [RFC 6585 section 4](https://www.rfc-editor.org/rfc/rfc6585#section-4) for the canonical definition of `429 Too Many Requests` and the `Retry-After` header.
