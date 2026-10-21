---
title: "Fix: HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR'"
description: "A peer sent RST_STREAM with PROTOCOL_ERROR for one request. HttpClient never retries it. Find which hop reset the stream, fix the request it rejected, retry only idempotent calls, or drop that hop to HTTP/1.1."
pubDate: 2026-10-21
template: error-page
tags:
  - "errors"
  - "httpclient"
  - "http2"
  - "dotnet"
  - "dotnet-10"
---

`HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1)` means the other end of the HTTP/2 connection sent an `RST_STREAM` frame for your request with error code 1. `HttpClient` did not break anything, it is reporting what the peer said, and it never retries a `PROTOCOL_ERROR` on its own. The fix is to find which hop sent the reset (your Kestrel app or a proxy, load balancer, or sidecar in front of it), fix whatever about that particular request it rejected, retry idempotent requests with a resilience handler, and as a last resort talk HTTP/1.1 to the hop that misbehaves.

Everything below was reproduced on .NET 10.0.10 (SDK 10.0.302, ASP.NET Core 10.0.10) with Kestrel and `HttpClient` in a single file-based app, plus `Microsoft.Extensions.Http.Resilience` 10.0.0 for the retry section. The relevant code paths are the same in .NET 8, 9, and 11.

## The error in context

When the reset arrives before the response headers, `SendAsync` (or `GetAsync`, `PostAsync`) throws an `HttpRequestException` that wraps the `HttpProtocolException`:

```text
System.Net.Http.HttpRequestException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
 ---> System.Net.Http.HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
   at System.Net.Http.Http2Connection.ThrowRequestAborted(Exception innerException)
   at System.Net.Http.Http2Connection.Http2Stream.CheckResponseBodyState()
   at System.Net.Http.Http2Connection.Http2Stream.TryEnsureHeaders()
   at System.Net.Http.Http2Connection.Http2Stream.ReadResponseHeadersAsync(CancellationToken cancellationToken)
   at System.Net.Http.Http2Connection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at System.Net.Http.Http2Connection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(HttpRequestMessage request, Boolean async, Boolean doRequestAuth, CancellationToken cancellationToken)
   at System.Net.Http.RedirectHandler.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
```

If the server already sent a status code and the reset hits while the body is being read, the outer message changes but the inner exception is identical:

```text
System.Net.Http.HttpRequestException: Error while copying content to a stream.
 ---> System.Net.Http.HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
```

In both cases `HttpRequestException.HttpRequestError` is `HttpRequestError.HttpProtocolError` and `HttpProtocolException.ErrorCode` is `1`. Check those two properties in code rather than the message text.

The wording "the HTTP/2 server reset the stream" is also important, because `SocketsHttpHandler` has three different HTTP/2 failure messages and each one points at a different problem:

| Message | Frame the client received | Scope |
| --- | --- | --- |
| `The HTTP/2 server reset the stream. HTTP/2 error code '...'` | `RST_STREAM` | This one request only |
| `The HTTP/2 server closed the connection. HTTP/2 error code '...'` | `GOAWAY` with an error | Every stream on that connection |
| `The HTTP/2 server sent invalid data on the connection. HTTP/2 error code '...'` | none, the client detected the violation itself | The whole connection |

This post covers the first row. If you see the second or third, the connection itself is unhealthy and the diagnosis is different.

## Why this happens

`PROTOCOL_ERROR` is the most generic code in [RFC 9113 section 7](https://www.rfc-editor.org/rfc/rfc9113#section-7). A peer sends it as a stream error when one request (its headers, its body, or its framing) breaks a rule, and the peer wants to reject that request without tearing down the shared connection. That design explains why the error looks random "under load": one HTTP/2 connection carries hundreds of concurrent requests, the reset hits only the one request that tripped a check, and the rest succeed. More traffic means more requests with the rare property that trips the check, so the failure rate climbs with load even though load is not the cause.

The causes, ranked by how often they show up for a .NET client:

1. **A proxy in the middle rejected something about that request.** Reverse proxies, service meshes, ingress controllers, and cloud load balancers all terminate HTTP/2 and validate requests with their own rules: header characters they consider invalid, multi-line header values, connection-specific headers, size limits on headers or bodies. Real examples: Envoy resetting streams that carry [malformed header characters](https://github.com/envoyproxy/envoy/issues/7061), nginx failing on a [multi-line header value](https://github.com/nginx/nginx/issues/540) without logging anything, and Kestrel itself rejecting [pseudo-headers after regular headers](https://github.com/dotnet/aspnetcore/issues/12190) sent by an Envoy hop.
2. **The request body did not match its `Content-Length`.** Kestrel resets the stream with `PROTOCOL_ERROR` when it receives more or fewer DATA bytes than the declared length (`Http2StreamErrorMoreDataThanLength` and `Http2StreamErrorLessDataThanLength` in [`Http2Stream.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Http2/Http2Stream.cs)). A .NET `HttpClient` catches its own mismatch before the server does (you get `Sent 5 request content bytes, but Content-Length promised 50.`), so when Kestrel logs this it is usually a non-.NET client, or a proxy that rewrote the body without fixing the header.
3. **Kestrel rejected the request's pseudo-headers.** Invalid `:method`, `:path`, `:scheme` mismatch, a bad `Host`/`:authority`, or a malformed extended CONNECT all end in `ResetAndAbort(..., Http2ErrorCode.PROTOCOL_ERROR)` in Kestrel. `HttpClient` builds these headers itself, so you only hit this through a proxy or a hand-rolled client.
4. **Application code reset the stream.** Any middleware or handler that calls `IHttpResetFeature.Reset(1)` produces exactly this error on the client. It is rare, but some gateways and gRPC interceptors do it on purpose to signal "malformed request".

One thing that is *not* usually the cause: the .NET client sending bad headers straight to Kestrel. In my repro, `TE: gzip`, `Connection: keep-alive`, and a 300 KB custom header sent over h2c to Kestrel 10.0.10 all came back as a normal `400 Bad Request`, not as a reset. If you see `PROTOCOL_ERROR` against a Kestrel backend, suspect whatever sits between the client and Kestrel first.

## Minimal repro

The smallest way to reproduce the exact exception is a Kestrel endpoint that resets its own stream through `IHttpResetFeature`, which is byte-for-byte what a proxy's `RST_STREAM` looks like from the client's side.

```csharp
// .NET 10.0.10, C# 14. Run with: dotnet run repro.cs
#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=false
using System.Net;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;

var hits = 0;
var builder = WebApplication.CreateBuilder();
builder.Logging.ClearProviders();
// h2c (HTTP/2 without TLS) needs an HTTP/2-only endpoint
builder.WebHost.ConfigureKestrel(k => k.ListenLocalhost(5199, o => o.Protocols = HttpProtocols.Http2));
var app = builder.Build();
app.MapGet("/reset/{code:int}", (HttpContext ctx, int code) =>
{
    Interlocked.Increment(ref hits);
    ctx.Features.Get<IHttpResetFeature>()!.Reset(code); // 1 = PROTOCOL_ERROR, 7 = REFUSED_STREAM
    return Results.Empty;
});
await app.StartAsync();

var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version20,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact,
};

foreach (var code in new[] { 1, 7 })
{
    hits = 0;
    try { await client.GetAsync($"http://localhost:5199/reset/{code}"); }
    catch (HttpRequestException e) when (e.InnerException is HttpProtocolException p)
    {
        Console.WriteLine($"code {code}: {e.HttpRequestError}, ErrorCode={p.ErrorCode}, server hits={hits}");
        Console.WriteLine($"  outer: {e.Message}");
    }
}
await app.StopAsync();
```

Output:

```text
code 1: HttpProtocolError, ErrorCode=1, server hits=1
  outer: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
code 7: HttpProtocolError, ErrorCode=7, server hits=4
  outer: The request was aborted.
```

The `server hits` column is the useful part. A `PROTOCOL_ERROR` reset reaches the server once and is thrown to you. A `REFUSED_STREAM` reset is retried by `SocketsHttpHandler` itself, because RFC 9113 guarantees the peer did not process a refused stream. The pool gives up after `MaxConnectionFailureRetries = 3` retries, so the server saw 4 attempts. The source is [`Http2Stream.OnReset`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/Http2Stream.cs), where `canRetry` is true only for `REFUSED_STREAM` and for streams a `GOAWAY` marked as unprocessed.

## Fix, in detail

### 1. Find out which hop sent the reset

The client cannot tell you who sent the `RST_STREAM`. It only knows the frame came from the peer it is connected to, which is the first HTTP/2 hop: often a proxy, not your service. Settle this before changing code:

- **Turn on Kestrel's HTTP/2 debug logs on the backend.** Kestrel logs every stream it resets under the `Microsoft.AspNetCore.Server.Kestrel.Http2` category at `Debug` level, with messages such as `HTTP/2 stream error "PROTOCOL_ERROR". A Reset is being sent to the stream.` (event 35) and `HTTP/2 stream error.` (event 30, carrying the `Http2StreamErrorException` with the exact reason, for example `More data received than specified in the Content-Length header.`).

```json
// appsettings.Development.json, ASP.NET Core 10
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore.Server.Kestrel.Http2": "Debug",
      "Microsoft.AspNetCore.Server.Kestrel.BadRequests": "Debug"
    }
  }
}
```

- **If Kestrel logs nothing for the failing request, the reset came from an intermediary.** Look in the proxy's access log for that time window. Envoy marks resets in its response flags and `upstream_reset_before_response_started` details, nginx logs header problems at `info` level in its error log (raise `error_log` to `info` to see them), and cloud load balancers usually expose a per-request reason code.
- **Bypass the proxy once.** Call the backend directly (port-forward, internal address) with the same request. If the error disappears, you have proved which hop is responsible.

### 2. Fix the request the hop rejected

Once you know which hop and what rule, the fix is usually in the request, not the transport. Log the method, path, header names, header value lengths, and body size of failing requests (never the values of auth headers) and compare them with successful ones. The usual suspects:

- Header values with characters outside visible ASCII, embedded line breaks, or leading/trailing whitespace, often user input copied into a custom header. `HttpClient` blocks CR, LF, and NUL, but strict proxies reject more than that.
- Headers that only make sense in HTTP/1.1 (`Connection`, `Keep-Alive`, `Proxy-Connection`, `Transfer-Encoding`, `Upgrade`, and `TE` with any value other than `trailers`). `HttpClient` lets you add them with `TryAddWithoutValidation`, and intermediaries are allowed to reset a stream that carries them.
- A request that is larger than the proxy's limits: big cookies, JWTs with many claims, large bodies on a proxy configured with small buffers. These are the classic "only some users" failures.
- A custom `HttpContent` that sets `Headers.ContentLength` and then writes a different number of bytes, or a proxy filter that compresses or rewrites the body. The non-.NET equivalent of this is a direct `PROTOCOL_ERROR` from Kestrel.

### 3. Retry, but only requests that are safe to repeat

When the reset comes from infrastructure you do not control, add a retry. A `PROTOCOL_ERROR` reset does not tell you whether the server processed the request (a proxy can reset after forwarding it), so limit retries to idempotent methods. With `Microsoft.Extensions.Http.Resilience`:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.0.0
using System.Net;
using Microsoft.Extensions.Http.Resilience;
using Polly;

builder.Services.AddHttpClient("api", c =>
    {
        c.BaseAddress = new Uri("https://api.internal");
        c.DefaultRequestVersion = HttpVersion.Version20;
    })
    .AddResilienceHandler("h2-reset", pipeline =>
    {
        var retry = new HttpRetryStrategyOptions
        {
            MaxRetryAttempts = 2,
            Delay = TimeSpan.FromMilliseconds(50),
            ShouldHandle = args => ValueTask.FromResult(
                args.Outcome.Exception is HttpRequestException { HttpRequestError: HttpRequestError.HttpProtocolError }),
        };
        retry.DisableForUnsafeHttpMethods(); // never replay POST, PUT, PATCH, DELETE, CONNECT
        pipeline.AddRetry(retry);
    });
```

Against an endpoint that resets the first attempt and succeeds on the second, a `GET` through this client returned `ok on attempt 2 via HTTP/2`, while a `POST` still threw the original `PROTOCOL_ERROR` after a single server hit. If you already use `AddStandardResilienceHandler`, its default `ShouldHandle` treats `HttpRequestException` as transient and covers this case too, but it retries every method unless you call `DisableForUnsafeHttpMethods()` on `options.Retry`. Note that `DisableForUnsafeHttpMethods` returns `void`, so call it on the options object before passing it to `AddRetry`, not in a fluent chain.

### 4. Downgrade the misbehaving hop to HTTP/1.1

If the reset comes from an intermediary with a buggy or overly strict HTTP/2 implementation, and you cannot fix or upgrade it, take HTTP/2 out of that hop. On the client:

```csharp
// .NET 10: ask for HTTP/1.1 for this client only
var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version11,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionOrLower,
};
```

In HTTP/1.1 there is no stream to reset: the same endpoint that reset the stream over HTTP/2 answered `ok on attempt 2 via HTTP/1.1` in the repro. You lose multiplexing, so expect more connections under load, and gRPC cannot do this at all because it requires HTTP/2. Treat this as a workaround with an issue filed against the proxy, not as the fix.

## Gotchas and variants

- **`REFUSED_STREAM` looks similar but is a different problem.** The outer message is `The request was aborted.` with the `REFUSED_STREAM` `HttpProtocolException` inside, and you only see it after the handler has already retried 3 times. It means the server or proxy is refusing new streams, typically because it hit its concurrent-stream limit or is shutting down. Look at `SETTINGS_MAX_CONCURRENT_STREAMS` on the server and consider `SocketsHttpHandler.EnableMultipleHttp2Connections = true`.
- **`HTTP_1_1_REQUIRED` on a local h2c endpoint.** If you configure Kestrel with `HttpProtocols.Http1AndHttp2` on plain `http://` and force HTTP/2 on the client, you get `The HTTP/2 server closed the connection. HTTP/2 error code 'HTTP_1_1_REQUIRED' (0xd).` Without TLS there is no ALPN to negotiate the protocol, so h2c needs an `Http2`-only endpoint.
- **Mid-body resets with `ResponseHeadersRead`.** When you stream the response yourself, the status code (often `200`) has already been returned when the reset arrives. Do not treat a success status as proof that the body is complete. The read throws `Error while copying content to a stream.`, or the `HttpProtocolException` directly (no `HttpRequestException` wrapper) from `ReadAsync` on the response stream.
- **Resilience handlers cannot retry a mid-body reset.** The handler pipeline returns as soon as the response headers arrive, and `HttpClient` buffers the body after that. A reset during the body therefore bypasses the retry in step 3, even with the default `ResponseContentRead`. If the body matters, wrap the whole "send and read" operation in your own retry for idempotent calls.
- **Peer closed the connection instead of resetting.** If the inner exception is `HttpIOException` with `ResponseEnded` rather than `HttpProtocolException`, the connection died without an HTTP/2 frame. That is the keep-alive and idle-timeout family covered in [the response ended prematurely fix](/2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient/).
- **Timeouts are not resets.** If the call hangs and then fails with `TaskCanceledException`, nothing reset the stream. Start with [why HttpClient throws "A task was canceled"](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

## Related

- [Fix: HttpIOException "The response ended prematurely" in HttpClient](/2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient/) covers the connection-level sibling of this error.
- [Polly vs resilience handlers in .NET 11](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) explains where the retry above fits and how the standard handler is composed.
- [HttpClient vs IHttpClientFactory vs Refit](/2026/05/httpclient-vs-httpclientfactory-vs-refit/) shows how to configure the named client this post uses.
- [Fix: The SSL connection could not be established](/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/) helps when the failure happens before HTTP/2 is even negotiated.
- [gRPC in containers: 4 traps you can fix](/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/) covers the HTTP/2-only transport issues gRPC adds on top.

## Sources

- [RFC 9113, HTTP/2: error codes (section 7) and stream errors (section 5.4.2)](https://www.rfc-editor.org/rfc/rfc9113#section-7)
- [`HttpProtocolException` class, Microsoft Learn](https://learn.microsoft.com/dotnet/api/system.net.http.httpprotocolexception)
- [`HttpProtocolException.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/HttpProtocolException.cs) and [`Http2Stream.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/Http2Stream.cs) in dotnet/runtime v10.0.0
- [Kestrel `Http2Stream.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Http2/Http2Stream.cs) and [`KestrelTrace.Http2.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Infrastructure/KestrelTrace.Http2.cs) in dotnet/aspnetcore v10.0.0
- [Build resilient HTTP apps, Microsoft Learn](https://learn.microsoft.com/dotnet/core/resilience/http-resilience)
- [envoyproxy/envoy#7061](https://github.com/envoyproxy/envoy/issues/7061), [nginx/nginx#540](https://github.com/nginx/nginx/issues/540), [dotnet/aspnetcore#12190](https://github.com/dotnet/aspnetcore/issues/12190)
