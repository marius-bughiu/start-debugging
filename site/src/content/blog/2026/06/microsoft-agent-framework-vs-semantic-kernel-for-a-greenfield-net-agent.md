---
title: "Microsoft Agent Framework vs Semantic Kernel for a Greenfield .NET Agent"
description: "For a new .NET agent in 2026, start on Microsoft Agent Framework 1.0. Semantic Kernel is in maintenance mode. Here is the side-by-side and the one case where SK still wins."
pubDate: 2026-06-06
template: vs
tags:
  - "comparison"
  - "microsoft-agent-framework"
  - "semantic-kernel"
  - "ai-agents"
  - "llm"
  - "dotnet"
  - "csharp"
---

If you are starting a brand-new .NET agent today and want the one-line answer: build it on **[Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/)** (`Microsoft.Agents.AI`, currently 1.7.0 on NuGet, GA'd April 3, 2026), not Semantic Kernel. Microsoft's own product team says the same thing in plain words: "If you are starting a new project and can wait until Microsoft Agent Framework reaches General Availability before shipping, we recommend starting with Microsoft Agent Framework." That release happened, so the qualifier is gone. Semantic Kernel (`Microsoft.SemanticKernel` 1.77.0 as of late May 2026) is still shipping and still supported, but it is now the legacy track: critical bugs and security fixes only, with the majority of new features going to Agent Framework. The rest of this post is why that is the right call for greenfield, the exact code differences you will hit on day one, and the one scenario where reaching for Semantic Kernel is still defensible.

## Why this is even a question

The confusing part is that both libraries come from the same team at Microsoft, both target .NET 10 and Python, and both let you build a tool-calling agent over OpenAI, Azure OpenAI, Anthropic, Bedrock, Gemini, or Ollama. They are not competitors in the usual sense. Microsoft's framing is blunt: "Think of Microsoft Agent Framework as Semantic Kernel v2.0 (it's built by the same team!)." Agent Framework folds in the enterprise plumbing that made Semantic Kernel useful and the multi-agent orchestration patterns that came out of AutoGen, then drops the `Kernel` god-object that every Semantic Kernel agent had to be wired through. If you have followed [what shipped in Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/), the headline is that the AutoGen/Semantic Kernel split is over and there is now one SDK.

So the real question is not "which is better" in the abstract. For a greenfield project, it is "is there any reason to start on the framework Microsoft has explicitly put into maintenance mode?" Usually the answer is no.

## The matrix that decides it

| Dimension | [Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) | Semantic Kernel 1.77 |
| --- | --- | --- |
| NuGet package | `Microsoft.Agents.AI` (1.7.0) | `Microsoft.SemanticKernel` (1.77.0) |
| Status (June 2026) | active, all new features | maintenance: critical bugs + security only |
| Core abstraction | `AIAgent` over `IChatClient` | `Kernel` + `ChatCompletionAgent` |
| Agent creation | one extension call, no container object | requires a built `Kernel` instance |
| Agent types | one `ChatClientAgent` for all providers | `ChatCompletionAgent`, `AzureAIAgent`, `OpenAIAssistantAgent`, ... |
| Tool registration | pass a method to `tools:`, no attribute | `[KernelFunction]` + plugin + add to `Kernel` |
| Invocation | `RunAsync` returns one `AgentResponse` | `InvokeAsync` returns an `IAsyncEnumerable` |
| Thread/session | `agent.CreateSessionAsync()` | caller picks the thread subclass manually |
| Message types | `Microsoft.Extensions.AI` (shared) | Semantic Kernel's own `ChatMessageContent` |
| Multi-agent | sequential, concurrent, handoff, group chat, Magentic-One | handoff via experimental agent orchestration |
| Long-term support | yes, GA stability commitment | at least 1 year past Agent Framework GA |

Read it top to bottom and the decision makes itself on the status row. You do not start a multi-year project on the library whose own maintainers are routing new work elsewhere. Everything below the status row is just Agent Framework removing boilerplate that Semantic Kernel made mandatory.

## The same agent, written both ways

The fastest way to feel the difference is to write a trivial tool-calling agent in each. Here is Semantic Kernel. Notice how much of the code is ceremony around the `Kernel`:

```csharp
// Semantic Kernel 1.77, .NET 10, Microsoft.SemanticKernel + .Agents.Core
using Microsoft.SemanticKernel;
using Microsoft.SemanticKernel.Agents;
using Microsoft.SemanticKernel.ChatCompletion;

// A tool has to be a [KernelFunction] inside a plugin class.
public class WeatherTools
{
    [KernelFunction, System.ComponentModel.Description("Get the weather for a city")]
    public static string GetWeather(string city) => $"It is 21C and clear in {city}.";
}

// You cannot make an agent without a Kernel, even for one call.
Kernel kernel = Kernel.CreateBuilder()
    .AddOpenAIChatCompletion("gpt-4o-mini", "your-api-key")
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

AgentThread thread = new ChatHistoryAgentThread();
await foreach (var item in agent.InvokeAsync("What should I pack for Lisbon?", thread))
{
    Console.WriteLine(item.Message);
}
```

Four things are mandatory here that have nothing to do with your agent: building a `Kernel`, decorating the tool with `[KernelFunction]`, registering the plugin type on the kernel, and knowing that `ChatHistoryAgentThread` is the thread subclass you want. The same agent in Agent Framework drops all four:

```csharp
// Microsoft Agent Framework 1.0, .NET 10, Microsoft.Agents.AI
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;

// A tool is just a method. Description is optional.
[System.ComponentModel.Description("Get the weather for a city")]
static string GetWeather(string city) => $"It is 21C and clear in {city}.";

AIAgent agent = new OpenAIClient("your-api-key")
    .GetChatClient("gpt-4o-mini")
    .AsIChatClient()
    .CreateAIAgent(
        instructions: "You are a concise travel concierge.",
        tools: [AIFunctionFactory.Create(GetWeather)]);

AgentResponse response = await agent.RunAsync("What should I pack for Lisbon?");
Console.WriteLine(response.Text);
```

There is no `Kernel`. The tool is a plain static method wrapped by `AIFunctionFactory.Create`, the same factory you would use when [adding tool calling to a raw Microsoft.Extensions.AI chat client](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/). `RunAsync` returns a single `AgentResponse` whose `.Text` is the answer and whose `.Messages` holds the full transcript including tool calls. If you want to manage conversation history across turns, `await agent.CreateSessionAsync()` gives you a session and you pass it to `RunAsync`. The framework picks the right session implementation for the provider so you never new-up a thread subclass by hand.

## When to pick Microsoft Agent Framework

For a greenfield .NET agent in 2026, this is the default, and these are the concrete reasons:

- **You want the framework that gets new features.** Provider connectors, orchestration patterns, middleware, and memory providers are all landing in `Microsoft.Agents.AI` first. Starting on Semantic Kernel means watching features arrive elsewhere and porting later anyway.
- **You are building multi-agent workflows.** Sequential, concurrent, handoff, group chat, and Magentic-One orchestration ship in the box, along with [durable checkpoint and restart](/2026/05/agent-framework-durable-workflows-checkpoint-restart/) so a long-running workflow survives a process recycle. Semantic Kernel's agent orchestration never left an experimental shape.
- **You care about the type system underneath.** Agent Framework speaks `Microsoft.Extensions.AI` message and content types end to end, so the agent layer and the raw `IChatClient` layer share one type system. There is no impedance mismatch between "calling a model" and "running an agent."
- **You need human-in-the-loop approval.** Tool-call gating is a first-class middleware concern, covered in [approving tool calls before they run](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/), rather than something you bolt on around `InvokeAsync`.

## When Semantic Kernel is still the right call

Not never. There is one honest scenario and a couple of soft ones:

- **You are extending an existing Semantic Kernel codebase.** If the agent is a new feature inside an app already built on `Kernel`, plugins, and prompt templates, do not rewrite. Microsoft commits to "address critical bugs, security issues" and support Semantic Kernel for "at least one year after Agent Framework reaches General Availability." Add the feature in SK and migrate the whole thing on its own schedule. The compatibility layer even lets a `KernelFunction` be reused as an Agent Framework tool when you do migrate.
- **You depend on a Semantic Kernel feature that has not reached Agent Framework GA yet.** During the preview window Microsoft warned that "there may be some features that are only available in one language or the other at first." That gap is closing fast, but if a specific connector or vector-store integration you need exists only in SK today, that is a real reason to start there and plan the move.
- **Your team has deep SK muscle memory and a hard deadline.** "If you need to ship something quickly, it is perfectly fine to use Semantic Kernel." Shipping on the framework your team already knows beats learning a new API under deadline pressure. This is a schedule decision, not an architecture one, and you should still plan the migration.

None of these apply to a true greenfield project with no deadline gun to your head. That is exactly the case Microsoft points at Agent Framework.

## The gotcha that quietly picks for you

The decision often gets made by a detail nobody puts in the comparison table: **message and content types.** Semantic Kernel uses its own `ChatMessageContent` and `StreamingChatMessageContent` hierarchy. Agent Framework uses the `ChatMessage` and `AIContent` types from `Microsoft.Extensions.AI`, the same abstraction layer that the rest of the modern .NET AI stack standardized on. If your service already calls `IChatClient` anywhere, returns `Microsoft.Extensions.AI` types from a RAG pipeline, or shares DTOs with a non-agent code path, Agent Framework slots in with zero adapter code and Semantic Kernel forces a translation boundary at every seam.

Dependency injection makes the same point. Semantic Kernel needs a `Kernel` registered in the container before any agent can be constructed:

```csharp
// Semantic Kernel: the Kernel registration is mandatory.
services.AddKernel().AddOpenAIChatCompletion("gpt-4o-mini", apiKey);
services.AddKeyedSingleton<Agent>("concierge", (sp, _) =>
    new ChatCompletionAgent { Kernel = sp.GetRequiredService<Kernel>() });
```

Agent Framework registers the agent directly, because there is no intermediate object it has to hang off:

```csharp
// Agent Framework: register the AIAgent itself.
services.AddKeyedSingleton<AIAgent>("concierge", (sp, _) =>
    sp.GetRequiredService<IChatClient>()
      .CreateAIAgent(instructions: "You are a concise travel concierge."));
```

Across a real app those small removals compound. The plugin-versus-method difference alone is the subject of a whole post on [function tools in Agent Framework](/2026/05/microsoft-agent-framework-function-tools-inline-method-class/), and the pattern there, a plain method with an optional `[Description]`, is the one you will reach for ninety percent of the time.

## Restating the call

For a greenfield .NET agent in 2026, build on **Microsoft Agent Framework 1.0**. It is GA, it is where every new feature lands, it removes the `Kernel` ceremony Semantic Kernel required, and it shares the `Microsoft.Extensions.AI` type system with the rest of your stack so the agent is not an island. Reach for **Semantic Kernel** only when you are extending an existing SK app, when you need a feature that has not crossed to Agent Framework GA yet, or when a deadline makes "the API my team already knows" the pragmatic choice. In all three cases you are choosing SK as a temporary measure and planning the migration, which is itself the strongest argument for not starting there. If you already have Semantic Kernel plugins, the smoothest first step is often [turning one into an MCP server](/2026/05/migrate-a-semantic-kernel-plugin-to-an-mcp-server/) so it works from either framework while you move.

## Sources

- [Semantic Kernel and Microsoft Agent Framework](https://devblogs.microsoft.com/agent-framework/semantic-kernel-and-microsoft-agent-framework/) - Microsoft's official "which one, when" guidance and support commitment.
- [Microsoft Agent Framework Version 1.0](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/) - the 1.0 GA announcement, April 3, 2026.
- [Semantic Kernel to Microsoft Agent Framework Migration Guide](https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-semantic-kernel/) - the C# API mapping the code samples above are based on.
- [Microsoft Agent Framework overview](https://learn.microsoft.com/en-us/agent-framework/overview/) - conceptual overview of `AIAgent`, `ChatClientAgent`, and orchestration.
- [Microsoft.Agents.AI on NuGet](https://www.nuget.org/packages/Microsoft.Agents.AI/) and [Microsoft.SemanticKernel on NuGet](https://www.nuget.org/packages/Microsoft.SemanticKernel/) - current package versions.
