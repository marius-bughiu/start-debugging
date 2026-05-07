---
title: "Microsoft Agent Framework workflows now survive process restarts via the Durable Task stack"
description: "Wrap an Agent Framework Workflow in Microsoft.Agents.AI.DurableTask and each executor step is checkpointed. Crash, redeploy, restart - the run continues where it stopped."
pubDate: 2026-05-07
tags:
  - "dotnet"
  - "ai-agents"
  - "agent-framework"
  - "csharp"
  - "durable-task"
---

Shyju Krishnankutty published [Durable Workflows in Microsoft Agent Framework](https://devblogs.microsoft.com/dotnet/durable-workflows-in-microsoft-agent-framework/) on the .NET Blog on May 6, 2026. The headline is that the workflow programming model from `Microsoft.Agents.AI.Workflows` now plugs into the Durable Task stack via the prerelease `Microsoft.Agents.AI.DurableTask` package, so a multi-step agent run can checkpoint after every executor and resume on a different process after a crash, scale event, or redeploy. This is the missing piece for taking a multi-agent pipeline from a console demo to something you can actually host.

## The piece that was already there

A workflow is a directed graph of `Executor<TInput, TOutput>` nodes wired with `WorkflowBuilder`. This part is in the stable [Microsoft.Agents.AI.Workflows](https://www.nuget.org/packages/Microsoft.Agents.AI.Workflows) package and is not new:

```csharp
using Microsoft.Agents.AI.Workflows;

Workflow cancelOrder = new WorkflowBuilder(orderLookup)
    .WithName("CancelOrder")
    .AddEdge(orderLookup, orderCancel)
    .AddEdge(orderCancel, sendEmail)
    .Build();

await foreach (var evt in InProcessExecution.RunStreamingAsync(cancelOrder, orderId))
{
    Console.WriteLine(evt);
}
```

`InProcessExecution.RunStreamingAsync` runs the graph in memory. If the host dies between `orderCancel` and `sendEmail`, the order is cancelled, the customer never gets the email, and there is no retry record. Fine for samples, dangerous for anything that touches money.

## What changed on May 6

`Microsoft.Agents.AI.DurableTask` lets the same workflow execute on top of Durable Task. Every executor invocation becomes a Durable activity, so progress is checkpointed after each node and the runtime replays history on restart. From the announcement: "Stateful, durable execution: workflows survive process restarts and failures" and "automatic checkpointing: progress is saved after each step".

Combined with `Microsoft.Agents.AI.Hosting.AzureFunctions` and the `Microsoft.DurableTask.Client.AzureManaged` / `Microsoft.DurableTask.Worker.AzureManaged` packages targeting Durable Task Scheduler, an Azure Functions host generates the HTTP trigger, orchestrator, and activity functions for you:

```csharp
var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureDurableWorkflows(workflows =>
{
    workflows.AddWorkflow("CancelOrder", sp => BuildCancelOrderWorkflow(sp),
        exposeMcpToolTrigger: true);
});

builder.Build().Run();
```

`exposeMcpToolTrigger: true` is the bit worth flagging on its own: the workflow shows up as an MCP tool, so a Claude or Copilot agent can call `CancelOrder` and the durable runtime handles the rest.

## Patterns that get more useful when durability is on

Three workflow features that were nice-to-have in-process become load-bearing once the run can span hours:

- `AddFanOutEdge()` and `AddFanInBarrierEdge()` for parallel sub-tasks (e.g. enrich an order from three systems, then merge), now safely resumable.
- `RequestPort.Create<TRequest, TResponse>()` for human-in-the-loop. The workflow parks, persists, and only wakes when the response arrives. Hours, days, whatever.
- `AddSwitch()` for conditional routing on a previous executor's output, which is a much safer pattern than letting the LLM pick the next branch.

The `Microsoft.Agents.AI.DurableTask` package is still prerelease, so pin the version explicitly and watch the [Microsoft Agent Framework DevBlogs feed](https://devblogs.microsoft.com/agent-framework/) for breaking changes before GA.
