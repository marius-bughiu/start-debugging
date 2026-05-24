---
title: "Polly vs resilience handlers in .NET 11: which should you use?"
description: "Use the Microsoft.Extensions.Http.Resilience handler for HttpClient calls, since it is Polly with HTTP-aware defaults and telemetry in one line. Reach for Polly's ResiliencePipeline directly only when you protect something that is not an HttpClient."
pubDate: 2026-05-24
template: vs
tags:
  - "comparison"
  - "polly"
  - "resilience"
  - "httpclient"
  - "dotnet"
  - "dotnet-11"
---

The framing of "Polly vs resilience handlers" is slightly wrong, and noticing why is the whole answer. The resilience handler, `AddStandardResilienceHandler` from the `Microsoft.Extensions.Http.Resilience` package, is not an alternative to Polly. It is Polly, wrapped in an HTTP-aware, dependency-injection-friendly layer that plugs straight into `IHttpClientFactory`. So the real question is not "which library" but "at which layer do I configure resilience". For new .NET 11 code in 2026: if the thing you are protecting is an `HttpClient` call, use the resilience handler, because it gives you Polly's strategies with HTTP-aware defaults, telemetry, and config binding in one line. Reach for Polly's `ResiliencePipeline` API directly only when the operation is not an `HttpClient` request: a database query, a message-broker publish, a manually invoked gRPC call, or any arbitrary delegate.

Every example here targets `<TargetFramework>net11.0</TargetFramework>` with the .NET 11 SDK and C# 14. "Polly" means Polly v8 (the `Polly.Core` package, 8.6.6 on NuGet), whose `ResiliencePipeline` API replaced the old `Policy` types. "Resilience handler" means `Microsoft.Extensions.Http.Resilience` 10.6.0, which depends on `Microsoft.Extensions.Resilience` and on Polly. The two are the same engine viewed from two heights.

## The feature matrix at a glance

This is the table you came for. The columns are the two ways you actually wire up resilience, and the rows are the decisions that change which one you pick.

| Concern | Polly `ResiliencePipeline` | Resilience handler (`Microsoft.Extensions.Http.Resilience`) |
| ------- | ------------------------- | ---------------------------------------------------------- |
| What it wraps | Any delegate or operation | `HttpClient` requests only |
| Built on | `Polly.Core` (the engine) | `Polly.Core`, wrapped |
| How it runs | You call `pipeline.ExecuteAsync(...)` explicitly | Transparent, inside the `HttpMessageHandler` pipeline |
| HTTP-aware defaults (5xx, 408, 429) | You write `ShouldHandle` yourself | Built in |
| A sane default pipeline in one line | No, you compose it | Yes, `AddStandardResilienceHandler()` |
| Telemetry (metrics + tracing) | Via `Microsoft.Extensions.Resilience` or manual | Built in |
| Config binding + hot reload | Manual | First-class (`EnableReloads`) |
| DI integration | `ResiliencePipelineRegistry<TKey>` | `IHttpClientBuilder` |
| NuGet package | `Polly.Core` 8.6.6 | `Microsoft.Extensions.Http.Resilience` 10.6.0 |
| Best for | DB calls, queues, gRPC, arbitrary code | Typed or named `HttpClient` calls |

The pattern in the table is that the resilience handler is the column on the right that inherits the engine on the left and adds HTTP knowledge, telemetry, and DI wiring on top. The cost of moving right is that you give up generality: the handler only ever runs against `HttpClient`.

## Why the resilience handler is just Polly wearing a uniform

When you call `AddStandardResilienceHandler`, the package builds a Polly `ResiliencePipeline<HttpResponseMessage>` and installs it as a `DelegatingHandler` in the message-handler pipeline that `IHttpClientFactory` composes for that client. Every retry, every circuit-breaker trip, every timeout is executed by `Polly.Core`. There is no second resilience engine in .NET. Microsoft did not reimplement retries; it took Polly v8, gave it defaults tuned for HTTP, wired it into the options system, and emitted OpenTelemetry-friendly metrics and traces around it.

That is why "should I use Polly or the resilience handler" is a category error for HTTP code. Using the handler is using Polly. The decision is whether you want the HTTP-shaped convenience layer or whether you need the raw engine because your operation is not HTTP.

## When the resilience handler is the right call

For any resilience that lives on an `HttpClient` resolved through `IHttpClientFactory`, the handler wins. The standard handler is one line on top of a typed client:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 10.6.0
using Microsoft.Extensions.DependencyInjection;

builder.Services.AddHttpClient<GitHubService>(client =>
{
    client.BaseAddress = new Uri("https://api.github.com");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
})
.AddStandardResilienceHandler(); // rate limiter, total timeout, retry, breaker, attempt timeout
```

That single call stacks five strategies with HTTP-aware defaults: it already knows that HTTP 500+, 408, and 429 are transient, that `HttpRequestException` and Polly's `TimeoutRejectedException` should be retried, and that a `Retry-After` header should be respected. You did not write a `ShouldHandle` predicate for any of that. This is the modern replacement for hand-wiring Polly policies onto a client, and it is the right default for almost all server-side HTTP code.

When the defaults are not quite right, you do not drop down to raw Polly. You stay in the handler layer and customize, because the handler exposes the same Polly options through HTTP-specific option types. Use `AddResilienceHandler` to build a named, fully custom pipeline:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 10.6.0
using System.Net;
using Microsoft.Extensions.Http.Resilience;
using Polly;

httpClientBuilder.AddResilienceHandler("CustomPipeline", static builder =>
{
    builder.AddRetry(new HttpRetryStrategyOptions
    {
        BackoffType = DelayBackoffType.Exponential,
        MaxRetryAttempts = 5,
        UseJitter = true
    });

    builder.AddCircuitBreaker(new HttpCircuitBreakerStrategyOptions
    {
        SamplingDuration = TimeSpan.FromSeconds(10),
        FailureRatio = 0.2,
        MinimumThroughput = 3,
        ShouldHandle = static args => ValueTask.FromResult(args is
        {
            Outcome.Result.StatusCode:
                HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests
        })
    });

    builder.AddTimeout(TimeSpan.FromSeconds(5));
});
```

Note the types: `HttpRetryStrategyOptions` and `HttpCircuitBreakerStrategyOptions`. These are the HTTP-flavored versions of Polly's `RetryStrategyOptions<T>` and `CircuitBreakerStrategyOptions<T>`, carrying conveniences such as `DisableForUnsafeHttpMethods()` that only make sense for HTTP. You are still in Polly, just the part of Polly that understands `HttpResponseMessage`.

The handler also binds to configuration and reloads at runtime. Bind `HttpStandardResilienceOptions` to an `appsettings.json` section, call `EnableReloads` inside an `AddResilienceHandler` overload that exposes the `ResilienceHandlerContext`, and changing the JSON re-tunes the live pipeline without a restart. That plumbing is not free to write by hand against raw Polly, and the handler gives it to you.

## What the standard handler actually configures

Readers reach for this comparison because they want to know what `AddStandardResilienceHandler` does before they trust it. The default configuration chains five strategies, from outermost to innermost. The numbers below are the .NET 11 / `Microsoft.Extensions.Http.Resilience` 10.6.0 defaults:

| Order | Strategy | Default |
| ----- | -------- | ------- |
| 1 | Rate limiter | Permit: `1_000`, Queue: `0` |
| 2 | Total request timeout | 30s across all attempts |
| 3 | Retry | Max retries: `3`, exponential backoff, jitter on, base delay 2s |
| 4 | Circuit breaker | Failure ratio: 10%, min throughput: `100`, sampling 30s, break 5s |
| 5 | Attempt timeout | 10s per individual attempt |

The ordering matters. The total timeout (30s) sits outside the retries, so three retries that each hit the 10s per-attempt timeout cannot run forever: the whole operation is capped at 30s. The circuit breaker sits inside the retry, so it counts individual attempt failures, and once 10% of at least 100 sampled calls fail within 30s it opens for 5s and short-circuits everything underneath. If you only remember one thing about the defaults: retries are bounded by a 30s wall clock, not just by a count.

## When you reach for Polly directly

The handler stops being an option the moment the thing you are protecting is not an `HttpClient` call. There is no `AddStandardResilienceHandler` for a database query, a `ServiceBusSender.SendMessageAsync`, a Redis call, or a block of business logic that occasionally throws. For those, you build a Polly `ResiliencePipeline` and invoke it explicitly:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - resilience around a non-HTTP operation
using Polly;
using Polly.Retry;

ResiliencePipeline pipeline = new ResiliencePipelineBuilder()
    .AddRetry(new RetryStrategyOptions
    {
        MaxRetryAttempts = 3,
        BackoffType = DelayBackoffType.Exponential,
        UseJitter = true,
        // Only retry the transient failures this dependency actually throws
        ShouldHandle = new PredicateBuilder().Handle<TimeoutException>()
    })
    .AddTimeout(TimeSpan.FromSeconds(5))
    .Build();

await pipeline.ExecuteAsync(
    async token => await SaveOrderAsync(order, token),
    cancellationToken);
```

The shape is the same engine you saw inside the handler: `AddRetry`, `AddTimeout`, `AddCircuitBreaker`, the same `DelayBackoffType` and `ShouldHandle`. What changes is that you call `ExecuteAsync` yourself, you choose what counts as a transient failure (here `TimeoutException`, because there is no HTTP status code to inspect), and the pipeline can wrap literally any delegate.

For typed results, use the generic builder so the pipeline can reason about the return value, not just exceptions:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - a pipeline that inspects the result
using Polly;

ResiliencePipeline<DbResult> pipeline = new ResiliencePipelineBuilder<DbResult>()
    .AddRetry(new()
    {
        MaxRetryAttempts = 3,
        ShouldHandle = static args => ValueTask.FromResult(
            args.Outcome.Result is { Status: DbStatus.Throttled })
    })
    .Build();

DbResult result = await pipeline.ExecuteAsync(
    async token => await QueryAsync(token),
    cancellationToken);
```

In a DI app you do not new up pipelines at call sites. You register them once with `AddResiliencePipeline`, and they land in the `ResiliencePipelineRegistry<TKey>` so you can resolve them anywhere through `ResiliencePipelineProvider<TKey>`:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - register once, resolve anywhere
using Microsoft.Extensions.DependencyInjection;
using Polly;
using Polly.Registry;

builder.Services.AddResiliencePipeline("db-writes", static b =>
{
    b.AddRetry(new()).AddTimeout(TimeSpan.FromSeconds(5));
});

// elsewhere, injected ResiliencePipelineProvider<string> provider
ResiliencePipeline pipeline = provider.GetPipeline("db-writes");
await pipeline.ExecuteAsync(static async ct => await DoWorkAsync(ct), ct);
```

If you also pull in `Microsoft.Extensions.Resilience`, these registered pipelines get the same telemetry treatment the HTTP handler enjoys, so a non-HTTP pipeline can still emit metrics and traces. That is the closest you get to "the handler experience" for non-HTTP code, and it is the right tool when you want resilience around your data or messaging layer rather than your outbound HTTP.

## Is one faster than the other?

No, and the question reveals the misconception. Because the resilience handler executes a Polly `ResiliencePipeline` under the hood, the per-call overhead of "the handler" and "raw Polly" is the same engine running the same strategies. There is no Polly tax you avoid by hand-rolling a pipeline, and no handler tax you pay for the convenience. Polly v8 was specifically rewritten to slash allocations versus v7, and both entry points sit on that rewrite.

What differs is not throughput but what you get around the execution: the handler adds telemetry, config binding, and the `IHttpClientFactory` lifetime guarantees for free, while a raw pipeline gives you those only if you wire them up. If you want a real number for your own workload, run BenchmarkDotNet against your own delegate with and without the pipeline; do not pick between these two on a performance basis, because performance is not the axis that separates them.

## The gotcha that picks for you

A few hard constraints settle the choice before preference enters the room.

**The handler only works on `HttpClient` through `IHttpClientFactory`.** If your code is not going through `AddHttpClient` and an injected client, there is no handler to add. A static singleton `HttpClient`, a `DbContext`, a Kafka producer: none of these can take a resilience handler. They take a Polly pipeline or nothing. This single fact decides most real cases.

**Do not stack resilience handlers.** Microsoft's guidance is explicit: add exactly one resilience handler per client. If you need a different shape, call `RemoveAllResilienceHandlers()` first and then add your custom one. Stacking a standard handler and a custom handler nests two full pipelines and produces retry counts and timeouts that multiply in ways nobody intends.

**Retries plus non-idempotent verbs duplicate data.** The standard handler retries every HTTP method by default. A retried `POST` that already reached the server can insert the same record twice. Call `options.Retry.DisableForUnsafeHttpMethods()` to skip retries on `POST`, `PATCH`, `PUT`, `DELETE`, and `CONNECT`, or `DisableFor(HttpMethod.Post, ...)` for a specific list. This is a handler-layer concern that raw Polly cannot help you with, because raw Polly does not know what an HTTP verb is.

**Polly throws `TimeoutRejectedException`, not `TimeoutException`.** If you write a `ShouldHandle` predicate on a retry and expect to catch the timeout strategy's failure, remember it surfaces as Polly's `TimeoutRejectedException`. Mishandling this is a frequent source of a [TaskCanceledException that a task was canceled](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) bubbling up where you expected a retry.

## The call, in one line

For new .NET 11 code in 2026: if you are adding resilience to an `HttpClient` resolved through `IHttpClientFactory`, use the resilience handler, because `AddStandardResilienceHandler` is Polly with HTTP-aware defaults, telemetry, and config binding in a single line, and `AddResilienceHandler` lets you customize without leaving that layer. Drop to Polly's `ResiliencePipeline` API directly only when the operation is not an `HttpClient` call: database access, message brokers, gRPC you invoke by hand, or arbitrary delegates. You are never really choosing between two resilience libraries, because there is only one. You are choosing whether to use Polly through the HTTP-shaped door or through the general-purpose one, and the kind of operation you are protecting picks the door for you.

## Related

- [HttpClient vs HttpClientFactory vs Refit: which should you use in .NET 11?](/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [Fix: TaskCanceledException, a task was canceled in HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [How to use OpenTelemetry with .NET 11 and a free backend](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [How to unit-test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/)

## Sources

- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) - `AddStandardResilienceHandler`, `AddResilienceHandler`, the standard pipeline defaults, and the transient outcome list.
- [Introduction to resilient app development](https://learn.microsoft.com/en-us/dotnet/core/resilience/) - how `Microsoft.Extensions.Resilience` builds on Polly and adds telemetry.
- [Polly docs: Resilience pipelines](https://www.pollydocs.org/pipelines/) - `ResiliencePipelineBuilder`, `ExecuteAsync`, and the registry.
- [Polly docs: Advanced dependency injection](https://www.pollydocs.org/advanced/dependency-injection/) - `AddResiliencePipeline`, `ResiliencePipelineRegistry`, and dynamic reloads.
- [Polly v7 to v8 migration guide](https://www.pollydocs.org/migration-v8.html) - why the `Policy` API was replaced by `ResiliencePipeline`.
- [Microsoft.Extensions.Http.Resilience on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Http.Resilience) - current package version and dependencies.
</content>
</invoke>
