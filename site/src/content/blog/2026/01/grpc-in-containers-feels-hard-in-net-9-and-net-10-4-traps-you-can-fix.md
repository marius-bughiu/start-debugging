---
title: "gRPC in Containers Feels “Hard” in .NET 9 and .NET 10: 4 Traps You Can Fix"
description: "This popped up again today in r/dotnet: “Why is hosting gRPC services in containers so hard?” The short answer is that gRPC is opinionated about HTTP/2, and containers make the network edge more explicit. You are forced to decide where TLS terminates, which ports speak HTTP/2, and what proxy sits in front. Source discussion: https://www.reddit.com/r/dotnet/comments/1q93h2h/why_is_hosting_grpc_services_in_containers_so_hard/…"
pubDate: 2026-01-10
tags:
  - "grpc"
  - "net"
  - "net-10"
  - "net-9"
---
This popped up again today in r/dotnet: “Why is hosting gRPC services in containers so hard?” The short answer is that gRPC is opinionated about HTTP/2, and containers make the network edge more explicit. You are forced to decide where TLS terminates, which ports speak HTTP/2, and what proxy sits in front.

Source discussion: [https://www.reddit.com/r/dotnet/comments/1q93h2h/why\_is\_hosting\_grpc\_services\_in\_containers\_so\_hard/](https://www.reddit.com/r/dotnet/comments/1q93h2h/why_is_hosting_grpc_services_in_containers_so_hard/)

## Trap 1: Your container port is reachable, but not speaking HTTP/2

gRPC requires HTTP/2 end-to-end. If a proxy downgrades to HTTP/1.1, you get mysterious “unavailable” failures that look like app bugs.

In .NET 9 / .NET 10, make the server intent explicit:

```cs
using Microsoft.AspNetCore.Server.Kestrel.Core;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(options =>
{
    // Inside a container you usually run plaintext HTTP/2 and terminate TLS at the proxy.
    options.ListenAnyIP(8080, listen =>
    {
        listen.Protocols = HttpProtocols.Http2;
    });
});

builder.Services.AddGrpc();

var app = builder.Build();
app.MapGrpcService<GreeterService>();
app.MapGet("/", () => "gRPC service. Use a gRPC client.");
app.Run();
```

## Trap 2: TLS termination is unclear (and gRPC clients care)

Many teams assume “container = TLS”. In practice, TLS termination at the edge is simpler:

-   **Kestrel**: run HTTP/2 without TLS on `8080` inside the cluster.
-   **Ingress / reverse proxy**: terminate TLS, forward to the service over HTTP/2.

If you do terminate TLS in Kestrel, you also need certificates inside the container and you need to expose the right port. That is workable, it is just more moving parts.

## Trap 3: Health checks probe the wrong thing

Kubernetes HTTP probes and basic load balancer probes are often HTTP/1.1. If you probe your gRPC endpoint directly, it can fail even when the service is healthy.

Two practical fixes:

-   **Expose a plain HTTP endpoint** for probes (like the `MapGet("/")` above) on a separate port, or on the same port if your proxy supports it.
-   **Use gRPC health checking** (`grpc.health.v1.Health`) if your environment supports gRPC-aware probes.

## Trap 4: Proxies and HTTP/2 defaults bite you

The easiest way to make gRPC “feel hard” is to add a proxy that is not configured for HTTP/2 upstream. Make sure your proxy is explicitly configured to:

-   accept HTTP/2 from clients
-   forward HTTP/2 to the upstream service (not just HTTP/1.1)

That last bullet is where many default Nginx configs fail for gRPC.

## A container setup that stays boring

-   **Container**: listen on `8080` with `HttpProtocols.Http2`.
-   **Proxy/ingress**: terminate TLS on `443`, speak HTTP/2 to the client and to the upstream.
-   **Observability**: turn on structured logs for request failures, and include gRPC status codes.

If you want a single reference point before touching Kubernetes, start by validating locally: run the container, hit it with `grpcurl`, then put a proxy in front and verify it still negotiates HTTP/2 end-to-end.

Further reading: [https://learn.microsoft.com/aspnet/core/grpc/](https://learn.microsoft.com/aspnet/core/grpc/)
