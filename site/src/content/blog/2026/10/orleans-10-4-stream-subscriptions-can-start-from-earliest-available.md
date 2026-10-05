---
title: "Orleans 10.4: Stream Subscriptions Can Now Start From the Oldest Cached Message"
description: "Orleans 10.4.0 adds StreamSubscriptionStartPosition.EarliestAvailable, so a new stream subscriber can replay what is still in the pulling agent's queue cache. The release also changes RPC argument wire IDs, request-latency metrics, and SQLite persistence scripts."
pubDate: 2026-10-05
tags:
  - "orleans"
  - "dotnet"
  - "streaming"
  - "distributed-systems"
---

Orleans [v10.4.0](https://github.com/dotnet/orleans/releases/tag/v10.4.0) shipped on October 3, 2026. The release notes cover a lot of ground (membership consistency across every clustering provider, cancellation tokens through framework APIs, NativeAOT-friendlier codecs, opt-in serializer Hot Reload), but the change most application code will touch is in streaming: you can finally tell a tokenless subscription where to start.

## What a new subscriber used to miss

Persistent stream subscribers in Orleans have always had two modes. Pass a `StreamSequenceToken` and a rewindable provider replays from that point. Pass nothing and you get live delivery: whatever arrives after the subscription handshake. Everything the pulling agent already had sitting in its queue cache for that stream was invisible to you.

That gap bites in a common shape: a grain activates in response to the first event on a stream, subscribes, and loses that very event plus anything else that landed during activation. The workaround was to track sequence tokens yourself, which only works if you saw a token in the first place.

## Subscribing with EarliestAvailable

[PR #10936](https://github.com/dotnet/orleans/pull/10936) adds the `StreamSubscriptionStartPosition` enum with two values, `Latest` (the default, same as before) and `EarliestAvailable`, plus `SubscribeAsync` overloads for item and batch observers:

```csharp
using Orleans.Streams;

public sealed class OrderProjectionGrain : Grain, IOrderProjectionGrain, IAsyncObserver<OrderEvent>
{
    public override async Task OnActivateAsync(CancellationToken cancellationToken)
    {
        var stream = this.GetStreamProvider("orders")
            .GetStream<OrderEvent>(StreamId.Create("orders", this.GetPrimaryKeyString()));

        await stream.SubscribeAsync(this, StreamSubscriptionStartPosition.EarliestAvailable);
    }

    public Task OnNextAsync(OrderEvent item, StreamSequenceToken? token = null) => Task.CompletedTask;
    public Task OnCompletedAsync() => Task.CompletedTask;
    public Task OnErrorAsync(Exception ex) => Task.CompletedTask;
}
```

`EarliestAvailable` starts inclusively at the oldest message the local queue cache still holds for that `StreamId`. If nothing is retained, it waits for the next message. It does not reach back into Event Hubs, SQS, or Azure Queues: replay is scoped to the cache, and receiver checkpoints are untouched.

Precedence is explicit: a concrete sequence token wins, then the position you pass, then the provider default, then `Latest`. The provider default lives on `StreamPullingAgentOptions`, which matters for legacy code that subscribes without any arguments:

```csharp
siloBuilder.AddMemoryStreams("orders", streams =>
    streams.ConfigurePullingAgent(ob => ob.Configure(options =>
        options.InitialSubscriptionStartPosition =
            StreamSubscriptionStartPosition.EarliestAvailable)));
```

The built-in pooled, simple, and Event Hubs caches support it. A custom `IQueueCache` without support fails the subscription deterministically rather than silently falling back to live delivery. During a rolling upgrade, only turn this on after every silo hosting pulling agents runs 10.4.0.

## Three upgrade notes you should not skip

The release flags these as compatibility changes:

- **RPC argument IDs**: parameter-level `[Id]` attributes now control serialized argument IDs, and automatic IDs count only serialized parameters. If a grain interface uses parameter `[Id]`s or puts `CancellationToken` anywhere but last, the wire format differs from 10.3.1. Upgrade clients and silos together or version the contract.
- **Metrics**: request latency is now one `Histogram<double>` named `orleans-app-requests-latency` in fractional milliseconds, replacing the `-bucket`, `-count`, and `-sum` instruments. `orleans-grains` uses a `grain_type` dimension instead of `type`. Dashboards and alerts need updating.
- **SQLite persistence**: rerun the 10.4.0 `Sqlite-Main.sql` and `Sqlite-Persistence.sql` scripts on existing databases. They are idempotent and fix atomicity under writer contention.

The [subscription start positions doc](https://github.com/dotnet/orleans/blob/main/docs/site/src/content/docs/streaming/subscription-start-positions.md) has the full semantics, and the release notes list the journaling and Durable Jobs preview changes that ship as `10.4.0-alpha.1`.
