---
title: "SwitchMediator v3: A Zero-Alloc Mediator That Stays Friendly to AOT"
description: "If you have ever profiled a “clean” CQRS codebase and found death by a thousand allocations in the mediator layer, today’s SwitchMediator v3 release is worth a look. The author is explicitly calling out zero-allocation and AOT-friendly behavior, which is exactly the combination you want in .NET 9 and .NET 10 services that care about…"
pubDate: 2026-01-08
tags:
  - "net"
  - "net-10"
---
If you have ever profiled a “clean” CQRS codebase and found death by a thousand allocations in the mediator layer, today’s **SwitchMediator v3** release is worth a look. The author is explicitly calling out **zero-allocation** and **AOT-friendly** behavior, which is exactly the combination you want in .NET 9 and .NET 10 services that care about latency.

## Where typical mediator implementations leak allocations

There are a few common patterns that quietly allocate:

-   **Boxing and interface dispatch**: especially when handlers are stored as `object` and cast per request.
-   **Pipeline behavior lists**: allocating enumerators, closures, and intermediate lists.
-   **Reflection-based handler discovery**: convenient, but a bad fit for trimming and native AOT.

An AOT-friendly mediator usually does the opposite: it makes handler registration explicit and keeps dispatch logic based on known generic types, not runtime reflection.

## A small “before vs after” benchmark harness

Even if you do not adopt SwitchMediator, you should benchmark your mediator boundary. This is a minimal harness you can drop into a console app targeting **.NET 10** to understand your baseline.

```cs
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

public static class Program
{
    public static void Main() => BenchmarkRunner.Run<MediatorBench>();
}

public sealed record Ping(int Value);
public sealed record Pong(int Value);

public interface IMediator
{
    ValueTask<Pong> Send(Ping request, CancellationToken ct = default);
}

public sealed class MediatorBench
{
    private readonly IMediator _mediator = /* wire your mediator here */;

    [Benchmark]
    public async ValueTask<Pong> SendPing() => await _mediator.Send(new Ping(123));
}
```

What I look for:

-   **Allocated bytes per operation** should be close to zero for trivial requests.
-   **Throughput** should scale with the handler work, not the dispatch overhead.

If you see allocations in the dispatch path, you can usually find them by switching the return type to `ValueTask` (as above) and by keeping request/response types as records or structs that are predictable to the JIT.

## AOT-friendly usually means “explicit”

If you are experimenting with native AOT in **.NET 10**, reflection-heavy mediators are one of the first things that break.

The architecture tradeoff is simple:

-   **Reflection scanning**: great developer experience, weak trimming/AOT story.
-   **Explicit registration**: a little more setup, but predictable and friendly to trimming.

SwitchMediator’s pitch suggests it is leaning toward the explicit end of the spectrum. That aligns with how I approach performance work: I will take a few more lines of wiring if it buys predictable behavior in production.

If you want the details, start from the announcement thread and follow the repository link from there: [https://www.reddit.com/r/dotnet/comments/1q6yl0n/switchmediator\_v3\_is\_out\_now\_a\_zeroalloc/](https://www.reddit.com/r/dotnet/comments/1q6yl0n/switchmediator_v3_is_out_now_a_zeroalloc/)
