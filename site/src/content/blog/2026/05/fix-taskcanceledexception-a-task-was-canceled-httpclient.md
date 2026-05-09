---
title: "Fix: TaskCanceledException: A task was canceled in HttpClient"
description: "HttpClient throws TaskCanceledException for three different reasons: timeout, caller cancellation, or a connection-level abort. Tell them apart with InnerException and CancellationToken.IsCancellationRequested, then fix the right one."
pubDate: 2026-05-09
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "httpclient"
  - "cancellation"
---

The fix: `HttpClient` raises `TaskCanceledException` (a subclass of `OperationCanceledException`) for three distinct causes, and you have to disambiguate them before you can act. If `ex.InnerException is TimeoutException`, the request hit `HttpClient.Timeout` (default 100 seconds), so raise the timeout or move long-running calls onto a per-request `CancellationTokenSource`. If your own `CancellationToken` is cancelled (`ex.CancellationToken.IsCancellationRequested == true`), that is the caller bailing out, no fix needed beyond letting it propagate. If neither is true, you are looking at a transport-level abort (DNS, TCP, TLS, server reset), which usually points at infrastructure, not your code.

```text
System.Threading.Tasks.TaskCanceledException: The request was canceled due to the configured HttpClient.Timeout of 100 seconds elapsing.
 ---> System.TimeoutException: The operation was canceled.
 ---> System.Threading.Tasks.TaskCanceledException: The operation was canceled.
   at System.Threading.Tasks.TaskCompletionSource`1.TrySetCanceled(CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(...)
   at System.Net.Http.HttpClient.<SendAsync>g__Core|...
   at MyApp.Program.<Main>$(String[] args)
```

This guide is written against .NET 11 preview 4 and `System.Net.Http` 11.0.0-preview.4. The exception type and the wrapped `TimeoutException` shape have not changed since .NET 5, but the message text was tightened in .NET 8 to spell out which timeout fired ("The request was canceled due to the configured `HttpClient.Timeout` of 100 seconds elapsing"). On .NET 6 and earlier you only got the generic "A task was canceled.", which is why so much pre-2024 advice tells you to log the inner exception manually.

## Why HttpClient throws TaskCanceledException for everything

The `HttpClient.SendAsync` pipeline is built on `Task` and a single `CancellationToken` parameter. The timeout, the caller's token, and the internal connection abort are all linked into one `CancellationTokenSource` before the request goes onto the socket. When any of those sources fire, the operation completes with the same `OperationCanceledException`-shaped failure, regardless of which one tripped first.

Microsoft has confirmed this design choice in [dotnet/runtime#21965](https://github.com/dotnet/runtime/issues/21965): timeout is not surfaced as `TimeoutException` directly because changing the type would be a binary-breaking change. Instead, .NET 5 added an `InnerException` of `TimeoutException` so callers can distinguish the cases, and .NET 8 added the explicit message text. The `CancellationToken` property on the exception, set by the runtime, is the second disambiguator.

So the same exception covers three completely different problems. Acting on "task was canceled" without inspecting which case you are in is the most common reason this bug stays unfixed for weeks.

## A minimal repro for each cause

```csharp
// .NET 11, C# 14, System.Net.Http 11.0.0-preview.4
using System.Net.Http;

// Cause 1: HttpClient.Timeout elapsed
using var c1 = new HttpClient { Timeout = TimeSpan.FromMilliseconds(50) };
try
{
    await c1.GetAsync("https://httpbin.org/delay/3");
}
catch (TaskCanceledException ex)
{
    Console.WriteLine($"Inner: {ex.InnerException?.GetType().Name}");
    // Inner: TimeoutException
}

// Cause 2: caller's CancellationToken cancelled
using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
using var c2 = new HttpClient();
try
{
    await c2.GetAsync("https://httpbin.org/delay/3", cts.Token);
}
catch (TaskCanceledException ex)
{
    Console.WriteLine($"Token cancelled: {ex.CancellationToken.IsCancellationRequested}");
    Console.WriteLine($"Linked token: {cts.Token == ex.CancellationToken}");
    // Token cancelled: True
}

// Cause 3: connection-level abort (DNS/TCP/TLS) - simulated with a closed port
using var c3 = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
try
{
    await c3.GetAsync("http://10.255.255.1/");
}
catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException)
{
    Console.WriteLine("Looks like a timeout, was actually connect failure under timeout.");
}
catch (HttpRequestException ex)
{
    Console.WriteLine($"True transport failure: {ex.HttpRequestError}");
    // .NET 8+ exposes ex.HttpRequestError = ConnectionError, NameResolutionError, etc.
}
```

The third case is interesting. If the connect timeout is hit, you get `HttpRequestException` with `ex.HttpRequestError == HttpRequestError.ConnectionError`. If the connect succeeds but the response stalls long enough to trip `HttpClient.Timeout`, you are back in case 1. The two look nearly identical from logs but need different fixes.

## Fix, in detail

### 1. Diagnose first, with an exception filter

Before changing any timeout, log which case you are in. Otherwise you will raise `Timeout` to 5 minutes and discover the real problem was a caller cancelling.

```csharp
// .NET 11, C# 14
try
{
    return await client.GetAsync(url, ct);
}
catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException)
{
    logger.LogWarning(ex,
        "HttpClient.Timeout elapsed for {Url} (configured: {Timeout})",
        url, client.Timeout);
    throw;
}
catch (OperationCanceledException ex) when (ct.IsCancellationRequested)
{
    logger.LogInformation("Caller cancelled request to {Url}", url);
    throw;
}
catch (TaskCanceledException ex)
{
    logger.LogError(ex, "Unknown cancellation cause for {Url}", url);
    throw;
}
```

`OperationCanceledException` is the parent type and is what you want for the caller-cancelled branch, since the exact runtime type can be `OperationCanceledException` or `TaskCanceledException` depending on where in the pipeline cancellation tripped.

### 2. Raise HttpClient.Timeout, but only for clients that need it

`HttpClient.Timeout` is per-client and applies to every request that does not pass a token with its own timeout. The 100-second default is fine for typical REST calls. If you have a long-running endpoint, give it a dedicated client.

```csharp
// .NET 11
builder.Services.AddHttpClient("LongRunning", c =>
{
    c.Timeout = TimeSpan.FromMinutes(10);
    c.BaseAddress = new Uri("https://reports.example.com/");
});

builder.Services.AddHttpClient("Default", c =>
{
    c.Timeout = TimeSpan.FromSeconds(30);
});
```

Do not raise `Timeout` on the global client just to make one slow call work. You will hide future regressions: a call that should take 200ms but starts taking 90s will silently pass the relaxed gate and surface as a UI hang. Tighter timeouts catch performance regressions early. The [unit-testing HttpClient walkthrough](/2026/04/how-to-unit-test-code-that-uses-httpclient/) covers how to exercise these timeout boundaries in tests so a regression here does not slip through CI.

### 3. Switch to per-request CancellationTokenSource for fine control

`HttpClient.Timeout` is a blunt instrument. Inside a `BackgroundService` or a request pipeline that already has a token, link them:

```csharp
// .NET 11, C# 14
using var perCallCts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
using var linked = CancellationTokenSource.CreateLinkedTokenSource(
    perCallCts.Token, requestAborted);

try
{
    var response = await client.GetAsync(url, linked.Token);
    return await response.Content.ReadAsStringAsync(linked.Token);
}
catch (OperationCanceledException) when (perCallCts.IsCancellationRequested
                                          && !requestAborted.IsCancellationRequested)
{
    // Per-call timeout, not caller cancellation. Surface as your own timeout type.
    throw new TimeoutException($"GET {url} exceeded 15 seconds.");
}
```

This pattern composes cleanly with `IHttpClientFactory`: keep the named client's `Timeout` set high (or `Timeout.InfiniteTimeSpan`), and enforce the real budget at the call site with the linked CTS. The reason `Timeout.InfiniteTimeSpan` works here is that `HttpClient` only adds its `Timeout` to the linked token when it is positive, so an infinite client `Timeout` means "the caller is in charge". The [cancellation deadlock walkthrough](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) covers the linked-token pattern in more detail, including how to tell timeouts apart from caller cancels at higher layers.

### 4. Use HttpCompletionOption.ResponseHeadersRead for streaming bodies

`HttpClient.Timeout` covers the time from `SendAsync` to "ready to read body" only when the default `HttpCompletionOption.ResponseContentRead` is used. With `ResponseHeadersRead`, the timeout applies only up to receiving the headers. The body read is on you to time out, as confirmed in [the HttpCompletionOption docs](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpcompletionoption).

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));
using var response = await client.GetAsync(
    url, HttpCompletionOption.ResponseHeadersRead, cts.Token);

response.EnsureSuccessStatusCode();
await using var stream = await response.Content.ReadAsStreamAsync(cts.Token);
await using var file = File.Create(path);
await stream.CopyToAsync(file, cts.Token);
```

Pass the same token everywhere. A common bug is to pass `cts.Token` to `GetAsync` but forget it on `CopyToAsync`, in which case `HttpClient.Timeout` no longer applies to the body and a stalled producer hangs forever. The [streaming-from-ASP.NET-Core post](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) covers the symmetric server-side mistake, where forgetting to forward the request's `CancellationToken` produces the same hang on the producer.

### 5. Configure connect timeout separately on .NET 8 and later

`HttpClient.Timeout` covers the whole request, but DNS and TCP connect are part of that budget. If you want DNS or connect to fail fast independent of the request timeout, set `SocketsHttpHandler.ConnectTimeout`:

```csharp
// .NET 11, C# 14
var handler = new SocketsHttpHandler
{
    ConnectTimeout = TimeSpan.FromSeconds(5),
    PooledConnectionLifetime = TimeSpan.FromMinutes(2),
};

builder.Services.AddHttpClient("Api", c =>
{
    c.Timeout = TimeSpan.FromSeconds(30);
    c.BaseAddress = new Uri("https://api.example.com/");
}).ConfigurePrimaryHttpMessageHandler(() => handler);
```

A short connect timeout converts "wait 30 seconds for nothing" into "fail in 5 seconds, retry on a different endpoint". Distinguishing connect from response timeouts is the difference between a Polly circuit breaker that opens fast and one that drags every caller through the full timeout window.

## Common shapes that trigger this

### IHttpClientFactory typed client with the wrong Timeout

A typed client picks up the `Timeout` you configured on `AddHttpClient`, not the property you set on `HttpClient` later. Code that does `_client.Timeout = TimeSpan.FromMinutes(5)` from constructor injection throws `InvalidOperationException` once a request has already gone through the client. The factory recycles the underlying handler, but the `HttpClient` instance is single-use for `Timeout` purposes. Configure the timeout in `AddHttpClient`, not in the typed client constructor.

### A Task.WhenAll with mismatched tokens

When you fan out N HTTP calls with `Task.WhenAll(tasks)` and one cancels, only that one throws. The rest keep running and may also hit timeouts. If your code rethrows the first cancellation, the surviving tasks become unobserved and their exceptions surface in `TaskScheduler.UnobservedTaskException`. Use `Task.WhenAll` with a shared linked CTS that you cancel on the first failure, so the remaining requests stop too.

### Polly retry policy hides the inner timeout

A Polly retry handler that swallows `TaskCanceledException` and retries can mask the underlying timeout entirely. If the upstream is genuinely slow, you turn one 100-second wait into three 100-second waits, then give up. Configure Polly to short-circuit on inner `TimeoutException` and let the caller decide.

```csharp
// .NET 11, Microsoft.Extensions.Http.Resilience 11.0.0-preview.4
builder.Services.AddHttpClient("Api")
    .AddStandardResilienceHandler(options =>
    {
        options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(10);
        options.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(30);
        options.Retry.ShouldHandle = args => args.Outcome switch
        {
            { Exception: HttpRequestException } => PredicateResult.True(),
            { Exception: TaskCanceledException tce } when tce.InnerException is TimeoutException
                => PredicateResult.False(),
            _ => PredicateResult.False(),
        };
    });
```

The `Microsoft.Extensions.Http.Resilience` package's `AddStandardResilienceHandler` separates per-attempt and total-request timeouts cleanly, which is the clean replacement for hand-rolled Polly + linked CTS code.

### Synchronous Wait or Result on an HttpClient call

`client.GetAsync(url).Result` deadlocks under a single-threaded sync context (classic ASP.NET, WPF) and surfaces as a `TaskCanceledException` when `HttpClient.Timeout` finally fires 100 seconds later. The fix is `await`, full stop. The deadlock makes the request never start the response phase, the timer eventually fires, and the symptom looks like a network timeout. If you see "task was canceled" with no network egress in your traces, look for blocking sync calls in the call stack. The [BackgroundService pattern post](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/) covers the async-all-the-way-down rule for hosted services where this bites hardest.

### Reusing HttpRequestMessage

`HttpRequestMessage` cannot be sent twice. The second `SendAsync` throws `InvalidOperationException: The request message was already sent`. Some retry libraries paper over this and the failure surfaces as a cancellation from a different request that shared a token with the failing one. Always create a new `HttpRequestMessage` per attempt.

## Variants that look like this error but are not

### "The operation was canceled" with no inner exception, on .NET Framework 4.8

On .NET Framework, the `InnerException` is rarely a `TimeoutException`. The disambiguation pattern in step 1 only works on .NET 5 and later. If you are still on Framework, your best signal is to compare `ex.CancellationToken` against the token you passed in, and to record the elapsed time before the throw. The ergonomics of this case are one of the better reasons to finish migrating off Framework sooner rather than later.

### "An error occurred while sending the request" wrapping SocketException

Different exception class entirely (`HttpRequestException`), almost always a transport problem (DNS, TCP RST, TLS handshake failure). On .NET 8+, `ex.HttpRequestError` enumerates the cause: `ConnectionError`, `NameResolutionError`, `SecureConnectionError`, etc. The fix lives in DNS, firewall, or certificate config, not in your code.

### "The SSL connection could not be established"

Inner exception is `AuthenticationException` from `System.Net.Security`. This is a TLS negotiation failure, not a timeout, even though it can take seconds and look superficially similar. Check the cert chain, the SNI host, and the TLS protocol version (`SslProtocols.Tls12 | SslProtocols.Tls13` is the .NET 11 default).

### "A connection attempt failed because the connected party did not properly respond"

`SocketException` with `ErrorCode == 10060` (WSAETIMEDOUT). Fires when a syn-ack never arrives. Usually a network-level firewall drop. Surfacing as a `TaskCanceledException` happens only when the wrapping `HttpClient.Timeout` is shorter than the OS-level connect timeout, otherwise you get an `HttpRequestException`.

### "Request was forcibly aborted" via CancelPendingRequests

Calling `HttpClient.CancelPendingRequests` cancels every in-flight request on that client, not just one. If your app reuses a client and one component calls `CancelPendingRequests`, every other component's pending request fails with the same `TaskCanceledException`. This is one of the strongest reasons to use `IHttpClientFactory` instead of a long-lived static client. The factory's per-call typed clients are short-lived facades, so a stray `CancelPendingRequests` only affects the caller.

## Related

For the full cancellation pattern, the [cancel-a-long-running-task walkthrough](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) covers `CancellationToken`, `Task.WaitAsync`, and the linked-token shape used above. The [unit-testing HttpClient guide](/2026/04/how-to-unit-test-code-that-uses-httpclient/) shows how to fake out timeouts in tests so the timeout branches are actually exercised. For streaming downloads, the [stream-from-ASP.NET-Core post](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) covers the matching server-side cancellation forwarding. If your background workers are issuing these calls, the [BackgroundService walkthrough](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/) covers the lifetime and cancellation rules that keep the linked-token pattern correct under host shutdown.

## Sources

- [`HttpClient.Timeout` property](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpclient.timeout), Microsoft Learn.
- [`HttpCompletionOption` enum](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpcompletionoption), Microsoft Learn.
- [`SocketsHttpHandler.ConnectTimeout`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.socketshttphandler.connecttimeout), Microsoft Learn.
- [`HttpRequestError` enum](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httprequesterror), Microsoft Learn.
- [HttpClient throws TaskCanceledException on timeout](https://github.com/dotnet/runtime/issues/21965), dotnet/runtime issue.
- [How to identify HttpClient connect timeout errors?](https://github.com/dotnet/runtime/issues/78070), dotnet/runtime issue.
- [`Microsoft.Extensions.Http.Resilience` standard handler](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience), Microsoft Learn.
