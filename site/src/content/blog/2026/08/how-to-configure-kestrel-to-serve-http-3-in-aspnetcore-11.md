---
title: "How to configure Kestrel to serve HTTP/3 in ASP.NET Core 11"
description: "A complete guide to enabling HTTP/3 on Kestrel in ASP.NET Core 11: the HttpProtocols.Http1AndHttp2AndHttp3 endpoint config, MsQuic platform requirements on Windows, Linux, and macOS, why the first request is never HTTP/3, how to verify with HttpClient and middleware, QuicTransportOptions tuning, and the firewall and proxy gotchas that make it silently fall back."
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "kestrel"
  - "http-3"
  - "performance"
---

To serve HTTP/3 from Kestrel you configure an HTTPS endpoint with `listenOptions.Protocols = HttpProtocols.Http1AndHttp2AndHttp3`. That is the whole API surface. Everything that goes wrong afterwards is environmental: MsQuic is missing on the host, UDP is blocked on the port, a reverse proxy terminates the connection before QUIC ever reaches you, or you are testing with a browser that refuses the development certificate over HTTP/3. Kestrel does not throw for any of these. It disables HTTP/3, keeps serving HTTP/1.1 and HTTP/2, and your `curl` output looks exactly like it did before you changed anything.

Everything here targets .NET 11 (tested against Preview 6, SDK `11.0.100-preview.6.26359.118`) with `Microsoft.NET.Sdk.Web` and C# 14. HTTP/3 in Kestrel has been fully supported since .NET 7, so the configuration below is unchanged on .NET 8, 9, and 10. The one piece that is genuinely new in .NET 11 is the early request-processing behavior covered at the end.

## The six steps, start to finish

1. Configure an HTTPS endpoint and set `Protocols` to `HttpProtocols.Http1AndHttp2AndHttp3`.
2. Make sure MsQuic is present on the host, which means Windows 11 or Windows Server 2022 or later, or the `libmsquic` package on Linux.
3. Open the UDP port with the same number as your TLS port on every firewall and security group in the path.
4. Add a startup guard that logs loudly when `QuicListener.IsSupported` is false, so a missing dependency is a log line and not a mystery.
5. Verify with `HttpClient` pinned to version 3.0, not with a browser.
6. Log `HttpContext.Request.Protocol` in middleware so you can see what clients actually negotiated in production.

The rest of this post is about doing each of those correctly rather than just making the code compile.

## Configuring the endpoint

There is no NuGet package to install. The QUIC transport, `Microsoft.AspNetCore.Server.Kestrel.Transport.Quic`, ships in the ASP.NET Core shared framework. You only need to change how the endpoint is declared:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Server.Kestrel.Core;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel((context, options) =>
{
    options.ListenAnyIP(5001, listenOptions =>
    {
        listenOptions.Protocols = HttpProtocols.Http1AndHttp2AndHttp3;
        listenOptions.UseHttps();
    });
});

var app = builder.Build();

app.MapGet("/ping", (HttpContext ctx) => new { protocol = ctx.Request.Protocol });

app.Run();
```

Two details in that snippet do real work. `UseHttps()` is not optional: HTTP/3 mandates TLS 1.3, so an endpoint without it can never negotiate h3. And the enum value is `Http1AndHttp2AndHttp3`, not `Http3`. Kestrel's default is `Http1AndHttp2`, and the three-protocol value is the one you want in production because not every router, corporate proxy, or mobile carrier passes QUIC cleanly. `HttpProtocols.Http3` on its own gives you an endpoint with no fallback path: on a host where MsQuic is unavailable, Kestrel disables HTTP/3 and there is nothing left for that endpoint to serve.

The same setting is available from configuration, which is usually the better place for it because it lets you enable HTTP/3 per environment without a rebuild:

```json
{
  "Kestrel": {
    "Endpoints": {
      "Https": {
        "Url": "https://*:5001",
        "Protocols": "Http1AndHttp2AndHttp3"
      }
    }
  }
}
```

There is also `Kestrel:EndpointDefaults:Protocols` if you want it applied to every endpoint. Be aware of the precedence rule that catches people here: an explicit `Listen` or `ListenAnyIP` call in `ConfigureKestrel` overrides `ASPNETCORE_URLS`, `--urls`, and the `applicationUrl` in `launchSettings.json`. Kestrel logs a warning when that happens ("Overriding address(es)"), and if you miss it you will spend an afternoon wondering why your app is not on port 7043 any more. Pick one mechanism, not both.

## What MsQuic requires on each platform

ASP.NET Core does not implement QUIC itself. `System.Net.Quic` binds to [MsQuic](https://github.com/microsoft/msquic), and the platform matrix is inherited wholesale from that native library.

On **Windows**, `msquic.dll` is distributed as part of the .NET runtime, so there is nothing to install, but the OS has to be Windows 11 or Windows Server 2022 or later. Earlier Windows versions lack the cryptographic APIs that QUIC needs, and no amount of configuration works around it. This is the single most common reason HTTP/3 does not light up on a corporate deployment target still running Windows Server 2019.

On **Linux**, you must install `libmsquic` yourself. It is published in Microsoft's package repository at `packages.microsoft.com`, and is also in Alpine's community repository:

```bash
# Debian / Ubuntu, after adding the packages.microsoft.com repo
sudo apt-get install libmsquic

# Alpine 3.21 and later
sudo apk add libmsquic
```

.NET 7 and later require libmsquic 2.2 or newer. The 1.9.x line that .NET 6 pinned to is not compatible, so if you are carrying an old Dockerfile forward from a .NET 6 project, check the version you are pulling. This also means a plain `mcr.microsoft.com/dotnet/aspnet` container image does **not** speak HTTP/3 out of the box; you have to add the package to your own image layer. If you are building images with `dotnet publish /t:PublishContainer`, that is an extra `RUN` you cannot express through the SDK's container properties alone, and you will need a Dockerfile.

On **macOS**, support is partial and unofficial. You can `brew install libmsquic`, but the runtime will not find it unless you point the dynamic loader at Homebrew's prefix:

```bash
DYLD_FALLBACK_LIBRARY_PATH=$DYLD_FALLBACK_LIBRARY_PATH:$(brew --prefix)/lib dotnet run
```

Treat that as a local development convenience, not a supported production configuration.

## Making the silent fallback loud

Kestrel's fallback behavior is the right default for a web server and the worst possible default for debugging. If MsQuic is missing, HTTP/3 is disabled and the app starts normally. Nothing in the default log output at `Information` level tells you.

The fix is a three-line startup check against the same `IsSupported` property that `System.Net.Quic` exposes:

```csharp
// .NET 11, C# 14
using System.Net.Quic;

var app = builder.Build();

if (!QuicListener.IsSupported)
{
    app.Logger.LogWarning(
        "QUIC is not supported on this host. HTTP/3 is disabled and Kestrel " +
        "will serve HTTP/1.1 and HTTP/2 only. Check for libmsquic and TLS 1.3 support.");
}
```

`QuicListener.IsSupported` returns false for both of the reasons that matter: the native library is absent, or TLS 1.3 is unavailable. Use `QuicListener.IsSupported` on the server side and `QuicConnection.IsSupported` on the client side. They currently report the same value, but the documented guidance is to check the one that matches your role.

If you want more detail, turn the Kestrel category up to `Debug` and watch the bind:

```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Server.Kestrel": "Debug"
    }
  }
}
```

## Why your first request is never HTTP/3

This is the part that makes people think their configuration is broken when it is working perfectly.

A client cannot know a server speaks HTTP/3 before it connects, because there is no DNS record or TLS extension advertising it. Discovery happens through the [`alt-svc`](https://developer.mozilla.org/docs/Web/HTTP/Headers/Alt-Svc) response header: the client makes its first request over HTTP/1.1 or HTTP/2, sees a header naming an h3 endpoint, and uses QUIC for subsequent requests to that origin. Kestrel adds that header automatically whenever HTTP/3 is enabled on the endpoint, so you get something like this on the first response:

```text
HTTP/2 200
alt-svc: h3=":5001"
```

So a single-request test will always report HTTP/2. Any measurement you take has to make at least two requests over the same client instance, and the client has to be one that honors `alt-svc`.

IIS is the exception worth knowing about. When you host behind IIS, HTTP/3 is supported in-process, but IIS does not add `alt-svc` for you. You add it yourself, early in the pipeline:

```csharp
// .NET 11, C# 14 - only needed when hosting behind IIS
app.Use((context, next) =>
{
    context.Response.Headers.AltSvc = "h3=\":443\"";
    return next(context);
});
```

IIS additionally needs Windows Server 2022 or Windows 11, an `https` binding, and the `EnableHttp3` registry key set. And note that out-of-process hosting reports `HTTP/1.1` from `HttpRequest.Protocol` even on an HTTP/3 connection, because that is the protocol IIS uses to proxy to Kestrel. Only the in-process model reports `HTTP/3`.

## Verifying it actually works

Do not use a browser. Browsers refuse self-signed certificates over HTTP/3, which includes the ASP.NET Core development certificate, so a local browser test will report HTTP/2 forever and tell you nothing.

Use `HttpClient` with the version pinned. For a test you want `RequestVersionExact`, because it fails loudly instead of silently downgrading:

```csharp
// .NET 11, C# 14
using System.Net;

using var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version30,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact
};

var response = await client.GetAsync("https://localhost:5001/ping");

Console.WriteLine($"status: {response.StatusCode}, version: {response.Version}");
// status: OK, version: 3.0
```

In application code you want the opposite policy. Set the version to 1.1 with `HttpVersionPolicy.RequestVersionOrHigher` so the client upgrades to HTTP/3 when the server advertises it and degrades gracefully when it does not. Pinning `RequestVersionExact` in production turns a network hiccup into a hard failure, which is a close cousin of [the TLS handshake failures that surface as "The SSL connection could not be established"](/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/).

On the server, the ground truth is one line of middleware:

```csharp
// .NET 11, C# 14
app.Use(async (context, next) =>
{
    app.Logger.LogInformation("Request served over {Protocol}", context.Request.Protocol);
    await next(context);
});
```

`HttpContext.Request.Protocol` is the string `"HTTP/3"` for a QUIC connection. If you want to branch on it, `HttpProtocol.IsHttp3(context.Request.Protocol)` from `Microsoft.AspNetCore.Http` avoids hardcoding the literal. Emitting this as a metric dimension for a week after rollout is the only honest way to know what fraction of your traffic actually made it onto h3, and it is usually lower than you expect.

## Tuning QuicTransportOptions

The transport has its own options object, configured through `UseQuic` on the web host builder rather than through `ConfigureKestrel`:

```csharp
// .NET 11, C# 14
builder.WebHost.UseQuic(options =>
{
    options.MaxBidirectionalStreamCount = 200;
    options.MaxUnidirectionalStreamCount = 20;
});
```

The defaults are `MaxBidirectionalStreamCount` 100, `MaxUnidirectionalStreamCount` 10, `MaxReadBufferSize` 1 MB, `MaxWriteBufferSize` 64 KB, and `Backlog` 512. The bidirectional stream count is the one worth revisiting: it caps concurrent requests per connection, and because QUIC has no head-of-line blocking, a client that would have opened several HTTP/2 connections may now push everything down one. If you are fronting a chatty single-page app or a gRPC client, 100 can become the ceiling.

If you copied a sample that wraps this block in `#pragma warning disable CA2252`, that dates from when `System.Net.Quic` shipped as a preview feature. Those APIs became stable in .NET 9, so you can usually drop the pragma.

## The gotchas that cost the most time

**UDP is not open.** QUIC runs over UDP on the same port number as your TLS endpoint. Every firewall, security group, and load balancer in the path has to allow inbound UDP on that port, and most default templates only open TCP. This is the number one cause of "it works on my machine and not in Azure."

**Something in front of you terminates the connection.** If a layer-7 load balancer, an ingress controller, or a CDN sits between the client and Kestrel, HTTP/3 has to be enabled *there*, and the hop from that proxy to Kestrel is frequently HTTP/1.1 regardless. Enabling h3 on Kestrel behind a proxy that does not forward QUIC changes nothing at all.

**Some `UseHttps` overloads are not compatible.** With HTTP/3 in play, `HandshakeTimeout` and `OnAuthenticate` on `HttpsConnectionAdapterOptions` are no-ops, and the `UseHttps` overloads taking a `ServerOptionsSelectionCallback` with a handshake timeout, or a `TlsHandshakeCallbackOptions`, throw. If you do dynamic per-hostname certificate selection, verify that path before enabling h3.

**You are measuring the wrong thing.** HTTP/3's wins are fewer handshake round trips and no head-of-line blocking under packet loss. On a low-latency, zero-loss connection between two machines in the same datacenter, it will look identical to HTTP/2, and a benchmark run on loopback will show nothing. Measure on a real mobile or lossy network or do not bother measuring. Response size still dominates most API latency budgets, which is why [response compression](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) is usually a bigger and cheaper win than a protocol upgrade.

## What .NET 11 changed

Before .NET 11, Kestrel waited to receive the peer's QUIC control stream and its initial `SETTINGS` frame before dispatching any request stream. That cost roughly one extra logical round trip on every brand-new connection, which is exactly the scenario where HTTP/3 is supposed to beat an already-warm HTTP/2 connection. In .NET 11, Kestrel dispatches request streams as soon as they arrive and applies peer settings when the control stream catches up. There is nothing to configure, and no handler-level code changes: it is a wire-level behavior change you get by upgrading, covered in more detail in the writeup of [Kestrel's early HTTP/3 request processing](/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/).

The one thing to keep in mind is that Kestrel still honors the peer's final `SETTINGS_MAX_FIELD_SECTION_SIZE` before serializing response headers. Keep first-request response headers small and you get the full benefit.

If you are standing up a new service and deciding how much of the host to configure explicitly, the protocol setting is one of a handful of knobs that pushes you toward a hand-built host rather than the default one; the tradeoffs are laid out in the comparison of [CreateBuilder, CreateSlimBuilder, and CreateEmptyBuilder](/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/).

## Related

- [Kestrel starts processing HTTP/3 requests before the SETTINGS frame in .NET 11](/2026/04/aspnetcore-11-kestrel-http3-early-request-processing/)
- [How to add response compression to an ASP.NET Core 11 API](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)
- [Fix: The SSL connection could not be established with HttpClient](/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/)
- [How to publish a .NET 11 app as a container image with dotnet publish /t:PublishContainer](/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)
- [WebApplication.CreateBuilder vs CreateSlimBuilder vs CreateEmptyBuilder in ASP.NET Core 11](/2026/07/webapplication-createbuilder-vs-createslimbuilder-vs-createemptybuilder-in-aspnetcore-11/)

## Sources

- [Use HTTP/3 with the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/http3), Microsoft Learn
- [Configure endpoints for the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/endpoints), Microsoft Learn
- [QUIC support in .NET, platform dependencies](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/quic/quic-overview#platform-dependencies), Microsoft Learn
- [Use HTTP/3 with HttpClient](https://learn.microsoft.com/en-us/dotnet/core/extensions/httpclient-http3), Microsoft Learn
- [Use ASP.NET Core with HTTP/3 on IIS](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/iis/http3), Microsoft Learn
- [RFC 9114: HTTP/3](https://www.rfc-editor.org/rfc/rfc9114), IETF
- [RFC 9000: QUIC, a UDP-based multiplexed and secure transport](https://www.rfc-editor.org/rfc/rfc9000), IETF
- [microsoft/msquic](https://github.com/microsoft/msquic), GitHub
