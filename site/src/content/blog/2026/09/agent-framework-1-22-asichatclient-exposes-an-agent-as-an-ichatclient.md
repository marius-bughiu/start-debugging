---
title: "Agent Framework 1.22: AsIChatClient Lets an AIAgent Pose as an IChatClient"
description: "Microsoft Agent Framework .NET 1.22.0 adds AIAgent.AsIChatClient(), closing the round trip with IChatClient.AsAIAgent(). Your agent, with its instructions and tools intact, now plugs into any API that takes an IChatClient."
pubDate: 2026-09-20
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
---

Microsoft Agent Framework [dotnet-1.22.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.22.0) shipped on September 18, 2026, and the entry worth your attention is [PR #7687](https://github.com/microsoft/agent-framework/pull/7687): `AsIChatClient`. `Microsoft.Extensions.AI` has had `ChatClientExtensions.AsAIAgent()` for a while, turning a chat client into an agent. The reverse did not exist. Now it does, and the round trip is closed.

## Why the missing direction hurt

The list of .NET APIs that accept an `IChatClient` keeps growing: the evaluators in `Microsoft.Extensions.AI.Evaluation`, caching and telemetry middleware, anything built on the `ChatClientBuilder` pipeline. An `AIAgent` is the richer object. It carries instructions, a tool set, a session, and whatever middleware you wrapped around it. Handing one of those APIs a bare `IChatClient` meant rebuilding all of that by hand, or giving the evaluation judge a model with none of the system prompt that makes it a judge.

`AsIChatClient` lives in `Microsoft.Agents.AI` and has this shape:

```csharp
public static IChatClient AsIChatClient(
    this AIAgent agent,
    AgentSession? session = null,
    string? conversationId = null,
    bool allowNonChatClientAgents = false)
```

So a judge agent becomes a judge chat client in one call:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIAgent judge = chatClient.CreateAIAgent(
    instructions: "You score answers for factual accuracy. Reply with JSON only.",
    name: "Judge");

IChatClient judgeClient = judge.AsIChatClient();
```

The adapter is an internal `AIAgentChatClient` that maps `GetResponseAsync` and `GetStreamingResponseAsync` onto `RunAsync` and `RunStreamingAsync`, and carries your `ChatOptions` through as `ChatClientAgentRunOptions`. Cancellation flows through, and an unkeyed `GetService<IChatClient>()` returns the adapter while every other service request forwards to the agent.

## The guard, and when to switch it off

By default the call throws `InvalidOperationException` unless the agent is a `ChatClientAgent` or returns one from an unkeyed `GetService<ChatClientAgent>()`. Decorators built on `DelegatingAIAgent` forward that request, so a wrapped agent still passes.

Set `allowNonChatClientAgents: true` and any agent type is wrapped, but read the fine print: only `ChatOptions.ResponseFormat` survives the trip. Temperature, tools, and the rest are silently ignored, because a workflow agent or a remote A2A agent has no chat options to apply them to.

Sessions are the other sharp edge. In the default stateless mode a non-blank `ChatOptions.ConversationId` throws, and raw response ids are cleared on the copies you get back. Pass a `session` and the client reports one stable conversation id for every response: the one you supplied, or a generated per-instance id. It never leaks the service-side id, which keeps provider conversation state inside the session where it belongs. Any other non-blank id throws as unknown.

The API is marked `[Experimental]`, so expect a build error until you suppress the diagnostic it points at.

One more line in the same release is worth a grep through your code: [PR #8531](https://github.com/microsoft/agent-framework/pull/8531) now passes `ChatClientAgent` tools per run instead of setting them on the underlying function-invoking chat client, which stops tools from duplicating or leaking across agents that share a client. That is flagged BREAKING, as is the promotion of `AgentSessionStore` into `Microsoft.Agents.AI.Abstractions`.

Upgrade to `Microsoft.Agents.AI` 1.22.0, and if you skipped last week's release, check [what 1.21 changed about LocalCodeAct and your host environment](/2026/09/agent-framework-1-21-localcodeact-stops-inheriting-host-environment/) before you go.
