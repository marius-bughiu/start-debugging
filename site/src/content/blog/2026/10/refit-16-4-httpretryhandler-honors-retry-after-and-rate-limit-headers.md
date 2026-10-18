---
title: "Refit 16.4 ships HttpRetryHandler, and it reads GitHub, Azure and AWS rate-limit headers"
description: "Refit 16.4.0 adds an opt-in HttpRetryHandler that retries idempotent requests, honors Retry-After and provider-specific headers like x-ratelimit-reset and x-ms-retry-after-ms, and needs no Polly or resilience package."
pubDate: 2026-10-18
tags:
  - "dotnet"
  - "refit"
  - "httpclient"
  - "resilience"
---

[Refit 16.4.0](https://github.com/reactiveui/refit/releases/tag/v16.4.0) landed on October 17, 2026, and the headline feature is a retry handler that lives in the core `Refit` package. `HttpRetryHandler` is a plain `DelegatingHandler`, so it works for Refit clients and for any ordinary `HttpClient`, without pulling in Polly or `Microsoft.Extensions.Http.Resilience`.

That is not just another exponential backoff loop. The interesting part is how it decides how long to wait.

## Server hints win over backoff

Out of the box, the handler allows three retries after the first send, but only for `GET`, `HEAD`, `OPTIONS` and `TRACE`. It retries HTTP 408, 429, 500, 502, 503 and 504, plus `HttpRequestException`. A 403 is retried only when the configured delay reader finds a valid timing hint, which is exactly how GitHub signals an exhausted primary rate limit.

The delay comes from a `DelayProvider`. The default reads the standard `Retry-After` header, and `RetryDelayProviders` ships four provider-specific readers:

- `Azure`: `x-ms-retry-after-ms`, then `retry-after-ms`, then `Retry-After`.
- `Aws`: `x-amz-retry-after` in milliseconds, then `Retry-After`.
- `GitHub`: `Retry-After`, or `x-ratelimit-reset` (Unix seconds) when the remaining quota is zero on a 403 or 429.
- `Jira`: `Retry-After`, or the ISO 8601 `X-RateLimit-Reset` on a 429.

When no valid hint exists, it falls back to exponential backoff starting at one second, capped at 30 seconds, with full jitter. Jitter never shortens a server hint, and a hint above `MaxDelay` makes the handler return the response instead of retrying too early.

## Wiring it into a Refit client

With `Refit.HttpClientFactory`, the handler goes in the chain like any other message handler:

```csharp
using Refit;

services.AddRefitGeneratedClient<IGitHubApi>()
    .ConfigureHttpClient(static client =>
        client.BaseAddress = new Uri("https://api.github.com"))
    .AddHttpMessageHandler(static () => new HttpRetryHandler(new HttpRetryOptions
    {
        MaxRetries = 3,
        DelayProvider = RetryDelayProviders.GitHub,
        MaxDelay = TimeSpan.FromMinutes(2),
    }));
```

Return a fresh handler from the factory lambda, as above. Handler instances belong to a single pipeline.

If your API uses some other header, `RetryDelayProviders.ReadHeader` parses seconds, milliseconds, Unix timestamps or dates for you:

```csharp
var options = new HttpRetryOptions
{
    DelayProvider = static (response, now, ct) =>
        RetryDelayProviders.ReadHeader(
            response, "X-Throttle-Reset", RetryHeaderFormat.UnixTimeSeconds, now, ct),
};
```

## The safety rails

`POST`, `PUT`, `PATCH` and `DELETE` are not retried unless you set `RetryUnsafeMethods = true`, and you should only do that for endpoints that accept an idempotency key. Each attempt is a fresh `HttpRequestMessage` with copied headers and options. The body is buffered once, with a 1 MiB default limit (`MaxRequestContentBufferSize`), so unbounded streaming uploads are a bad fit.

Two ordering details matter. An auth handler placed inside the retry handler runs on every attempt, which is what you want for refreshed tokens. And `HttpClient.Timeout` covers the whole call, including the waits between retries, so a 100-second default timeout can cut short a two-minute GitHub reset window.

Do not stack this on top of `AddStandardResilienceHandler`. Pick one retry layer. If you already run the Microsoft resilience pipeline, keep it. If you have a small Refit client that just needs to behave politely against a rate-limited API, this is now a two-line change.

For tests, `Refit.Testing` adds `RetryReply.After`, `RetryReply.Header` and `StubHttp.CreateRetryHandler`, all driven by `TimeProvider`, so you can assert the waits without sleeping.

The release also adds `[Query(Name = "client_id")]` and `[Url(AllowRelative = true)]`, and fixes route and query parameters that differ only by case. It is the biggest Refit drop since [16.1 started generating the paging loop with PagedEnumerable](/2026/09/refit-16-1-generates-the-paging-loop-with-pagedenumerable/).
