---
title: "Declarative YAML Workflows vs Code-First Orchestration in Microsoft Agent Framework"
description: "Use declarative YAML when the graph is a sequential routing decision that non-developers change often. Use code-first WorkflowBuilder the moment you need parallelism, custom executors, or a non-Foundry agent. Here is the decision, the action catalog limits, and the code both ways."
pubDate: 2026-08-05
template: vs
tags:
  - "comparison"
  - "microsoft-agent-framework"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "yaml"
---

Microsoft Agent Framework now gives you two ways to author the same orchestration graph: a YAML file loaded by `Microsoft.Agents.AI.Workflows.Declarative` (1.17.0 on NuGet as of August 4, 2026) or a `WorkflowBuilder` chain in C#, Python, or Go. Here is the call: **author in YAML when your graph is a sequential routing decision over Foundry-registered agents that someone outside the codebase needs to change, and stay code-first the moment you need two agents running at once, a stateful custom node, or an agent that is not registered in Foundry.** The dividing line is not "simple vs complex". It is whether your custom code needs to be a *node* in the graph or can live as a *leaf* the graph calls.

Both paths converge on the same runtime. `DeclarativeWorkflowBuilder.Build<TInput>` returns the identical `Workflow` object that `new WorkflowBuilder(start).Build()` returns, so streaming, checkpointing, and human-in-the-loop behave the same either way. The choice is purely about the authoring surface, and the authoring surface has hard edges that the announcement post does not spell out.

## The matrix

| | Declarative YAML | Code-first `WorkflowBuilder` |
| --- | --- | --- |
| Package (.NET) | `Microsoft.Agents.AI.Workflows.Declarative` 1.17.0 | `Microsoft.Agents.AI.Workflows` 1.17.0 |
| Package (Python) | `agent-framework-declarative` 1.0.1 | `agent-framework-core` |
| Languages | C#, Python only | C#, Python, Go |
| Authoring vocabulary | 27 fixed action kinds + PowerFx expressions | arbitrary host language |
| Parallel execution | none, actions run in list order | superstep fan-out and fan-in |
| Your code enters as | `InvokeFunctionTool` (a leaf call) | `Executor` (a routing node) |
| Agent invocation | `InvokeAzureAgent`, resolved by name | any `AIAgent` instance |
| Validation | PowerFx evaluated at runtime | graph and message types checked in `Build()` |
| Change without a rebuild | yes, edit the file | no, recompile and redeploy |
| Checkpoint and resume | yes | yes |
| Native AOT | yes, with `DeclarativeWorkflowJsonOptions.Default` | yes, `[MessageHandler]` is source-generated |

## Why the "custom code is a leaf" distinction decides most cases

The 1.0 action catalog has exactly one way for your own code to run inside a declarative workflow: `InvokeFunctionTool`, which calls an `AIFunction` you registered with the host.

```yaml
# Microsoft.Agents.AI.Workflows.Declarative 1.17.0, C# dialect
- kind: InvokeFunctionTool
  id: invoke_get_data
  displayName: Get customer record
  functionName: GetUserData
  requireApproval: true
  arguments:
    userId: =Local.userId
  output:
    result: Local.UserData
```

That function receives arguments, returns a value, and the workflow moves to the next action in the list. It cannot decide where the message goes next, cannot fan a message out to three downstream nodes, and cannot hold state that the runtime checkpoints on its behalf. Routing stays in the YAML, expressed only through `If`, `ConditionGroup`, `Foreach`, `GotoAction`, `BreakLoop`, and `ContinueLoop`.

A code-first executor is the opposite. It is a node that owns its own routing:

```csharp
// Microsoft.Agents.AI.Workflows 1.17.0, .NET 10
using Microsoft.Agents.AI.Workflows;

internal sealed partial class TriageExecutor() : Executor("Triage")
{
    [MessageHandler]
    private async ValueTask HandleAsync(SupportTicket ticket, IWorkflowContext context)
    {
        if (ticket.Severity >= 3)
        {
            await context.SendMessageAsync(new EscalationRequest(ticket));
            await context.SendMessageAsync(new PageOnCall(ticket));
            return;
        }

        await context.YieldOutputAsync($"Auto-closed {ticket.Id}");
    }
}
```

Two `SendMessageAsync` calls in one handler means both downstream branches run concurrently in the next superstep. There is no action kind in the declarative catalog that expresses that. The class must be `partial` and the handler carries `[MessageHandler]` because registration is compile-time source-generated, which is also what makes the code-first path Native AOT friendly without extra ceremony.

So the question to ask about any workflow you are about to author is: does my own code ever need to choose the next hop, or run alongside something else? If yes, YAML is the wrong surface and no amount of `GotoAction` will fix it.

## When to pick declarative YAML

**The graph is a routing decision over named Foundry agents.** This is the shape the action catalog was designed for. A `ConditionGroup` that picks one of four agents based on a classified category is three dozen lines of readable YAML, and the person who owns the taxonomy can add a fifth branch without opening the solution:

```yaml
# C# dialect: input arrives via System.LastMessage, output leaves via SendActivity
kind: Workflow
trigger:
  kind: OnConversationStart
  id: support_router
  actions:
    - kind: SetVariable
      id: capture_category
      variable: Local.category
      value: =Lower(System.LastMessage.Text)

    - kind: ConditionGroup
      id: route_request
      conditions:
        - condition: =Local.category = "billing"
          id: billing_branch
          actions:
            - kind: InvokeAzureAgent
              id: billing_agent
              agent:
                name: BillingAgent
              conversationId: =System.ConversationId
              output:
                responseObject: Local.Result
                autoSend: true
      elseActions:
        - kind: InvokeAzureAgent
          id: general_agent
          agent:
            name: GeneralAgent
          conversationId: =System.ConversationId
          output:
            autoSend: true
```

**The routing changes on a different cadence than the code.** A YAML file ships as content, gets reviewed as a diff by someone who is not fluent in the builder API, and can be swapped without a rebuild. That is the entire practical argument, and it is a good one when the churn is real.

**You want the workflow visible outside your repo.** The Microsoft Foundry toolkit for VS Code renders a declarative workflow as a visual graph next to the YAML, and both stay in sync as you edit. That round trip does not exist for a `WorkflowBuilder` chain.

**You are calling MCP or HTTP tools in a fixed sequence.** `InvokeMcpTool` takes a `serverUrl`, `toolName`, `arguments`, and optional `headers`, with a `requireApproval` flag. `HttpRequestAction` does the same for REST, parses a JSON response into a variable, and fails the action on any non-2xx. Both are wired through handlers you configure once on `DeclarativeWorkflowOptions`:

```csharp
DeclarativeWorkflowOptions options = new(agentProvider)
{
    Configuration = configuration,
    HttpRequestHandler = new DefaultHttpRequestHandler(),
    McpToolHandler = mcpToolHandler,
    MaximumCallDepth = 50,
    MaximumExpressionLength = 10_000,
};

Workflow workflow = DeclarativeWorkflowBuilder.Build<string>("support-router.yaml", options);
```

## When to pick code-first

**Two things need to happen at the same time.** The runtime uses a modified Pregel model: a superstep collects pending messages, routes them, runs every target executor concurrently, then waits at a synchronization barrier before advancing. Fan-out is a first-class edge concept in `WorkflowBuilder`. In YAML, actions execute in list order and there is no parallel action kind, so a research step and a compliance step that could run together will run one after the other.

**A node has to hold state across messages.** Executors can carry mutable fields, and the framework gives you `IResettableExecutor` to clear stale state when an instance is reused across runs. A declarative workflow's state is a flat bag of PowerFx variables in `Local.*`, typed by whatever PowerFx inferred.

**The agent is not registered in Foundry.** `InvokeAzureAgent` is the only agent-invocation action in the catalog, and the C# host resolves it through `AzureAgentProvider`, which takes a project endpoint and a credential. A locally constructed `ChatClientAgent` pointed at Ollama, an OpenAI key, or an on-prem gateway has no name for the YAML to reference. Code-first takes any `AIAgent` instance directly.

**You want errors at build time.** `WorkflowBuilder.Build()` validates message-type compatibility between connected executors, graph connectivity from the start executor, executor binding, and duplicate edges. A PowerFx typo like `=Local.categry = "billing"` is a runtime surprise that silently takes the else branch.

**You are on Go.** `agent-framework-go` has the full executor and edge model, including `workflow.NewBuilder(...).AddEdge(...).WithOutputFrom(...).Build()`. There is no declarative package for Go. The Learn article for declarative workflows only has C# and Python zones.

## The gotchas that pick for you

**The YAML is not portable between C# and Python.** These are two dialects, not one format with two loaders. The C# document starts with `kind: Workflow` and a `trigger`, has no `Workflow.Inputs` or `Workflow.Outputs` namespace at all, takes input from `System.LastMessage` and emits output through `SendActivity`. The Python document starts with `name:`, declares typed `inputs:`, and reads and writes `Workflow.Inputs.*` and `Workflow.Outputs.*`. Four conversation actions (`AddConversationMessage`, `CopyConversationMessages`, `RetrieveConversationMessage`, `RetrieveConversationMessages`) are C# only. If "portable config" is your reason for choosing YAML, that reason is weaker than it sounds.

**Python 3.14 does not work.** The declarative package supports Python 3.10 through 3.13, and Learn states plainly that 3.14 is not yet supported because of PowerFx compatibility. The code-first `agent-framework-core` path has no such constraint. If your service is already on 3.14, the decision is made for you.

**Native AOT needs one extra line.** Publishing with `PublishAot=true`, or setting `JsonSerializerIsReflectionEnabledByDefault=false`, breaks the default `CheckpointManager.CreateJson(store)` on commit or rehydration. The package ships a source-generated options instance for every declarative type in the checkpoint pipeline:

```csharp
// Safe in non-AOT apps too. Adopt unconditionally.
CheckpointManager checkpointManager = CheckpointManager.CreateJson(
    store,
    DeclarativeWorkflowJsonOptions.Default);
```

`DeclarativeWorkflowJsonOptions` is marked `[Experimental("MAAI001")]`, so suppress the diagnostic with `<NoWarn>$(NoWarn);MAAI001</NoWarn>`. If your workflow input or approval arguments are your own types, clone `Default` and append your own `JsonSerializerContext` to `TypeInfoResolverChain` before calling `MakeReadOnly()`.

**The Learn prerequisites are stale.** The declarative article still tells you to install with `--prerelease`. That page is dated June 26, 2026 and predates the 1.0 announcement on July 23. The stable packages are on NuGet and PyPI now, so drop the flag.

**The escape hatch is one-way.** The Foundry VS Code toolkit has a Generate Code button that converts a YAML workflow into Agent Framework code in Python or C#, but it drives GitHub Copilot to do the translation and therefore needs a Copilot subscription. Treat it as a starting point for a rewrite, not a supported round trip. There is no code-to-YAML direction at all.

## The recommendation, with the reasoning attached

Start code-first. Move a graph to YAML when you can point at a specific person outside the engineering team who will edit it, and when that graph is a sequential chain or a branch over Foundry-registered agents with no parallelism and no stateful nodes. That is a narrow but genuinely common shape, and inside it the declarative path is strictly better: same runtime, same checkpoints, same human-in-the-loop, minus a deployment per routing tweak.

Outside that shape, YAML costs you build-time type validation, concurrency, custom executors, Go, and Python 3.14, and it gives you a second dialect to maintain per runtime. Mixing is fine and probably right for a large system: load the routing layer from YAML, keep the parts that actually compute in C# executors, and compose them, since a declarative workflow is just a `Workflow` instance like any other.

## Related

- The [Declarative Workflows 1.0 release](/2026/07/agent-framework-declarative-workflows-1-0-yaml-orchestration/) and what reaching Python parity actually changed.
- If you have not picked a topology yet, the [built-in orchestration patterns compared](/2026/07/agent-framework-orchestration-patterns-compared/) covers sequential, concurrent, group chat, handoff, and magentic.
- Long-running graphs need durability, which is covered in [making workflows survive process restarts](/2026/05/agent-framework-durable-workflows-checkpoint-restart/).
- Declarative agent invocation assumes registered agents, so see [deploying an agent to Foundry Hosted Agents](/2026/06/deploy-a-microsoft-agent-framework-agent-to-foundry-hosted-agents/).
- The functions behind `InvokeFunctionTool` are ordinary tools, built the three ways described in [authoring a function tool in C#](/2026/05/microsoft-agent-framework-function-tools-inline-method-class/).

## Sources

- [Declarative Workflows overview](https://learn.microsoft.com/en-us/agent-framework/workflows/declarative) on Microsoft Learn, including the full action quick reference and the C# and Python dialect differences.
- [Move Agent Orchestration/Workflows out of Code with Agent Framework Declarative Workflows 1.0](https://devblogs.microsoft.com/agent-framework/move-agent-orchestration-workflows-out-of-code-with-agent-framework-declarative-workflows-1-0/), July 23, 2026.
- [Workflow Builder and Execution](https://learn.microsoft.com/en-us/agent-framework/workflows/workflows) for the superstep model and build-time validation.
- [Executors](https://learn.microsoft.com/en-us/agent-framework/workflows/executors) for the `[MessageHandler]` source-generated handler model.
- [Add declarative agent workflows in VS Code](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/vs-code-agents-workflow-low-code) for the visual designer and the Generate Code conversion.
- [Microsoft.Agents.AI.Workflows.Declarative on NuGet](https://www.nuget.org/packages/Microsoft.Agents.AI.Workflows.Declarative) and [agent-framework-declarative on PyPI](https://pypi.org/project/agent-framework-declarative/) for current versions and supported runtimes.
