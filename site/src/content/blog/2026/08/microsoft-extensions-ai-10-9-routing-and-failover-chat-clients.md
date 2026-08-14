---
title: "Microsoft.Extensions.AI 10.9 Ships Routing and Failover Chat Clients"
description: "Microsoft.Extensions.AI 10.9.0 adds RoutingChatClient, OrderedFailoverChatClient, and SemanticRoutingChatClient. Verified against the real package: what fails over, what does not, and why MEAI001 breaks your build."
pubDate: 2026-08-14
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "resilience"
  - "csharp"
---

On August 13, 2026 the .NET team published [Routing and Failover for Microsoft.Extensions.AI](https://devblogs.microsoft.com/dotnet/routing-and-failover-for-microsoft-extensions-ai/). The interesting part is that the types are already on NuGet in `Microsoft.Extensions.AI` 10.9.0, so you can pull them today. Until now, sending a request to a cheap model and falling back to a bigger one meant hand-rolling a `try`/`catch` wrapper around `IChatClient`. There are now four types that do it: `RoutingChatClient` and `RoutingContext` in `Microsoft.Extensions.AI.Abstractions`, plus `FailoverChatClient`, `OrderedFailoverChatClient`, and `SemanticRoutingChatClient` in `Microsoft.Extensions.AI`.

## A ranked list of clients is now two lines

`OrderedFailoverChatClient` walks a list until one succeeds. Its constructor is `(IReadOnlyList<IChatClient> clients, bool leaveOpen = false)`, so pass `leaveOpen: true` when the container owns the inner clients:

```csharp
using var failover = new OrderedFailoverChatClient(
    [primaryClient, backupClient, lastResortClient],
    leaveOpen: true);

ChatResponse response = await failover.GetResponseAsync(
    [new ChatMessage(ChatRole.User, "hi")]);
```

If every client throws, you get the last exception, not an aggregate. Worth knowing before you write a `catch` block that expects `AggregateException`.

## The streaming rule that will bite you

Failover is not free for streaming calls. The retry loop only re-selects a client while nothing has been handed to the caller yet. I ran three cases against a fake client to confirm it:

- Non-streaming primary throws: `SelectClientAsync` runs again, the backup answers, the caller never sees the failure.
- Streaming primary throws before the first `ChatResponseUpdate`: same, a clean switch to the backup.
- Streaming primary throws after two updates have already been yielded: the exception surfaces mid-enumeration and the two partial chunks stay consumed.

That third case is the one to design around. Once `FailoverChatClientAttempt.OutputCommitted` is `true`, there is no mid-stream recovery, so a UI that appends tokens as they arrive needs its own truncation handling.

## Routing by cost, or by meaning

For anything other than an ordered list, `RoutingChatClient.Create` takes a callback:

```csharp
using var router = RoutingChatClient.Create((context, ct) =>
    new ValueTask<IChatClient>(
        context.Messages.Last().Text.Length > 20 ? powerfulClient : cheapClient));
```

`RoutingContext` exposes just `Messages` and `ChatOptions`, which is enough to route on `AdditionalProperties` for sticky sessions. Subclass `FailoverChatClient` instead if you also want the retry loop, and set `MaximumAttemptsPerRequest` (an `int?`) to cap it.

`SemanticRoutingChatClient` picks by embedding similarity. The full signature has more knobs than the blog post shows:

```csharp
SemanticRoutingChatClient(
    IEmbeddingGenerator<string, Embedding<float>> embeddingGenerator,
    IReadOnlyDictionary<IChatClient, IReadOnlyList<string>> clientProfiles,
    IChatClient defaultClient,
    float scoreThreshold = 0.3f,
    int topK = 1,
    ScoreAggregation scoreAggregation = ScoreAggregation.Mean,
    bool leaveOpen = false)
```

`ScoreAggregation` is `Mean` or `Sum`, and anything under `scoreThreshold` lands on `defaultClient`.

## MEAI001 is an error, not a warning

All of these carry `[Experimental("MEAI001")]`, and the compiler treats it as an error by default:

```
error MEAI001: 'Microsoft.Extensions.AI.OrderedFailoverChatClient' is for evaluation
purposes only and is subject to change or removal in future updates.
```

Add `<NoWarn>MEAI001</NoWarn>` to your csproj to opt in. Given that the shape is still moving, keep the routing decision behind your own interface. If you are still on the raw provider SDK, the [migration to Microsoft.Extensions.AI](https://startdebugging.net/2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai/) is the prerequisite for any of this.
