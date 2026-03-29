---
title: "Generative AI for Beginners .NET v2: Rebuilt for .NET 10 with Microsoft.Extensions.AI"
description: "Microsoft's free generative AI course for .NET developers ships Version 2, rebuilt for .NET 10 and migrated from Semantic Kernel to Microsoft.Extensions.AI's IChatClient pattern."
pubDate: 2026-03-29
tags:
  - "dotnet"
  - "dotnet-10"
  - "ai"
  - "microsoft-extensions-ai"
  - "generative-ai"
---

Microsoft has updated [Generative AI for Beginners .NET](https://aka.ms/genainet) to Version 2. The course is free, open-source, and now rebuilt entirely for .NET 10 with a significant architectural change: Semantic Kernel is out as the primary abstraction, replaced by [Microsoft.Extensions.AI](https://learn.microsoft.com/en-us/dotnet/ai/microsoft-extensions-ai) (MEAI).

## The Shift to Microsoft.Extensions.AI

Version 1 leaned on Semantic Kernel for orchestration and model access. Version 2 standardizes on MEAI's `IChatClient` interface, which ships as part of .NET 10 and follows the same dependency injection conventions as `ILogger`.

The registration pattern will be familiar to any .NET developer:

```csharp
var builder = Host.CreateApplicationBuilder();

// Register any IChatClient-compatible provider
builder.Services.AddChatClient(new OllamaChatClient("phi4"));

var app = builder.Build();
var client = app.Services.GetRequiredService<IChatClient>();

var response = await client.GetStreamingResponseAsync("What is AOT compilation?");
await foreach (var update in response)
    Console.Write(update.Text);
```

The interface is provider-agnostic. Swapping `OllamaChatClient` for an Azure OpenAI implementation requires changing a single line. The course uses this deliberately -- the skills transfer between providers rather than locking you into one vendor's SDK.

## What the Five Lessons Cover

The restructured curriculum runs in five self-contained lessons:

1. **Foundations** -- LLM mechanics, tokens, context windows, and how .NET 10 integrates with model APIs
2. **Core Techniques** -- Chat completions, prompt engineering, function calling, structured outputs, and RAG basics
3. **AI Patterns** -- Semantic search, retrieval-augmented generation, document processing pipelines
4. **Agents** -- Tool use, multi-agent orchestration, and Model Context Protocol (MCP) integration using .NET 10's built-in MCP client support
5. **Responsible AI** -- Bias detection, content safety APIs, and transparency guidelines

The agent lesson is particularly relevant if you have been following .NET 10's MCP support. The course connects multi-agent orchestration directly to that feature using the `Microsoft.Extensions.AI.Abstractions` MCP client, so you can run samples against local or remote MCP servers without framework gymnastics.

## Migrating from Version 1

The eleven Semantic Kernel samples from Version 1 are moved to a deprecated folder inside the repo -- they still run, but are no longer presented as the recommended pattern. If you worked through Version 1, the core concepts remain the same. The migration is mostly a swap at the API layer: replace Semantic Kernel's `Kernel` and `IKernelBuilder` with `IChatClient` and the standard `IServiceCollection` extensions.

The course repository is at [github.com/microsoft/generative-ai-for-beginners-dotnet](https://github.com/microsoft/generative-ai-for-beginners-dotnet). The course itself starts at [aka.ms/genainet](https://aka.ms/genainet).
