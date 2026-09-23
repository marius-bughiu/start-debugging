---
title: "Fix: custom DelegatingHandler does not run again on each retry with AddStandardResilienceHandler"
description: "A DelegatingHandler registered before AddStandardResilienceHandler runs once per logical request, not once per retry. Move it after the resilience handler, and make it idempotent, because the retry re-sends the same HttpRequestMessage. Measured on Microsoft.Extensions.Http.Resilience 10.10.0 and 8.10.0."
pubDate: 2026-09-23
template: how-to
tags:
  - "dotnet-10"
  - "httpclient"
  - "resilience"
  - "polly"
  - "aspnetcore"
---

**Short answer:** `IHttpClientFactory` builds the handler chain in registration order, first registered is outermost. If you call `AddHttpMessageHandler<MyHandler>()` *before* `AddStandardResilienceHandler()`, your handler sits outside the retry loop and runs exactly once, no matter how many attempts Polly makes underneath it. Register it *after* the resilience handler and it runs once per attempt. Then fix the second bug that move exposes: the standard retry re-sends the **same** `HttpRequestMessage` object, so any `request.Headers.Add(...)` in a per-attempt handler piles up duplicate values, and a non-seekable `StreamContent` body throws `InvalidOperationException: The stream was already consumed` on the second attempt.

Everything below was measured with a file-based probe on .NET 10.0.10 (SDK 10.0.302) against `Microsoft.Extensions.Http.Resilience` 10.10.0, the current stable, and repeated on 8.10.0. Both versions produced identical output, so this is not a regression and not something a package upgrade will change. It is how the pipeline is built.

## Why the handler runs only once

`AddStandardResilienceHandler` is not a setting on the client. It is one more `DelegatingHandler`, of type `ResilienceHandler`, appended to the same ordered list that `AddHttpMessageHandler` appends to. The ASP.NET Core docs describe the rule in one line: handlers ["can be registered in the order that they should execute"](https://learn.microsoft.com/aspnet/core/fundamentals/http-requests#outgoing-request-middleware), and each one wraps the next.

Inside `ResilienceHandler.SendAsync`, the Polly pipeline executes a callback that calls `base.SendAsync(request, ...)`, which is the next handler down the chain. When the retry strategy decides to try again, it invokes that callback again. So only the handlers **below** `ResilienceHandler` are re-executed. Anything above it has already called `base.SendAsync` once and is simply awaiting the final result.

That is the whole bug. Tutorials and older code often register cross-cutting handlers first and bolt resilience on at the end, because that reads naturally:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddTransient<SigningHandler>();

builder.Services.AddHttpClient<PaymentsClient>(c => c.BaseAddress = new("https://payments.example"))
    .AddHttpMessageHandler<SigningHandler>()   // outermost: runs once
    .AddStandardResilienceHandler();           // retries happen below this line
```

If `SigningHandler` stamps a timestamp and an HMAC signature, every retry goes out with the signature computed for attempt one. If it fetches a short-lived token, a retry after a slow 503 can go out with a token that has since expired. If it logs "sending request", you see one log line for three network calls.

## The measured handler chain

I resolved `IHttpMessageHandlerFactory.CreateHandler("c")` and walked `InnerHandler` down to the primary handler. The primary was a stub that returns `503` twice and then `200`, and retry delays were set to zero so the probe runs instantly. A `CountingHandler` logs every call it sees.

Registered **before** `AddStandardResilienceHandler`:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> CountingHandler -> ResilienceHandler
       -> LoggingHttpMessageHandler -> StubPrimary
final: 200, primary calls: 3
CountingHandler #1 X-Attempt=[]
CountingHandler #1 <- 200
```

Three requests hit the wire. The handler ran once and only ever saw the final `200`.

Registered **after** `AddStandardResilienceHandler`:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> ResilienceHandler -> CountingHandler
       -> LoggingHttpMessageHandler -> StubPrimary
final: 200, primary calls: 3
CountingHandler #2 <- 503
CountingHandler #3 <- 503
CountingHandler #4 <- 200
```

Now it runs per attempt and sees each `503`. Note where the factory's own `LoggingHttpMessageHandler` sits: always innermost, just above the primary handler. That is why the built-in `System.Net.Http.HttpClient.<name>.ClientHandler` log category already shows one entry per attempt, while a handler you registered first shows one entry per call. If your logs and your handler disagree about the request count, this is why.

## Fix it in three steps

1. Decide, per handler, whether its work belongs to the **logical call** or to **each attempt**. Signing, token acquisition, per-attempt logging and metrics are per attempt. An idempotency key, a correlation ID you want to stay stable across retries, and anything that must happen exactly once are per call.
2. Register per-attempt handlers **after** `AddStandardResilienceHandler()` (or `AddResilienceHandler(...)`), and per-call handlers before it.
3. Make every per-attempt handler safe to run repeatedly on the same `HttpRequestMessage`: replace headers instead of adding them, and make sure the request body can be read more than once.

The registration for the payments example becomes:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddTransient<IdempotencyKeyHandler>();
builder.Services.AddTransient<SigningHandler>();

var payments = builder.Services
    .AddHttpClient<PaymentsClient>(c => c.BaseAddress = new("https://payments.example"));

payments.AddHttpMessageHandler<IdempotencyKeyHandler>(); // once per call: same key on every retry
payments.AddStandardResilienceHandler();
payments.AddHttpMessageHandler<SigningHandler>();        // once per attempt: fresh signature
```

Keep the `IHttpClientBuilder` in a variable. You cannot chain `.AddHttpMessageHandler<T>()` onto `AddStandardResilienceHandler()`, because it returns an `IHttpStandardResiliencePipelineBuilder`, not the client builder. Trying it fails the build:

```text
error CS1929: 'IHttpStandardResiliencePipelineBuilder' does not contain a definition for
'AddHttpMessageHandler' and the best extension method overload
'HttpClientBuilderExtensions.AddHttpMessageHandler<SigningHandler>(IHttpClientBuilder)'
requires a receiver of type 'Microsoft.Extensions.DependencyInjection.IHttpClientBuilder'
```

I suspect that compiler error is the real reason so much code registers handlers first: the fluent chain only compiles in the wrong order, so people put resilience last and move on. A second `AddHttpClient<PaymentsClient>()` call for the same client also works, since it returns a builder for the same name, but the variable makes the order visible.

The idempotency key is the case people get wrong in the opposite direction. If you move *every* handler inside the retry to fix signing, a handler that generates `Idempotency-Key: Guid.NewGuid()` now sends a different key per attempt, and the server can no longer tell a retry from a new payment. The whole point of the key is that it stays constant across retries, so it has to live outside the loop.

## The retry re-sends the same HttpRequestMessage

This one surprised me. I expected the resilience handler to clone the request per attempt. It does not, for the standard (retry) handler. The probe logged the request's hash code in each attempt and it was the same object every time. A per-attempt handler that uses `Headers.Add` then produces this:

```text
chain: ... -> ResilienceHandler -> HeaderHandler -> CountingHandler -> ...
CountingHandler #5 X-Attempt=[1]
CountingHandler #6 X-Attempt=[1,1]
CountingHandler #7 X-Attempt=[1,1,1]
```

By the third attempt the header has three values. For a signature header that means the server receives `X-Signature: abc, def, ghi` and rejects it. The code in `ResilienceHandler` confirms it: the pipeline callback calls `GetRequestMessage(context, state.request)`, which returns the original request unless an outer strategy has put a different one on the context. Only hedging does that.

The fix is to write headers with "set" semantics. `Authorization` is a single-valued typed property, so assigning it replaces the old value. For custom headers, remove first:

```csharp
// .NET 10, C# 14
public sealed class SigningHandler(ISigner signer, TimeProvider clock) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var timestamp = clock.GetUtcNow().ToUnixTimeSeconds().ToString();

        request.Headers.Remove("X-Timestamp");
        request.Headers.Remove("X-Signature");
        request.Headers.Add("X-Timestamp", timestamp);
        request.Headers.Add("X-Signature", await signer.SignAsync(request, timestamp, cancellationToken));

        return await base.SendAsync(request, cancellationToken);
    }
}
```

With `Remove` followed by `Add`, the probe showed `X-Attempt=[1]`, `[2]`, `[3]` across the three attempts: one value, refreshed each time. The same applies to a token handler: `request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);` is already safe to repeat.

## Request bodies must be replayable

Because the same `HttpRequestMessage` goes out again, so does the same `HttpContent`. `StringContent`, `ByteArrayContent`, `JsonContent` and `FormUrlEncodedContent` are backed by memory and can be serialized any number of times. The probe's primary handler copied the body with `CopyToAsync`, which is what `SocketsHttpHandler` does, and a `StringContent` POST came through intact on all three attempts.

A `StreamContent` over a non-seekable stream (a network stream, a pipe, an upload you are forwarding) does not survive:

```text
primary #1 body='{"a":1}'
primary #2 InvalidOperationException: The stream was already consumed. It cannot be read again.
```

`InvalidOperationException` is not one of the exceptions the standard retry treats as transient, so the call fails on attempt two with that exception instead of retrying. A seekable stream works, because `StreamContent` rewinds to its starting position before each send.

You have three options:

```csharp
// .NET 10, C# 14
// Option 1: buffer it (fine for small bodies)
var content = new StreamContent(uploadStream);
await content.LoadIntoBufferAsync(cancellationToken);   // probe: all 3 attempts sent the full body

// Option 2: copy to a seekable stream first
var ms = new MemoryStream();
await uploadStream.CopyToAsync(ms, cancellationToken);
ms.Position = 0;
var seekable = new StreamContent(ms);

// Option 3: do not retry this request at all
builder.Services.AddHttpClient("uploads")
    .AddStandardResilienceHandler()
    .Configure(o => o.Retry.DisableForUnsafeHttpMethods());
```

For large uploads, option 3 is usually the honest answer. Buffering a 500 MB body into memory to make it retryable is a worse failure mode than surfacing the error. `DisableForUnsafeHttpMethods` also keeps the standard handler from retrying `POST`, `PUT`, `PATCH` and `DELETE` in general, which you often want for non-idempotent endpoints anyway.

## Aspire and ConfigureHttpClientDefaults already put your handler inside

If your project uses .NET Aspire's `ServiceDefaults`, you may not have this bug at all. `AddServiceDefaults()` calls `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())`, and default actions always run before a named or typed client's own configuration. I registered the resilience handler through `ConfigureHttpClientDefaults` and a `CountingHandler` on the named client:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> ResilienceHandler -> CountingHandler
       -> LoggingHttpMessageHandler -> StubPrimary
CountingHandler #8 <- 503
CountingHandler #9 <- 503
CountingHandler #10 <- 200
```

Every per-client handler lands inside the retry, regardless of the order of `AddServiceDefaults()` and `AddHttpClient(...)` in `Program.cs`. That is the right default for signing and tokens, and the wrong one for idempotency keys. If you need a per-call handler in an Aspire app, you have to remove the default resilience handler for that client and re-add it after your handler, which is covered in [how to override the default resilience handler that Aspire registers](/2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers/). Adding a second `AddStandardResilienceHandler()` does not replace the first, it stacks.

## Hedging behaves differently

`AddStandardHedgingHandler()` is the exception to the "same request object" rule. Hedging can have several attempts in flight at once, so it snapshots the original request and sends a clone per attempt. The chain also contains two `ResilienceHandler` instances, one for the hedging pipeline and one for the per-endpoint strategies:

```text
chain: ... -> ResilienceHandler -> ResilienceHandler -> HeaderHandler -> CountingHandler -> ...
final: 503, primary calls: 2
CountingHandler #16 req@9c43c1 X-Attempt=[1]
CountingHandler #17 req@17e61ce X-Attempt=[1]
```

Two different request objects, each with exactly one header value, even with the `Headers.Add` version of the handler. Handlers registered after the hedging handler still run per attempt. Do not rely on the cloning, though: code that is only correct under hedging breaks the day someone swaps back to the standard handler.

## Other things that change once the handler is inside

Moving a handler under the resilience handler puts it under the **attempt timeout** (10 seconds by default) and inside the **circuit breaker's** view of the world. Three consequences:

- Slow work in the handler counts against each attempt. A token endpoint that takes 8 seconds leaves 2 seconds for the actual request before the attempt times out. Cache tokens, and refresh them ahead of expiry rather than on the request path.
- Exceptions your handler throws are outcomes the retry and circuit breaker evaluate. An `HttpRequestException` thrown by your handler is retried and counts as a failure for the breaker. Throw something non-transient (or return a response) for failures a retry cannot fix, such as missing configuration.
- A handler that short-circuits and returns its own `HttpResponseMessage` (a cache hit, say) is also subject to the retry's `ShouldHandle`. Returning a synthetic `503` from inside the loop gets retried like a real one.

`DelegatingHandler` instances registered with `AddHttpMessageHandler<T>()` must be transient, and that does not change. The factory creates one chain per handler lifetime (two minutes by default) and reuses it across requests, so per-request state belongs on the `HttpRequestMessage` (`request.Options`), not in fields on the handler.

## How to verify your own chain

Do not trust the registration code, check the constructed chain. This test works for any client:

```csharp
// .NET 10, xUnit v3, Microsoft.Extensions.Http.Resilience 10.10.0
[Fact]
public void SigningHandler_runs_inside_the_retry()
{
    var services = new ServiceCollection();
    services.AddTransient<SigningHandler>();
    services.AddSingleton<ISigner, FakeSigner>();
    services.AddSingleton(TimeProvider.System);
    var payments = services.AddHttpClient("payments");
    payments.AddStandardResilienceHandler();
    payments.AddHttpMessageHandler<SigningHandler>();

    using var sp = services.BuildServiceProvider();
    var handler = sp.GetRequiredService<IHttpMessageHandlerFactory>().CreateHandler("payments");

    var names = new List<string>();
    for (HttpMessageHandler? h = handler; h is not null; h = (h as DelegatingHandler)?.InnerHandler)
        names.Add(h.GetType().Name);

    Assert.True(names.IndexOf(nameof(ResilienceHandler)) < names.IndexOf(nameof(SigningHandler)));
}
```

For a behavioural test, swap the primary handler for a stub that fails a fixed number of times, the same technique as in [unit-testing code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/), and assert your handler's call count equals the number of attempts.

## Related

- [Polly vs resilience handlers in .NET 11](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) explains the five strategies inside `AddStandardResilienceHandler` and their order.
- [How to override the default resilience handler that Aspire registers](/2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers/) for removing and re-adding the handler per client.
- [HttpClient vs HttpClientFactory vs Refit](/2026/05/httpclient-vs-httpclientfactory-vs-refit/) covers how the factory composes `DelegatingHandler` pipelines.
- [Fix TaskCanceledException: A task was canceled in HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) for when the attempt timeout, not your handler, is what fails the call.
- [Polly 8.8 reloads a resilience pipeline from your own IOptionsMonitor](/2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor/) if you tune retry settings at runtime.

## Sources

- [Make outgoing HTTP requests: outgoing request middleware](https://learn.microsoft.com/aspnet/core/fundamentals/http-requests#outgoing-request-middleware), Microsoft Learn
- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/dotnet/core/resilience/http-resilience), Microsoft Learn
- [`ResilienceHandler.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/ResilienceHandler.cs) in dotnet/extensions
- [`Microsoft.Extensions.Http.Resilience` on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Http.Resilience), versions 10.10.0 and 8.10.0 tested
- [`HttpContent.LoadIntoBufferAsync`](https://learn.microsoft.com/dotnet/api/system.net.http.httpcontent.loadintobufferasync), Microsoft Learn
