---
title: "How to Migrate a Semantic Kernel Plugin to an MCP Server"
description: "Take an existing Semantic Kernel plugin with [KernelFunction] methods and turn it into a Model Context Protocol server other agents can call. Covers the drop-in WithTools(kernel) bridge, the native [McpServerTool] rewrite, parameter binding, dependency injection, and the gotchas that bite during the cutover."
pubDate: 2026-05-02
tags:
  - "mcp"
  - "semantic-kernel"
  - "ai-agents"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
---

If you built an internal agent on **Semantic Kernel 1.x** in 2025, you almost certainly own a folder of plugin classes with `[KernelFunction]` methods that wrap your APIs, your EF Core models, and your business rules. That investment is fine when the only consumer is your own SK-hosted agent. It becomes a problem the day someone else on the team wants to call those same tools from Claude Code, Cursor, VS Code's MCP client, or a Microsoft Agent Framework workflow. They cannot. SK plugins are an SK-only contract. **MCP is the cross-tool contract**, and as of the **`ModelContextProtocol` C# SDK 1.2.0** (released March 27, 2026, against the **2025-11-25** spec) the cost of exposing your plugins through it is small enough that there is no reason to put it off.

This post walks through two migration paths from `Microsoft.SemanticKernel` 1.75.0 plugins to a working MCP server, in **C# 14 on .NET 11**: the **drop-in bridge** that keeps every `[KernelFunction]` line of code intact and just publishes them over MCP, and the **native rewrite** that drops the SK dependency entirely and uses `[McpServerToolType]` / `[McpServerTool]` directly. Pick the bridge if you still need the same plugins inside an SK agent; pick the rewrite if MCP is the only consumer going forward.

## Why move plugins out of Semantic Kernel at all

Semantic Kernel's plugin model and MCP solve overlapping problems with different blast radii. SK plugins are first-class inside a single .NET process: the kernel resolves them, planners reason about them, filters intercept their calls. None of that travels. An MCP server, on the other hand, is a separate process that any compliant client can launch over stdio or hit over HTTP, and the [official SDKs in TypeScript, Python, and C#](https://modelcontextprotocol.io/) all produce the same wire traffic. The moment a second consumer wants your tools, MCP is the answer.

The other reason is operational. SK plugins live on the same kernel as your prompt orchestration and inherit its lifetime. An MCP server is a process you start, restart, deploy, and version on its own schedule. That separation matters when the team running the agents is not the team that owns the data.

If you have not built a plain MCP server in C# yet, the [step-by-step .NET 11 guide](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) is the right primer. The rest of this post assumes you know what `AddMcpServer().WithStdioServerTransport()` does and you are choosing how to feed it your existing SK plugin code.

## A representative SK plugin to migrate

To make the comparison concrete, here is the kind of plugin the rest of the post migrates. It is the shape every SK codebase has somewhere: a class that wraps a service, decorated with `[KernelFunction]` and `[Description]` so the planner can pick it up.

```csharp
// Microsoft.SemanticKernel 1.75.0
using System.ComponentModel;
using Microsoft.SemanticKernel;

public sealed class InventoryPlugin
{
    private readonly IInventoryService _inventory;

    public InventoryPlugin(IInventoryService inventory) => _inventory = inventory;

    [KernelFunction, Description("Look up stock level for a SKU across all warehouses.")]
    public async Task<int> GetStockLevelAsync(
        [Description("SKU code, e.g. SKU-1042")] string sku,
        CancellationToken ct = default)
    {
        return await _inventory.GetStockLevelAsync(sku, ct);
    }

    [KernelFunction, Description("Reserve stock for an order. Returns the reservation id.")]
    public async Task<string> ReserveAsync(
        [Description("SKU code")] string sku,
        [Description("Quantity to reserve, must be positive")] int quantity,
        CancellationToken ct = default)
    {
        return await _inventory.ReserveAsync(sku, quantity, ct);
    }
}
```

Two behaviours matter for the migration. First, the methods are **instance** methods that depend on `IInventoryService` from DI. Second, parameter descriptions are part of the schema the LLM sees. Both have to survive the cutover or the model will start hallucinating SKUs that do not exist.

## Path 1: The drop-in bridge with WithTools(kernel)

The fastest migration leaves every plugin file untouched. You add a thin extension that walks `kernel.Plugins`, converts each `KernelFunction` into an `AIFunction` (the abstraction `Microsoft.Extensions.AI` uses for tool descriptions), wraps it in an `McpServerTool`, and registers the lot. Microsoft's own [Semantic Kernel + MCP server walkthrough](https://devblogs.microsoft.com/agent-framework/building-a-model-context-protocol-server-with-semantic-kernel/) ships exactly this pattern.

```csharp
// ModelContextProtocol 1.2.0 + Microsoft.SemanticKernel 1.75.0
// Targeting .NET 11, C# 14
using Microsoft.Extensions.AI;
using Microsoft.SemanticKernel;
using ModelContextProtocol.Server;

public static class McpServerBuilderSemanticKernelExtensions
{
    public static IMcpServerBuilder WithTools(this IMcpServerBuilder builder, Kernel kernel)
    {
        foreach (KernelPlugin plugin in kernel.Plugins)
        {
            foreach (KernelFunction function in plugin)
            {
                AIFunction aiFunction = function.AsAIFunction(kernel);
                builder.Services.AddSingleton(_ => McpServerTool.Create(aiFunction));
            }
        }
        return builder;
    }
}
```

The `Program.cs` is then a textbook MCP host plus a kernel build:

```csharp
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.SemanticKernel;

var builder = Host.CreateApplicationBuilder(args);

// Stderr is mandatory for stdio MCP servers. stdout is the protocol channel.
builder.Logging.AddConsole(options =>
    options.LogToStandardErrorThreshold = LogLevel.Trace);

builder.Services.AddSingleton<IInventoryService, InventoryService>();

builder.Services.AddSingleton(sp =>
{
    var kb = Kernel.CreateBuilder();
    kb.Services.AddSingleton(sp.GetRequiredService<IInventoryService>());
    kb.Plugins.AddFromType<InventoryPlugin>("Inventory");
    return kb.Build();
});

builder.Services
    .AddMcpServer()
    .WithStdioServerTransport()
    .WithTools(builder.Services.BuildServiceProvider().GetRequiredService<Kernel>());

await builder.Build().RunAsync();
```

A few things in that listing are easy to get wrong.

- **Logging goes to stderr.** Every stdio-based MCP server has to keep stdout clean for protocol traffic. The first time you forget this, the client either hangs or rejects every frame. The same trap exists in the [Python SDK](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) and [TypeScript SDK](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/).
- **`AsAIFunction(kernel)`** binds the function to a kernel instance so SK can resolve constructor dependencies on invocation. If you call the parameterless `AsAIFunction()` overload, instance methods that depend on `IInventoryService` will throw at first call.
- **Argument schemas are inherited.** `AsAIFunction` reads `[Description]` from parameters and turns them into the JSON Schema fields the MCP client surfaces to the model. The schema you tuned for SK is the schema the agent sees over MCP.
- **Filters do not cross.** `IFunctionInvocationFilter` and `IPromptRenderFilter` registered on the kernel run only for in-process SK calls. An MCP client invoking the same function bypasses them. Anything you relied on those filters for, validation, redaction, audit, has to move into the tool method or sit in front of the server. Microsoft's [Agent Governance Toolkit](/2026/05/agent-governance-toolkit-mcp-policy-control-dotnet/) is explicitly designed to plug that hole.

For HTTP rather than stdio, swap `.WithStdioServerTransport()` for the ASP.NET Core hosting in the [`ModelContextProtocol.AspNetCore`](https://www.nuget.org/packages/ModelContextProtocol.AspNetCore) package. The `WithTools(kernel)` extension is unchanged.

## Path 2: The native rewrite with [McpServerTool]

The bridge is fine when SK is staying. If MCP is the only consumer going forward, dragging `Microsoft.SemanticKernel` (which itself pulls in `Microsoft.Extensions.AI.Abstractions`, OpenAI client surface, and a few connector packages depending on flavour) just to surface attributes is wasted weight. The native rewrite swaps the attributes one-for-one.

```csharp
// ModelContextProtocol 1.2.0 only, no Semantic Kernel dependency
using System.ComponentModel;
using ModelContextProtocol.Server;

[McpServerToolType]
public sealed class InventoryTools
{
    private readonly IInventoryService _inventory;

    public InventoryTools(IInventoryService inventory) => _inventory = inventory;

    [McpServerTool, Description("Look up stock level for a SKU across all warehouses.")]
    public async Task<int> GetStockLevelAsync(
        [Description("SKU code, e.g. SKU-1042")] string sku,
        CancellationToken ct = default)
    {
        return await _inventory.GetStockLevelAsync(sku, ct);
    }

    [McpServerTool, Description("Reserve stock for an order. Returns the reservation id.")]
    public async Task<string> ReserveAsync(
        [Description("SKU code")] string sku,
        [Description("Quantity to reserve, must be positive")] int quantity,
        CancellationToken ct = default)
    {
        return await _inventory.ReserveAsync(sku, quantity, ct);
    }
}
```

`Program.cs` shrinks to the canonical MCP shape:

```csharp
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

var builder = Host.CreateApplicationBuilder(args);

builder.Logging.AddConsole(options =>
    options.LogToStandardErrorThreshold = LogLevel.Trace);

builder.Services.AddSingleton<IInventoryService, InventoryService>();

builder.Services
    .AddMcpServer()
    .WithStdioServerTransport()
    .WithToolsFromAssembly();

await builder.Build().RunAsync();
```

`WithToolsFromAssembly()` scans the entry assembly, finds every type marked `[McpServerToolType]`, and registers every `[McpServerTool]` method. Constructor dependencies resolve through the host's `IServiceProvider`, which is why `IInventoryService` is registered above. By default, tool types are resolved per call; if a method must share state across invocations, register the type explicitly as a singleton:

```csharp
builder.Services.AddSingleton<InventoryTools>();
builder.Services.AddMcpServer().WithTools<InventoryTools>().WithStdioServerTransport();
```

`WithTools<T>()` is the targeted alternative to `WithToolsFromAssembly()` and is worth knowing about for tests, where you usually want to expose only the tools relevant to the scenario.

## Mapping the SK concepts to their MCP equivalents

Most of the migration is mechanical, but a handful of SK concepts do not have a one-to-one MCP twin. The table below is the cheat sheet.

| Semantic Kernel | MCP equivalent | Notes |
|---|---|---|
| `[KernelFunction]` | `[McpServerTool]` | Same idea, different attribute. Both use `[Description]` for the tool blurb. |
| `KernelArguments` | Method parameters | MCP binds JSON arguments to method parameters by name and type. |
| `[KernelFunction]` on a `static` method | `[McpServerTool]` on a `static` method | Both supported; static is the easiest path when no DI is needed. |
| `Kernel.InvokeAsync(...)` | The MCP client calls the tool by name | The transport handles dispatch; you do not write the call site. |
| `IFunctionInvocationFilter` | No direct equivalent | Move logic into the tool, into a custom `IMcpServerBuilder` interceptor, or in front of the server with [Agent Governance Toolkit](/2026/05/agent-governance-toolkit-mcp-policy-control-dotnet/). |
| Planner | The calling agent | The model in Claude Code, Cursor, or [Microsoft Agent Framework](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) does the planning. |
| Memory connectors | MCP resources | Use `[McpServerResourceType]` / `[McpServerResource]` if the data is best modelled as a resource rather than a tool call. |
| `KernelFunctionFromPrompt` | `[McpServerPrompt]` | Prompt templates become MCP prompts. |

The two rows that catch teams off guard are filters and the planner. Filters disappear, which is why an outbound sanitizer or policy layer becomes interesting; the planner moves to whatever client connects, which is why per-tool descriptions matter more than they did when you owned the planning prompt.

## Parameter binding and the schema the model sees

MCP serialises tool calls as JSON, and the C# SDK uses `System.Text.Json` (with `JsonSerializerDefaults.Web`) plus reflection to bind. Three rules matter:

1. **Primitives, strings, enums, `Guid`, `DateTime`, and POCOs all bind by default.** No annotations needed. Records work. Nullable reference types are honoured.
2. **`CancellationToken` is special-cased.** A `CancellationToken` parameter is filled with the request's cancellation token, not bound from the JSON arguments. Keep the SK habit of taking one and propagating it to your service calls.
3. **JSON Schema is generated from the parameter list.** `[Description]` on a parameter becomes the `description` of the corresponding schema property. `[Required]` is inferred from non-nullable, non-optional parameters. Anything more exotic, an enum constraint or a regex pattern, requires implementing `IMcpServerToolHandler` or post-processing the schema.

The same shape works in [the Python](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) and [TypeScript](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) SDKs, which is why a tool defined here is callable from Claude Desktop on macOS, Cursor on Windows, and a Python notebook all at once.

## Gotchas during the cutover

A few things that bit me running this migration on a real codebase.

**Optional parameters with defaults disappear from `required`.** In SK, an `int quantity = 1` parameter still showed up in the planner prompt with the default. In MCP, the same parameter ends up as non-required JSON Schema. A model that ignores it will silently get the default, which is sometimes not what you want. If a parameter must be present, drop the default and let the bind throw.

**Async return types unwrap as expected, but tuples do not.** `Task<int>` becomes `int`. `Task<string>` becomes `string`. A `Task<(int, string)>` serialises as a JSON object with `Item1` and `Item2`, which is rarely what an LLM expects. Return a record instead.

**`Kernel` is not a singleton you can share across processes.** If a tool needs another LLM call mid-flight (a classic SK pattern of one plugin calling another via the kernel), recreating `Kernel` per call is fine, but pulling in chat completion connectors makes your MCP server fat. In most cases, refactor the secondary call out to its own MCP tool and let the calling agent decide when to invoke it. That is the philosophical shift: **the planner moves out of your process**.

**Tool name collisions are silent.** Two `[McpServerTool]` methods named `Reserve` (one on `InventoryTools`, one on `OrderTools`) will both be registered, and the second one wins for the model. Either rename the methods or annotate explicitly: `[McpServerTool(Name = "inventory.reserve")]`.

**Kestrel auto-binds to a port; stdio servers must not.** If you copy-paste from an ASP.NET sample and forget to switch transports, your stdio MCP server will quietly start listening on `http://localhost:5000` and the client will hang waiting for a JSON-RPC frame on stdin that will never come. Pick the transport explicitly and stick with it.

## Where to go after the migration

Once your SK plugins are MCP tools, the obvious next step is wiring them into a calling agent. If that agent is also yours, the [Microsoft Agent Framework 1.0 walkthrough](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) shows how to consume an MCP server as a tool provider in three lines, with prompt caching and streaming on top. If the agent is Claude Code, the [Azure MCP server registration guide](/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) walks through the `mcp.json` shape that Visual Studio 2022 17.14.30, Claude Desktop, and Claude Code all share.

The migration is shorter than it looks because the hard work, deciding which behaviours are tools, what the descriptions say, what the parameters mean, was already done when you wrote the SK plugins. MCP is just a more interoperable place to put them.

### Source links

- [`ModelContextProtocol` 1.2.0 on NuGet](https://www.nuget.org/packages/ModelContextProtocol/)
- [Official MCP C# SDK on GitHub](https://github.com/modelcontextprotocol/csharp-sdk)
- [Building a Model Context Protocol Server with Semantic Kernel](https://devblogs.microsoft.com/agent-framework/building-a-model-context-protocol-server-with-semantic-kernel/) (Microsoft devblogs)
- [`Microsoft.SemanticKernel` 1.75.0 on NuGet](https://www.nuget.org/packages/Microsoft.SemanticKernel)
- [MCP specification, 2025-11-25 revision](https://modelcontextprotocol.io/)
