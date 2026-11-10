---
title: "Agent Framework 1.28: A2A Hosting Returns Messages Only, and A2AAgent Takes an Options Object"
description: "Microsoft Agent Framework for .NET 1.28.0 removes A2AServerRegistrationOptions.AgentRunMode, so hosted A2A agents always answer with a message, and replaces the id/name/description overloads on A2AAgent and AsAIAgent with A2AAgentOptions. Here is what breaks and how to migrate."
pubDate: 2026-11-10
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "a2a"
---

Microsoft Agent Framework for .NET [1.28.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.28.0) shipped on November 6, 2026 with another batch of breaking changes, a week after [1.27 locked down redirects in declarative workflows](/2026/11/agent-framework-1-27-redirects-can-no-longer-switch-the-http-client/). Two of them hit anyone using the A2A (Agent2Agent) integration: one on the server side, one on the client side. Both remove public API, so the compiler flags them on upgrade, but the server change also alters what clients get back on the wire.

## Hosted A2A agents no longer return tasks

Until 1.27, `A2AServerRegistrationOptions` had an `AgentRunMode` property. Setting it to `AgentRunMode.ReturnTask` made the built-in handler answer with an A2A task that a client could later poll, resume, or cancel. [PR #10037](https://github.com/microsoft/agent-framework/pull/10037) deletes that property. The default registration now always constructs its handler with `AgentRunMode.ReturnMessage`: the agent runs to completion and the response is a single message.

The reasoning in the PR is about multi-host deployments. Returning a task is only half the contract; the client must be able to continue it later, and that follow-up request can land on a different instance. The framework cannot do that reliably yet, so the team pulled the feature instead of shipping half of it. Note that `A2AServerRegistrationOptions` was already marked `[Experimental]`, which is how this lands in a minor version.

```csharp
// Agent Framework 1.27: compiled, returned an A2A task
builder.AddA2AServer(agent, (A2AServerRegistrationOptions options) =>
    options.AgentRunMode = AgentRunMode.ReturnTask);

// Agent Framework 1.28.0: the property is gone, delete the assignment
builder.AddA2AServer(agent);
```

The runtime side matters too. If a client sends a continuation for an existing task, or calls cancel, the message-only handler now throws `A2AException` with `A2AErrorCode.UnsupportedOperation` and the message "Task resumption is not supported by the message-only handler." (or "Task cancellation..."). Clients that branched on a `Task` payload case need to read `SendMessageResponseCase.Message` instead. Even a request with `ReturnImmediately = true` gets the aggregated message once the run finishes. If you genuinely need tasks, the migration note is blunt: provide your own handler and own the task lifecycle.

## A2AAgent identity moves into A2AAgentOptions

On the client side, [PR #10113](https://github.com/microsoft/agent-framework/pull/10113) removes the overloads that took `id`, `name`, and `description` as separate parameters, both on the `A2AAgent` constructor and on `IA2AClient.AsAIAgent`. The remaining overloads take an optional `A2AAgentOptions`:

```csharp
// Before 1.28.0
AIAgent remote = new A2AAgent(a2aClient, id: "lift", name: "LiftPlanner",
    description: "Plans crane lifts");
AIAgent viaExt = a2aClient.AsAIAgent(name: "LiftPlanner");

// 1.28.0
var options = new A2AAgentOptions
{
    Id = "lift",
    Name = "LiftPlanner",
    Description = "Plans crane lifts"
};
AIAgent remote = new A2AAgent(a2aClient, options);
AIAgent viaExt = a2aClient.AsAIAgent(options, loggerFactory);
```

The options parameter is now nullable, so `new A2AAgent(a2aClient)` and `a2aClient.AsAIAgent()` keep compiling and fall back to the base agent's defaults. Supplied options are cloned, so mutating the object after construction does not change the agent's name. `AgentCard.AsAIAgent(httpClient)` was rewritten internally to use the options object, so code that discovers agents from a card is unaffected.

## What else to check before bumping

The same release flips several other defaults: CodeAct redacts host-tool exception details unless `IncludeDetailedErrors = true`, the GitHub Copilot agent disables file hooks unless `EnableFileHooks = true`, and workflow spans are renamed from `workflow_invoke` to `invoke_workflow {name}` per the OpenTelemetry GenAI conventions. The A2A packages also move to `A2A` 1.0.0-preview4. Read the full [1.28.0 changelog](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.28.0) before you upgrade, because almost every section carries a `[BREAKING]` tag this time.
