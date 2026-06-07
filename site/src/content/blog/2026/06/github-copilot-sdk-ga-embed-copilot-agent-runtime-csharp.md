---
title: "GitHub Copilot SDK Hits GA: Embed Copilot's Agent Runtime in Your Own C# Apps"
description: "At Build 2026 GitHub shipped Copilot SDK 1.0 GA with a first-class .NET package. You can now drive the same planning, tool-calling, and multi-turn agent runtime from C# code, BYOK included."
pubDate: 2026-06-07
tags:
  - "github-copilot"
  - "copilot-sdk"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "mcp"
---

GitHub announced the [GitHub Copilot SDK reaching general availability](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/) on June 2, 2026 at Build, and the part worth your attention as a .NET developer is the `GitHub.Copilot.SDK` package. It gives you direct, programmatic access to the same agent runtime that sits behind Copilot in the editor: planning, tool invocation, file edits, streaming, and multi-turn sessions. The selling point is that you do not have to build the orchestration layer yourself. The runtime that already ships millions of agent turns a day is now a NuGet dependency.

## What you actually get

The SDK landed in six languages at GA (`@github/copilot-sdk`, `github-copilot-sdk` for Python, Go, Rust, Java, and `GitHub.Copilot.SDK` for .NET). For Node.js, Python, and .NET the Copilot CLI is bundled automatically as a transitive dependency, so there is no separate binary to install or keep on PATH. You add one package and you have an agent host:

```bash
dotnet add package GitHub.Copilot.SDK
```

A session is the unit of work. You start a client, open a session against a model, and listen for typed events instead of polling. Here is the full round trip for a single prompt:

```csharp
using GitHub.Copilot;

await using var client = new CopilotClient();
await client.StartAsync();

await using var session = await client.CreateSessionAsync(new SessionConfig
{
    Model = "gpt-5",
    OnPermissionRequest = PermissionHandler.ApproveAll,
});

var done = new TaskCompletionSource();

session.On<SessionEvent>(evt =>
{
    if (evt is AssistantMessageEvent msg)
        Console.WriteLine(msg.Data.Content);
    else if (evt is SessionIdleEvent)
        done.SetResult();
});

await session.SendAsync(new MessageOptions { Prompt = "What is 2+2?" });
await done.Task;
```

Streaming is a flag, not a different API: set `Streaming = true` on `SessionConfig` and you receive `AssistantMessageDeltaEvent` chunks that you accumulate until the final `AssistantMessageEvent`.

## Tools are plain methods, MCP is built in

The piece that makes this more than a chat wrapper is custom tools. `CopilotTool.DefineTool` takes a delegate and reuses the `Microsoft.Extensions.AI` function factory, so a tool is just a typed C# method with a `[Description]` on each parameter:

```csharp
using Microsoft.Extensions.AI;
using System.ComponentModel;

var session = await client.CreateSessionAsync(new SessionConfig
{
    Model = "gpt-5",
    Tools =
    [
        CopilotTool.DefineTool(
            async ([Description("Issue ID")] string id) => await FetchIssueAsync(id),
            factoryOptions: new AIFunctionFactoryOptions
            {
                Name = "lookup_issue",
                Description = "Fetch issue details",
            }),
    ],
});
```

If you have already built [a custom MCP server in C#](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/), the agent can connect to it directly, so existing tools come along without a rewrite.

## BYOK so it is not locked to GitHub billing

Authentication is the other reason to look. Out of the box the SDK picks up your `copilot` CLI login or environment tokens (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`). But bring-your-own-key works for OpenAI, Microsoft Foundry, Anthropic, and other providers, so you can point the runtime at a model you already pay for:

```csharp
var session = await client.CreateSessionAsync(new SessionConfig
{
    Provider = new ProviderConfig
    {
        Type = "openai",
        BaseUrl = "https://api.openai.com/v1",
        ApiKey = "your-api-key",
    },
});
```

It also ships OpenTelemetry tracing with W3C trace context propagation, so the agent's tool calls and turns show up in the same traces as the rest of your service. For anyone who has been hand-rolling a tool loop on top of a raw chat client, the GA package is the first time GitHub's own agent runtime is something you can `dotnet add` and ship. The [.NET cookbook and getting-started guide](https://github.com/github/copilot-sdk) are the place to go next.
