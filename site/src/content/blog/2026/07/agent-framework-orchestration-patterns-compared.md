---
title: "Microsoft Agent Framework orchestration: sequential vs concurrent vs group chat vs handoff vs magentic"
description: "Sequential for pipelines, concurrent for fan-out, group chat for moderated rounds, handoff for routing, magentic for open-ended planning. The C# builders and how to choose."
pubDate: 2026-07-21
template: vs
tags:
  - "comparison"
  - "microsoft-agent-framework"
  - "ai-agents"
  - "llm"
  - "dotnet"
  - "csharp"
  - "orchestration"
---

Microsoft Agent Framework ships five built-in multi-agent orchestration patterns, and they reached 1.0 in both the .NET and Python SDKs. The short version: use **sequential** when each agent builds on the last, **concurrent** when several agents answer the same prompt in parallel, **group chat** when you want a moderator to run bounded rounds of review, **handoff** when a triage agent should route the conversation to a specialist, and **magentic** when the solution path is unknown and you need a planning manager to decide who acts next. Everything below is against `Microsoft.Agents.AI.Workflows` 1.13.0 on NuGet (orchestration hit 1.0 on April 2, 2026; 1.13.0 shipped July 3, 2026), running on .NET 10. All five build from the same `AgentWorkflowBuilder` family and run through the same `InProcessExecution` loop, so switching patterns is usually a one-line change.

If you are new to the SDK, start with [what shipped in Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) and then come back. This post assumes you already have `ChatClientAgent` instances and just need to pick how they collaborate.

## The five patterns at a glance

| Pattern | Topology | Who decides the next speaker | Runs in parallel | Interactive by default | Best for |
| --- | --- | --- | --- | --- | --- |
| Sequential | Pipeline | Fixed order | No | No | Staged pipelines, progressive refinement |
| Concurrent | Fan-out / fan-in | All at once | Yes | No | Ensembles, voting, multi-perspective |
| Group Chat | Star (central manager) | A manager (round-robin, prompt, custom) | No | No | Writer/reviewer loops, bounded iteration |
| Handoff | Mesh (no orchestrator) | The current agent, via a handoff tool call | No | Yes | Triage, customer support, dynamic routing |
| Magentic | Star (planning manager) | A planning manager with a task ledger | No | Optional plan review | Open-ended research, unknown solution path |

The rows that actually force a decision are "who decides the next speaker" and "interactive by default." Sequential and concurrent are deterministic control flow you write. Group chat and magentic hand the turn-taking to a manager. Handoff is the only one that pauses for user input between turns unless you opt out.

## Sequential: a pipeline where each agent builds on the last

Sequential orchestration chains agents so each one consumes the previous agent's output. It is the right call for document review, translation pipelines, or any multi-stage reasoning where step N depends on step N-1.

```csharp
// Microsoft.Agents.AI.Workflows 1.13.0, .NET 10
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Extensions.AI;

// translationAgents is an IEnumerable<ChatClientAgent>
var workflow = AgentWorkflowBuilder.BuildSequential(translationAgents);
```

By default each agent sees the full conversation so far, both the inputs to the previous agent and its response. That is usually what you want for review chains. For a pure transform pipeline where each stage should only see the prior stage's output, the Python `SequentialBuilder` exposes `chain_only_agent_responses=True`; on .NET you get the same effect by shaping what each agent emits.

Pick sequential when the order is known and fixed, and when you would otherwise be tempted to write a `foreach` over your agents by hand. The builder gives you the same thing plus streaming events and built-in tool approval.

## Concurrent: fan out the same prompt, aggregate the answers

Concurrent orchestration sends one input to every agent at the same time and collects their responses. Use it for ensembles, brainstorming, or a voting system where diverse perspectives on the same question are the point.

```csharp
// Microsoft.Agents.AI.Workflows 1.13.0, .NET 10
var workflow = AgentWorkflowBuilder.BuildConcurrent(translationAgents);
```

The default aggregator returns one assistant message per participant. That is the key difference from sequential: there is no ordering and no shared refinement, just N independent takes stitched together. In Python you can swap in a custom aggregator (for example, a summarizer agent that consolidates the outputs into one answer). On .NET the default aggregation covers most cases; drop to a manual fan-out/fan-in workflow with `WorkflowBuilder` if you need a custom reducer.

Concurrent is the pattern people most often reach for and then regret, because "parallel" sounds efficient. It is efficient only when the agents genuinely do not need each other's output. If agent B should read agent A's answer, you want sequential or group chat, not concurrent.

## Group chat: a manager runs bounded rounds

Group chat models a moderated conversation. A central orchestrator (the manager) decides who speaks next and when to stop. Internally it is a star topology: the manager sits in the middle and every agent talks through it. This is the writer/reviewer loop, iterative refinement, or any "propose, critique, revise" cycle.

```csharp
// Microsoft.Agents.AI.Workflows 1.13.0, .NET 10
var workflow = AgentWorkflowBuilder
    .CreateGroupChatBuilderWith(agents =>
        new RoundRobinGroupChatManager(agents)
        {
            MaximumIterationCount = 5 // hard cap on turns
        })
    .AddParticipants(writer, reviewer)
    .Build();
```

The built-in `RoundRobinGroupChatManager` alternates speakers in order and stops at `MaximumIterationCount`. To make the loop end on a condition instead of a fixed count, subclass the manager and override `ShouldTerminateAsync`:

```csharp
// Terminate as soon as the reviewer says "approve"
public class ApprovalBasedManager : RoundRobinGroupChatManager
{
    private readonly string _approver;
    public ApprovalBasedManager(IReadOnlyList<AIAgent> agents, string approver)
        : base(agents) => _approver = approver;

    protected override ValueTask<bool> ShouldTerminateAsync(
        IReadOnlyList<ChatMessage> history, CancellationToken ct = default)
    {
        var last = history.LastOrDefault();
        bool done = last?.AuthorName == _approver &&
            last.Text?.Contains("approve", StringComparison.OrdinalIgnoreCase) == true;
        return ValueTask.FromResult(done);
    }
}
```

Reach for group chat when you want multiple rounds and shared context, but the coordination logic is simple enough to express as round-robin or a short custom rule. Always set `MaximumIterationCount`. A group chat with no cap and a manager that never terminates is how you burn a month of API budget in an afternoon.

## Handoff: a triage agent routes to a specialist

Handoff is the odd one out. There is no orchestrator; agents are wired in a mesh and each one can transfer control to another by calling a handoff tool. Control passes fully to the receiving agent, which then owns the task. This is the customer-support pattern: a triage agent reads the question and hands off to the math tutor, the refund specialist, or the shipping desk.

```csharp
// Microsoft.Agents.AI.Workflows 1.13.0, .NET 10
var workflow = AgentWorkflowBuilder.CreateHandoffBuilderWith(triageAgent)
    .WithHandoffs(triageAgent, [mathTutor, historyTutor]) // triage routes to either
    .WithHandoffs([mathTutor, historyTutor], triageAgent)  // specialists route back
    .Build();
```

The framework injects the handoff tools onto each agent based on those rules, detects the handoff tool call in the response, and filters the internal tool calls out of the history before forwarding it, so the model never sees the plumbing. Two things distinguish handoff from every other pattern:

- **It is interactive by default.** When an agent responds without handing off, the workflow returns control to you for the next user message and emits a `RequestInfoEvent`. That makes it the natural fit for multi-turn chat, but it also means you handle user input in the event loop.
- **It is not the same as agent-as-tools.** With agent-as-tools, a primary agent calls a helper and control comes back. With handoff, the receiving agent takes full ownership and the conversation moves on. Do not confuse "delegate a subtask" (tools) with "transfer the whole conversation" (handoff).

To run a handoff loop without a human in it, opt in to autonomous mode. Each agent then runs up to a turn limit (default 50) before yielding:

```csharp
var workflow = AgentWorkflowBuilder.CreateHandoffBuilderWith(triageAgent)
    .WithHandoffs(triageAgent, [mathTutor, historyTutor])
    .WithAutonomousMode(turnLimit: 10)
    .WithTerminationCondition(c => c.Any(m => m.Text?.Contains("RESOLVED") == true))
    .Build();
```

## Magentic: a planning manager for open-ended tasks

Magentic is the heavyweight. It borrows the design of the [Magentic-One system from AutoGen](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html): a manager builds a task plan, maintains a progress ledger, selects the next specialist each round, detects when the team stalls, and replans automatically. Architecturally it is group chat with a much smarter manager, so use it only when a simple round-robin manager cannot cope, that is, when the solution path is not known in advance.

```csharp
// Microsoft.Agents.AI.Workflows 1.13.0, .NET 10
#pragma warning disable MAAIW001 // Magentic types are experimental
using Microsoft.Agents.AI.Workflows.Specialized.Magentic;

Workflow workflow = new MagenticWorkflowBuilder(managerAgent)
    .AddParticipants([researcherAgent, coderAgent])
    .RequirePlanSignoff(false)  // set true to review the plan before it runs
    .WithMaxRounds(10)          // hard ceiling on coordination rounds
    .WithMaxStalls(3)           // consecutive non-progressing rounds before replanning
    .WithMaxResets(2)           // how many times the plan may be reset
    .Build();
```

Note the `MAAIW001` experimental warning: the Magentic types are still marked experimental in 1.13.0 even though the pattern itself is 1.0. Note also that `RequirePlanSignoff` defaults to **true** on .NET, so an out-of-the-box magentic workflow pauses for a human to approve the plan. That is the opposite of the Python default and it will look like a hang if you are not handling the `MagenticPlanReviewRequest` in your event loop. The manager also surfaces `MagenticPlanCreatedEvent`, `MagenticReplannedEvent`, and `MagenticProgressLedgerUpdatedEvent` so you can watch it reason.

Magentic costs the most tokens per task because the manager is itself an LLM doing planning on every round. Do not use it for problems a fixed pipeline solves. The Microsoft docs are explicit that its behavior outside the original Magentic-One task shape is untested, so treat it as the tool for genuinely open-ended work, not the default.

## One runtime for all five

The reason switching patterns is cheap is that they all produce a `Workflow` you drive the same way. Build once, then run through `InProcessExecution` and read the event stream:

```csharp
// Microsoft.Agents.AI.Workflows 1.13.0, .NET 10 - identical for every pattern
var messages = new List<ChatMessage> { new(ChatRole.User, "Hello, world!") };

await using StreamingRun run = await InProcessExecution.RunStreamingAsync(workflow, messages);
await run.TrySendMessageAsync(new TurnToken(emitEvents: true));

List<ChatMessage> result = [];
await foreach (WorkflowEvent evt in run.WatchStreamAsync())
{
    if (evt is AgentResponseUpdateEvent e)
    {
        Console.Write(e.Update.Text); // per-agent streaming deltas
    }
    else if (evt is WorkflowOutputEvent output)
    {
        result = output.As<List<ChatMessage>>()!; // terminal output
        break;
    }
}
```

`AgentResponseUpdateEvent` carries streaming text with an `ExecutorId` so you can label which agent is talking, and `WorkflowOutputEvent` carries the terminal result. Tool approval and human-in-the-loop work the same way across patterns: wrap a sensitive function in `ApprovalRequiredAIFunction`, and the workflow pauses with a `RequestInfoEvent` carrying `ToolApprovalRequestContent` that you answer with `SendResponseAsync`. Because the runtime is uniform, you can prototype on sequential and graduate to magentic without rewriting your event handling. And because a workflow is just a graph of executors, you can wrap any of these in [durable checkpointing so the run survives a process restart](/2026/05/agent-framework-durable-workflows-checkpoint-restart/).

## The gotcha that picks for you

Three constraints tend to make the decision regardless of preference.

**Do you need user input mid-run?** If yes, handoff is the only pattern that pauses for it by default. Bolting interactivity onto sequential means dropping to a custom `WorkflowBuilder` with a `RequestPort`. If your app is a chat interface, start with handoff.

**Is the number of steps known?** If yes, sequential or concurrent. Writing a manager (group chat) or a planner (magentic) to run a fixed three-stage pipeline is pure overhead, both in tokens and in the surface area you have to debug.

**Do the agents need to read each other?** Concurrent is the only pattern where they do not. The moment agent B should see agent A's output, concurrent is wrong and you want sequential (fixed order) or group chat (manager-decided order).

Put those together and the default ladder is: reach for sequential first, add concurrency only where agents are truly independent, move to group chat when you need bounded back-and-forth, use handoff when a human is in the loop and routing matters, and save magentic for the genuinely open-ended tasks where you cannot write the plan yourself. Start at the top of that ladder and climb only when the pattern below it cannot express what you need. If you are still deciding whether Agent Framework is even the right SDK, the [greenfield comparison against Semantic Kernel](/2026/06/microsoft-agent-framework-vs-semantic-kernel-for-a-greenfield-net-agent/) and the [Agent Framework vs LangChain vs LlamaIndex breakdown](/2026/06/microsoft-agent-framework-vs-langchain-vs-llamaindex-in-2026/) cover that first fork. And for the tool layer each agent exposes, see how to [author function tools inline, as methods, or as classes](/2026/05/microsoft-agent-framework-function-tools-inline-method-class/).

## Sources

- [Workflow orchestrations in Agent Framework](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/) - the pattern index.
- [Sequential orchestration](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/sequential) and [Concurrent orchestration](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/concurrent) - the two deterministic patterns.
- [Group Chat orchestration](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat) - manager and speaker selection.
- [Handoff orchestration](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff) - mesh topology, autonomous mode, tool approval.
- [Magentic orchestration](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic) - planning manager, plan review, stall detection.
- [Agent Framework's Orchestration Patterns Reach 1.0](https://devblogs.microsoft.com/agent-framework/agent-frameworks-orchestration-patterns-reach-1-0/) - the 1.0 announcement.
- [Microsoft.Agents.AI.Workflows on NuGet](https://www.nuget.org/packages/Microsoft.Agents.AI.Workflows) - version history.
