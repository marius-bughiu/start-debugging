---
title: "Blazor Gets Agentic UI Components in .NET 11 RC1: ChatPage, UIAgent, and Tool Approvals"
description: "Microsoft.AspNetCore.Components.AI is an experimental Blazor package in .NET 11 RC1 that turns any IChatClient into a streaming chat UI with tool approvals, typed tool rendering, and shared state over AG-UI."
pubDate: 2026-09-29
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnet-core"
  - "ai-agents"
  - "microsoft-extensions-ai"
  - "ag-ui"
---

On September 28, 2026 Daniel Roth published [Build Agentic UI with the new Blazor AI components](https://devblogs.microsoft.com/dotnet/build-agentic-ui-blazor/), the first real walkthrough of `Microsoft.AspNetCore.Components.AI`. The package shipped quietly with [.NET 11 RC1](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/aspnetcore.md#experimental-blazor-ai-components-for-agentic-user-interfaces) and is marked experimental: it stays prerelease for the whole .NET 11 cycle. What it gives you is the part every team building an agent frontend has been rewriting by hand: streaming message rendering, tool call display, human approval gates, and state the agent can edit.

## From IChatClient to a working chat page

Everything hangs off `UIAgent`, which wraps any `Microsoft.Extensions.AI` `IChatClient`, consumes the `ChatResponseUpdate` stream, and maps it to observable `ContentBlock` instances that Razor components render. The fastest path is `ChatPage`, a complete shell with message list, input, streaming status, and retry:

```bash
dotnet add package Microsoft.AspNetCore.Components.AI --prerelease
```

```razor
<link rel="stylesheet" href="@Assets["_content/Microsoft.AspNetCore.Components.AI/ai-chat.css"]" />

<ChatPage Agent="_agent" Placeholder="Type a message...">
    <WelcomeContent>
        <p>Ask the agent a question.</p>
    </WelcomeContent>
</ChatPage>

@code {
    private UIAgent _agent = default!;

    protected override void OnInitialized()
    {
        IChatClient chatClient = GetChatClient();
        _agent = new UIAgent(chatClient);
    }
}
```

When you outgrow the shell, `ChatPage` decomposes into `AgentBoundary`, `MessageList`, `MessageInput`, and `BlockRenderer<TBlock>`, so you can lay out the conversation yourself and pick Razor content per block type.

## Approvals and typed tool rendering

The piece I care most about is the approval flow. Wrap a consequential tool in `ApprovalRequiredAIFunction` and the agent pauses on a `FunctionApprovalBlock` until the user decides:

```razor
<BlockRenderer TBlock="FunctionApprovalBlock" Context="block">
    @if (block.Status == ApprovalStatus.Pending)
    {
        <button @onclick="block.Approve">Approve</button>
        <button @onclick="() => block.Reject()">Reject</button>
    }
</BlockRenderer>
```

For backend tools you declare how a call renders with a source-generated block, then register it with `options.AddGeneratedToolBlocks()`:

```csharp
[ToolBlock("get_weather")]
public partial class WeatherToolBlock : FunctionInvocationContentBlock
{
    [ToolParameter(Name = "location")]
    public string? Location { get; set; }

    [ToolResult]
    public WeatherInfo? Weather { get; set; }
}
```

Frontend tools are plain `AIFunctionFactory.Create` delegates added to `ChatOptions.Tools`, so the model can call back into the component (the sample sets a page accent color through `InvokeAsync`).

## Shared state and AG-UI

`UIAgent<TState>` adds a strongly typed state object the agent and the user edit together. A `StateMapper` in `UIAgentOptions` applies incoming state, and predictive state lets the agent stage a change that the UI commits with `AcceptPredictiveState()` or drops with `RejectPredictiveState()`.

State travels over [AG-UI](https://docs.ag-ui.com/sdk/dotnet): `STATE_SNAPSHOT` replaces it, `STATE_DELTA` patches it with RFC 6902 JSON Patch, and `REASONING_*` events show up as collapsible reasoning panels. To point the UI at a remote agent, hand `UIAgent` an `AGUIChatClient` instead of a model client:

```csharp
HttpClient http = httpClientFactory.CreateClient("agentserver");
IChatClient client = new AGUIChatClient(new AGUIChatClientOptions(http, endpoint));
```

The server side is `AddAGUIServer()` plus `MapAGUIServer("/agentic_chat", agent)`, from either `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` or `AGUI.Server`, the standalone package I covered in [AG-UI .NET SDK 1.0](/2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework/).

## Should you use it yet

It needs the .NET 11 RC1 SDK and the API is explicitly open for feedback, so expect renames before GA. For a new internal agent tool it is already the shortest path from `IChatClient` to an approval-gated UI. The full set of scenarios lives in the [AgenticUI sample repository](https://github.com/danroth27/AgenticUI).
