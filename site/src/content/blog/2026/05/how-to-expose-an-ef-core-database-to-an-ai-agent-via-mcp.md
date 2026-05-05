---
title: "How to Expose an EF Core Database to an AI Agent via MCP"
description: "Wire an EF Core 10 DbContext into a Model Context Protocol server so Claude Code, Cursor, or any compliant client can run safe, scoped queries against your database. Covers IDbContextFactory lifetime, read-only projections, schema discovery tools, AsNoTracking, parameterised filters, row-level scoping, and the destructive-tool gates you need before letting an agent touch UPDATE."
pubDate: 2026-05-05
tags:
  - "mcp"
  - "ai-agents"
  - "ef-core"
  - "claude-code"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
---

The fastest way to make a coding agent useful on a real product is to give it the ability to ask questions of the production data the team already trusts. Not a CSV export. Not a one-off prompt with the schema pasted in. The actual `DbContext` your application uses, with the same models, the same query translation, and the same auth scoping. As of the **`ModelContextProtocol` C# SDK 1.2.0** (released March 27, 2026, targeting the **2025-11-25** spec) and **EF Core 10** on **.NET 10 GA**, the wiring is small enough that the interesting decisions are no longer "how do I expose this" but "how do I expose this without letting an agent run a `DELETE` on a customer table at 2 a.m.".

This post walks through a working MCP server in **C# 14 / .NET 10** that wraps an EF Core 10 `DbContext`, exposes a small set of typed query tools to a coding agent (Claude Code, Cursor, VS Code, anything that speaks MCP), and applies the safety patterns that matter once the agent actually has the connection string. Every snippet uses the official SDK, an `IDbContextFactory<T>`, and read-only projections. The destructive tools are gated explicitly, not by accident.

## Why the agent should not see your raw `DbContext`

The temptation when first wiring this up is to register `MyDbContext` as a singleton in the MCP server, hand the agent an `[McpServerTool]` called `RunQuery(string sql)`, and call it a day. Do not. Three things go wrong fast.

The first is lifetime. An MCP server in stdio mode is a long-running process. EF Core's `DbContext` is explicitly designed to be **short-lived**, owning a connection and a change tracker. Reusing one across thousands of tool calls is the same pooling antipattern that bites web apps the first time they handle real load: you accumulate tracked entities, you serialise concurrent calls onto a single connection, and you eventually get `InvalidOperationException` from the change tracker. The `IDbContextFactory<T>` pattern, [documented in the EF Core team's pooling guidance](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor), gives you one fresh context per tool call, optionally pooled, with no state leaking between calls.

The second is intent. A model that can run arbitrary SQL is a model that can run `UPDATE Orders SET ShippedAt = NULL` because it misread the user's intent and is trying to "reset" something. Tool calling works because each tool has a narrow contract and a JSON schema the model has to fill in. `RunQuery(string sql)` throws that away and turns the whole tool list into "trust me, the LLM will type the right SQL". It will not.

The third is auditability. Tools defined by `[McpServerTool]` show up in the MCP client's tool list with their name, description, and parameter schema. Reviewers and the agent itself can see exactly which operations are exposed. A single `RunQuery` tool reduces every database operation to one entry in the audit log. Splitting the surface into named tools (`SearchOrders`, `GetCustomerById`, `ListLowStockProducts`) makes the agent's behaviour readable at the trace level.

## A concrete scenario: an inventory database read by Claude Code

The example throughout this post is a small e-commerce schema with `Products`, `Customers`, and `Orders`, and an MCP server called `inventory-mcp` that exposes it to a coding agent. The agent gets four tools: `GetSchema`, `SearchProducts`, `GetCustomerOrders`, and `MarkOrderShipped`. The first three are read-only. The last is destructive and gated.

The schema:

```csharp
// EF Core 10.0, .NET 10 GA
public sealed class Product
{
    public int Id { get; set; }
    public string Sku { get; set; } = "";
    public string Name { get; set; } = "";
    public decimal Price { get; set; }
    public int StockOnHand { get; set; }
}

public sealed class Customer
{
    public int Id { get; set; }
    public string Email { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string TenantId { get; set; } = "";
}

public sealed class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public Customer? Customer { get; set; }
    public DateTime PlacedAt { get; set; }
    public DateTime? ShippedAt { get; set; }
    public decimal Total { get; set; }
}

public sealed class InventoryDbContext(DbContextOptions<InventoryDbContext> opts)
    : DbContext(opts)
{
    public DbSet<Product> Products => Set<Product>();
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();
}
```

Nothing exotic. The point is that you almost certainly already have a class shaped like this in your application, and it is the unit of reuse we want.

## Project setup with the .NET 10 SDK

A new console project, the MCP SDK, and EF Core. The `ModelContextProtocol` package is the host-friendly meta-package; if you only need the low-level server APIs and want fewer dependencies, use `ModelContextProtocol.Core` instead.

```bash
dotnet new console -n InventoryMcp -f net10.0
cd InventoryMcp

dotnet add package ModelContextProtocol --version 1.2.0
dotnet add package Microsoft.EntityFrameworkCore --version 10.0.0
dotnet add package Microsoft.EntityFrameworkCore.Sqlite --version 10.0.0
dotnet add package Microsoft.Extensions.Hosting --version 10.0.0
```

The SQLite provider is just for the demo. Swap in `Microsoft.EntityFrameworkCore.SqlServer` or `Npgsql.EntityFrameworkCore.PostgreSQL` against the same `DbContext` and none of the tool code changes.

`Program.cs`:

```csharp
// Claude Code 2.x, MCP spec 2025-11-25, ModelContextProtocol 1.2.0, EF Core 10
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

var builder = Host.CreateApplicationBuilder(args);

// MCP servers communicate over stdio. Anything written to stdout is
// JSON-RPC. Logging goes to stderr or it corrupts the protocol.
builder.Logging.ClearProviders();
builder.Logging.AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace);

// Pooled context factory: cheap to resolve per tool call, no shared state.
builder.Services.AddDbContextFactory<InventoryDbContext>(o =>
{
    var connectionString = builder.Configuration.GetConnectionString("Inventory")
        ?? "Data Source=inventory.db";
    o.UseSqlite(connectionString);
});

builder.Services
    .AddMcpServer()
    .WithStdioServerTransport()
    .WithToolsFromAssembly();

await builder.Build().RunAsync();
```

Three things in this block matter and the official guide tends to skim past them. The `LogToStandardErrorThreshold = LogLevel.Trace` line is non-negotiable: stdout is the wire, and a single stray `Console.WriteLine` will [break the JSON-RPC framing](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) and surface as "MCP server disconnected" inside Claude Code with no useful error. `AddDbContextFactory` is what gives every tool call a fresh context. `WithToolsFromAssembly` tells the SDK to scan the current assembly for `[McpServerToolType]` classes, so you do not register each one by hand.

## Tool 1: schema discovery without leaking the world

The first tool a coding agent benefits from is "what does this database look like". You do not want to dump `INFORMATION_SCHEMA` raw. You want a curated, allowlisted view that matches the entities and columns you are happy to expose.

```csharp
using ModelContextProtocol.Server;
using System.ComponentModel;

[McpServerToolType]
public sealed class SchemaTools(IDbContextFactory<InventoryDbContext> factory)
{
    [McpServerTool, Description(
        "Returns the list of entities exposed by this server, with their " +
        "columns and types. Call this first to learn what you can query.")]
    public IReadOnlyList<EntityInfo> GetSchema()
    {
        using var ctx = factory.CreateDbContext();
        var model = ctx.Model;

        return model.GetEntityTypes()
            .Where(e => AllowedEntities.Contains(e.ClrType.Name))
            .Select(e => new EntityInfo(
                Name: e.ClrType.Name,
                Columns: e.GetProperties()
                    .Where(p => !ExcludedColumns.Contains(p.Name))
                    .Select(p => new ColumnInfo(
                        p.Name,
                        p.ClrType.Name,
                        p.IsNullable))
                    .ToArray()))
            .ToArray();
    }

    private static readonly HashSet<string> AllowedEntities =
        new(StringComparer.Ordinal) { "Product", "Customer", "Order" };

    private static readonly HashSet<string> ExcludedColumns =
        new(StringComparer.Ordinal) { "TenantId" };
}

public sealed record EntityInfo(string Name, IReadOnlyList<ColumnInfo> Columns);
public sealed record ColumnInfo(string Name, string Type, bool Nullable);
```

The allowlist is doing real work. EF Core's `Model` knows about every entity registered in the context, including any join tables, audit shadow entities, or internal queues you would rather not advertise to a coding agent. The `ExcludedColumns` set hides `TenantId` from the agent's view because it is a server-side concern, not a query parameter the model should choose.

The `Description` attribute on the tool is what the model actually reads when planning. Treat it as part of your prompt: tell the agent when to call this tool ("Call this first to learn what you can query"), not just what it does.

## Tool 2: read-only search with parameterised filters

The agent's instinct is to ask for everything. Pagination, projection, and `AsNoTracking` are the three knobs that keep that cheap.

```csharp
[McpServerToolType]
public sealed class ProductTools(IDbContextFactory<InventoryDbContext> factory)
{
    [McpServerTool, Description(
        "Search products by name or SKU substring. Returns at most 50 rows. " +
        "Use null for any filter you do not want to apply.")]
    public async Task<IReadOnlyList<ProductDto>> SearchProducts(
        [Description("Case-insensitive substring of the name. Optional.")]
            string? nameContains,
        [Description("Case-insensitive substring of the SKU. Optional.")]
            string? skuContains,
        [Description("Only return products with stock at or below this number. Optional.")]
            int? maxStock,
        CancellationToken ct)
    {
        await using var ctx = await factory.CreateDbContextAsync(ct);

        var query = ctx.Products.AsNoTracking();

        if (!string.IsNullOrWhiteSpace(nameContains))
            query = query.Where(p => EF.Functions.Like(p.Name, $"%{nameContains}%"));
        if (!string.IsNullOrWhiteSpace(skuContains))
            query = query.Where(p => EF.Functions.Like(p.Sku, $"%{skuContains}%"));
        if (maxStock is { } cap)
            query = query.Where(p => p.StockOnHand <= cap);

        return await query
            .OrderBy(p => p.Sku)
            .Take(50)
            .Select(p => new ProductDto(p.Id, p.Sku, p.Name, p.Price, p.StockOnHand))
            .ToListAsync(ct);
    }
}

public sealed record ProductDto(int Id, string Sku, string Name, decimal Price, int Stock);
```

`AsNoTracking` is the single biggest cost lever in a query path that an agent will hit thousands of times. The change tracker is wasted work when the result is going straight to JSON. The hard cap of 50 rows in the LINQ itself, not in the tool description, is what protects you when the model decides to ignore your "at most 50 rows" instruction. The DTO projection is what stops navigation properties from being lazy-loaded into the response and accidentally leaking that `TenantId` you carefully removed from the schema tool.

The `EF.Functions.Like` calls translate to the provider's `LIKE` operator with proper parameterisation. Concatenating user-supplied strings into a `FromSqlRaw` is how you get the [classic injection vector EF Core's docs warn about](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#passing-parameters); LINQ + parameter binding is the safe path, and the agent does not even see the SQL.

## Tool 3: tenant-scoped reads

If your application is multi-tenant, the agent must never call a tool that returns rows from the wrong tenant. The right place for that gate is the server, not the prompt.

```csharp
[McpServerToolType]
public sealed class CustomerTools(
    IDbContextFactory<InventoryDbContext> factory,
    IAgentContext agentContext)
{
    [McpServerTool, Description(
        "Returns up to 25 most recent orders for the given customer. " +
        "Scoped to the caller's tenant.")]
    public async Task<IReadOnlyList<OrderDto>> GetCustomerOrders(
        int customerId,
        CancellationToken ct)
    {
        await using var ctx = await factory.CreateDbContextAsync(ct);
        var tenantId = agentContext.TenantId;

        return await ctx.Orders
            .AsNoTracking()
            .Where(o => o.CustomerId == customerId
                     && o.Customer!.TenantId == tenantId)
            .OrderByDescending(o => o.PlacedAt)
            .Take(25)
            .Select(o => new OrderDto(
                o.Id, o.CustomerId, o.PlacedAt, o.ShippedAt, o.Total))
            .ToListAsync(ct);
    }
}

public interface IAgentContext { string TenantId { get; } }
public sealed record OrderDto(int Id, int CustomerId, DateTime PlacedAt,
    DateTime? ShippedAt, decimal Total);
```

`IAgentContext` is whatever you already use to resolve the current tenant. In a stdio server it is typically read once from an environment variable or argument when the process starts; in an HTTP-transport MCP server it comes from the OAuth claim now standardised in the [2025-11-25 authorization framework](https://modelcontextprotocol.io/specification/2025-11-25). The crucial point is that `TenantId` is **not** a tool parameter. The agent cannot choose it, cannot see it, and cannot trick the server into widening it.

## Tool 4: a destructive tool, gated

Some agent workflows do need write access. The shape that holds up under review is "narrow tool, explicit confirmation, transactional, audited".

```csharp
[McpServerToolType]
public sealed class FulfilmentTools(
    IDbContextFactory<InventoryDbContext> factory,
    ILogger<FulfilmentTools> log)
{
    [McpServerTool, Description(
        "Marks a single order as shipped. Idempotent: safe to retry. " +
        "Caller must already have confirmed intent with the user.")]
    public async Task<MarkOrderShippedResult> MarkOrderShipped(
        int orderId,
        CancellationToken ct)
    {
        await using var ctx = await factory.CreateDbContextAsync(ct);

        var rows = await ctx.Orders
            .Where(o => o.Id == orderId && o.ShippedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(
                o => o.ShippedAt, DateTime.UtcNow), ct);

        log.LogInformation(
            "MarkOrderShipped order={OrderId} rowsAffected={Rows}", orderId, rows);

        return new MarkOrderShippedResult(orderId, rows == 1);
    }
}

public sealed record MarkOrderShippedResult(int OrderId, bool Updated);
```

`ExecuteUpdateAsync` is doing two helpful things. It generates a single `UPDATE ... WHERE Id = @id AND ShippedAt IS NULL`, which makes the operation idempotent at the database layer (a second call sets zero rows), and it never loads the entity into the change tracker, so there is no chance of a stray `SaveChanges` somewhere else flushing tracked state. The return type tells the agent exactly what happened, which it can surface back to the user.

The destructive tool also has a different lifecycle from the read tools: in your MCP client config, you can require user approval for `MarkOrderShipped` while letting the read tools run automatically. Claude Code respects this through its `permissions` block; Cursor exposes it as the per-tool toggle in MCP settings.

## Wiring it into Claude Code

With the project built, the client config is the last piece.

```json
{
  "mcpServers": {
    "inventory": {
      "command": "dotnet",
      "args": ["C:\\src\\InventoryMcp\\bin\\Release\\net10.0\\InventoryMcp.dll"],
      "env": {
        "ConnectionStrings__Inventory": "Server=...;Database=Inventory;...",
        "AGENT_TENANT_ID": "tenant-7"
      }
    }
  }
}
```

Drop this into `~/.claude.json` for Claude Code or the equivalent location for Cursor / VS Code. The next session lists `GetSchema`, `SearchProducts`, `GetCustomerOrders`, and `MarkOrderShipped` in the tool palette, all four with the descriptions you wrote. If a tool fails to appear, run the server with `--cli` once and check that the JSON-RPC handshake completes: a stray write to stdout from a logging call is by far the most common cause.

## Gotchas worth knowing before production

`IDbContextFactory<T>` does not pool connections by default. If your provider is SQL Server or Postgres and the agent's call rate is high, register the pooled factory (`AddPooledDbContextFactory<T>`) and tune `PoolSize`. The pooling rules around state and reset are unchanged from regular EF Core pooled contexts, so the [usual reset gotchas apply](/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).

Long-running queries are an availability issue, not just a cost one. Wrap each tool call in a `CancellationToken` (the SDK passes one in automatically) and set a query timeout on the connection string. An agent that asks for "all orders in the last decade grouped by hour" will otherwise pin a connection until the OS kills the process.

Schema drift bites quickly. The `GetSchema` tool reads from `ctx.Model` at runtime, so a migration that adds a column shows up in the agent's next call. That is usually what you want, but if you have intentionally hidden columns (`PasswordHash`, `TenantId`), make sure your `ExcludedColumns` set is keyed by name in a way that survives a rename.

If you need write access from an HTTP-transport MCP server rather than stdio, switch to `ModelContextProtocol.AspNetCore` and put the OAuth 2.1 PRM flow from the November 2025 spec in front of the destructive tools. The [agent governance toolkit pattern](/2026/05/agent-governance-toolkit-mcp-policy-control-dotnet/) for policy control fits in here directly.

The pattern generalises beyond inventory. Any time an internal `DbContext` already encodes the right rows-and-columns boundary for an audience, an MCP server is a thin wrapper that lets a coding agent read it without copying the data anywhere. The work is in the tool list, not the protocol.

## Related reading

- [How to Build a Custom MCP Server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/)
- [How to Migrate a Semantic Kernel Plugin to an MCP Server](/2026/05/migrate-a-semantic-kernel-plugin-to-an-mcp-server/)
- [How to Add Tool Calling to a Microsoft.Extensions.AI Chat Client](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/)
- [How to Detect N+1 Queries in EF Core 11](/2026/04/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Agent Governance Toolkit: MCP Policy Control on .NET](/2026/05/agent-governance-toolkit-mcp-policy-control-dotnet/)

## Source links

- [MCP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [ModelContextProtocol 1.2.0 on NuGet](https://www.nuget.org/packages/ModelContextProtocol/1.2.0)
- [EF Core SQL queries and parameter binding](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)
- [`DbContext` factory configuration in EF Core](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/)
