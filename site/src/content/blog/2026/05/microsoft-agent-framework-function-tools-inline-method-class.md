---
title: "How to Author a Function Tool in the Microsoft Agent Framework: Inline, Method, or Class"
description: "If you came from Semantic Kernel looking for 'skills,' the Microsoft Agent Framework 1.0 calls them function tools and builds every one from AIFunctionFactory.Create. Here are the three ways to author one in C# -- an inline lambda, a named method, or a class of related tools -- plus what the declarative YAML 'file' approach can and cannot do."
pubDate: 2026-05-24
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "llm"
---

If you searched for "how to author a skill in the Microsoft Agent Framework," the short answer is that there is no `Skill` type. The Agent Framework 1.0 (GA April 2026) calls the unit of agent-callable code a **function tool**, and every one of them is built from a single factory: `AIFunctionFactory.Create` in `Microsoft.Extensions.AI`. You author one in C# three ways depending on state and reuse: an **inline lambda** for one-offs, a **named method** when the logic deserves a name and `[Description]` metadata, or a **class of related methods** when several tools share dependencies. There is also a declarative YAML "file" path, but it defines the agent, not the executable body of your tools. This post shows all four against Agent Framework 1.0 on .NET 11.

## Why "skill" is the wrong word here

The word "skill" is Semantic Kernel vocabulary. In SK you had plugins (originally "skills") whose functions came in two flavors: native functions written as C# methods with `[KernelFunction]`, and semantic functions defined in `skprompt.txt` files alongside a `config.json`. That file-vs-code split is exactly the mental model behind the "file vs inline C# vs class" question, and it does not survive the move to the Agent Framework.

The Agent Framework, which unifies Semantic Kernel and AutoGen into one model (covered in [Microsoft Agent Framework 1.0: Building AI Agents in Pure C#](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/)), drops the plugin/skill abstraction for code-level tools. A function tool is an `AIFunction`: a delegate plus the metadata an LLM needs to call it (name, description, and a JSON schema generated from the parameters). The same `AIFunction` type and the same `AIFunctionFactory.Create` you may already know from [adding tool calling to a Microsoft.Extensions.AI chat client](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/) are what the agent consumes. The Agent Framework just wires the invocation loop for you.

## The setup: one agent, any provider

Everything below attaches to an `AIAgent`. Build one from any connector that implements `IChatClient`. Here is OpenAI; swap `OpenAIClient` for the Anthropic or Azure connector and pass `claude-sonnet-4-6` or your Azure deployment name instead, the tool code does not change.

```csharp
// Microsoft Agent Framework 1.0, .NET 11
// dotnet add package Microsoft.Agents.AI.OpenAI
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;

IChatClient chat = new OpenAIClient("your-api-key")
    .GetChatClient("gpt-4o-mini")
    .AsIChatClient();
```

`AIFunctionFactory` lives in `Microsoft.Extensions.AI` (the `Microsoft.Extensions.AI.Abstractions` package), not in `Microsoft.Agents.AI`. You will reference both namespaces.

## Approach 1: the inline lambda

For a single tool whose body is a couple of lines, pass a lambda straight to `AIFunctionFactory.Create` and supply the name and description as arguments. The model needs both, so do not skip them on a lambda, an anonymous delegate has no useful name and no `[Description]` to fall back on.

```csharp
// Microsoft Agent Framework 1.0, .NET 11
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIAgent agent = chat.CreateAIAgent(
    instructions: "You answer questions about the weather.",
    tools:
    [
        AIFunctionFactory.Create(
            (string location) => $"The weather in {location} is 15C and cloudy.",
            name: "get_weather",
            description: "Get the current weather for a given location.")
    ]);

Console.WriteLine(await agent.RunAsync("What is it like in Amsterdam?"));
```

The `name` and `description` overloads are why the inline form works at all. Without them the factory falls back to the delegate's compiler-generated name (something like `<Main>b__0_0`), which tells the model nothing. Use inline tools for glue: a quick lookup, a format conversion, a stub during a spike. Once the body grows past a few lines or you want parameter-level descriptions, promote it to a method.

## Approach 2: a named method with [Description]

A named static or instance method is the form the official docs lead with, and it is the one to reach for most of the time. The method name becomes the tool name, and `System.ComponentModel.DescriptionAttribute` on the method and each parameter feeds the schema the model uses to decide when and how to call it.

```csharp
// Microsoft Agent Framework 1.0, .NET 11
using System.ComponentModel;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

[Description("Get the current weather for a given location.")]
static string GetWeather(
    [Description("City name, for example 'Amsterdam'.")] string location)
    => $"The weather in {location} is 15C and cloudy.";

AIAgent agent = chat.CreateAIAgent(
    instructions: "You answer weather questions. Use the provided tools.",
    tools: [ AIFunctionFactory.Create(GetWeather) ]);
```

No name string, no description string at the call site, the attributes carry them. This is the single biggest readability win over the lambda: the metadata sits next to the code it documents, and a parameter description like "City name, for example 'Amsterdam'" measurably improves how reliably the model fills the argument.

Real tools do I/O, so they are async. The framework awaits `Task<T>` and `ValueTask<T>` returns natively, no extra registration. It also binds a trailing `CancellationToken` for you and hides it from the schema the model sees, so the model never tries to supply one.

```csharp
// Microsoft Agent Framework 1.0, .NET 11
[Description("Look up the multi-day forecast for a location.")]
static async Task<string> GetForecastAsync(
    [Description("City name.")] string location,
    CancellationToken ct = default)
{
    using var http = new HttpClient();
    return await http.GetStringAsync(
        $"https://api.example.com/forecast?q={Uri.EscapeDataString(location)}", ct);
}

// Registers identically. The CancellationToken is bound by the framework,
// not exposed to the model.
var forecastTool = AIFunctionFactory.Create(GetForecastAsync);
```

## Approach 3: a class of related tools that share state

When several tools talk to the same dependency (a repository, an HTTP client, a feature flag), wrap them in a class and register the bound instance methods. The constructor holds the shared state, the methods stay focused on what the model should actually control, and you get dependency injection for free.

```csharp
// Microsoft Agent Framework 1.0, .NET 11
using System.ComponentModel;

public sealed class OrderTools(IOrderRepository repo)
{
    [Description("Look up an order by its ID and return its status.")]
    public async Task<string> GetOrderAsync(
        [Description("The order ID, for example 'ORD-1024'.")] string orderId)
    {
        var order = await repo.FindAsync(orderId);
        return order is null
            ? $"No order found with ID {orderId}."
            : $"{order.Id}: {order.Status}";
    }

    [Description("Cancel an order by its ID.")]
    public async Task<string> CancelOrderAsync(
        [Description("The order ID to cancel.")] string orderId)
    {
        await repo.CancelAsync(orderId);
        return $"Order {orderId} cancelled.";
    }
}
```

Registration passes the bound method group from a live instance. The `repo` dependency is captured once in the constructor, so neither the model nor the schema ever sees it.

```csharp
// Microsoft Agent Framework 1.0, .NET 11
var orderTools = new OrderTools(repo); // or resolve from your DI container

AIAgent agent = chat.CreateAIAgent(
    instructions: "Help users manage their orders. Confirm before cancelling.",
    tools:
    [
        AIFunctionFactory.Create(orderTools.GetOrderAsync),
        AIFunctionFactory.Create(orderTools.CancelOrderAsync),
    ]);
```

In a host with DI, resolve `OrderTools` from the container so its dependencies and their lifetimes are honored. The lifetime is the part that bites: if `IOrderRepository` is a scoped `DbContext` and you build the agent once as a singleton, you have captured a scoped service in a long-lived object, the same trap you would hit running [a Semantic Kernel plugin from a BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/). Build the tool instance (and the agent, if it is cheap) per scope or per run, or inject `IServiceScopeFactory` and open a scope inside each tool method.

Mutable instance fields are shared across every call the agent makes, including parallel tool calls within one turn. Keep per-call data in parameters and reserve fields for genuinely shared, thread-safe state.

## The declarative "file" approach, and its hard limit

This is where the Semantic Kernel instinct misleads people. You cannot drop a function tool's executable body into a file the way SK let you write a `skprompt.txt`. What the Agent Framework does support is a **declarative agent**: a YAML (or JSON) spec that defines the agent's identity, instructions, and model options, which you load with the declarative agent factory.

```yaml
# weather-agent.yaml -- Agent Framework declarative agent spec
kind: Prompt
name: WeatherAgent
description: Answers weather questions.
instructions: |
  You answer questions about the weather.
  Use the provided tools and never invent data.
model:
  options:
    temperature: 0.2
    top_p: 0.9
```

The win is that prompt, model, temperature, and orchestration topology become version-controlled config that a non-developer can review and tweak without a rebuild. The limit is just as important to state plainly: the YAML can declare built-in and hosted tools (web search, MCP servers, code interpreters) by reference, but a custom C# function tool has a body that has to run somewhere. That body stays in code. The declarative spec gives you the agent's shape, you still attach your `AIFunctionFactory.Create` tools in C# when you build it. So the honest answer to "file vs inline C# vs class" is that file-level declaration covers the agent and its hosted tools, while your own logic is always one of the three code forms above. See the [declarative agents documentation](https://learn.microsoft.com/en-us/agent-framework/agents/declarative) for the full schema and the loader API.

## Overriding names, schemas, and the gotchas that bite

A few behaviors are worth pinning down before you ship.

**Name and description resolution.** The factory resolves the tool name in this order: the explicit `name` argument, then the method name, then the delegate's generated name. The description resolves from the explicit `description` argument, then `[Description]` on the method, then empty. An empty description is the most common reason a model ignores a tool that is technically registered, always give it one.

**Schema generation.** `AIFunctionFactory.Create` introspects the parameter types and `[Description]` attributes to emit a JSON schema. Primitive parameters (string, int, bool, enums, simple DTOs) map cleanly. Deeply nested or polymorphic types produce schemas the model handles poorly, flatten the inputs or accept a string and parse it yourself. This is the same schema-fidelity issue behind a whole class of tool-call errors; if you see arguments arrive malformed, the schema, not the prompt, is usually the culprit.

**Gating dangerous tools.** A tool like `CancelOrderAsync` should not fire unsupervised. Wrap it so the agent pauses for confirmation, the pattern in [gating risky tool calls behind FunctionApprovalRequestContent](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/), rather than relying on the system prompt to ask politely.

**Tool count.** Every registered tool spends tokens describing itself and adds a choice the model can get wrong. A dozen sharply scoped tools beat thirty overlapping ones. If a class has grown a tool for every method, split it by capability and register only the set a given agent actually needs.

**From SK plugins.** If you are porting `[KernelFunction]` methods, the mechanical move is to strip the SK attribute, keep `[Description]`, and register through `AIFunctionFactory.Create`. If the goal is to expose them to other agents rather than embed them, the better path may be turning the plugin into a server, which is its own walkthrough in [migrating a Semantic Kernel plugin to an MCP server](/2026/05/migrate-a-semantic-kernel-plugin-to-an-mcp-server/).

Pick by lifetime and reuse, not by ceremony. Inline for throwaway glue, a named method the moment the logic earns a name, a class as soon as two tools share a dependency. All three compile down to the same `AIFunction`, so you can start inline and promote without rewriting the agent.

Sources:

- [Using function tools with an agent -- Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/agents/tools/function-tools)
- [Tools overview -- Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/agents/tools/)
- [Declarative agents -- Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/agents/declarative)
- [Microsoft Agent Framework version 1.0 -- DevBlogs](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/)
- [microsoft/agent-framework .NET samples -- GitHub](https://github.com/microsoft/agent-framework/tree/main/dotnet/samples)
