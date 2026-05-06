---
title: "Microsoft Agent Framework gates risky tool calls behind FunctionApprovalRequestContent"
description: "Wrap an AIFunction in ApprovalRequiredAIFunction and the agent stops mid-run to ask permission. Here is how the request and response flow works in C#."
pubDate: 2026-05-06
tags:
  - "dotnet"
  - "ai-agents"
  - "agent-framework"
  - "csharp"
  - "human-in-the-loop"
---

Jeremy Likness published [Building Blocks for AI Part 3](https://devblogs.microsoft.com/dotnet/microsoft-agent-framework-building-blocks-for-ai-part-3/) on the .NET Blog on May 4, 2026, and the part worth flagging for anyone shipping agents to production is the human-in-the-loop tool approval flow. Microsoft Agent Framework 1.0 (`Microsoft.Agents.AI` on NuGet) treats this as a first-class run state: when a sensitive tool is invoked, the agent does not call it. It pauses, surfaces the call, and waits for your application to approve or reject it before the next run continues.

## Mark a function as approval-required

The wrapper is `ApprovalRequiredAIFunction`. You build a normal `AIFunction` from a delegate, wrap it once, then hand the wrapped instance to `AsAIAgent`. The model still sees the same schema; only the framework's call site changes.

```csharp
using System.ComponentModel;
using Azure.AI.Projects;
using Azure.Identity;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

[Description("Get the weather for a given location.")]
static string GetWeather([Description("The location to get the weather for.")] string location)
    => $"The weather in {location} is cloudy with a high of 15C.";

AIFunction weatherFunction = AIFunctionFactory.Create(GetWeather);
AIFunction approvalRequired = new ApprovalRequiredAIFunction(weatherFunction);

AIAgent agent = new AIProjectClient(
    new Uri("<your-foundry-project-endpoint>"),
    new DefaultAzureCredential())
    .AsAIAgent(
        model: "gpt-4o-mini",
        instructions: "You are a helpful assistant",
        tools: [approvalRequired]);
```

You do not change the function body. Anything that should require a confirmation step (DB writes, payment calls, outbound email, anything you would not want a hallucinated argument to trigger) gets the wrapper, and only those.

## Detect the request

When the model decides to call an approval-gated tool, the framework yields a response that contains one or more `FunctionApprovalRequestContent` items instead of the tool's return value. After every `RunAsync`, you scan the message contents for them.

```csharp
AgentSession session = await agent.CreateSessionAsync();
AgentResponse response = await agent.RunAsync(
    "What is the weather like in Amsterdam?", session);

var requests = response.Messages
    .SelectMany(m => m.Contents)
    .OfType<FunctionApprovalRequestContent>()
    .ToList();

foreach (var req in requests)
{
    Console.WriteLine($"Approval needed for {req.FunctionCall.Name}");
    Console.WriteLine($"Arguments: {req.FunctionCall.Arguments}");
}
```

`FunctionCall.Name` and `FunctionCall.Arguments` are what you render to the user. Show the actual arguments, not just the function name. The whole point of the gate is that the model picked the arguments, and `delete_account(id: 42)` is the part you want a human eye on.

## Send the response back

The reply is built off the request itself. `requestContent.CreateResponse(true)` produces a `FunctionApprovalResponseContent`; pass `false` to reject. Wrap it in a user `ChatMessage`, run again on the same session, and the agent either executes the tool or proceeds without its result.

```csharp
var approvalMessage = new ChatMessage(
    ChatRole.User,
    [requests[0].CreateResponse(approve: true)]);

AgentResponse final = await agent.RunAsync(approvalMessage, session);
Console.WriteLine(final);
```

## Loop, do not assume

A single user turn can produce multiple approval requests, especially with a planner that batches calls. The docs are explicit: keep checking for `FunctionApprovalRequestContent` after every run until the response contains none. If you only handle the first request and call it done, you will silently drop subsequent tool calls and end up with an answer that is missing data.

For workflow scenarios, `AgentWorkflowBuilder.BuildSequential()` already understands the approval contract: it pauses the workflow and emits a `RequestInfoEvent`, no extra plumbing. Full runnable sample in the [microsoft/agent-framework repo](https://github.com/microsoft/agent-framework/tree/main/dotnet/samples/02-agents/Agents/Agent_Step01_UsingFunctionToolsWithApprovals), and the API is documented at [learn.microsoft.com](https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval).
