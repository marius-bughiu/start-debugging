---
title: "How to Build a Custom MCP Server in C# on .NET 11"
description: "Build a working Model Context Protocol server in C# 14 / .NET 11 using the official ModelContextProtocol 1.2 SDK. Covers stdio transport, [McpServerTool] attributes, dependency injection, the stderr logging trap, and registration with Claude Code, Claude Desktop, and VS Code."
pubDate: 2026-04-26
tags:
  - "mcp"
  - "ai-agents"
  - "claude-code"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "anthropic-sdk"
---

If your team's source of truth lives in a .NET service -- an EF Core database, an internal API, a Hangfire job runner, a Workspace API -- then exposing it to a coding agent through the [Model Context Protocol](https://modelcontextprotocol.io/) is faster than the dotnet-shop side of the internet usually advertises. The official C# SDK hit `1.0` on March 5 2026 and shipped `1.2.0` on March 27, both maintained jointly by Microsoft and Anthropic. The boilerplate is now small enough that the interesting work is in your tool methods, not the protocol plumbing.

This guide builds a real, runnable MCP server in **C# 14 on .NET 11**, using the **`ModelContextProtocol` 1.2.0** package against the **2025-11-25 MCP specification**. By the end you will have an `inventory-mcp` server that exposes a SQLite database to an agent through three tools, with proper dependency injection, the stderr logging trick the docs only mention in passing, and the exact configuration snippets for Claude Code, Claude Desktop, and VS Code's `mcp.json`.

## When the C# SDK is the right call

The Anthropic and MCP teams ship official SDKs in TypeScript, Python, and C#. They produce identical wire traffic, so the question is not "which transports the protocol best" but "where does the code I want to expose already live." Two cases where C# wins:

- **Your business logic is already in .NET.** EF Core models, Microsoft.Identity.Web auth, Hangfire / Quartz scheduled jobs, Polly retry policies, an internal API surfaced through Refit. Re-implementing any of that in Python or Node so an agent can call it is wasted work. The C# SDK lets you put `[McpServerTool]` on a method and ship.
- **You want the standard .NET hosting model.** `IHostedService`, `IHttpClientFactory`, `IConfiguration`, structured logging through `Microsoft.Extensions.Logging`, OpenTelemetry. The SDK plugs into `Host.CreateApplicationBuilder` directly, so observability and config look the same as any other ASP.NET Core service.

For background on the protocol itself, the older [Microsoft `mcp` wiring overview for .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/) covers the contract-first mindset; this post is the concrete how-to update for .NET 11 and the post-1.0 SDK.

## Project setup with the .NET 11 SDK

You need the .NET 11 SDK (`dotnet --version` should report `11.0.x` or later). The `ModelContextProtocol` 1.2.0 package targets `net8.0` and up, so `net11.0` is supported and gets you C# 14 features for free.

```bash
# .NET 11 SDK, ModelContextProtocol 1.2.0
dotnet new console -n InventoryMcp
cd InventoryMcp
dotnet add package ModelContextProtocol --version 1.2.0
dotnet add package Microsoft.Extensions.Hosting --version 11.0.0
dotnet add package Microsoft.Data.Sqlite --version 11.0.0
```

The packages split looks like this, and the choice matters:

- **`ModelContextProtocol`** -- the main server package. Pulls in hosting and dependency-injection extensions and the attribute-based tool registration. Pick this for any project that does not need its own ASP.NET Core HTTP host.
- **`ModelContextProtocol.Core`** -- minimal dependencies for low-level client/server work or library code. No `Microsoft.Extensions.Hosting` baked in.
- **`ModelContextProtocol.AspNetCore`** -- adds `WithHttpTransport()` and the streamable-HTTP server endpoints for remote deployments.

For a stdio server you launch from a coding agent, only the first one is needed.

The `.csproj` for .NET 11 ends up minimal:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <LangVersion>14.0</LangVersion>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>InventoryMcp</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="ModelContextProtocol" Version="1.2.0" />
    <PackageReference Include="Microsoft.Extensions.Hosting" Version="11.0.0" />
    <PackageReference Include="Microsoft.Data.Sqlite" Version="11.0.0" />
  </ItemGroup>
</Project>
```

## The Program.cs that does not corrupt stdout

Stdio transport carries JSON-RPC messages on the process's stdin/stdout pair. The server reads requests on stdin and writes responses on stdout. Anything else that touches stdout -- a stray `Console.WriteLine`, a default-configured `ILogger` emitting to stdout, an exception's stack trace landing on stdout instead of stderr -- gets injected into the JSON stream and the client kills the connection with a parse error.

The C# SDK's hosting integration handles the protocol writes, but you have to rebind the console logger to stderr or you will lose the first 30 minutes of your life chasing "MCP server disconnected" alerts in Claude Code:

```csharp
// Program.cs, .NET 11, ModelContextProtocol 1.2.0
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Data.Sqlite;
using InventoryMcp;

var builder = Host.CreateApplicationBuilder(args);

// All log output goes to stderr. Stdout is reserved for MCP traffic.
builder.Logging.AddConsole(o =>
{
    o.LogToStandardErrorThreshold = LogLevel.Trace;
});

builder.Services.AddSingleton<ProductRepository>(_ =>
{
    var dbPath = Environment.GetEnvironmentVariable("INVENTORY_DB_PATH")
                 ?? Path.Combine(AppContext.BaseDirectory, "inventory.db");
    return new ProductRepository($"Data Source={dbPath}");
});

builder.Services
    .AddMcpServer()
    .WithStdioServerTransport()
    .WithToolsFromAssembly();

await builder.Build().RunAsync();
```

Three things worth pinning down:

- `LogToStandardErrorThreshold = LogLevel.Trace` sends every log line to stderr. Without it, `Microsoft.Extensions.Logging` writes warnings and above to stderr but information and below to stdout, which silently corrupts the protocol stream the moment something logs at info level.
- `AppContext.BaseDirectory` anchors the SQLite path next to the published binary. The agent process spawns the server with whatever working directory it feels like, so do not rely on `Environment.CurrentDirectory`.
- `WithToolsFromAssembly()` scans the entry assembly for any class marked `[McpServerToolType]` and registers every method marked `[McpServerTool]`. You can also pin specific types with `WithTools<EchoTool>().WithTools<MonkeyTools>()` if you prefer explicit registration.

## Defining the tools

Each tool is a method on a class decorated with `[McpServerToolType]`. The method itself carries `[McpServerTool, Description("...")]`. Method parameters become the input schema; `[Description]` on each parameter ends up in the JSON Schema the agent sees when it decides whether to call the tool.

The repository is plain ADO.NET with `Microsoft.Data.Sqlite` so the example reads end to end without an ORM dance. The pattern works the same with EF Core 11 -- inject the `DbContext` and the registration loop is identical:

```csharp
// ProductRepository.cs, .NET 11
using Microsoft.Data.Sqlite;

namespace InventoryMcp;

public sealed record Product(string Sku, string Name, int Stock, decimal Price);

public sealed class ProductRepository
{
    private readonly string _connectionString;

    public ProductRepository(string connectionString)
    {
        _connectionString = connectionString;
        EnsureSchema();
    }

    public IReadOnlyList<Product> List(bool lowStockOnly, int limit)
    {
        using var conn = new SqliteConnection(_connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = lowStockOnly
            ? "SELECT sku, name, stock, price FROM products WHERE stock < 10 ORDER BY name LIMIT $limit"
            : "SELECT sku, name, stock, price FROM products ORDER BY name LIMIT $limit";
        cmd.Parameters.AddWithValue("$limit", limit);

        var results = new List<Product>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            results.Add(new Product(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetInt32(2),
                reader.GetDecimal(3)));
        }
        return results;
    }

    public Product? Get(string sku)
    {
        using var conn = new SqliteConnection(_connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT sku, name, stock, price FROM products WHERE sku = $sku";
        cmd.Parameters.AddWithValue("$sku", sku);

        using var reader = cmd.ExecuteReader();
        return reader.Read()
            ? new Product(reader.GetString(0), reader.GetString(1), reader.GetInt32(2), reader.GetDecimal(3))
            : null;
    }

    public int Adjust(string sku, int delta)
    {
        using var conn = new SqliteConnection(_connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE products SET stock = stock + $delta
            WHERE sku = $sku AND stock + $delta >= 0
            RETURNING stock
            """;
        cmd.Parameters.AddWithValue("$sku", sku);
        cmd.Parameters.AddWithValue("$delta", delta);

        var result = cmd.ExecuteScalar();
        if (result is null)
        {
            throw new InvalidOperationException(
                $"Cannot adjust stock for SKU '{sku}': product not found or stock would go negative.");
        }
        return Convert.ToInt32(result);
    }

    private void EnsureSchema() { /* CREATE TABLE IF NOT EXISTS ... and seed */ }
}
```

The tool class is the surface the agent sees:

```csharp
// InventoryTools.cs, ModelContextProtocol 1.2.0
using System.ComponentModel;
using ModelContextProtocol.Server;

namespace InventoryMcp;

[McpServerToolType]
public sealed class InventoryTools
{
    private readonly ProductRepository _repo;
    private readonly ILogger<InventoryTools> _logger;

    public InventoryTools(ProductRepository repo, ILogger<InventoryTools> logger)
    {
        _repo = repo;
        _logger = logger;
    }

    [McpServerTool, Description("List products in the inventory database. Optionally filter to low-stock items (under 10 units).")]
    public IReadOnlyList<Product> ListProducts(
        [Description("If true, return only products with fewer than 10 units in stock.")] bool lowStockOnly = false,
        [Description("Maximum number of rows to return. Default 50, hard cap 500.")] int limit = 50)
    {
        limit = Math.Clamp(limit, 1, 500);
        return _repo.List(lowStockOnly, limit);
    }

    [McpServerTool, Description("Get a single product by its SKU. Returns null if no product matches.")]
    public Product? GetProduct(
        [Description("Stock-keeping unit, e.g. 'SKU-001'. Case-sensitive exact match.")] string sku)
        => _repo.Get(sku);

    [McpServerTool, Description("Adjust stock for a SKU by a positive or negative delta. Returns the new stock level. Errors if the SKU does not exist or the result would be negative.")]
    public int AdjustStock(
        [Description("SKU to adjust, e.g. 'SKU-001'.")] string sku,
        [Description("Signed integer delta. Use positive numbers to receive stock, negative to ship.")] int delta)
    {
        _logger.LogInformation("AdjustStock sku={Sku} delta={Delta}", sku, delta);
        return _repo.Adjust(sku, delta);
    }
}
```

A few details that matter once an agent actually starts calling this:

- **Constructor injection.** Tool methods can also take services as parameters directly, but a repository like this is shared across calls and belongs in the constructor. `WithToolsFromAssembly()` resolves both styles through the standard DI container.
- **Records as return types.** The SDK serialises `Product` to structured JSON output the client can show as a typed result. If you returned `IDictionary<string, object>` the agent would still get text, but it would lose the schema and any type guarantees.
- **`[Description]` matters more than the parameter name.** "The name of the monkey to get details for" is what the agent reads when it picks a tool. Vague descriptions like "the SKU" route the wrong free-text into the wrong tool. Be specific, including format hints.
- **Throw for tool-level errors.** The SDK catches the exception and returns it to the client as a tool error result the model can react to. You do not need to construct `CallToolResult` objects by hand for the common case.
- **Parameterised SQL only.** An agent will happily pass a SKU like `'; DROP TABLE products; --` if the upstream prompt has user input in it. Always use `$param` placeholders.

## Wiring it to Claude Code, Claude Desktop, and VS Code

Once `dotnet run` starts the process, register it with the agent. Three formats, same binary.

**Claude Code** has a built-in command for stdio servers. From the project root:

```bash
# Claude Code 2.x
claude mcp add inventory -- dotnet run --project ./InventoryMcp.csproj
```

For a published build, swap to the binary:

```bash
dotnet publish -c Release -o publish
claude mcp add inventory -- ./publish/InventoryMcp
```

**Claude Desktop** uses `claude_desktop_config.json`. On Windows it lives at `%AppData%\Claude\claude_desktop_config.json`; on macOS at `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "inventory": {
      "command": "dotnet",
      "args": [
        "run",
        "--project",
        "C:\\src\\InventoryMcp\\InventoryMcp.csproj",
        "--no-launch-profile"
      ],
      "env": {
        "INVENTORY_DB_PATH": "C:\\data\\inventory.db"
      }
    }
  }
}
```

Restart Claude Desktop, and the MCP indicator should list `list_products`, `get_product`, and `adjust_stock`. Ask it "Which products are low on stock?" and watch it call `list_products(lowStockOnly: true)`.

**VS Code** uses `.vscode/mcp.json` for workspace-scoped servers:

```json
{
  "inputs": [],
  "servers": {
    "inventory": {
      "type": "stdio",
      "command": "dotnet",
      "args": ["run", "--project", "${workspaceFolder}/InventoryMcp/InventoryMcp.csproj"]
    }
  }
}
```

For a sense of how an IDE bundles MCP servers natively rather than going through user config, [the Azure MCP Server inside Visual Studio 2022 17.14.30](/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) is a useful reference point.

## When stdio is wrong: the HTTP transport shape

Stdio is correct for "agent on my machine, server on my machine, one client per process." The moment you want a long-lived server other developers connect to remotely, swap the package and the registration:

```csharp
// dotnet add package ModelContextProtocol.AspNetCore --version 1.2.0
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<ProductRepository>(/* ... */);
builder.Services
    .AddMcpServer(o => o.ServerInfo = new() { Name = "inventory", Version = "1.0.0" })
    .WithHttpTransport()
    .WithToolsFromAssembly();

var app = builder.Build();
app.MapMcp();
app.Run();
```

`MapMcp()` exposes the streamable-HTTP and SSE endpoints the spec defines. Put it behind your usual ASP.NET Core auth pipeline and you get OAuth 2.0 incremental scope consent, well-known authorization discovery, and the long-running request polling that landed in the 1.0 release for free.

## Production gotchas the docs underplay

**Don't ship a single `Microsoft.Data.Sqlite` connection.** The above example opens a fresh connection per call, which is the right default for an SDK demo. For workloads beyond a hobby database, register `SqliteConnection` as a transient service or wire EF Core 11 with pooling. SQLite serialises writes by default; if two `AdjustStock` calls fire simultaneously you will see `SQLITE_BUSY` once the lock contention crosses a few hundred ms.

**Cancellation tokens.** Tool methods can take a trailing `CancellationToken` parameter and the SDK will plumb the per-request token in. If your tool calls `HttpClient`, EF Core, or any I/O, accept the token and pass it through. Otherwise a misbehaving model that times out leaves a SQLite transaction or HTTP request hanging on the server.

**`IHttpClientFactory` for outbound calls.** When a tool fetches from an external API, inject `IHttpClientFactory` and create named clients. The same lifetime rules that bite ASP.NET Core apps -- socket exhaustion from `new HttpClient()`, DNS pinning -- bite MCP servers harder, because they tend to stay running across many agent sessions.

**Logging volume.** A chatty `LogInformation` per tool call is fine. Logging the entire tool input on every call leaks PII into stderr and ends up in Claude Code's transcript, which the user may not realise is being captured. Treat tool-call logs the same way you treat web-request logs: redact secrets, summarise inputs.

**JSON serialisation surprises.** The SDK uses `System.Text.Json` with the default options. If your domain types rely on `Newtonsoft.Json` attributes or non-default casing, configure the JSON options on the host or convert to plain records at the tool boundary. A type that serialises one way to your REST clients and another way to MCP clients is a debugging nightmare.

**Native AOT.** The `ModelContextProtocol` package is not fully AOT-friendly yet because the attribute-driven tool discovery uses reflection. If you need a single-file AOT executable for distribution, use `ModelContextProtocol.Core` and register tools manually with `MapTool` instead of `WithToolsFromAssembly`.

## What this pattern unlocks for a .NET shop

The core move -- decorate a method, return a record, throw on errors -- scales to every C# integration your team already has. A few obvious next steps:

- Wrap an EF Core 11 `DbContext` and expose schema introspection plus a parameterised query tool, so an agent can answer "how many orders shipped last week" without you writing the SQL. The newer EF Core features pair well; see [EF Core 11 SQL Server vector search with DiskANN indexes](/2026/04/efcore-11-sql-server-vector-search-diskann-indexes/) for a particularly agent-friendly retrieval primitive.
- Wrap a Hangfire / Quartz scheduler and let the agent inspect or trigger background jobs.
- Wrap an internal Refit client around your real API, with the existing auth pipeline, so the agent talks to the same surface your apps do.

If you primarily work in another language, [the equivalent server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) covers Node.js with `@modelcontextprotocol/sdk`, and [the Python guide using the official `mcp` SDK](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/) covers the FastMCP pattern. And if you are looking past MCP into multi-agent orchestration in C#, [Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) picks up where MCP leaves off, with planners, multi-agent handoff, and durable run state.

The MCP server itself does not care whether your tool wraps a SQLite database, a SignalR hub, or a 500-line domain service. It only needs typed parameters (the C# attributes give you that for free), a return value the SDK can serialise, and a stdio stream that does not have stray bytes in it.

## Source links

- [`modelcontextprotocol/csharp-sdk` on GitHub](https://github.com/modelcontextprotocol/csharp-sdk) -- official repository, maintained by Anthropic and Microsoft.
- [`ModelContextProtocol` 1.2.0 on NuGet](https://www.nuget.org/packages/ModelContextProtocol/) -- main server package.
- [.NET Blog: Release v1.0 of the official MCP C# SDK](https://devblogs.microsoft.com/dotnet/release-v10-of-the-official-mcp-csharp-sdk/) -- 1.0 release notes from March 5 2026.
- [.NET Blog: Build a Model Context Protocol (MCP) server in C#](https://devblogs.microsoft.com/dotnet/build-a-model-context-protocol-mcp-server-in-csharp/) -- the canonical Microsoft walkthrough.
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/) -- the spec version implemented by SDK 1.x.
