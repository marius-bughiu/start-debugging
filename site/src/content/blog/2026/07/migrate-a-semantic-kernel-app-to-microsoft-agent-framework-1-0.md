---
title: "Migrate a Semantic Kernel App to Microsoft Agent Framework 1.0"
description: "A step-by-step checklist for moving an existing Semantic Kernel 1.77 .NET app to Microsoft Agent Framework 1.13. Covers the Kernel-to-AIAgent rewrite, plugins-to-tools, thread-to-session, the KernelFunction compatibility bridge, DI changes, and the gotchas that bite mid-cutover."
pubDate: 2026-07-07
updatedDate: 2026-07-07
template: migration
tags:
  - "migration"
  - "semantic-kernel"
  - "microsoft-agent-framework"
  - "ai-agents"
  - "llm"
  - "dotnet"
  - "csharp"
---

If you shipped a .NET agent on **Semantic Kernel** in 2025, you now own a codebase built around the `Kernel` object, `[KernelFunction]` plugins, and `ChatCompletionAgent`. Microsoft has put that stack into maintenance mode: **`Microsoft.SemanticKernel` 1.77.0** (released May 28, 2026) still gets critical bug and security fixes for at least a year past Agent Framework GA, but every new feature now lands in **`Microsoft.Agents.AI`**, which is at **1.13.0** as of July 3, 2026. This post is the migration checklist for moving an existing SK app to Agent Framework 1.x on **.NET 10 / C# 14**: what breaks, the exact API mapping, how to do it incrementally with the `KernelFunction` compatibility bridge, and how to verify each step. If you are deciding *whether* to move at all rather than *how*, read the [greenfield comparison first](/2026/06/microsoft-agent-framework-vs-semantic-kernel-for-a-greenfield-net-agent/); this post assumes you have already decided to migrate.

The short version: a small SK agent (one `Kernel`, a handful of plugins, one `ChatCompletionAgent`) is a half-day job because the concepts map one-to-one. The pain is not conceptual, it is mechanical: message and content types change from SK's `ChatMessageContent` to `Microsoft.Extensions.AI`, thread creation moves from the caller to the agent, and every DI registration that hung off `Kernel` needs to be re-pointed at `AIAgent`. None of it is a rewrite. Most of it is find-and-replace with a compiler at your back.

## Why move off Semantic Kernel now

Four concrete reasons, not marketing ones:

- **New features only ship on Agent Framework.** Provider connectors, orchestration patterns (sequential, concurrent, handoff, group chat, Magentic-One), middleware, and memory providers all land in `Microsoft.Agents.AI` first. Staying on SK means porting later anyway, on a worse schedule.
- **You drop the `Kernel` god-object.** In SK every agent must be wired through a built `Kernel`, even for a single call. Agent Framework creates an `AIAgent` directly off an `IChatClient`. Less ceremony, fewer moving parts in DI.
- **One type system end to end.** Agent Framework speaks `Microsoft.Extensions.AI` `ChatMessage` and `AIContent` types, the same abstraction the rest of the modern .NET AI stack standardized on. If your service already calls `IChatClient` for [tool calling](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/) anywhere, the agent layer stops being an island.
- **Multi-agent and durable workflows are in the box.** SK's agent orchestration never left an experimental shape. Agent Framework ships orchestration plus [durable checkpoint and restart](/2026/05/agent-framework-durable-workflows-checkpoint-restart/) so a long-running workflow survives a process recycle.

## What breaks

Here is the full breaking-change surface for a typical SK agent. Severity is how much hand-editing each area needs, not how hard it is to understand.

| Area | Semantic Kernel 1.77 | Agent Framework 1.13 | Severity |
| --- | --- | --- | --- |
| Namespaces | `Microsoft.SemanticKernel`, `.Agents` | `Microsoft.Agents.AI`, `Microsoft.Extensions.AI` | low |
| Core abstraction | `Kernel` + `ChatCompletionAgent` | `AIAgent` over `IChatClient` | high |
| Agent types | `ChatCompletionAgent`, `AzureAIAgent`, `OpenAIAssistantAgent` | single `ChatClientAgent` | medium |
| Tool registration | `[KernelFunction]` + plugin + add to `Kernel` | `AIFunctionFactory.Create(method)` | medium |
| Message / content types | `ChatMessageContent`, `StreamingChatMessageContent` | `ChatMessage`, `AIContent` (M.E.AI) | high |
| Thread creation | caller news up the thread subclass | `await agent.CreateSessionAsync()` | medium |
| Invocation | `InvokeAsync` returns `IAsyncEnumerable<...>` | `RunAsync` returns one `AgentResponse` | medium |
| Streaming | `InvokeStreamingAsync` -> `StreamingChatMessageContent` | `RunStreamingAsync` -> `AgentResponseUpdate` | medium |
| Options | `OpenAIPromptExecutionSettings` + `KernelArguments` | `ChatClientAgentRunOptions` | low |
| Dependency injection | `AddKernel()`, agent needs `Kernel` | `AddKeyedSingleton<AIAgent>(...)` | medium |

The two `high` rows (core abstraction and message types) are where the real work is. Everything else is mechanical.

## Pre-flight checklist

Before you touch a line of agent code:

1. **Target .NET 10.** Agent Framework 1.x targets .NET 10 (and .NET Standard 2.0 for the core library). Confirm your `<TargetFramework>` is `net10.0` and `dotnet --version` reports a 10.x SDK.
2. **Pin your current SK version** in a branch so rollback is a `git checkout` away. Note the exact `Microsoft.SemanticKernel` version in your `.csproj` (this guide assumes 1.77.0).
3. **Bump Semantic Kernel to 1.38 or higher** if you plan to use the compatibility bridge. The `KernelFunction`-as-tool path needs a version where `KernelFunction` derives from `Microsoft.Extensions.AI.AIFunction`; 1.77 is well past that line.
4. **Inventory your plugins.** List every `[KernelFunction]` method. Each one is either a straight port or a bridge candidate. This list is your migration work queue.
5. **Inventory hosted threads.** If you use `OpenAIAssistantAgent` or `AzureAIAgent` with server-side threads, note that Agent Framework has no `thread.DeleteAsync()`; you clean up via the provider SDK. Flag those call sites now.

## Migration steps

Do these in order. Each step ends with a verification you can actually run.

1. **Add the Agent Framework packages and namespaces.** Install `Microsoft.Agents.AI` (1.13.0) and the provider package you need, for example the OpenAI or Azure client that exposes an `IChatClient`. Swap the `using` directives at the top of your agent files.

   ```csharp
   // Before: Semantic Kernel 1.77
   using Microsoft.SemanticKernel;
   using Microsoft.SemanticKernel.Agents;
   using Microsoft.SemanticKernel.ChatCompletion;

   // After: Microsoft Agent Framework 1.13, .NET 10
   using Microsoft.Agents.AI;
   using Microsoft.Extensions.AI;
   ```

   Verify: `dotnet build` fails only on the SK-specific symbols you are about to replace, not on missing packages.

2. **Replace `Kernel` + `ChatCompletionAgent` with a single `AsAIAgent` call.** The `Kernel` builder, the plugin registration, and the agent constructor collapse into one extension call off your chat client.

   ```csharp
   // Before: Semantic Kernel 1.77
   Kernel kernel = Kernel.CreateBuilder()
       .AddOpenAIChatCompletion("gpt-4o-mini", apiKey)
       .Build();
   kernel.Plugins.AddFromType<WeatherTools>();

   ChatCompletionAgent agent = new()
   {
       Name = "Concierge",
       Instructions = "You are a concise travel concierge.",
       Kernel = kernel,
       Arguments = new(new OpenAIPromptExecutionSettings
       {
           FunctionChoiceBehavior = FunctionChoiceBehavior.Auto()
       })
   };

   // After: Microsoft Agent Framework 1.13
   AIAgent agent = new OpenAIClient(apiKey)
       .GetChatClient("gpt-4o-mini")
       .AsIChatClient()
       .AsAIAgent(
           instructions: "You are a concise travel concierge.",
           tools: [AIFunctionFactory.Create(WeatherTools.GetWeather)]);
   ```

   Note that `FunctionChoiceBehavior.Auto()` is gone: automatic tool calling is the default when you pass `tools`. Verify: the agent constructs without a `Kernel` reference anywhere in the file.

3. **Convert plugins to plain methods (or bridge them).** For a full rewrite, drop the `[KernelFunction]` attribute; a plain method with an optional `[Description]` is enough. This is the same tool-authoring model covered in [function tools in Agent Framework](/2026/05/microsoft-agent-framework-function-tools-inline-method-class/).

   ```csharp
   // Before
   public class WeatherTools
   {
       [KernelFunction, Description("Get the weather for a city")]
       public static string GetWeather(string city) => $"It is 21C and clear in {city}.";
   }

   // After: attribute optional, description optional
   public class WeatherTools
   {
       [Description("Get the weather for a city")]
       public static string GetWeather(string city) => $"It is 21C and clear in {city}.";
   }
   ```

   If you have dozens of plugins and cannot rewrite them all at once, use the compatibility bridge instead (see the next section) so the migration can land incrementally. Verify: the tool shows up in `agent.RunAsync` tool-call traces with the right name and schema.

4. **Move thread creation to the agent.** SK made the caller pick the thread subclass. Agent Framework asks the agent to create the session.

   ```csharp
   // Before
   AgentThread thread = new ChatHistoryAgentThread();

   // After
   AgentSession session = await agent.CreateSessionAsync();
   ```

   Verify: multi-turn conversations retain context across `RunAsync` calls when you pass the same `session`.

5. **Rewrite invocation from `InvokeAsync` to `RunAsync`.** SK's non-streaming call is an async iterator; Agent Framework returns a single `AgentResponse` whose `.Text` is the answer and whose `.Messages` holds the full transcript including tool calls.

   ```csharp
   // Before
   await foreach (AgentResponseItem<ChatMessageContent> item in
       agent.InvokeAsync("What should I pack for Lisbon?", thread))
   {
       Console.WriteLine(item.Message);
   }

   // After
   AgentResponse response = await agent.RunAsync("What should I pack for Lisbon?", session);
   Console.WriteLine(response.Text);
   ```

   Verify: `response.Text` is non-empty and `response.Messages` contains the tool-call and tool-result messages you expect.

6. **Rewrite streaming from `InvokeStreamingAsync` to `RunStreamingAsync`.** The pattern is the same async foreach, but the update type carries more agent context.

   ```csharp
   // Before
   await foreach (StreamingChatMessageContent update in
       agent.InvokeStreamingAsync(userInput, thread))
   {
       Console.Write(update);
   }

   // After
   await foreach (AgentResponseUpdate update in
       agent.RunStreamingAsync(userInput, session))
   {
       Console.Write(update); // ToString()-friendly; concatenate .Text for the full answer
   }
   ```

   Verify: tokens stream to the console and the concatenated `.Text` matches the non-streaming answer.

7. **Re-point dependency injection at `AIAgent`.** Delete `AddKernel()` and the `Kernel`-keyed registration. Register the `AIAgent` directly.

   ```csharp
   // Before
   services.AddKernel().AddOpenAIChatCompletion("gpt-4o-mini", apiKey);
   services.AddKeyedSingleton<Microsoft.SemanticKernel.Agents.Agent>("concierge",
       (sp, _) => new ChatCompletionAgent { Kernel = sp.GetRequiredService<Kernel>() });

   // After
   services.AddKeyedSingleton<AIAgent>("concierge", (sp, _) =>
       sp.GetRequiredService<IChatClient>()
         .AsAIAgent(instructions: "You are a concise travel concierge."));
   ```

   Verify: the app resolves the keyed `AIAgent` at startup and `dotnet test` passes on any DI smoke test you have.

8. **Migrate options.** Replace `OpenAIPromptExecutionSettings` wrapped in `KernelArguments` with `ChatClientAgentRunOptions`.

   ```csharp
   // Before
   var settings = new OpenAIPromptExecutionSettings { MaxTokens = 1000 };
   var options = new AgentInvokeOptions { KernelArguments = new(settings) };

   // After
   var options = new ChatClientAgentRunOptions(new() { MaxOutputTokens = 1000 });
   ```

   Verify: token limits and other inference options take effect (check a response that would otherwise overflow the old limit).

## The incremental path: bridge KernelFunction instead of rewriting

The single most useful fact for a large migration is that in current Semantic Kernel, **`KernelFunction` derives from `Microsoft.Extensions.AI.AIFunction`**. That means you do not have to rewrite every plugin before the app compiles on Agent Framework. You can reuse an existing `KernelFunction` as an Agent Framework tool directly, either by passing it straight into `tools:` or via the `.AsAIFunction()` extension.

```csharp
// Microsoft Agent Framework 1.13 + Semantic Kernel 1.77 side by side.
// Keep your existing plugin class untouched during the cutover.
KernelPlugin plugin = KernelPluginFactory.CreateFromType<WeatherTools>();

AIAgent agent = chatClient.AsAIAgent(
    instructions: "You are a concise travel concierge.",
    // KernelFunction is an AIFunction, so it drops straight into tools:
    tools: [.. plugin.Select(kf => kf.AsAIFunction())]);
```

This is the same "keep both frameworks in the process while you move" strategy as [turning an SK plugin into an MCP server](/2026/05/migrate-a-semantic-kernel-plugin-to-an-mcp-server/), except here the tool never leaves the process. Land the framework swap first with plugins bridged, get the app green, then rewrite plugins to plain methods one at a time in follow-up commits. Each rewrite is independently shippable and independently revertible.

## Verification: the smoke test after the cutover

Run this checklist once the build is green:

- **It builds:** `dotnet build` with zero warnings referencing `Microsoft.SemanticKernel` in migrated files.
- **Tools fire:** trigger a prompt that forces a tool call and confirm the tool name and arguments in `response.Messages`.
- **Multi-turn works:** two `RunAsync` calls with the same `AgentSession` retain context.
- **Streaming matches non-streaming:** the concatenated `RunStreamingAsync` text equals the `RunAsync` text for the same prompt.
- **DI resolves:** the app starts and every keyed `AIAgent` resolves.
- **No perf regression:** first-token latency and total tokens per turn are within noise of the SK baseline. Agent Framework removes object allocation overhead, so if anything expect a small improvement.

## Rollback plan

This migration is reversible per commit if you stage it right. Because the compatibility bridge lets both frameworks coexist, the safe sequence is: (1) framework swap with plugins bridged, (2) plugin rewrites, (3) SK package removal. Roll back by reverting the relevant commit. The one **one-way** door is removing the `Microsoft.SemanticKernel` package reference in step 3: do that only after every plugin is rewritten to a plain method and the SK smoke tests are deleted. Until then, keep the SK package installed even though the bridge is the only thing using it. If you deleted SK too early and need it back, it is a `dotnet add package Microsoft.SemanticKernel --version 1.77.0` away, but the point of staging is that you never have to.

## Gotchas we hit

- **`ChatMessageContent` leaks across your seams.** If any non-agent code path returns SK's `ChatMessageContent` (a logging helper, a DTO mapper, a RAG pipeline), it will not compile against the agent layer anymore. Agent Framework uses `Microsoft.Extensions.AI` `ChatMessage`. Grep for `ChatMessageContent` across the whole solution, not just the agent project, before you call the migration done.
- **Hosted-thread cleanup is now your job.** SK gave you `thread.DeleteAsync()`. Agent Framework's `AgentSession` has no deletion API because not every provider supports hosted threads. If you used `OpenAIAssistantAgent` or `AzureAIAgent` with server-side threads, you must track the session's `ConversationId` and delete it via the provider SDK, for example `await assistantClient.DeleteThreadAsync(session.ConversationId)`. Miss this and you leak server-side threads.
- **`FunctionChoiceBehavior.Auto()` has no direct replacement, and that is fine.** New migrators go looking for where to set it. There is nowhere: passing `tools` enables automatic function calling by default. Delete the setting, do not port it.
- **Agent type consolidation surprises code that switched on the concrete type.** If you had `if (agent is AzureAIAgent)` branches, they all collapse to `ChatClientAgent`. Provider differences move to how you build the `IChatClient`, not to the agent class. Audit any code that inspected the agent's runtime type.
- **The bridge needs SK >= 1.38.** If your legacy app is pinned to an older SK where `KernelFunction` is not yet an `AIFunction`, the `.AsAIFunction()` path does not exist. Bump SK to 1.77 as the very first move so both the bridge and your existing plugins keep working.

## Related

- [Microsoft Agent Framework vs Semantic Kernel for a greenfield .NET agent](/2026/06/microsoft-agent-framework-vs-semantic-kernel-for-a-greenfield-net-agent/) - the decision framework behind this migration.
- [Microsoft Agent Framework 1.0: AI agents in C#](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) - what shipped at GA and the `AIAgent` model.
- [How to migrate a Semantic Kernel plugin to an MCP server](/2026/05/migrate-a-semantic-kernel-plugin-to-an-mcp-server/) - the cross-tool alternative to bridging in-process.
- [Function tools in Agent Framework: inline, method, or class](/2026/05/microsoft-agent-framework-function-tools-inline-method-class/) - how to author the tools you rewrite in step 3.
- [Approving tool calls before they run](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/) - add human-in-the-loop gating once you are on the new API.

## Sources

- [Semantic Kernel to Microsoft Agent Framework Migration Guide](https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-semantic-kernel/) - the official C# API mapping every step above is based on.
- [Semantic Kernel and Microsoft Agent Framework](https://devblogs.microsoft.com/agent-framework/semantic-kernel-and-microsoft-agent-framework/) - the maintenance-mode and support-window commitment.
- [Transforming Semantic Kernel Functions](https://devblogs.microsoft.com/agent-framework/transforming-semantic-kernel-functions/) - the `KernelFunction` as `AIFunction` compatibility story.
- [Microsoft.Agents.AI on NuGet](https://www.nuget.org/packages/Microsoft.Agents.AI/) (1.13.0) and [Microsoft.SemanticKernel on NuGet](https://www.nuget.org/packages/Microsoft.SemanticKernel/) (1.77.0) - current package versions.
