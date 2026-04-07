---
title: "Microsoft Agent Framework 1.0: Building AI Agents in Pure C#"
description: "Microsoft Agent Framework hits 1.0 with stable APIs, multi-provider connectors, multi-agent orchestration, and A2A/MCP interop. Here is what it looks like in practice on .NET 10."
pubDate: 2026-04-07
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "ai"
  - "microsoft-agent-framework"
---

Microsoft shipped [Agent Framework 1.0](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/) on April 3, 2026, for both .NET and Python. This is the production-ready release: stable APIs, long-term support commitment, and a clear upgrade path from the preview that landed earlier this year.

Agent Framework unifies the enterprise plumbing of Semantic Kernel with the multi-agent orchestration patterns from AutoGen into a single framework. If you have been tracking those two projects separately, that split is over.

## What ships in the box

The 1.0 release covers five areas that previously required stitching multiple libraries together:

First-party **service connectors** for Azure OpenAI, OpenAI, Anthropic Claude, Amazon Bedrock, Google Gemini, and Ollama. Swapping providers is a one-line change because every connector implements `IChatClient` from `Microsoft.Extensions.AI`.

**Multi-agent orchestration** patterns lifted from Microsoft Research and AutoGen: sequential, concurrent, handoff, group chat, and Magentic-One. These are not toy demos, they are the same patterns the AutoGen team validated in research settings.

**MCP support** lets agents discover and invoke tools exposed by any Model Context Protocol server. **A2A (Agent-to-Agent)** protocol support goes further, enabling agents running in different frameworks or runtimes to coordinate through structured messaging.

A **middleware pipeline** for intercepting and transforming agent behavior at every execution stage, plus pluggable **memory providers** for conversation history, key-value state, and vector retrieval.

## A minimal agent in five lines

The fastest path from zero to a running agent:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;

AIAgent agent = new OpenAIClient("your-api-key")
    .GetChatClient("gpt-4o-mini")
    .AsIChatClient()
    .CreateAIAgent(
        instructions: "You are a senior .NET architect. Be concise and production-focused.");

var response = await agent.RunAsync("Design a retry policy for transient SQL failures.");
Console.WriteLine(response);
```

`AsIChatClient()` bridges the OpenAI client to the `IChatClient` abstraction. `CreateAIAgent()` wraps it with instruction context, tool registration, and conversation threading. Replace `OpenAIClient` with any other supported connector and the rest of the code stays identical.

## Adding tools

Agents become useful when they can call your code. Register tools with `AIFunctionFactory`:

```csharp
using Microsoft.Agents.AI;

var tools = new[]
{
    AIFunctionFactory.Create((string query) =>
    {
        // search your internal docs, database, etc.
        return $"Results for: {query}";
    }, "search_docs", "Search internal documentation")
};

AIAgent agent = chatClient.CreateAIAgent(
    instructions: "Use search_docs to answer questions from internal docs.",
    tools: tools);
```

The framework handles tool discovery, schema generation, and invocation automatically. MCP-exposed tools work the same way, the agent resolves them at runtime from any MCP-compliant server.

## Why this matters now

Before 1.0, building a .NET agent meant choosing between Semantic Kernel (good enterprise integration, limited orchestration) or AutoGen (powerful multi-agent patterns, rougher .NET story). Agent Framework removes that choice. One package, one programming model, production-ready.

The NuGet packages are `Microsoft.Agents.AI` for the core and `Microsoft.Agents.AI.OpenAI` (or the provider-specific variant) for connectors. Install with:

```bash
dotnet add package Microsoft.Agents.AI.OpenAI
```

Full documentation and samples are on [GitHub](https://github.com/microsoft/agent-framework) and [Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/overview/).
