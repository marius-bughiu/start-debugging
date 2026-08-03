---
title: "Agent Framework's Copilot Provider Turns the Copilot CLI Into a Plain AIAgent"
description: "Microsoft.Agents.AI.GitHub.Copilot 1.16.0 shipped on July 30, 2026. The Copilot CLI runtime now sits behind the ordinary AIAgent abstraction, permissions are deny-by-default, and Squad plugs a whole agent team in as one AIAgent."
pubDate: 2026-08-03
tags:
  - "agent-framework"
  - "github-copilot"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "mcp"
---

Microsoft pushed `Microsoft.Agents.AI.GitHub.Copilot` 1.16.0 to NuGet on July 30, 2026, and the [Agent Framework blog post that landed the same day](https://devblogs.microsoft.com/agent-framework/building-agent-teams-with-agent-framework-github-copilot-cli-and-squad/) describes the GitHub Copilot integration as fully supported in both C# and Python. The practical effect: the Copilot CLI runtime, the one that runs shell commands, edits files, fetches URLs, and speaks MCP, is now reachable through the ordinary `AIAgent` abstraction.

## Two lines to a coding agent

```bash
dotnet add package Microsoft.Agents.AI.GitHub.Copilot
```

```csharp
using GitHub.Copilot;
using Microsoft.Agents.AI;

await using CopilotClient copilotClient = new();
await copilotClient.StartAsync();

AIAgent agent = copilotClient.AsAIAgent();

Console.WriteLine(await agent.RunAsync("What is Microsoft Agent Framework?"));
```

`AsAIAgent` optionally takes `tools:` and `instructions:`, so an `AIFunction` you already registered elsewhere drops straight in. What you get back is a standard `AIAgent`, which means `RunStreamingAsync`, `CreateSessionAsync` for multi-turn context, and any workflow or orchestration you already built on Agent Framework all work against it unchanged. That is the difference from driving [the Copilot SDK directly](/2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp/): you stop hand-writing the session event loop and treat Copilot as one more provider.

## Permissions are deny-by-default

The detail that will bite you first is that the agent cannot execute shell commands, touch the file system, or fetch URLs until you hand it a permission handler:

```csharp
SessionConfig sessionConfig = new()
{
    OnPermissionRequest = PromptPermission,
};

AIAgent agent = copilotClient.AsAIAgent(sessionConfig);
```

Your handler returns `PermissionDecision.ApproveOnce()` or `PermissionDecision.Reject()`. There is a `PermissionHandler.ApproveAll` shortcut, and the [MS Learn provider page](https://learn.microsoft.com/en-us/agent-framework/agents/providers/github-copilot) is blunt about running that inside a container or dev container rather than on your workstation. MCP servers come along too, local stdio and remote HTTP, configured through `SessionConfig.McpServers`. Code interpreter, file search, and hosted web search do not: the docs mark all three unsupported for this provider.

## Squad rides the same abstraction

The second half of the announcement is Squad, an open-source multi-agent setup where a coordinator and a handful of specialists live in your repo as markdown files under `.squad/`. The `Squad.Agents.AI` package wraps the whole team as a `DelegatingAIAgent`, so an entire roster presents itself to your app as one `AIAgent`:

```csharp
builder.Services.AddSquadAgent(o =>
{
    o.SquadFolderPath = @"C:\path\to\your\team-root";
});

var squad = host.Services.GetRequiredService<AIAgent>();
var session = await squad.CreateSessionAsync();
var response = await squad.RunAsync("What can this Squad team do?", session);
```

Every specialist dispatch emits an OpenTelemetry span named `squad.subagent {Name}`, so the fan-out shows up in Aspire or Jaeger without extra wiring. Squad itself is still alpha (`Squad.Agents.AI` is at 0.5.5, with 0.5.6 previews), and it needs `dotnet add package Squad.Agents.AI --prerelease` plus the `@bradygaster/squad-cli` npm package to scaffold the folder.

The provider is the part worth adopting this week. Squad is the interesting proof that once a coding agent is just an `AIAgent`, an entire team of them can be too.
