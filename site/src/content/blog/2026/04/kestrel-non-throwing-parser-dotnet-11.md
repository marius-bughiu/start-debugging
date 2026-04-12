---
title: "Kestrel Drops Exceptions from Its HTTP/1.1 Parser in .NET 11"
description: "Kestrel's HTTP/1.1 request parser in .NET 11 replaces BadHttpRequestException with a result struct, cutting malformed-request overhead by up to 40%."
pubDate: 2026-04-08
tags:
  - "dotnet"
  - "aspnetcore"
  - "dotnet-11"
  - "performance"
---

Every malformed HTTP/1.1 request that hit Kestrel used to throw a `BadHttpRequestException`. That exception allocated a stack trace, unwound the call stack, and got caught somewhere higher up, all for a request that was never going to produce a valid response. In .NET 11, the parser [switches to a non-throwing code path](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11), and the difference is measurable: **20-40% higher throughput** in scenarios with frequent malformed traffic.

## Why exceptions were expensive

Throwing an exception in .NET is not free. The runtime captures a stack trace, walks the call stack looking for a matching `catch`, and allocates the exception object on the heap. For a well-formed request this never fires, so you do not notice. But port scanners, misconfigured clients, and malicious traffic can push thousands of bad requests per second. Each one paid the full exception tax.

```csharp
// Before (.NET 10 and earlier): every parse failure threw
try
{
    ParseRequestLine(buffer);
}
catch (BadHttpRequestException ex)
{
    Log.ConnectionBadRequest(logger, ex);
    return;
}
```

In hot paths, `try/catch` with frequent throws becomes a throughput bottleneck.

## The result-struct approach

The .NET 11 parser returns a lightweight result struct instead:

```csharp
// After (.NET 11): no exception on parse failure
var result = ParseRequestLine(buffer);

if (result.Status == ParseStatus.Error)
{
    Log.ConnectionBadRequest(logger, result.ErrorReason);
    return;
}
```

The struct carries a `Status` field (`Success`, `Incomplete`, or `Error`) and an error reason string when relevant. No heap allocation, no stack unwinding, no `catch` block overhead. Valid requests see zero change because they already took the success path.

## When this matters

If your server sits behind a load balancer that health-checks with raw TCP or if you expose Kestrel directly to the internet, you are getting hit by malformed requests constantly. Honeypot deployments, API gateways handling mixed protocols, and any service exposed to port scans all benefit.

The improvement is entirely internal to Kestrel. There is no API change, no configuration flag, and no opt-in. Upgrade to .NET 11 and the parser is faster by default.

## Other .NET 11 performance wins

This is not the only allocation reduction in .NET 11 Preview. The HTTP logging middleware now pools its `ResponseBufferingStream` instances, cutting per-request allocations when response body logging is enabled. Combined with the parser change, .NET 11 continues the runtime team's pattern of turning exception-heavy hot paths into struct-based result flows.

If you want to see the impact on your own workload, run a before/after benchmark with [Bombardier](https://github.com/codesenberg/bombardier) or `wrk` while injecting a percentage of malformed requests. The parser change is transparent, but the numbers should speak for themselves.
