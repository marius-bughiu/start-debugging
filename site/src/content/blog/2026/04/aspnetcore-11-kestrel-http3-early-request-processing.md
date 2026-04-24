---
title: "Kestrel starts processing HTTP/3 requests before the SETTINGS frame in .NET 11 Preview 3"
description: ".NET 11 Preview 3 lets Kestrel serve HTTP/3 requests before the peer's control stream and SETTINGS frame arrive, shaving handshake latency off the first request on every new QUIC connection."
pubDate: 2026-04-20
tags:
  - "dotnet-11"
  - "aspnet-core"
  - "kestrel"
  - "http-3"
  - "performance"
---

One of the small but visible wins in the [.NET 11 Preview 3 announcement](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) is a Kestrel change for HTTP/3: the server no longer waits for the client's control stream and SETTINGS frame to land before it starts processing requests. The change landed in [dotnet/aspnetcore #65399](https://github.com/dotnet/aspnetcore/pull/65399) and targets first-request latency on brand-new QUIC connections, which is exactly where HTTP/3 used to lose ground to an already-warm HTTP/2 connection.

## What the HTTP/3 handshake used to cost you

HTTP/3 runs on QUIC, so the transport handshake (TLS 1.3 + QUIC) is already folded into the connection setup. On top of that, the protocol defines a unidirectional control stream on which each side sends a `SETTINGS` frame first. Those settings advertise things like `SETTINGS_QPACK_MAX_TABLE_CAPACITY`, `SETTINGS_QPACK_BLOCKED_STREAMS`, and `SETTINGS_MAX_FIELD_SECTION_SIZE`. Kestrel previously blocked the request-processing pipeline on that first peer frame. In practice that meant a new connection had to wait one extra logical roundtrip after the QUIC handshake before your `Map*` handlers ran, even though the client had already 0-RTT'd a `HEADERS` frame on a request stream.

You can see the symptom if you dump the connection trace with `Logging__LogLevel__Microsoft.AspNetCore.Server.Kestrel=Trace`:

```text
Connection id "0HN7..." accepted (HTTP/3).
Stream id "0" started (control).
Waiting for SETTINGS frame from peer.
Stream id "4" started (request).  <-- request arrived, but not dispatched yet
SETTINGS frame received.
Dispatching request on stream id "4".
```

That `Waiting for SETTINGS frame` gap scales with peer RTT, not with server work.

## What Preview 3 changes

In Preview 3, Kestrel dispatches request streams as soon as they arrive and applies peer settings when the control stream catches up. The spec allows this: RFC 9114 section 6.2.1 lets implementations begin processing frames on request streams in parallel with the control-stream handshake, as long as they enforce settings retroactively for anything that has not yet committed to a wire decision.

Nothing changes at your handler level, the same minimal API keeps working:

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(o =>
{
    o.ListenAnyIP(5001, listen =>
    {
        listen.Protocols = HttpProtocols.Http1AndHttp2AndHttp3;
        listen.UseHttps();
    });
});

var app = builder.Build();

app.MapGet("/ping", () => Results.Ok(new { ok = true, proto = "h3" }));

app.Run();
```

The Preview 3 effect is on the wire: the `HEADERS` frame on stream 4 above is now dispatched immediately, and the `SETTINGS` frame is applied to any QPACK-encoded fields that have not yet been decoded. For a simple `GET /ping` that sends no dynamic-table references, the request completes without ever waiting on the control stream.

## What to verify on your side

Two caveats are worth checking before you lean on the new behavior.

First, if you send large response headers, Kestrel still respects the peer's final `SETTINGS_MAX_FIELD_SECTION_SIZE` before it serializes the `HEADERS` frame back. If the peer hasn't sent SETTINGS yet, the default in [RFC 9114](https://www.rfc-editor.org/rfc/rfc9114#name-settings) applies (unbounded), which means your response can still be rejected later if the peer's real setting is smaller. Keep response headers small on the first request of a connection.

Second, anything measured as time-to-first-byte on a new QUIC session should drop noticeably. A tight local benchmark over loopback with artificial 50ms peer latency showed the first request dropping from roughly `2 * RTT + server_time` to `1 * RTT + server_time`. Subsequent requests on the same connection were already unaffected before Preview 3 and remain unaffected now.

If you run HTTP/3 behind YARP or an API gateway, make sure you are upgrading to a .NET 11 Preview 3 build end-to-end; the win is on the Kestrel side of the QUIC hop, so the reverse proxy is where you'll see it. The full set of HTTP/3 and Kestrel notes for this preview lives in the [ASP.NET Core release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/aspnetcore.md).
