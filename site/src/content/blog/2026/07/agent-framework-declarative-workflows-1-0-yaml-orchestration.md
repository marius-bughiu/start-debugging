---
title: "Agent Framework Declarative Workflows 1.0: Your Orchestration Graph Is Now a YAML File"
description: "Microsoft Agent Framework shipped Declarative Workflows 1.0 on July 23, 2026. Python's agent-framework-declarative 1.0.0 reaches parity with the .NET Microsoft.Agents.AI.Workflows.Declarative package, so multi-agent routing lives in YAML instead of C#."
pubDate: 2026-07-25
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "yaml"
---

Microsoft shipped [Declarative Workflows 1.0](https://devblogs.microsoft.com/agent-framework/move-agent-orchestration-workflows-out-of-code-with-agent-framework-declarative-workflows-1-0/) for Agent Framework on July 23, 2026. The headline is parity: Python's `agent-framework-declarative` hit 1.0.0, matching the already-stable .NET package `Microsoft.Agents.AI.Workflows.Declarative`. Both now load the same YAML dialect and run it on the same workflow runtime that executes code-first graphs.

If you built a multi-agent system with the [orchestration patterns that reached 1.0 earlier this month](/2026/07/agent-framework-orchestration-patterns-compared/), you wrote the routing in C#. Every time product wanted a new triage branch, you edited a builder chain, rebuilt, and redeployed. Declarative workflows move that graph out of the assembly and into a file you can diff, review, and version like config.

## What the YAML actually looks like

A workflow is a `kind: Workflow` document with a trigger and a list of actions. Expressions are Power Fx, prefixed with `=`, and read from `System.*` and `Local.*` scopes:

```yaml
kind: Workflow
trigger:
  kind: OnConversationStart
  id: support_router
  actions:
    - kind: SetVariable
      id: set_category
      variable: Local.category
      value: =System.LastMessage.Text

    - kind: ConditionGroup
      id: route_request
      conditions:
        - condition: =Local.category = "billing"
          id: billing_route
          actions:
            - kind: InvokeAzureAgent
              id: billing_agent
              agent:
                name: BillingAgent
              conversationId: =System.ConversationId
      elseActions:
        - kind: InvokeAzureAgent
          id: general_agent
          agent:
            name: GeneralAgent
          conversationId: =System.ConversationId
```

That is the whole router. `ConditionGroup` gives you branching, `SetVariable` gives you state, and `InvokeAzureAgent` calls a named Foundry agent. The 1.0 action set also covers loops, `InvokeFunctionTool` for local functions, MCP and HTTP tool calls, human-in-the-loop pauses for approvals, and checkpoint plus resume.

## Loading it from C#

The .NET side is two types. `DeclarativeWorkflowOptions` wraps an agent provider, and `DeclarativeWorkflowBuilder.Build<TInput>` compiles the YAML into the same `Workflow` object you would have built by hand:

```csharp
using Azure.Identity;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Agents.AI.Workflows.Declarative;

AzureAgentProvider agentProvider = new(
    new Uri(foundryEndpoint),
    new DefaultAzureCredential());

DeclarativeWorkflowOptions options = new(agentProvider)
{
    Configuration = configuration,
};

Workflow workflow = DeclarativeWorkflowBuilder.Build<string>(
    Path.Combine(AppContext.BaseDirectory, "support-router.yaml"),
    options);

StreamingRun run = await InProcessExecution.RunStreamingAsync(
    workflow,
    "billing",
    CheckpointManager.CreateInMemory());

await foreach (WorkflowEvent evt in run.WatchStreamAsync())
{
    if (evt is AgentResponseEvent response)
    {
        Console.WriteLine(response.Response.Text);
    }
}
```

Note `Build<string>` is generic over the input type, and the returned `Workflow` flows into `InProcessExecution` exactly like a programmatically built one. Checkpointing, streaming events, and error events are unchanged, so your existing host code does not care which way the graph was authored.

## Where this stops being the right tool

Declarative is a serialization of the workflow model, not a replacement for it. Custom executors, bespoke state machines, and anything that needs real control flow beyond conditions and loops still belong in C#. The practical split: put agent routing and tool sequencing in YAML where a non-developer can read it, and keep genuinely custom behavior code-first. You can mix both in one application.

Start with the [declarative workflows reference on MS Learn](https://learn.microsoft.com/en-us/agent-framework/workflows/declarative) for the full action catalog.
