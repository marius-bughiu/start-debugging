---
title: "gRPC vs REST vs SignalR for service-to-service calls in .NET 11"
description: "For internal service-to-service calls in .NET 11, default to gRPC when you own both ends of the contract and the call is point-to-point. Use REST with JSON when anything you do not control has to call the service. SignalR is not an RPC transport between services: reach for it only when one producer has to fan a message out to many long-lived consumers."
pubDate: 2026-08-06
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "grpc"
  - "signalr"
  - "csharp"
---

If service A calls service B and nothing else calls B, use gRPC. You own both ends, so a generated client and a binary contract cost you nothing and buy you a payload roughly half the size of the JSON equivalent plus real deadline propagation. Use REST with JSON the moment something you do not control has to call the service: a browser, a partner, a curl command in a runbook. SignalR is the odd one out, and the single most common mistake in this comparison is treating it as a third RPC option. It is not. SignalR is a connection-management and fan-out layer, and it earns its place only when one producer has to push to many long-lived consumers. Everything below targets .NET 11 (Preview 6, SDK `11.0.100-preview.6.26359.118`, GA expected November 2026) and C# 14, with `Grpc.AspNetCore` 2.83.0.

## The decision in one table

| Feature | gRPC | REST with JSON | SignalR |
| --- | --- | --- | --- |
| Shape of the call | Point-to-point RPC | Point-to-point request/response | One producer, many consumers |
| Contract | Required, `.proto` | Optional, OpenAPI | None, method names by string |
| Protocol | HTTP/2 (required) | HTTP/1.1, HTTP/2, HTTP/3 | WebSockets, SSE, long polling |
| Payload | Protobuf, binary | JSON, text | JSON or MessagePack |
| Client | Generated from `.proto` | Hand-written or OpenAPI-generated | Hand-written, strings for method names |
| Streaming | Client, server, bidirectional | Server (chunked / SSE) | Server, client, bidirectional |
| Caller cancellation reaches callee | Yes, plus a native deadline | Only as a connection abort | Yes as of .NET 11, non-streaming invocations |
| Callable from a browser | No, needs gRPC-Web or transcoding | Yes | Yes, that is the point |
| Works behind an L4 load balancer | Badly | Yes | Needs sticky sessions or a backplane |
| Human-readable on the wire | No | Yes | Yes with JSON, no with MessagePack |
| Ships with ASP.NET Core | No, out-of-band NuGet | Yes | Yes |

Two rows decide almost every real case. "Shape of the call" separates SignalR from the other two, and "contract" separates gRPC from REST. If you find yourself weighing rows further down the table, you have probably already made the decision and are looking for permission.

## Why SignalR keeps ending up in this comparison, and why it usually loses

SignalR shows up in service-to-service searches because a hub method looks exactly like an RPC:

```csharp
// .NET 11, C# 14 -- looks like RPC, is not built for it
public sealed class PricingHub : Hub
{
    public Task<decimal> GetPrice(string sku) => _pricing.LookupAsync(sku);
}
```

A caller can absolutely `InvokeAsync<decimal>("GetPrice", sku)` from another service and get an answer. It works. What you have built, though, is an RPC channel on top of a technology whose entire design centre is connection lifetime management for clients that come and go. You inherit the costs of that design without needing any of the benefits.

The concrete costs: method names are strings resolved by reflection at dispatch time, so a rename is a runtime failure rather than a build failure. There is no schema, so nothing generates a client and nothing validates a payload shape. Scaling out means every server in the pool needs to reach every connection, which means a Redis backplane or the Azure SignalR Service, plus sticky sessions if you are not on WebSockets. And a hub connection is stateful: your caller now has a reconnect state machine to reason about for what used to be a stateless request.

SignalR is the right answer when the traffic really is fan-out. A pricing service that must push tick updates to forty worker processes is a SignalR problem, because SignalR has groups, broadcast, and a backplane, and gRPC has none of those. Microsoft's own [gRPC and HTTP API comparison](https://learn.microsoft.com/en-us/aspnet/core/grpc/comparison) says this directly: gRPC supports streaming but has no concept of broadcasting to registered connections, so each gRPC call has to stream to its client individually.

The distinction is fan-out, not "real-time". gRPC bidirectional streaming is real-time. It is just point-to-point.

## What each one actually puts on the wire

The performance argument for gRPC is usually stated as "Protobuf is smaller than JSON" with no number attached. Here is the number, for a message shaped like a typical internal reply:

```protobuf
// proto3
message OrderStatus {
  string order_id   = 1;  // "8f14e45f-ceea-467a-9c1d-2b7f2f0c3a11"
  int32  status     = 2;  // 3
  int64  updated_at = 3;  // 1786060800
  double total      = 4;  // 129.95
  string currency   = 5;  // "EUR"
}
```

| Encoding | Message bytes | Framed bytes | Ratio vs JSON |
| --- | --- | --- | --- |
| JSON (`System.Text.Json`, default options) | 116 | 116 | 100% |
| MessagePack (SignalR binary hub protocol) | 66 | n/a | 56.9% |
| Protobuf (`Google.Protobuf` 3.35.1) | 60 | 65 | 51.7% |
| SignalR JSON hub protocol invocation | n/a | 165 | 142% |

**Methodology**: serialized each encoding of the same five fields and counted bytes, measured on Windows 11 with the .NET 10.0.5 runtime (SDK 10.0.201), `Google.Protobuf` 3.35.1 and `MessagePack` 3.1.8. The wire formats are specified independently of the runtime version, so the byte counts are identical on .NET 11; only the runtime doing the encoding differs. "Framed bytes" adds gRPC's five-byte length prefix (one compressed flag byte plus a four-byte big-endian length) and, for SignalR, the JSON invocation envelope plus the `0x1E` record separator.

Read that table carefully before you use it to justify anything. Protobuf saves 56 bytes on a 116-byte message. On a service handling ten thousand calls a second that is 560 KB/s of egress, which matters if you are paying for cross-zone traffic and is noise if you are not. The SignalR row is the interesting one: the JSON hub protocol envelope makes a single invocation *larger* than the plain REST equivalent, because you are paying for `type`, `target`, and `arguments` on top of the payload. Switching a hub to MessagePack claws most of that back, at the cost of the human readability that was the reason to consider a text protocol in the first place.

Serialization size is also the weakest of gRPC's advantages. The stronger ones are the generated client and the deadline.

## When to pick gRPC

- **Internal, point-to-point, and you own both repositories.** The `.proto` file is the contract, both sides generate from it, and a field you rename breaks the build on both sides in the same pull request. This is the whole argument, and it is worth more than the byte count.
- **You need deadlines that reach the callee.** A gRPC deadline travels with the call, so service B knows how long service A is still willing to wait and can abandon its own database query. HTTP has no equivalent: cancelling an `HttpClient` request aborts the connection and the server observes `HttpContext.RequestAborted`, but nothing tells the server the original budget.
- **Polyglot callers.** A Go or Python service consuming your `.proto` gets a real client for free. Handing the same team an OpenAPI document and wishing them luck is a worse experience.
- **Chatty hot paths.** Once a bidirectional stream is open, messages ride an existing HTTP/2 request rather than paying for a new one per call. Microsoft's [gRPC performance guidance](https://learn.microsoft.com/en-us/aspnet/core/grpc/performance) explicitly recommends this as an advanced technique for high-throughput paths, with the caveat that `RequestStream.WriteAsync` is not thread-safe and you need a `Channel<T>` to marshal writes.

```csharp
// .NET 11, C# 14 -- Grpc.AspNetCore 2.83.0
// Server
builder.Services.AddGrpc();
app.MapGrpcService<OrderService>();

// Client: register through the factory so channels are reused.
builder.Services
    .AddGrpcClient<Orders.OrdersClient>(o => o.Address = new Uri("https://orders"))
    .AddStandardResilienceHandler();

// Call site: the deadline is the point.
var reply = await client.GetStatusAsync(
    new OrderRequest { OrderId = id },
    deadline: DateTime.UtcNow.AddSeconds(2),
    cancellationToken: ct);
```

Use `AddGrpcClient` rather than `GrpcChannel.ForAddress` in application code. Creating a channel per call forces a fresh socket, TCP handshake, TLS negotiation, and HTTP/2 connection preface every time, and the factory reuses the channel for you. If you are layering retries on top, the same [resilience handler that wraps HttpClient](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) applies here, because a gRPC channel is a `SocketsHttpHandler` underneath.

## When to pick REST with JSON

- **Anything you cannot regenerate a client for calls it.** Browsers cannot speak gRPC at all, and gRPC-Web or JSON transcoding are both real additions to your deployment topology. If the answer to "who calls this" includes anyone outside your build, ship JSON.
- **The call is rare.** A nightly reconciliation job calling one endpoint does not justify a `.proto` file, a code-generation step in CI, and a second protocol in your service mesh.
- **You want to debug it with the tools you already have.** Protobuf on the wire is opaque without the schema. A 500 at 3am is easier to diagnose when you can replay the request with curl.
- **Your load balancer is L4.** This one is not a preference, and it is covered below.

```csharp
// .NET 11, C# 14 -- minimal API + typed client
app.MapGet("/orders/{id}", async (string id, IOrderStore store, CancellationToken ct)
    => await store.FindAsync(id, ct) is { } o
        ? Results.Ok(o)
        : Results.NotFound());

// Caller
builder.Services
    .AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://orders"))
    .AddStandardResilienceHandler();
```

For anything more structured than this, [returning a typed Results union](/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) gets you compile-time checking of the response shapes and a correct OpenAPI document without hand-written attributes, which recovers a slice of the contract discipline that made gRPC attractive.

## When SignalR is genuinely the right call

- **One producer, many long-lived consumers, and every consumer needs the same message.** Price ticks, job-queue state, configuration invalidation. Groups and broadcast are the features you are buying.
- **The consumer set changes at runtime.** SignalR handles connect, disconnect, and reconnect. Reimplementing that on top of gRPC streams is a project.
- **Some of the consumers are browsers.** If a dashboard and a set of worker services both need the same feed, one hub serves both, and no gRPC configuration serves the browser without a proxy.

.NET 11 makes SignalR meaningfully better for long-lived connections in two ways. The `/refresh` endpoint plus `EnableAuthenticationRefresh` means a hub connection no longer drops when its bearer token expires, which was the single largest source of spurious reconnects in token-authenticated deployments. And [SignalR clients can finally cancel a running hub method](/2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6/), so cancelling the `CancellationToken` you passed to `InvokeAsync` actually reaches the server. Both features are .NET client only in Preview 6; the JavaScript client and Azure SignalR Service support are still in progress.

## The gotchas that pick for you

**L4 load balancers break gRPC.** A gRPC channel is one HTTP/2 connection, and every call multiplexes onto it. An L4 balancer distributes TCP connections, so every call from that channel lands on the same backend forever. Your fleet gets a hot instance and a lot of idle ones. Fixing it means client-side load balancing or an L7 proxy such as Envoy, Linkerd, or YARP, and that decision usually belongs to a platform team rather than to you. If you cannot make that change, the comparison is over and REST wins. The same class of infrastructure friction shows up when [running gRPC in containers](/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/), where a proxy that only speaks HTTP/1.1 produces failures that look nothing like a protocol mismatch.

**gRPC ships out-of-band and the TFM list proves it.** `Grpc.AspNetCore` 2.83.0, published 3 August 2026, targets `net8.0`, `net9.0`, and `net10.0`. There is no `net11.0` target framework, and there is no gRPC section in the [What's new in ASP.NET Core in .NET 11](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11) release notes at all. This is not a support gap: a `net10.0` assembly loads and runs on .NET 11. It is a cadence difference. gRPC on .NET is maintained in `grpc/grpc-dotnet` on its own release schedule, so a .NET 11 feature that would benefit gRPC arrives when grpc-dotnet ships it, not in November. Plan your upgrade notes accordingly.

**HTTP/2 is mandatory for gRPC, optional for everything else.** That is a real constraint on any hop where you do not control the intermediaries. It also means gRPC does not benefit from HTTP/3 today, while a REST endpoint does: [configuring Kestrel to serve HTTP/3](/2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11/) is a one-line endpoint change, and .NET 11's Kestrel now starts processing HTTP/3 requests without waiting for the control stream and SETTINGS frame, cutting first-request latency on new connections.

**SignalR scale-out is a dependency, not a setting.** More than one server instance means a Redis backplane or the Azure SignalR Service, and non-WebSocket transports need sticky sessions on top. Compare that with a stateless REST endpoint behind a round-robin balancer before you decide the fan-out is worth it.

**Observability is not equal.** All three emit `ActivitySource` traces that flow through OpenTelemetry, so [wiring traces to a free backend](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) covers all of them. What differs is what you can see in a network capture: JSON is readable, Protobuf and MessagePack need the schema and tooling.

## The recommendation, restated

Draw the boundary at fan-out first. If one service has to notify many long-lived consumers, that is SignalR, and neither of the other two has a substitute for groups and a backplane. Everything else is point-to-point, and there the question is who owns the contract. If you own both ends and can regenerate clients in the same pull request that changes the schema, gRPC pays for itself through the generated client and propagated deadlines, with the smaller payload as a bonus rather than the reason. If anyone outside your build calls the service, ship REST with JSON and stop optimizing bytes you are not paying for.

The failure mode worth avoiding is picking gRPC for a service with three callers a minute because a benchmark showed 51.7% payload size, then discovering that your L4 load balancer pins every call to one pod. Fifty-six bytes per message is not worth a platform migration.

## Related

- [gRPC in containers feels hard in .NET 9 and .NET 10: 4 traps you can fix](/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/)
- [SignalR clients can finally cancel a running hub method in .NET 11 Preview 6](/2026/07/signalr-client-cancel-hub-method-dotnet-11-preview-6/)
- [How to configure Kestrel to serve HTTP/3 in ASP.NET Core 11](/2026/08/how-to-configure-kestrel-to-serve-http-3-in-aspnetcore-11/)
- [Polly vs resilience handlers in .NET 11: which should you use?](/2026/05/polly-vs-resilience-handlers-in-dotnet-11/)
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [How to use OpenTelemetry with .NET 11 and a free backend](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)

## Sources

- [Compare gRPC services with HTTP APIs](https://learn.microsoft.com/en-us/aspnet/core/grpc/comparison), Microsoft Learn
- [Performance best practices with gRPC](https://learn.microsoft.com/en-us/aspnet/core/grpc/performance), Microsoft Learn
- [Overview of ASP.NET Core SignalR](https://learn.microsoft.com/en-us/aspnet/core/signalr/introduction), Microsoft Learn
- [What's new in ASP.NET Core in .NET 11](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11), Microsoft Learn
- [Grpc.AspNetCore 2.83.0](https://www.nuget.org/packages/Grpc.AspNetCore), NuGet
- [SignalR Hub Protocol specification](https://github.com/dotnet/aspnetcore/blob/main/src/SignalR/docs/specs/HubProtocol.md), dotnet/aspnetcore
- [gRPC over HTTP/2 protocol specification](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md), grpc/grpc
