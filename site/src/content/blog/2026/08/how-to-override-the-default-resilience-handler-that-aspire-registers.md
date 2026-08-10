---
title: "How to override the default resilience handler that Aspire registers"
description: "Aspire's AddServiceDefaults applies a standard resilience handler to every HttpClient. Calling AddStandardResilienceHandler again stacks a second one instead of replacing it. Here are the three real override paths, the -standard options name nobody documents, and the infinite timeout you inherit if you just remove it."
pubDate: 2026-08-10
template: how-to
tags:
  - "aspire"
  - "dotnet"
  - "dotnet-11"
  - "httpclient"
  - "resilience"
  - "polly"
  - "how-to"
---

Aspire's `AddServiceDefaults()` calls `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())`, which puts retries, a circuit breaker, a rate limiter, and a 30-second total request timeout in front of every `HttpClient` in the process. Calling `AddStandardResilienceHandler()` again on one client does not replace that. It stacks a second handler on top of the first, so a single logical request can fan out to sixteen physical ones. There are exactly three ways to actually override the default: edit `ServiceDefaults/Extensions.cs` if you own it, call `RemoveAllResilienceHandlers()` on the specific `IHttpClientBuilder` before adding your own, or reconfigure the named options instance the default handler reads, which is literally named `-standard`.

Every behaviour below was verified by running it, not by reading the docs. The probe targets `net10.0` on SDK 10.0.201 with `Microsoft.Extensions.Http.Resilience` 10.8.0, which is the package the Aspire 13.4.6 ServiceDefaults template pulls in. The resilience behaviour lives in that package rather than in Aspire itself, so the same rules apply to any `IHttpClientFactory` app that uses `ConfigureHttpClientDefaults`.

## What AddServiceDefaults actually puts in front of your HttpClient

The generated `ServiceDefaults/Extensions.cs` contains this:

```csharp
// Aspire 13.4.6 ServiceDefaults template
public static TBuilder AddServiceDefaults<TBuilder>(this TBuilder builder)
    where TBuilder : IHostApplicationBuilder
{
    builder.ConfigureOpenTelemetry();
    builder.AddDefaultHealthChecks();
    builder.Services.AddServiceDiscovery();

    builder.Services.ConfigureHttpClientDefaults(http =>
    {
        // Turn on resilience by default
        http.AddStandardResilienceHandler();

        // Turn on service discovery by default
        http.AddServiceDiscovery();
    });

    return builder;
}
```

`AddStandardResilienceHandler()` composes five Polly v8 strategies, outermost first: a rate limiter (1000 permits, queue 0), a total request timeout of 30 seconds, a retry strategy (3 retries, exponential backoff with jitter, 2-second base delay), a circuit breaker (10 percent failure ratio, minimum throughput 100, 30-second sampling window, 5-second break), and a per-attempt timeout of 10 seconds. Retry and circuit breaking trigger on HTTP 5xx, 408, 429, `HttpRequestException`, and Polly's `TimeoutRejectedException`.

There is one more line in that method that matters more than any of the strategy defaults:

```csharp
// ResilienceHttpClientBuilderExtensions.StandardResilience.cs, dotnet/extensions
// Disable the HttpClient timeout to allow the timeout strategies to control the timeout.
_ = builder.ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan);
```

Adding the standard handler switches off `HttpClient.Timeout` entirely and hands timeout duty to the Polly strategies. Remember that, because it survives the removal of the handler. I come back to it under the gotchas.

## Why adding a second handler does not replace the first

The intuition that a per-client registration overrides a defaults registration is wrong here. `ConfigureHttpClientDefaults` and `AddHttpClient(name)` both push into the same ordered `HttpClientFactoryOptions.HttpMessageHandlerBuilderActions` list, and `AddStandardResilienceHandler` ultimately calls `AddHttpMessageHandler`, which appends. Nothing deduplicates.

I registered the defaults block and then a per-client handler, then walked the constructed handler chain with `IHttpMessageHandlerFactory.CreateHandler`:

```text
A stacked: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
           -> ResilienceHandler -> ResilienceHandler
           -> LoggingHttpMessageHandler -> SocketsHttpHandler
```

Two `ResilienceHandler` instances. That is not a cosmetic duplicate. The outer retry strategy issues up to 4 attempts, and each of those passes through the inner retry strategy, which issues up to 4 of its own, so one call from your code can become 16 requests against the dependency you were trying to protect. Two rate limiters both charge a permit, and two circuit breakers observe different slices of the same traffic. The outer 30-second total timeout is the only thing keeping it bounded, which means you get a request that fails at 30 seconds after hammering the downstream service, instead of the tuned behaviour you thought you configured.

The same thing happens if you call `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())` yourself in `Program.cs` on top of `AddServiceDefaults()`. I checked, and the chain shows two handlers on every client in the process.

## Steps to override the default without stacking handlers

1. **Decide the scope.** If the new settings should apply to every outbound call in the service, change `ServiceDefaults/Extensions.cs`. If only one dependency is slow or non-idempotent, do it per client and leave the default alone.
2. **Remove before you add.** On the `IHttpClientBuilder` you are targeting, call `RemoveAllResilienceHandlers()` first, then `AddStandardResilienceHandler(...)`. Registration order within one builder is what decides the outcome.
3. **Suppress `EXTEXP0001`.** `RemoveAllResilienceHandlers` is annotated `[Experimental]`, and the diagnostic is an error, not a warning, so the build fails without a `#pragma warning disable` or a `NoWarn` entry.
4. **Keep the timeouts internally consistent.** `TotalRequestTimeout` must be greater than `AttemptTimeout`, and `CircuitBreaker.SamplingDuration` must be at least double `AttemptTimeout`, or the host throws on startup.
5. **Verify the chain, not the intent.** Resolve `IHttpMessageHandlerFactory` in a test and count the `ResilienceHandler` instances in the constructed pipeline.

## Changing it for the whole service in ServiceDefaults

If you own `ServiceDefaults`, editing the block is the honest fix. Microsoft ships exactly this shape in the `Microsoft.Extensions.AI` chat template, where the Ollama endpoint routinely takes minutes to answer and the 10-second attempt timeout would kill every request:

```csharp
// Microsoft.Extensions.Http.Resilience 10.8.0, .NET 10
public static IServiceCollection AddOllamaResilienceHandler(this IServiceCollection services)
{
    services.ConfigureHttpClientDefaults(http =>
    {
#pragma warning disable EXTEXP0001 // RemoveAllResilienceHandlers is experimental
        http.RemoveAllResilienceHandlers();
#pragma warning restore EXTEXP0001

        http.AddStandardResilienceHandler(config =>
        {
            config.AttemptTimeout.Timeout = TimeSpan.FromMinutes(3);

            // Must be at least double the AttemptTimeout to pass options validation
            config.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(10);
            config.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(10);
        });
    });

    return services;
}
```

Note that this is a second `ConfigureHttpClientDefaults` block, called after `AddServiceDefaults()`. The removal runs before the re-add because the actions execute in registration order, so the net effect is one handler with your settings. The template also re-adds `AddServiceDiscovery()` inside that block, which is unnecessary: `RemoveAllResilienceHandlers` only strips handlers of type `ResilienceHandler`, and re-adding service discovery gives you two service-discovery handlers instead.

## Overriding one client without touching ServiceDefaults

This is the case that actually comes up: one dependency is slow, or one endpoint is a `POST` you must never retry, and the rest of the service should keep Aspire's defaults.

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.8.0
builder.AddServiceDefaults();

builder.Services.AddHttpClient("reports", client =>
    {
        client.BaseAddress = new Uri("https+http://reporting");
    })
#pragma warning disable EXTEXP0001
    .RemoveAllResilienceHandlers()
#pragma warning restore EXTEXP0001
    .AddStandardResilienceHandler(o =>
    {
        o.AttemptTimeout.Timeout = TimeSpan.FromMinutes(3);
        o.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(10);
        o.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(10);
        o.Retry.DisableForUnsafeHttpMethods();
    });
```

Two things about this that are not obvious.

First, call order between `AddServiceDefaults()` and `AddHttpClient(...)` does not matter. `ConfigureHttpClientDefaults` inserts its registrations at a tracked position in the service collection so that defaults always run before named-client configuration. I registered the named client first and the defaults block second, and the `reports` client still ended up with exactly one `ResilienceHandler` using the three-minute attempt timeout, while an unrelated client kept the 10-second default. Order does matter within a single builder chain, though: put `RemoveAllResilienceHandlers()` after `AddStandardResilienceHandler()` on the same client and you get a client with no resilience at all.

Second, `DisableForUnsafeHttpMethods()` turns retries off for `POST`, `PATCH`, `PUT`, `DELETE`, and `CONNECT`. The standard handler retries every method by default, which is a data-duplication bug waiting to happen on a non-idempotent endpoint. `DisableFor(HttpMethod.Post, HttpMethod.Delete)` gives you the narrower version.

## The options name nobody documents: `-standard`

`AddStandardResilienceHandler` does not use the default options instance. It computes an options name as `$"{httpClientName}-{pipelineIdentifier}"` with the identifier `standard`, then reads that named instance through `IOptionsMonitor<HttpStandardResilienceOptions>`. For a client named `slow`, the options name is `slow-standard`. Inside `ConfigureHttpClientDefaults` the builder's `Name` is null, so the string interpolation produces `-standard`, with a leading hyphen and nothing before it.

This has a sharp edge. The plain `Configure<HttpStandardResilienceOptions>` call that looks correct does nothing:

```csharp
builder.Services.ConfigureHttpClientDefaults(h => h.AddStandardResilienceHandler());
builder.Services.Configure<HttpStandardResilienceOptions>(o => o.Retry.MaxRetryAttempts = 9);
```

```text
options[''].MaxRetryAttempts          = 9
options['-standard'].MaxRetryAttempts = 3
```

Your value lands on the unnamed instance, which no handler ever reads, and the handler keeps the default 3. No exception, no log entry. If you have ever "configured" resilience and watched it have zero effect, this is almost certainly why. It also explains why the standard handler is immune to a bare `Configure` even though `HttpStandardResilienceOptions` is an ordinary options class. The [difference between the options accessor interfaces](/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) is not the issue here; the name is.

Knowing the name gives you a third override path, useful when you cannot edit `ServiceDefaults` (a shared package, a template you do not own) and do not want to enumerate every client:

```csharp
// Retunes the handler that AddServiceDefaults already registered.
builder.Services.Configure<HttpStandardResilienceOptions>("-standard", o =>
{
    o.AttemptTimeout.Timeout = TimeSpan.FromSeconds(20);
    o.CircuitBreaker.SamplingDuration = TimeSpan.FromSeconds(60);
    o.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(90);
});
```

That resolves to `attempt=00:00:20 total=00:01:30` at startup, with a single handler in the chain. It is a string literal coupled to an implementation detail, so leave a comment next to it, but it works and it does not stack.

For per-client settings that belong in configuration rather than code, bind a section instead. `AddStandardResilienceHandler(IConfigurationSection)` is a real overload that forwards to `.Configure(section)` on the correctly named options instance:

```json
{
  "Resilience": {
    "Slow": {
      "AttemptTimeout": { "Timeout": "00:03:00" },
      "TotalRequestTimeout": { "Timeout": "00:10:00" },
      "CircuitBreaker": { "SamplingDuration": "00:10:00" },
      "Retry": { "MaxRetryAttempts": 2 }
    }
  }
}
```

```csharp
builder.Services.AddHttpClient("slow")
#pragma warning disable EXTEXP0001
    .RemoveAllResilienceHandlers()
#pragma warning restore EXTEXP0001
    .AddStandardResilienceHandler(builder.Configuration.GetSection("Resilience:Slow"));
```

Bound values come through exactly as written, and because the standard handler calls `context.EnableReloads`, editing those values in `appsettings.json` rebuilds the pipeline without a restart.

## The gotchas that bite

**Bad timeouts fail at startup, not at first request.** Both validators are registered with `AddOptionsWithValidateOnStart`, so a mismatch throws when the host starts. Setting only `AttemptTimeout` to 3 minutes and leaving the rest alone produces this:

```text
Microsoft.Extensions.Options.OptionsValidationException: Total request timeout resilience
strategy must have a greater timeout than the attempt resilience strategy. Total Request
Timeout: 30s, Attempt Timeout: 180s; The sampling duration of circuit breaker strategy needs
to be at least double of an attempt timeout strategy’s timeout interval, in order to be
effective. Sampling Duration: 30s,Attempt Timeout: 180s
```

The doubling rule is a hard-coded multiplier of 2 in `HttpStandardResilienceOptionsCustomValidator`. Raising `AttemptTimeout` always means raising both `TotalRequestTimeout` and `CircuitBreaker.SamplingDuration`. If you want that kind of check on your own settings, the same machinery is available through [startup validation with `IValidateOptions<T>`](/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/).

**Removing the handler leaves you with no timeout at all.** This is the worst one. `RemoveAllResilienceHandlers()` strips the `ResilienceHandler` instances, but it does not undo the `ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan)` that `AddStandardResilienceHandler` registered. A client built with `AddHttpClient("bare").RemoveAllResilienceHandlers()` and nothing added back gives:

```text
bare client chain:   LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
                     -> LoggingHttpMessageHandler -> SocketsHttpHandler
HttpClient('bare').Timeout = -00:00:00.0010000
```

That negative one millisecond is `Timeout.InfiniteTimeSpan`. No resilience handler, no 100-second `HttpClient` default, no timeout of any kind. A hung dependency now hangs your request thread pool until the cancellation token you hopefully passed fires. If you remove the handler and do not add one back, set `client.Timeout` explicitly. The related failure mode where a timeout does fire is covered in [why HttpClient throws TaskCanceledException](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

**Removal is type-scoped, not chain-scoped.** The implementation loops the additional handlers backwards and removes only those matching `is ResilienceHandler`. Custom `DelegatingHandler` types, auth handlers, and the service-discovery handler all survive. I confirmed it with a marker handler registered in the defaults block: after `RemoveAllResilienceHandlers()` on a named client, the marker is still there. So do not re-add service discovery after a removal.

**gRPC clients need `Grpc.Net.ClientFactory` 2.64.0 or later.** Combining the standard handler with an older `AddGrpcClient` throws `System.InvalidOperationException: The ConfigureHttpClient method isn't supported when creating gRPC clients`. There is a build-time check for it, suppressible with `<SuppressCheckGrpcNetClientFactoryVersion>`.

**`RemoveAllResilienceHandlers` is experimental.** `EXTEXP0001` is emitted as an error by the analyzer in `Microsoft.Extensions.Http.Resilience` 10.8.0, so the pragma is mandatory rather than tidy. The API has been stable in shape since 9.0, but the annotation means the team reserves the right to change it.

The rule that covers all of this: a resilience handler is a message handler, and message handlers compose rather than replace. Once you internalise that, "how do I override the Aspire default" stops being a puzzle and becomes "remove, then add, in that order, on the right builder."

## Related

- [Polly vs resilience handlers in .NET 11](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) explains which layer to configure resilience at in the first place.
- [Adding Aspire to an existing ASP.NET Core solution](/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) covers what else `AddServiceDefaults()` turns on.
- [HttpClient vs HttpClientFactory vs Refit](/2026/05/httpclient-vs-httpclientfactory-vs-refit/) for how the handler chain gets built in the first place.
- [IOptions vs IOptionsSnapshot vs IOptionsMonitor in .NET 11](/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) for the monitor the standard handler reads its named options through.
- [Aspire vs Docker Compose for local multi-service development](/2026/08/aspire-vs-docker-compose-for-local-multi-service-development/) if you are still deciding whether to adopt Aspire at all.

## Sources

- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) on MS Learn, for the standard handler defaults table and the known issues.
- [`ResilienceHttpClientBuilderExtensions.StandardResilience.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/ResilienceHttpClientBuilderExtensions.StandardResilience.cs) in dotnet/extensions, for the options name and the infinite client timeout.
- [`HttpStandardResilienceOptionsCustomValidator.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/Internal/Validators/HttpStandardResilienceOptionsCustomValidator.cs), for the exact validation rules and messages.
- [`OllamaResilienceHandlerExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/ProjectTemplates/Microsoft.Extensions.AI.Templates/templates/AIChatWeb-CSharp/AIChatWeb-CSharp.Web/OllamaResilienceHandlerExtensions.cs), Microsoft's own override of the Aspire default.
- [Aspire service defaults](https://aspire.dev/get-started/csharp-service-defaults/), for the generated `AddServiceDefaults` source.
