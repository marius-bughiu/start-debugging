---
title: "StackExchange.Redis 3.3 Moves Off a Redis Node Before the Server Drops You"
description: "StackExchange.Redis 3.3.0 adds opt-in maintenance notifications (smart client handoffs) for Redis Enterprise, Redis Cloud and Azure Managed Redis: relaxed timeouts during migrations, topology re-reads, and a proactive move before an endpoint goes away. Here is how to turn it on and the SER010 error you will hit first."
pubDate: 2026-09-23
tags:
  - "redis"
  - "stackexchange-redis"
  - "dotnet"
  - "resilience"
---

[StackExchange.Redis 3.3.0](https://github.com/StackExchange/StackExchange.Redis/releases/tag/3.3.0) shipped on September 18, 2026, followed by [3.3.1](https://github.com/StackExchange/StackExchange.Redis/releases/tag/3.3.1) on September 22. The headline feature is server-native maintenance notifications, which other Redis clients call "smart client handoffs" or "hitless upgrades". Redis Enterprise and Redis Cloud can now warn the .NET client that a shard is migrating, a node is failing over, or the endpoint it is connected to is about to be replaced, and the client acts on it instead of waiting for a socket to die.

If you have ever seen a burst of `RedisTimeoutException` during a managed Redis maintenance window, this is the fix for that class of problem.

## What the client does with each notification

The notifications arrive as RESP3 push frames on the same connection that carries your commands. Per the [design notes in PR #3191](https://github.com/StackExchange/StackExchange.Redis/pull/3191), the client reacts without any code from you:

- `MIGRATING`, `FAILING_OVER`, `SMIGRATING`: command timeouts on that server are relaxed (10 seconds by default, `maintRelaxedTimeout`).
- `MIGRATED`, `FAILED_OVER`: the window closes, with a short relaxed tail while things settle.
- `SMIGRATED`: the cluster topology is re-read and sharded subscriptions whose slots moved are re-subscribed.
- `MOVING`: the client asks for the replacement address, drains in-flight work, and swaps the connection before the server closes it.

That last one matters most. The author measured DNS trailing a `MOVING` notification by 4 to 19 seconds, while the server closes the old socket at roughly 16 to 19 seconds. By asking the server to name the replacement endpoint (`maintMovingEndpointType=Auto`, the default), the handoff becomes a direct move that completes within a second.

## Turning it on in 3.3

It is opt-in for now, even when you connect to a recognized Redis Cloud or Azure Managed Redis hostname. The [documentation](https://seredis.dev/ServerMaintenanceEvent) says auto-enlistment for those providers is planned for a follow-up release. The connection string route is the simplest:

```csharp
var muxer = await ConnectionMultiplexer.ConnectAsync(
    "my-redis.example.com:6379,maintNotifications=Auto,maintRelaxedTimeout=15");
```

The strongly typed API is marked experimental, and in 3.3.1 that is a compile error, not a warning:

```text
error SER010: 'StackExchange.Redis.ConfigurationOptions.MaintenanceNotifications' is for
evaluation purposes only and is subject to change or removal in future updates.
```

Suppress it explicitly if you want the property and the event types:

```csharp
#pragma warning disable SER010
using StackExchange.Redis;
using StackExchange.Redis.Maintenance;

var options = ConfigurationOptions.Parse("my-redis.example.com:6379");
options.MaintenanceNotifications = MaintenanceNotificationMode.Auto;

var muxer = await ConnectionMultiplexer.ConnectAsync(options);
muxer.ServerMaintenanceEvent += (_, e) =>
{
    if (e is PushMaintenanceEvent m)
        Console.WriteLine($"{m.NotificationType} seq {m.SequenceId} from {m.EndPoint}");
};
```

`MaintenanceNotificationMode` has three values. `Disabled` is the current default. `Auto` asks during the handshake and carries on if the server refuses. `Enabled` rejects the connection if notifications cannot be delivered, including when the connection lands on RESP2, which makes it a useful way to prove the feature is live in staging.

## Two things to check before you ship it

RESP3 is required. `protocol=resp2`, a `defaultVersion` below 6.0, or disabling `HELLO` in the command map all silently turn the feature off under `Auto`.

A deliberate handoff also shows up as a `ConnectionFailed` event with `FailureType == ConnectionFailureType.MaintenanceHandoff`. If you alert on `ConnectionFailed`, filter that value out or your pager goes off during every planned maintenance.

One change is not opt-in: 3.3.0 adds `topologyRefreshSeconds`, which re-reads the topology every 30 minutes by default (jittered, `0` disables it). It exists for endpoints that still answer a handshake but no longer belong to the deployment.

If Redis already sits behind your `HybridCache`, see [how to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/). Adding `maintNotifications=Auto` to that connection string is the cheapest resilience upgrade you will make this month.
