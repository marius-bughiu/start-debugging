---
title: "Migrate a Custom Multi-Agent Orchestrator to Handoff Orchestration in Agent Framework 1.17"
description: "Replace a hand-rolled classifier-plus-switch router with AgentWorkflowBuilder.CreateHandoffBuilderWith in Microsoft.Agents.AI.Workflows 1.17.0. What breaks, the six migration steps, and the gotchas around agent Ids, descriptions, and context broadcast."
pubDate: 2026-08-07
updatedDate: 2026-08-07
template: migration
tags:
  - "migration"
  - "microsoft-agent-framework"
  - "ai-agents"
  - "llm"
  - "dotnet"
  - "csharp"
  - "orchestration"
---

Most multi-agent systems in production today were not built on an orchestration framework. They are a `while` loop, a classifier call that returns an agent name, a `switch`, and a `List<ChatMessage>` that everything shares. That design works until you need human approval on a tool call, per-agent streaming, or a run that survives a process restart. Moving it to handoff orchestration in `Microsoft.Agents.AI.Workflows` 1.17.0 (published August 4, 2026) took about half a day for a three-agent support bot, and the surprises were not where I expected. The classifier prompt disappears entirely, routing becomes a tool call named `handoff_to_<agent_id>`, and your `List<ChatMessage>` stops being the source of truth. Everything below is compiled against `Microsoft.Agents.AI.Workflows` 1.17.0 on .NET 10 (SDK 10.0.201).

## What the hand-rolled router actually looks like

Here is the shape almost every custom orchestrator converges on. A cheap model classifies each user turn into an agent name, the loop keeps the picked agent "sticky", and one flat history is passed to whichever agent runs:

```csharp
// The "before": custom routing loop, Microsoft.Agents.AI 1.17.0, .NET 10
List<ChatMessage> history = [];
string current = "triage";

while (true)
{
    Console.Write("> ");
    string input = Console.ReadLine() ?? string.Empty;
    history.Add(new ChatMessage(ChatRole.User, input));

    ChatResponse routing = await chatClient.GetResponseAsync(
    [
        new ChatMessage(ChatRole.System,
            "Reply with exactly one of: triage, refunds, shipping. No other text."),
        .. history,
    ]);

    string picked = routing.Text.Trim().ToLowerInvariant();
    if (specialists.ContainsKey(picked))
    {
        current = picked;
    }

    AgentResponse answer = await specialists[current].RunAsync(history);
    history.AddRange(answer.Messages);
    Console.WriteLine(answer.Text);
}
```

Four things are structurally wrong with it, and they are the reason to migrate rather than to keep patching:

- **Routing costs an extra model round trip per turn**, and the classifier sees the same history as the agent that just answered. You are paying twice for one decision.
- **The routing decision is a string.** `routing.Text` is free-form, so `if (specialists.ContainsKey(picked))` silently falls through to the previous agent whenever the classifier answers "Refunds." with a trailing period, or explains its reasoning.
- **There is no pause point.** A refund tool call executes the moment the agent decides to call it. Adding approval means restructuring the loop around a state machine you now own.
- **History is append-only and unfiltered.** Every agent sees every other agent's tool calls, which is exactly the noise that makes a specialist start narrating the routing mechanics back to the user.

## What handoff orchestration replaces it with

Handoff is a mesh with no orchestrator. Each agent gets handoff tools injected onto it based on the edges you declare, and the framework detects the handoff tool call, filters the plumbing out of the history, and transfers full ownership of the conversation to the target. The Microsoft docs are blunt about the distinction from agent-as-tools: with tools, "the primary agent retains overall responsibility"; with handoff, the receiving agent owns the task. If you have not picked a pattern yet, the [comparison of sequential, concurrent, group chat, handoff and magentic](/2026/07/agent-framework-orchestration-patterns-compared/) covers that fork first.

## What breaks

| Area | Change | Severity |
| --- | --- | --- |
| Agent identity | Handoff tools are named `handoff_to_<agent_id>`, so every agent needs a stable, unique `Id` | high |
| Agent metadata | `Build()` throws if a target agent has no `Description`, `Name`, or instructions | high |
| Routing prompt | The classifier call and its system prompt are deleted, not ported | high |
| Conversation state | The workflow owns history; your `List<ChatMessage>` becomes a per-turn delta | high |
| Control flow | The run pauses for user input whenever an agent answers without handing off | medium |
| Tool approval | Approval moves from your loop onto the tool via `ApprovalRequiredAIFunction` | medium |
| Agent type | Participants must support local tool execution; server-side tool execution is out | medium |
| Observability | Per-agent output arrives as workflow events, not as return values | low |

## Pre-flight checklist

- .NET 8, 9, or 10 (the package also targets .NET Standard 2.0 and .NET Framework 4.7.2).
- `Microsoft.Agents.AI.Workflows` 1.17.0, which pulls `Microsoft.Agents.AI` 1.17.0 and `Microsoft.Extensions.AI` 10.7.0 or newer.
- A written list of every routing edge your classifier prompt currently encodes, including the implicit "stay on the current agent" case.
- The set of tool calls that today are irreversible (refunds, cancellations, writes). Those become approval-gated.
- A branch. This is not an incremental refactor; the loop and the builder cannot both own the conversation.

## Migration steps

1. **Pin the packages.** Run `dotnet add package Microsoft.Agents.AI.Workflows --version 1.17.0`. Verify with `dotnet list package` that `Microsoft.Agents.AI` resolved to 1.17.0 as well; a mismatched pair is the most common cause of a missing `AsAIAgent` overload.

2. **Give every agent a stable `Id`, `Name`, and `Description`.** The `Id` becomes part of the handoff tool name and part of the executor identity, so it must be a fixed logical role, never a request or user id. The `Description` becomes the handoff reason the model reads when choosing a target:

   ```csharp
   // Microsoft.Agents.AI.Workflows 1.17.0, .NET 10
   AIAgent refunds = chatClient.AsAIAgent(new ChatClientAgentOptions
   {
       Id = "refund-agent",                                        // -> handoff_to_refund-agent
       Name = "Refunds",
       Description = "Handles refund requests and returns.",       // -> the handoff reason
       ChatOptions = new() { Instructions = "You process refunds." },
   });
   ```

   Verify by building. If a target agent has no description, name, or instructions, `Build()` throws an `ArgumentException` telling you exactly which agent is unusable as a handoff target.

3. **Translate the classifier prompt into handoff edges.** Every branch of your old `switch` is one `WithHandoff` call. Delete the classifier prompt; do not port it:

   ```csharp
   // Microsoft.Agents.AI.Workflows 1.17.0, .NET 10
   HandoffWorkflowBuilder builder = AgentWorkflowBuilder.CreateHandoffBuilderWith(triage);

   builder.WithHandoffs(triage, [refunds, shipping]);                 // triage routes out
   builder.WithHandoffs([refunds, shipping], triage, "the customer changed topic");
   builder.WithHandoff(shipping, refunds, "the package was lost and needs a refund");
   builder.EnableReturnToPrevious();                                  // sticky agent, like the old loop

   Workflow workflow = builder.Build();
   ```

   `EnableReturnToPrevious()` is the direct equivalent of the `current` variable in the old loop: without it, every fresh user turn re-enters through the coordinator. Verify by asserting `Build()` returns without throwing, then by watching the first run log a `handoff_to_` tool call instead of a routing completion.

4. **Replace the loop with a streaming run.** This is the step that trips people up. There are two ways to drive a handoff workflow, and they behave differently. `InProcessExecution.RunStreamingAsync(workflow, messages)` starts a fresh run seeded from a message list you own, which means you must merge the terminal output back into your own history each turn. `InProcessExecution.OpenStreamingAsync(workflow)` opens one long-lived run that owns the conversation, and you feed it user turns:

   ```csharp
   // Microsoft.Agents.AI.Workflows 1.17.0, .NET 10
   await using StreamingRun run = await InProcessExecution.OpenStreamingAsync(workflow);

   await run.TrySendMessageAsync("Where is order 1234?");
   await run.TrySendMessageAsync(new TurnToken(emitEvents: true)); // agents cache input; the token starts the turn

   await foreach (WorkflowEvent evt in run.WatchStreamAsync())
   {
       switch (evt)
       {
           case AgentResponseUpdateEvent update:
               Console.Write($"{update.Update.AuthorName}: {update.Update.Text}");
               break;
           case WorkflowErrorEvent error:
               Console.WriteLine(error.Exception);
               break;
           case WorkflowOutputEvent output:
               List<ChatMessage> newMessages = output.As<List<ChatMessage>>()!;
               break;
       }
   }
   ```

   The `TurnToken` is not optional. Agents are wrapped in executors that cache incoming messages and only run when they receive one. Verify by confirming that `update.Update.AuthorName` changes mid-turn when a handoff happens: that is the mesh working.

5. **Choose interactive or autonomous.** By default the workflow yields control back to you whenever an agent responds without handing off, which is right for a chat UI and wrong for a batch job. For unattended runs, enable autonomous mode and always pair it with a termination condition:

   ```csharp
   // Microsoft.Agents.AI.Workflows 1.17.0, .NET 10
   builder.WithAutonomousMode(
       turnLimit: 6,                                     // default is 50
       continuationPrompt: "Continue without the customer.",
       agents: [triage],                                 // allow-list; omit to enable for all
       agentTurnLimits: new Dictionary<AIAgent, int> { [triage] = 3 });

   builder.WithTerminationCondition(c => c.Any(m => m.Text?.Contains("RESOLVED") == true));
   ```

   Verify with a scripted conversation that never says the magic word: the run must stop at the turn limit rather than looping. The default continuation prompt tells the agent the user did not respond and to keep going autonomously, which is a sentence your agents' instructions should be able to handle.

6. **Move approval gates onto the tools.** Approval stops being loop logic. Wrap the irreversible function and handle the pause in the same event loop you already wrote:

   ```csharp
   // Microsoft.Agents.AI.Workflows 1.17.0, .NET 10
   ChatOptions = new()
   {
       Tools = [new ApprovalRequiredAIFunction(AIFunctionFactory.Create(ProcessRefund))],
   }
   ```

   ```csharp
   case RequestInfoEvent request
       when request.Request.TryGetDataAs(out ToolApprovalRequestContent? approval):
       var call = (FunctionCallContent)approval.ToolCall;
       Console.Write($"Approve {call.Name}? (y/n): ");
       bool ok = (Console.ReadLine() ?? "n").Trim()
           .Equals("y", StringComparison.OrdinalIgnoreCase);
       await run.SendResponseAsync(request.Request.CreateResponse(approval.CreateResponse(ok)));
       break;
   ```

   Verify by denying an approval and confirming the agent recovers and tells the user, rather than retrying the call. The mechanics are the same as in any other orchestration, covered in more depth in the walkthrough of [human-in-the-loop tool approval in C#](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/).

## The smoke test after the cutover

Run these five before you delete the old loop:

- **Routing parity.** Replay 20 real user turns and compare the agent that answered against the old classifier's pick. Disagreements are usually the framework being right and the classifier having been fooled by a trailing period.
- **Handoff hygiene.** Grep the transcript for "handoff", "transfer", and your agent ids. If a specialist narrates the routing to the user, the default handoff instructions were overwritten or the tool filtering behavior was changed.
- **Approval gate.** Trigger the sensitive tool and confirm the workflow pauses with a `RequestInfoEvent` before anything executes.
- **Turn cap.** With autonomous mode on, confirm a conversation that never terminates stops at the turn limit.
- **Token delta.** Compare per-turn input tokens against the old build. Losing the classifier round trip should show up as a measurable drop; if it does not, you are probably rebuilding the workflow per turn and re-sending history.

## Rollback plan

This one is genuinely reversible, and cheaply, because the migration does not touch the agents themselves: `ChatClientAgentOptions`, instructions, and tools are unchanged, and the extra `Id` and `Description` are inert in the old code path. Keep the old loop behind a feature flag for one release and both paths can run against the same agent registry. The only thing you cannot roll back is an in-flight run: a checkpointed handoff workflow's state has no representation in the hand-rolled loop, so drain before flipping back.

## Gotchas we hit

**The handoff tool is named after the `Id`, not the `Name`.** The constant is `HandoffWorkflowBuilderCore<T>.FunctionPrefix`, which is `handoff_to_`, and the full name is `handoff_to_<agent_id>`. If your routing analytics parse tool names, they will now see `handoff_to_refund-agent`, not `Refunds`. Pick ids you can live with in logs forever, since changing one changes the executor identity and invalidates existing checkpoints.

**Registering the same edge twice throws.** `WithHandoff(a, b)` after `WithHandoffs(a, [b, c])` raises an `InvalidOperationException` about the handoff already being registered. This bites when you translate a classifier prompt mechanically, because prompts usually list the same route more than once.

**No explicit edges means a full mesh.** If you only call `AddParticipants` and never `WithHandoff`, every participant is wired to hand off to every other participant. That is a reasonable default for a support bot and a terrible one for a system where a specialist must never reach the refund agent directly.

**Tool content is not broadcast.** Participants broadcast their responses to each other to keep context in sync, but tool calls and tool results are not part of that broadcast. A specialist that looks up an order and hands off does not carry the lookup result forward as a tool message; if the next agent needs the data, the answer must state it in prose.

**Filtering is configurable and defaults to handoff-only.** `WithToolCallFilteringBehavior(HandoffToolCallFilteringBehavior.All)` strips every function call and tool result from the history flowing between agents, not just the handoff plumbing. Use it when specialists' tools are noisy or sensitive; the default `HandoffOnly` keeps external tool calls visible.

**Autonomous turn counters reset more often than you think.** The per-agent counter resets when the agent hands off, when its autonomous loop ends, and at the start of every fresh user turn. An agent that loops twice, hands off, and later regains control starts again from zero, so `turnLimit` is a per-agent-per-turn cap, not a budget for the whole conversation. That is the number to watch when you [put spend limits around an agent](/2026/06/policy-enforcement-and-audit-logging-for-a-microsoft-agent-framework-agent/).

**Handoff needs local tool execution.** The docs restrict handoff orchestration to agents that execute tools locally, which rules out participants whose tool calls are resolved server-side. Check this before you plan the migration, not after.

If you are coming from an older stack rather than a bespoke loop, the same destination is reachable from [Semantic Kernel via the 1.0 migration checklist](/2026/07/migrate-a-semantic-kernel-app-to-microsoft-agent-framework-1-0/), and once the workflow exists you can decide whether to keep it in C# or express it as YAML, which the [declarative versus code-first breakdown](/2026/08/agent-framework-declarative-yaml-vs-code-first-orchestration/) settles. For long-running support conversations, the next step after this migration is usually [checkpointing the workflow so it survives a restart](/2026/05/agent-framework-durable-workflows-checkpoint-restart/), which is precisely why step 2 insists on stable agent ids.

## Sources

- [Handoff orchestration](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff) on Microsoft Learn, including context synchronization and the `HandoffAgentExecutor` responsibilities.
- [`HandoffWorkflowBuilder.cs`](https://github.com/microsoft/agent-framework/blob/main/dotnet/src/Microsoft.Agents.AI.Workflows/HandoffWorkflowBuilder.cs) in the agent-framework repository, the source for `FunctionPrefix`, default handoff instructions, and autonomous-mode semantics.
- [The Handoff sample](https://github.com/microsoft/agent-framework/tree/main/dotnet/samples/03-workflows/Orchestration/Handoff), which is where the stable-agent-id guidance and `OpenStreamingAsync` pattern come from.
- [Microsoft.Agents.AI.Workflows on NuGet](https://www.nuget.org/packages/Microsoft.Agents.AI.Workflows), for the 1.17.0 release date and dependency set.
