---
title: "Fix: HttpIOException: The response ended prematurely from HttpClient in .NET"
description: "HttpClient reuses a keep-alive connection the server just closed, or the server drops the connection mid-response. Lower PooledConnectionIdleTimeout below the server's idle timeout and retry only idempotent requests."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "httpclient"
  - "networking"
---

`HttpIOException: The response ended prematurely. (ResponseEnded)` means the TCP connection closed before `HttpClient` got a complete HTTP response. The most common cause is a keep-alive race: `HttpClient` sends a request on a pooled connection at the same moment the server closes it for being idle. Set `SocketsHttpHandler.PooledConnectionIdleTimeout` well below the server's (or load balancer's) idle timeout, and retry `ResponseEnded` only for requests that are safe to send twice. If the error happens on every request, you are talking to the wrong thing: `http://` against an HTTPS port, or a Docker port mapping with nothing listening behind it.

Everything below was reproduced on .NET 10.0.10 (SDK 10.0.302) and .NET 11 RC 1 (SDK 11.0.100-rc.1.26425.128) against small raw-socket servers that misbehave on purpose. Both runtimes gave byte-for-byte identical results.

## The error in context

The exception you see at the call site is almost always an `HttpRequestException` that wraps the `HttpIOException`:

```text
System.Net.Http.HttpRequestException: An error occurred while sending the request.
 ---> System.Net.Http.HttpIOException: The response ended prematurely. (ResponseEnded)
   at System.Net.Http.HttpConnection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at System.Net.Http.HttpConnection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(HttpRequestMessage request, Boolean async, Boolean doRequestAuth, CancellationToken cancellationToken)
   at System.Net.Http.RedirectHandler.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpClient.<SendAsync>g__Core|83_0(HttpRequestMessage request, HttpCompletionOption completionOption, CancellationTokenSource cts, Boolean disposeCts, CancellationTokenSource pendingRequestsCts, CancellationToken originalCancellationToken)
```

There are three variants of the message, and which one you get tells you where the connection died:

| Outer message | Inner message | What it means |
| --- | --- | --- |
| `An error occurred while sending the request.` | `The response ended prematurely. (ResponseEnded)` | EOF before a single byte of the status line arrived |
| `Error while copying content to a stream.` | `The response ended prematurely. (ResponseEnded)` | Headers arrived, the body was cut short (buffered read) |
| none, `HttpIOException` is thrown directly | `The response ended prematurely, with at least 90 additional bytes expected. (ResponseEnded)` | Body cut short while you read the stream yourself |

HTTP/2 connections add a fourth: `The response ended prematurely while waiting for the next frame from the server.` Since .NET 8, `HttpRequestException.HttpRequestError` and `HttpIOException.HttpRequestError` are both set to `HttpRequestError.ResponseEnded` in every one of these cases, which is what your code should check instead of parsing message strings.

## Why this happens

`SocketsHttpHandler` throws `ResponseEnded` whenever a read from the socket returns 0 bytes (a clean FIN from the other side) while it still expects data. The source is two lines in `HttpConnection.cs`: an empty read buffer after sending the request, or `bytesRead == 0` inside `FillAsync`. Nothing in .NET decided to fail. The peer closed the connection. The question is why, and the causes, ranked by how often they show up:

1. **Keep-alive race.** The server (or a proxy, or a cloud load balancer) closes idle connections after N seconds. `HttpClient` keeps idle connections for 60 seconds by default. If N is shorter, sooner or later a request goes out on a connection the server is closing at that exact moment. This is the intermittent, "works 99% of the time" version.
2. **Nothing real is listening.** Docker Desktop, `kubectl port-forward`, SSH tunnels and some reverse proxies accept the TCP connection themselves and then close it when the backend is not there. You get `ResponseEnded` instead of `Connection refused`.
3. **Wrong protocol on the port.** Sending plain `http://` to a TLS-only port (a common Kestrel `launchSettings.json` mix-up) makes the server fail the handshake and close the socket.
4. **The server crashed or gave up mid-response.** A process that dies while streaming, a proxy that hits a size or time limit, or a handler that sets `Content-Length` higher than what it writes. This gives the body-phase variants.

## Minimal repro

This file-based app starts a raw TCP server that answers the first request on each connection and closes the connection without answering the second one, which is exactly what a server-side idle timeout looks like when it fires during your request.

```csharp
// .NET 10.0.10, C# 14. Run with: dotnet run repro.cs
using System.Net;
using System.Net.Sockets;
using System.Text;

var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
int port = ((IPEndPoint)listener.LocalEndpoint).Port;
int connections = 0;

_ = Task.Run(async () =>
{
    while (true)
    {
        var tcp = await listener.AcceptTcpClientAsync();
        int connectionId = Interlocked.Increment(ref connections);
        _ = Task.Run(async () =>
        {
            using (tcp)
            {
                var stream = tcp.GetStream();
                for (int requestNo = 1; ; requestNo++)
                {
                    if (!await ReadRequestAsync(stream)) return;
                    Console.WriteLine($"  server: connection {connectionId}, request {requestNo}");
                    if (requestNo == 2) return; // idle timeout fires: close, no response
                    await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"u8.ToArray());
                }
            }
        });
    }
});

using var client = new HttpClient();
foreach (var method in new[] { HttpMethod.Get, HttpMethod.Post })
{
    for (int i = 1; i <= 2; i++)
    {
        try
        {
            using var request = new HttpRequestMessage(method, $"http://127.0.0.1:{port}/");
            if (method == HttpMethod.Post) request.Content = new StringContent("{}");
            using var response = await client.SendAsync(request);
            Console.WriteLine($"{method} #{i}: {await response.Content.ReadAsStringAsync()}");
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"{method} #{i}: {ex.HttpRequestError} / {ex.InnerException?.Message}");
        }
    }
}

// Reads one request: headers up to the blank line, then Content-Length bytes of body.
static async Task<bool> ReadRequestAsync(NetworkStream stream)
{
    var data = new List<byte>();
    var buffer = new byte[8192];
    int headerEnd;
    while ((headerEnd = Encoding.ASCII.GetString(data.ToArray()).IndexOf("\r\n\r\n")) < 0)
    {
        int read = await stream.ReadAsync(buffer);
        if (read == 0) return false;
        data.AddRange(buffer.AsSpan(0, read));
    }
    var headers = Encoding.ASCII.GetString(data.ToArray(), 0, headerEnd);
    var lengthLine = headers.Split("\r\n")
        .FirstOrDefault(h => h.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase));
    int remaining = (lengthLine is null ? 0 : int.Parse(lengthLine[15..])) - (data.Count - headerEnd - 4);
    while (remaining > 0)
    {
        int read = await stream.ReadAsync(buffer);
        if (read == 0) return false;
        remaining -= read;
    }
    return true;
}
```

Output on .NET 10.0.10 and .NET 11 RC 1:

```text
  server: connection 1, request 1
GET #1: ok
  server: connection 1, request 2
  server: connection 2, request 1
GET #2: ok
  server: connection 2, request 2
POST #1: ResponseEnded / The response ended prematurely. (ResponseEnded)
  server: connection 3, request 1
POST #2: ok
```

Read the server lines. `GET #2` hit the dead connection too (connection 1, request 2), and `SocketsHttpHandler` silently resent it on a brand-new connection 2. `POST #1` then reused connection 2, got dropped the same way, and surfaced the exception. The handler resends a failed request only when it went out on a reused pooled connection and had no body, or its body was held back by `Expect: 100-continue` (the `_canRetry` flag in `HttpConnection.SendAsync`). A `POST` with content is never resent, because the handler cannot know whether the server already acted on it. That is why this error shows up in the logs for your writes and almost never for your reads.

## Fix 1: keep idle connections shorter than the server does

The durable fix for the intermittent version is to make sure `HttpClient` throws an idle connection away before the server does. Find the shortest idle timeout on the path: the service itself, any reverse proxy, and the load balancer. Some real defaults:

- Kestrel `KeepAliveTimeout`: 130 seconds, longer than the client default, so .NET to .NET is fine out of the box.
- Node.js 26 `http.Server`: `keepAliveTimeout` 5 seconds, `keepAliveTimeoutBuffer` 1 second.
- uvicorn: `--timeout-keep-alive` 5 seconds. Gunicorn: `keepalive` 2 seconds.
- AWS Application Load Balancer: idle timeout 60 seconds, the same as the client default, which makes the race possible on every connection that sits idle for about a minute.

Then configure the handler below that number. With `IHttpClientFactory`:

```csharp
// .NET 10, Microsoft.Extensions.Http 10.0.12
builder.Services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://orders.internal/"))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        // Server or load balancer closes idle connections after 60s (AWS ALB default).
        PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
        // Also recycle connections so DNS changes are picked up.
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    });
```

Leave real margin. `PooledConnectionIdleTimeout` is not checked when a connection is taken from the pool. It is enforced by a background scavenger timer that runs every `PooledConnectionIdleTimeout / 4`, with a floor of one second (`HttpConnectionPoolManager.cs`). A connection can therefore live up to about 1.25 times the configured idle timeout, or the idle timeout plus one second for small values. Half of the server's timeout is a safe rule.

What does get checked at rent time is the server's own `Keep-Alive: timeout=N` response header. `HttpConnection.PrepareForReuse` calls `CheckKeepAliveTimeoutExceeded()` and discards the connection if it has been idle for N seconds or more, on HTTP/1.1 as well as 1.0. That is why Node.js services rarely trigger this: Node advertises `timeout=5` and actually closes after 6. If you own the server, sending a `Keep-Alive` header with a value lower than the real timeout is a fix that protects every client, not just .NET ones.

I measured all three options against a server that closes connections after exactly 2,000 ms of idle time, with a client that sends a `POST` every 1,990-2,010 ms (150 requests each, .NET 10.0.10):

| Client/server configuration | Succeeded | `ResponseEnded` |
| --- | --- | --- |
| Defaults (`PooledConnectionIdleTimeout` 60 s) | 147 | 3 |
| `PooledConnectionIdleTimeout = 800 ms` | 150 | 0 |
| Server sends `Keep-Alive: timeout=1` | 150 | 0 |

Three failures out of 150 is what makes this error so annoying in production: it is rare enough to pass every test and frequent enough to page someone. Most of the time the server's FIN arrives before the next request, and `PrepareForReuse` sees the closed connection and quietly opens a new one. Only when the close lands in the few milliseconds between that check and the request going out does it surface. Both fixes removed it completely. The 800 ms idle timeout works because the scavenger (running every second at that setting) drops connections before the 2,000 ms server timeout. The header works because the client checks it synchronously on every rent.

## Fix 2: retry `ResponseEnded`, but only when a second attempt is safe

Timeouts reduce the race, they cannot eliminate it: a server can still restart, scale in, or drop a connection for its own reasons. So treat `ResponseEnded` as transient, with one condition. The server may have received and processed the request before it closed the socket. My repro server read the full body of every request it then dropped. For a `POST` that creates an order, a blind retry can create two orders.

`AddStandardResilienceHandler()` does not make this distinction for you. Its default `ShouldHandle` (`HttpClientResiliencePredicates.IsTransient`) treats every `HttpRequestException` as transient, for every HTTP method. Either call `options.Retry.DisableForUnsafeHttpMethods()`, or write a predicate that retries unsafe methods only when the request carries an idempotency key the server deduplicates on:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddHttpClient<OrdersClient>()
    .AddResilienceHandler("stale-connection", pipeline => pipeline.AddRetry(new HttpRetryStrategyOptions
    {
        MaxRetryAttempts = 1,
        Delay = TimeSpan.Zero, // a new connection is all we need, no backoff
        ShouldHandle = args => ValueTask.FromResult(
            args.Outcome.Exception is HttpRequestException { HttpRequestError: HttpRequestError.ResponseEnded }
            && args.Context.GetRequestMessage() is { } request
            && (request.Method == HttpMethod.Get
                || request.Method == HttpMethod.Put
                || request.Method == HttpMethod.Delete
                || request.Headers.Contains("Idempotency-Key"))),
    }));
```

And on the call site:

```csharp
// .NET 10
using var request = new HttpRequestMessage(HttpMethod.Post, "orders") { Content = JsonContent.Create(order) };
request.Headers.Add("Idempotency-Key", order.ClientRequestId.ToString());
using var response = await http.SendAsync(request, ct);
```

Against the repro server (which drops the second request on every connection), three `POST`s with this handler all returned `200 ok`, with one retry each for the second and third. The server saw five requests on three connections, which is the point: the two dropped ones did reach it. If your retry sits in a `DelegatingHandler` instead, keep in mind [where that handler runs relative to the retry loop](/2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler/), and read [Polly vs the built-in resilience handlers](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) if you are deciding between the two APIs.

## Fix 3: when it fails on every single request

A consistent `ResponseEnded` on the first request of a fresh process is not a race. My probe produced the exact same exception for both of these:

**`http://` against a TLS endpoint.** A server that only speaks TLS receives `GET / HTTP/1.1` as a garbage ClientHello, fails the handshake, and closes. Check the scheme and port against `launchSettings.json` (Kestrel's default profile listens on an `https` port and an `http` port, and it is easy to pair the wrong ones) or against `ASPNETCORE_URLS`. The opposite mistake, `https://` against a plain HTTP port, gives [the SSL connection could not be established](/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/) instead.

**A listener with nothing behind it.** Docker publishes ports through its own proxy. If the app inside the container listens on `localhost` instead of `0.0.0.0` (`ASPNETCORE_URLS=http://+:8080` fixes that for ASP.NET Core), or has crashed, the proxy accepts your connection and closes it immediately. Run `curl -v http://localhost:8080/` from the same machine. If curl reports `Empty reply from server`, the problem is not in your .NET code.

## Fix 4: when the body is what gets cut off

If the outer message is `Error while copying content to a stream.`, or you read the stream yourself and see `with at least N additional bytes expected`, the status line and headers arrived and the connection closed partway through the body. The server-side logs are where the answer is:

- The upstream process crashed or was killed (OOM, a pod eviction, a deployment) while streaming.
- A proxy cut the response at a size or duration limit. nginx `proxy_read_timeout`, a CDN response limit, or an API gateway payload cap all end this way.
- The server declared a `Content-Length` larger than the bytes it wrote, usually a middleware that changed the body (compression, rewriting) after the header was set. .NET reports the shortfall exactly, 90 bytes in my repro where the header said 100 and the server sent 10.
- A chunked response ended without the terminating zero-length chunk, which also produces the `copying content` variant.

Retrying a truncated body is only safe under the same idempotency rules as Fix 2, because the server certainly processed this request.

## Gotchas and lookalikes

**`HttpRequestError` exists only on .NET 8 and later.** On .NET 6 and 7 the inner exception is a plain `IOException` with the message `The response ended prematurely.`, and there is no enum to switch on. The keep-alive behavior and every fix above are the same.

**`Connection reset by peer` is the same race, one step later.** If the server closes a socket that still has unread request data in its receive buffer, the kernel sends RST instead of FIN, and you get `HttpRequestException` wrapping `IOException: Unable to read data from the transport connection: Connection reset by peer` (`An existing connection was forcibly closed by the remote host` on Windows). The fixes are identical.

**`PooledConnectionIdleTimeout = TimeSpan.Zero` disables pooling.** It does make the race impossible, and in my probe it turned the failing `POST` into a success, but every request then pays for a new TCP (and TLS) handshake. Use it for diagnosis only: if the error disappears with it, you have confirmed the keep-alive race.

**`TaskCanceledException` is a different failure.** A request that hits `HttpClient.Timeout` ends with [a task was canceled](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/), not with `ResponseEnded`. If you see both, the server is probably slow and something in front of it is closing connections that wait too long.

**Creating a new `HttpClient` per request does not fix it.** It hides the keep-alive race by never reusing connections, and trades it for socket exhaustion under load. [HttpClient vs HttpClientFactory vs Refit](/2026/05/httpclient-vs-httpclientfactory-vs-refit/) covers the lifetime rules that actually work.

## Related

- [Fix: TaskCanceledException: A task was canceled with HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/), the timeout counterpart of this error.
- [Fix: The SSL connection could not be established](/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/), for the scheme mix-up in the other direction.
- [Why a DelegatingHandler does not run on each retry with AddStandardResilienceHandler](/2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler/).
- [Polly vs resilience handlers in .NET 11](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/).
- [How to unit test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/), if you want a test that throws `HttpRequestException` with `HttpRequestError.ResponseEnded` to cover your retry predicate.

## Sources

- [`HttpConnection.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/HttpConnection.cs) (`SendAsync`, `FillAsync`, `PrepareForReuse`, `CheckKeepAliveTimeoutExceeded`) and [`HttpConnectionPoolManager.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/HttpConnectionPoolManager.cs) (scavenger period) on the `release/10.0` branch of dotnet/runtime.
- [`ContentLengthReadStream.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/ContentLengthReadStream.cs) and the [System.Net.Http resource strings](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/Resources/Strings.resx) for the exact messages.
- [`HttpRequestError` enum](https://learn.microsoft.com/dotnet/api/system.net.http.httprequesterror) and [`SocketsHttpHandler.PooledConnectionIdleTimeout`](https://learn.microsoft.com/dotnet/api/system.net.http.socketshttphandler.pooledconnectionidletimeout) on Microsoft Learn.
- [HttpClient guidelines for .NET](https://learn.microsoft.com/dotnet/fundamentals/networking/http/httpclient-guidelines), on pooled connection lifetime and client reuse.
- [`HttpClientResiliencePredicates.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Polly/HttpClientResiliencePredicates.cs) and [`HttpRetryStrategyOptionsExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Polly/HttpRetryStrategyOptionsExtensions.cs) in dotnet/extensions.
- [Node.js `server.keepAliveTimeout`](https://nodejs.org/api/http.html#serverkeepalivetimeout) and [AWS ALB connection idle timeout](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html#connection-idle-timeout).
