---
title: "Microsoft `mcp`: Wiring Model Context Protocol Servers from C# on .NET 10"
description: "How to wire Model Context Protocol (MCP) servers in C# on .NET 10 using microsoft/mcp. Covers tool contracts, input validation, auth, observability, and production-readiness patterns."
pubDate: 2026-01-10
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "mcp"
  - "ai-agents"
---
Today’s GitHub Trending (C#, daily) includes **`microsoft/mcp`**, Microsoft’s repo for Model Context Protocol (MCP). If you are building internal tools on **.NET 10** and you want a clean boundary between an LLM client and your real systems (files, tickets, databases, CI), MCP is the shape to watch.

Source: [microsoft/mcp](https://github.com/microsoft/mcp)

## The useful shift: tools become a contract, not ad-hoc glue

Most “AI integrations” start as ad-hoc glue code: prompt templates, a couple of HTTP calls, and a growing pile of “just one more tool”. The moment you need reliability, auditing, or a local developer story, you want a contract:

-   a discoverable set of tools,
-   typed inputs and outputs,
-   predictable transport,
-   logs you can reason about.

That is what MCP is aiming for: a protocol boundary so the client and server can evolve independently.

## A tiny MCP server shape in C# (what you will actually implement)

The exact API surface depends on which C# MCP library you pick (and it is still early). The server shape is stable though: define tools, validate inputs, execute, return structured output.

Here is a minimal C# 14 style example for .NET 10 showing the “contract first” approach. Treat it as a template for the shape of your handlers.

```cs
using System.Text.Json;

public static class CiTools
{
    public static string GetBuildStatus(JsonElement args)
    {
        if (!args.TryGetProperty("pipeline", out var pipelineProp) || pipelineProp.ValueKind != JsonValueKind.String)
            throw new ArgumentException("Missing required string argument: pipeline");

        var pipeline = pipelineProp.GetString()!;

        // Replace with your real implementation (Azure DevOps, GitHub, Jenkins).
        var status = new
        {
            pipeline,
            state = "green",
            lastRunUtc = DateTimeOffset.UtcNow.AddMinutes(-7),
        };

        return JsonSerializer.Serialize(status);
    }
}
```

The important parts are not the JSON parsing details. The important parts are:

-   **Explicit input validation**: MCP makes it easy to forget you are building an API. Treat it like one.
-   **No implicit ambient state**: pass dependencies in, log everything.
-   **Structured results**: return stable shapes, not strings that are impossible to diff.

## Where this lands in a real .NET 10 codebase

If you adopt MCP in production, you will care about the same things you care about in any service:

-   **Auth**: the server should enforce identity, not the client.
-   **Least privilege**: tools should expose the smallest surface area possible.
-   **Observability**: request IDs, tool invocation logs, and failure metrics.
-   **Determinism**: tools should be safe to call repeatedly, and idempotent where possible.

If you do one thing this week: clone the repo, skim the protocol docs, and draft a list of 5 tools you currently implement as “prompt glue”. That list is usually enough to justify a proper MCP boundary.

Resource: [microsoft/mcp](https://github.com/microsoft/mcp)
