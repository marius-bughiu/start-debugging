---
title: "AG-UI .NET SDK 1.0: AGUI.Server and AGUI.Client Move the Protocol Out of Agent Framework"
description: "The AG-UI protocol now has a standalone .NET SDK: AGUI.Server 1.0.0 streams any IChatClient as AG-UI events over SSE, and AGUIChatClient consumes an AG-UI endpoint as an IChatClient, down to .NET Framework 4.7.2. Agent Framework users get renamed APIs."
pubDate: 2026-09-27
tags:
  - "ag-ui"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
  - "agent-framework"
---

On September 25, 2026 the .NET team [announced a first-class .NET SDK for the AG-UI protocol](https://devblogs.microsoft.com/dotnet/ag-ui-dotnet-sdk/). The packages hit NuGet as `1.0.0` on September 17: `AGUI.Abstractions`, `AGUI.Formatting`, `AGUI.Protobuf`, `AGUI.Server`, and `AGUI.Client`, MIT licensed, living in [ag-ui-protocol/ag-ui under sdks/dotnet](https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/dotnet). Until now, AG-UI support in .NET meant taking a dependency on Microsoft Agent Framework. That coupling is gone.

## What AG-UI is, in one paragraph

[AG-UI](https://docs.ag-ui.com/) is a wire protocol between an agent backend and a frontend. The client POSTs a `RunAgentInput` (messages, tools, state), and the server answers with a stream of typed events: `RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, tool call events, `STATE_DELTA`, `RUN_FINISHED`. Server-Sent Events is the default transport, with an optional protobuf codec for part of the event set. Frontends like CopilotKit already speak it, so a .NET backend that emits correct AG-UI events plugs straight into them.

## Any IChatClient becomes an AG-UI endpoint

`AGUI.Server` targets `net8.0`, `net9.0`, and `net10.0`, and it only needs a `Microsoft.Extensions.AI` `IChatClient`. No agent abstraction required:

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(CreateChatClient());
builder.Services.Configure<JsonOptions>(options =>
    options.SerializerOptions.TypeInfoResolverChain.Insert(
        0, AGUIJsonUtilities.DefaultTypeInfoResolver));

var app = builder.Build();

app.MapPost("/", (RunAgentInput input, IChatClient chatClient,
    IOptions<JsonOptions> jsonOptions, CancellationToken ct) =>
{
    var context = input.ToChatRequestContext(jsonOptions.Value.SerializerOptions);

    var events = chatClient
        .GetStreamingResponseAsync(context.Messages, context.ChatOptions, ct)
        .AsAGUIEventStreamAsync(context, ct);

    return TypedResults.ServerSentEvents(events);
});

await app.RunAsync();
```

The interesting work happens in `AsAGUIEventStreamAsync`. It wraps the run in `RUN_STARTED` and `RUN_FINISHED`, closes an open text or reasoning block before switching to another message or tool call, and folds multiple interrupts into a single terminal `RUN_FINISHED`. Those are exactly the ordering rules a hand-rolled SSE mapper tends to get wrong, and a frontend that receives a `TEXT_MESSAGE_CONTENT` for a block that was never started usually fails silently.

## The client side reaches .NET Framework 4.7.2

`AGUI.Client` also targets `netstandard2.0` and `net472`. Its `AGUIChatClient` implements `IChatClient`, so a remote AG-UI agent looks like any other model to your code:

```csharp
using AGUI.Client;

using var httpClient = new HttpClient();
IChatClient agent = new AGUIChatClient(
    new AGUIChatClientOptions(httpClient, "http://localhost:5001"));

await foreach (var update in agent.GetStreamingResponseAsync("Summarize ticket 4211"))
    Console.Write(update.Text);
```

That is useful for a legacy WinForms or WPF app on .NET Framework that needs to call an agent hosted elsewhere without migrating first.

## Breaking renames for Agent Framework users

If you already used `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` (currently `1.22.0-preview.260918.1`), the hosting package now builds on the new SDK and the names changed:

| Before | After |
| --- | --- |
| `AddAGUI()` / `MapAGUI()` | `AddAGUIServer()` / `MapAGUIServer()` |
| `Microsoft.Agents.AI.AGUI` namespace | `AGUI.Client`, `AGUI.Server`, `AGUI.Abstractions` |
| positional `AGUIChatClient` constructor | `AGUIChatClientOptions` |

```csharp
builder.Services.AddAGUIServer();
var app = builder.Build();

AIAgent agent = chatClient.AsAIAgent(
    name: "AGUIAssistant",
    instructions: "You are a helpful assistant.");

app.MapAGUIServer("/", agent);
```

Combined with last week's [`AsIChatClient` in Agent Framework 1.22](/2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient/), the pieces now compose in both directions: an `AIAgent` can be an `IChatClient`, an `IChatClient` can be an AG-UI endpoint, and an AG-UI endpoint can be an `IChatClient` again. If you only need a streaming chat backend for a CopilotKit-style frontend, `AGUI.Server` plus your existing chat client is now the smallest dependency that does it correctly.
