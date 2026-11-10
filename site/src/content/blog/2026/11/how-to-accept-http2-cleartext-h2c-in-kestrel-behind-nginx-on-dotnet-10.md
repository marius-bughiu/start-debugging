---
title: "How to accept HTTP/2 over cleartext (h2c) in Kestrel behind nginx on .NET 10"
description: "Kestrel on .NET 10 only speaks h2c on an endpoint set to HttpProtocols.Http2, and only to clients that use prior knowledge. Http1AndHttp2 without TLS silently falls back to HTTP/1.1, Upgrade: h2c is ignored, and nginx needs proxy_http_version 2 (1.29.4+, stable 1.30) or grpc_pass to talk HTTP/2 upstream. Checked with curl and HttpClient on ASP.NET Core 10.0.10."
pubDate: 2026-11-10
template: how-to
tags:
  - "aspnetcore"
  - "kestrel"
  - "http2"
  - "nginx"
  - "docker"
  - "dotnet-10"
---

**Short answer:** on .NET 10, Kestrel accepts HTTP/2 over plain `http://` (h2c) only on an endpoint whose `Protocols` is exactly `HttpProtocols.Http2`, and only from clients that start with the HTTP/2 connection preface ("prior knowledge"). The default `Http1AndHttp2` on a non-TLS endpoint logs a startup warning and serves HTTP/1.1 only, because without TLS there is no ALPN to pick the protocol, and Kestrel does not implement the `Upgrade: h2c` handshake. On the nginx side, the regular `proxy_pass` speaks HTTP/1.x to the backend unless you run nginx 1.29.4 or later (stable 1.30.0 or later) and set `proxy_http_version 2;`. On older nginx the only HTTP/2 upstream path is `grpc_pass grpc://...`, which is meant for gRPC.

The Kestrel behavior below was checked on ASP.NET Core 10.0.10 (SDK 10.0.302, macOS arm64) with curl 8.7.1 and `HttpClient`. nginx was not run for this post: the nginx statements come from the official changelog, the `proxy_http_version` reference, and the `ngx_http_proxy_v2_module.c` source on the `release-1.31.8` tag, all linked at the end.

## What the Stack Overflow asker ran into

The question [How to enable HTTP/2.0 for unencrypted http requests in Kestrel](https://stackoverflow.com/questions/80013217) describes a common layout: a .NET 10 app in a Docker container, nginx in front, and a wish to have nginx pass HTTP/2 through to the app. The asker notes that most search results describe .NET 5 or older. Two things are tangled together in that question, and they fail for different reasons:

1. **Browser to nginx.** This is where HTTP/2 actually matters for page load (multiplexing, header compression). Browsers only use HTTP/2 over TLS, so this hop is `listen 443 ssl; http2 on;` and has nothing to do with Kestrel.
2. **nginx to Kestrel.** This hop is usually cleartext inside a Docker network. Making it HTTP/2 requires both sides to agree on h2c, and both sides default to HTTP/1.1.

If you only care about the first hop, you are done once nginx terminates TLS with `http2 on;`. HTTP/1.1 with keepalive between nginx and a backend on the same host is the normal, well-trodden setup. You need h2c on the second hop when the backend relies on HTTP/2 features end to end: gRPC (which needs trailers and HTTP/2 framing), long-lived streaming calls, or a deliberate choice to reduce upstream connection count.

## Why Http1AndHttp2 without TLS gives you HTTP/1.1

A server that accepts both HTTP/1.1 and HTTP/2 on one port must learn which protocol the client wants before reading the first byte as a request. With TLS that is ALPN: the client lists `h2` and `http/1.1` in the handshake and the server picks one. Without TLS there are two options in the HTTP/2 spec family:

- **Upgrade.** The client sends an HTTP/1.1 request with `Upgrade: h2c` and an `HTTP2-Settings` header, and the server switches with `101 Switching Protocols`. RFC 9113 removed this mechanism (it was deprecated from RFC 7540), and Kestrel never implemented it.
- **Prior knowledge.** The client already knows the server speaks HTTP/2 and opens the connection with the preface `PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n`. No negotiation happens at all.

Kestrel supports only the second option, and only when the endpoint is HTTP/2-only. On an `Http1AndHttp2` cleartext endpoint it treats every connection as HTTP/1.1, and tells you so once at startup.

## Minimal repro: three endpoints, three curl modes

This file-based app (run with `dotnet run app.cs` on SDK 10.0.302) opens one listener per protocol setting and echoes what Kestrel saw. `PublishAot=false` keeps the file-based app from pulling in the Native AOT compiler package, which file-based web apps enable by default.

```csharp
// .NET 10 (SDK 10.0.302, ASP.NET Core 10.0.10), C# 14
#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=false

using Microsoft.AspNetCore.Server.Kestrel.Core;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(k =>
{
    k.ListenAnyIP(5001, o => o.Protocols = HttpProtocols.Http1AndHttp2); // the "obvious" setting
    k.ListenAnyIP(5002, o => o.Protocols = HttpProtocols.Http2);         // h2c, prior knowledge
    k.ListenAnyIP(5003, o => o.Protocols = HttpProtocols.Http1);         // plain HTTP/1.1
});

var app = builder.Build();

app.MapGet("/", (HttpContext ctx) =>
    $"port={ctx.Connection.LocalPort} protocol={ctx.Request.Protocol} scheme={ctx.Request.Scheme}\n");

app.Run();
```

Startup prints a warning for port 5001 and nothing for the others:

```text
warn: Microsoft.AspNetCore.Server.Kestrel[64]
      HTTP/2 is not enabled for [::]:5001. The endpoint is configured to use HTTP/1.1 and HTTP/2, but TLS is not enabled. HTTP/2 requires TLS application protocol negotiation. Connections to this endpoint will use HTTP/1.1.
```

That warning is the whole explanation, and it is easy to miss in container logs. Now hit each port with plain curl, with `--http2` (which over `http://` means "try `Upgrade: h2c`"), and with `--http2-prior-knowledge`:

```bash
# curl 8.7.1 (nghttp2 1.69.0), macOS arm64
for p in 5001 5002 5003; do
  for mode in "" "--http2" "--http2-prior-knowledge"; do
    echo "== port $p curl ${mode:-(http1.1)}"
    curl -sS -m 5 $mode -w "[http_version=%{http_version} code=%{http_code}]\n" http://localhost:$p/
  done
done
```

The output, condensed to one line per request:

```text
== port 5001 curl (http1.1)
port=5001 protocol=HTTP/1.1 scheme=http        [http_version=1.1 code=200]
== port 5001 curl --http2
port=5001 protocol=HTTP/1.1 scheme=http        [http_version=1.1 code=200]
== port 5001 curl --http2-prior-knowledge
curl: (16) Remote peer returned unexpected data while we expected SETTINGS frame.
== port 5002 curl (http1.1)
An HTTP/1.x request was sent to an HTTP/2 only endpoint.   [http_version=1.1 code=400]
== port 5002 curl --http2
An HTTP/1.x request was sent to an HTTP/2 only endpoint.   [http_version=1.1 code=400]
== port 5002 curl --http2-prior-knowledge
port=5002 protocol=HTTP/2 scheme=http          [http_version=2 code=200]
== port 5003 curl --http2-prior-knowledge
curl: (16) Remote peer returned unexpected data while we expected SETTINGS frame.
```

Four things fall out of this:

- **`Upgrade: h2c` is ignored.** With `--http2`, curl sent `Connection: Upgrade, HTTP2-Settings` and `Upgrade: h2c`. Kestrel answered `HTTP/1.1 200 OK` on port 5001 and never switched. Any client or proxy that relies on the upgrade dance stays on HTTP/1.1 forever.
- **Prior knowledge against `Http1AndHttp2` is rejected, not downgraded.** Sending the raw preface to port 5001 returned exactly one 17-byte HTTP/2 frame: `00 00 08 07 00 ...  00 00 00 0d`. That is a `GOAWAY` (type `0x7`) with error code `0xd`, `HTTP_1_1_REQUIRED`. Kestrel recognizes the preface, then refuses HTTP/2 on that endpoint. curl reports it as "unexpected data while we expected SETTINGS frame"; .NET's `HttpClient` reports `The HTTP/2 server closed the connection. HTTP/2 error code 'HTTP_1_1_REQUIRED' (0xd).`
- **An `Http2`-only endpoint rejects HTTP/1.1 with a 400.** The body is `An HTTP/1.x request was sent to an HTTP/2 only endpoint.` This matters for health checks, covered below.
- **Only `Http2` plus prior knowledge works.** `Request.Protocol` is `HTTP/2` and `Request.Scheme` stays `http`.

## How to enable h2c between nginx and Kestrel

1. **Give Kestrel an HTTP/2-only cleartext endpoint.** In code, use `HttpProtocols.Http2` as in port 5002 above. In a container you usually do not hardcode ports, so set it through configuration instead. `Kestrel:EndpointDefaults:Protocols` applies to endpoints created from `ASPNETCORE_HTTP_PORTS`, which is what the official .NET 10 images set to `8080`:

   ```bash
   # .NET 10.0.10: no code changes, environment only
   ASPNETCORE_HTTP_PORTS=8080
   Kestrel__EndpointDefaults__Protocols=Http2
   ```

   With those two variables and an otherwise empty `WebApplication`, `curl --http2-prior-knowledge http://localhost:8080/` returned `protocol=HTTP/2`, and plain `curl` got the 400 above. If you prefer explicit endpoints in `appsettings.json`:

   ```json
   {
     "Kestrel": {
       "Endpoints": {
         "H2c": { "Url": "http://*:8080", "Protocols": "Http2" }
       }
     }
   }
   ```

2. **Keep a separate HTTP/1.1 port if anything else talks to the app.** Docker `HEALTHCHECK` commands, Kubernetes HTTP probes, and most ad-hoc `curl` or `wget` calls speak HTTP/1.1 and will get a 400 from the h2c port. Add a second listener (for example `http://*:8081` with `Http1`) and point probes there. Both listeners serve the same pipeline, so `/healthz` works on both.

3. **Make nginx speak HTTP/2 upstream.** On nginx 1.29.4 mainline or later, including the 1.30 stable branch released on 14 April 2026, the proxy module supports `proxy_http_version 2`. With an `http://` upstream, the HTTP/2 proxy module writes the connection preface straight onto the socket and sets `:scheme: http`, which is exactly the prior-knowledge h2c that Kestrel's `Http2` endpoint expects (see `ngx_http_proxy_v2_module.c`, where the preface is copied into the first buffer before the `HEADERS` frame):

   ```nginx
   # nginx 1.30.x stable or 1.31.x mainline (proxy_http_version 2 needs 1.29.4+)
   upstream app_h2c {
       server app:8080;          # Kestrel endpoint with Protocols = Http2
       keepalive 16;
   }

   server {
       listen 443 ssl;
       http2 on;                 # browser <-> nginx over TLS + ALPN
       server_name example.com;

       ssl_certificate     /etc/nginx/certs/example.com.crt;
       ssl_certificate_key /etc/nginx/certs/example.com.key;

       location / {
           proxy_http_version 2; # nginx <-> Kestrel as h2c, prior knowledge
           proxy_pass http://app_h2c;
           proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

   `proxy_http_version 2` requires nginx to be built with `ngx_http_v2_module`, which the official `nginx` Docker images include. Do not copy the `proxy_set_header Connection ""` line from HTTP/1.1 keepalive guides into this location: HTTP/2 forbids connection-specific headers, and since 1.29.7 nginx no longer sends `Connection` upstream by default anyway.

4. **On older nginx, use `grpc_pass` for gRPC traffic only.** Before 1.29.4, `proxy_http_version` accepted only `1.0` and `1.1`. The [gRPC module](https://nginx.org/en/docs/http/ngx_http_grpc_module.html) has spoken HTTP/2 upstream since 1.13.10, and `grpc_pass grpc://app:8080;` sends prior-knowledge h2c to the same `Http2` endpoint. It is designed for gRPC (trailers, `application/grpc`), so route only your gRPC service paths through it and leave regular HTTP on `proxy_pass` with HTTP/1.1. If you are on such an old nginx, upgrading is the cleaner fix.

5. **Verify from inside the Docker network.** Do not trust a 200 from the browser: it proves the browser-to-nginx hop only. Log `ctx.Request.Protocol` in the app, or run `curl --http2-prior-knowledge http://app:8080/` from a container on the same network to prove the Kestrel side, then check that requests arriving through nginx report `HTTP/2`.

## Calling the h2c endpoint from HttpClient

If the client is another .NET service rather than nginx, `HttpClient` has to be told to use prior knowledge too. The setting that does it is `HttpVersionPolicy.RequestVersionExact` with `Version20`. Against the environment-configured app on port 8080:

```csharp
// .NET 10 (SDK 10.0.302, runtime 10.0.10), C# 14
#:property PublishAot=false
using System.Net;

using var http = new HttpClient();
foreach (var (name, version, policy) in new[]
{
    ("default (1.1)",               HttpVersion.Version11, HttpVersionPolicy.RequestVersionOrLower),
    ("2.0 + RequestVersionOrLower", HttpVersion.Version20, HttpVersionPolicy.RequestVersionOrLower),
    ("2.0 + RequestVersionExact",   HttpVersion.Version20, HttpVersionPolicy.RequestVersionExact),
})
{
    var req = new HttpRequestMessage(HttpMethod.Get, "http://localhost:8080/")
    {
        Version = version,
        VersionPolicy = policy,
    };
    using var res = await http.SendAsync(req);
    Console.WriteLine($"{name,-28} -> {(int)res.StatusCode} HTTP/{res.Version} {(await res.Content.ReadAsStringAsync()).Trim()}");
}
```

```text
default (1.1)                -> 400 HTTP/1.1 An HTTP/1.x request was sent to an HTTP/2 only endpoint.
2.0 + RequestVersionOrLower  -> 400 HTTP/1.1 An HTTP/1.x request was sent to an HTTP/2 only endpoint.
2.0 + RequestVersionExact    -> 200 HTTP/2.0 protocol=HTTP/2
```

The middle line is the trap. Asking for 2.0 with the default `RequestVersionOrLower` policy over `http://` quietly uses HTTP/1.1, because the "or lower" negotiation needs ALPN. Only `RequestVersionExact` (or `RequestVersionOrHigher`) makes `SocketsHttpHandler` open the connection with the preface. Against an `Http1AndHttp2` cleartext endpoint, `RequestVersionExact` fails with `HttpRequestException: The HTTP/2 server closed the connection. HTTP/2 error code 'HTTP_1_1_REQUIRED' (0xd).`, the `GOAWAY` from the curl test seen from the .NET side. Set the version once with `http.DefaultRequestVersion` and `http.DefaultVersionPolicy` if every call goes to the h2c endpoint. Grpc.Net.Client already does this: `GrpcChannel` defaults to HTTP/2 with `HttpVersionPolicy.RequestVersionExact` unless `GrpcChannelOptions` overrides it.

## Gotchas once h2c is on

**WebSockets and SignalR.** Kestrel can run WebSockets over HTTP/2 (extended `CONNECT`, since .NET 7), but a browser's WebSocket to nginx arrives as an HTTP/1.1 `Upgrade: websocket` request, and the nginx HTTP/2 proxy module source has no `Upgrade` handling to translate it. An `Http2`-only Kestrel port also rejects that HTTP/1.1 request outright. Keep SignalR and other WebSocket paths in their own `location` with `proxy_http_version 1.1`, the usual `Upgrade`/`Connection` headers, and a backend port that speaks HTTP/1.1.

**Forwarded headers still need trust configuration.** Moving to HTTP/2 does not change how `ForwardedHeadersMiddleware` decides whether to apply `X-Forwarded-For`. If nginx reaches the container through a Docker network, the rules in [making UseForwardedHeaders work behind nginx in Docker](/2026/11/how-to-make-useforwardedheaders-work-behind-nginx-in-docker-on-dotnet-10/) apply unchanged.

**Resets now come from a different layer.** Once the upstream hop is HTTP/2, an nginx bug or a header Kestrel rejects can surface on the client as a stream reset rather than a 502. The [walkthrough for the HTTP/2 PROTOCOL_ERROR reset](/2026/10/fix-the-http2-server-reset-the-stream-protocol-error-httpclient/) shows how to find which hop sent it. Read the nginx changelog for your version too: the 1.29.5 through 1.31.x releases contain several fixes for the HTTP/2 proxy module, including CVE-2026-42926 (request injection with `proxy_set_body` to an HTTP/2 backend, fixed in 1.31.0).

**macOS and HTTP/2.** The Kestrel HTTP/2 docs list TLS and ALPN requirements per OS. None of that applies to h2c: the repro above ran HTTP/2 on macOS arm64 without TLS, because no negotiation happens.

**Default port 8080 in containers.** If you add `ConfigureKestrel` listeners in code, Kestrel ignores `ASPNETCORE_HTTP_PORTS`. Running the repro app with `ASPNETCORE_HTTP_PORTS=8080` logged `Overriding address(es) 'http://*:8080'. Binding to endpoints defined via IConfiguration and/or UseKestrel() instead.` and listened only on 5001-5003. Pick one mechanism (code or configuration) so you do not end up with the h2c listener on a port Docker does not publish.

**Do you even need it?** For a REST or Razor app, HTTP/2 between nginx and a backend on the same host rarely changes latency in a measurable way. The browser still gets HTTP/2 (or HTTP/3) from nginx. Reach for h2c upstream when a feature needs it: gRPC, as in [the gRPC-in-containers traps](/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/), or streaming calls compared in [gRPC vs REST vs SignalR for service-to-service calls](/2026/08/grpc-vs-rest-vs-signalr-for-service-to-service-calls-in-dotnet-11/). If you want the next protocol on the public edge instead, see [serving HTTP/3 from Kestrel](/2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11/).

## Sources

- [Stack Overflow: How to enable HTTP/2.0 for unencrypted http requests in Kestrel](https://stackoverflow.com/questions/80013217)
- [Configure endpoints for the ASP.NET Core Kestrel web server: HTTP protocols](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/endpoints?view=aspnetcore-10.0)
- [Use HTTP/2 with the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/http2?view=aspnetcore-10.0)
- [HttpVersionPolicy enum](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpversionpolicy)
- [RFC 9113, HTTP/2: starting HTTP/2 with prior knowledge](https://www.rfc-editor.org/rfc/rfc9113#section-3.3)
- [nginx `proxy_http_version` reference](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_http_version)
- [nginx mainline CHANGES](https://nginx.org/en/CHANGES) and [nginx 1.30 stable CHANGES](https://nginx.org/en/CHANGES-1.30)
- [nginx commit "Proxy: added HTTP/2 proxy module"](https://github.com/nginx/nginx/commit/9bf758ea4d5db1101296cc111f6d782045148727) and [`ngx_http_proxy_v2_module.c` at release-1.31.8](https://github.com/nginx/nginx/blob/release-1.31.8/src/http/modules/ngx_http_proxy_v2_module.c)
- [nginx trac #808: h2c via prior knowledge only on `listen ... http2`](https://trac.nginx.org/nginx/ticket/808)
