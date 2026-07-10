---
title: "Migrate a LangChain Agent to the MCP Tool-Calling Pattern"
description: "A step-by-step checklist for moving an existing LangChain agent off inline @tool functions onto a standalone MCP server that any client can call. Covers extracting tools into FastMCP, re-wiring the agent with langchain-mcp-adapters MultiServerMCPClient, the sync-to-async switch, transports, and the gotchas that bite mid-cutover."
pubDate: 2026-07-10
updatedDate: 2026-07-10
template: migration
tags:
  - "migration"
  - "mcp"
  - "ai-agents"
  - "llm"
  - "langchain"
  - "python"
---

If you built an agent on **LangChain** in 2025, your tools almost certainly live inline: a folder of functions decorated with `@tool`, imported into the same module as the agent, and handed to `create_agent` as a Python list. That is the fastest way to get a working agent, and it is fine right up until a second consumer wants the same tools. A colleague using Claude Code, a Cursor session, or a plain MCP client cannot import your `@tool` functions. They are a LangChain-only contract. **MCP is the cross-tool contract**, and moving your tools onto it is smaller than it looks because the tool shape barely changes: `@tool` becomes `@mcp.tool()`, the function body is identical, and `langchain-mcp-adapters` hands the migrated tools back to the same `create_agent` call you already have.

This post is the migration checklist for a real agent running **LangChain 1.1.0** (with `create_agent` from `langchain.agents`), moving its tools to a standalone server built on the **MCP Python SDK** (`mcp`, FastMCP API, targeting the **2025-11-25** spec revision) and consuming them through **`langchain-mcp-adapters` 0.3.0** (released June 10, 2026). Model calls in the examples use `claude-sonnet-4-6`. The short version: for a handful of tools this is a half-day job, the tool code moves almost verbatim, and the one thing that genuinely breaks is that your agent invocation has to become async.

## Why move tools out of LangChain at all

The inline `@tool` model and MCP solve overlapping problems with different blast radii. A LangChain tool is first-class inside one Python process: the agent binds it, the model sees its schema, and the call happens on the same event loop. None of that travels. An MCP server is a separate process that any compliant client can launch over stdio or hit over HTTP, and the official SDKs in Python, TypeScript, and C# all emit the same wire traffic.

Concretely, the migration buys you:

- **Reuse across clients.** The same `reserve` tool becomes callable from Claude Code, Cursor, VS Code's MCP client, and a Microsoft Agent Framework workflow, not just your LangChain script. This is the same argument that applies when you [migrate a Semantic Kernel plugin to an MCP server](/2026/05/migrate-a-semantic-kernel-plugin-to-an-mcp-server/): the moment a second agent wants your tools, MCP is the answer.
- **Process isolation.** Tools deploy, restart, and version on their own schedule, decoupled from the agent's prompt orchestration. The team that owns the inventory data is no longer coupled to the team that owns the agent loop.
- **A language boundary.** The tool can be Python today and Go tomorrow. The agent does not care, because it only ever sees JSON-RPC over a transport.

The cost is that a tool call is no longer a local function call. It is a serialized request to another process, which changes the error model, the concurrency model, and what data can cross the boundary. That is what the rest of this post is about.

## The LangChain agent we are migrating

Here is the shape almost every LangChain codebase has somewhere: two `@tool` functions that wrap an internal service, handed straight to `create_agent`.

```python
# langchain 1.1.0, langgraph 1.x
from langchain.agents import create_agent
from langchain_core.tools import tool
import httpx

@tool
def get_stock_level(sku: str) -> int:
    """Look up stock level for a SKU across all warehouses."""
    resp = httpx.get(f"https://inventory.internal/stock/{sku}")
    resp.raise_for_status()
    return resp.json()["quantity"]

@tool
def reserve(sku: str, quantity: int) -> str:
    """Reserve stock for an order. Returns the reservation id."""
    resp = httpx.post(
        "https://inventory.internal/reserve",
        json={"sku": sku, "quantity": quantity},
    )
    resp.raise_for_status()
    return resp.json()["reservation_id"]

agent = create_agent("anthropic:claude-sonnet-4-6", [get_stock_level, reserve])
result = agent.invoke({"messages": "How many SKU-1042 are in stock?"})
print(result["messages"][-1].content)
```

Two things about this code decide the migration. First, the **docstring is the tool description the model reads** to decide when to call the tool, and the **type hints become the argument schema**. Both have to survive the cutover verbatim or the model starts guessing. Second, `agent.invoke(...)` is **synchronous**. That is the line that has to change.

## What breaks

| Area | Change | Severity |
| ---- | ------ | -------- |
| Tool definition | `@tool` in-process becomes `@mcp.tool()` in a separate server file | high |
| Agent invocation | Sync `.invoke()` becomes async `.ainvoke()`; tools are awaited under the hood | high |
| Error propagation | A raised exception no longer bubbles up; it returns to the model as a `ToolMessage` with `status="error"` | medium |
| Data across the boundary | Arguments and return values must be JSON-serializable; rich Python objects do not cross the wire | medium |
| Tool state | `MultiServerMCPClient` is stateless by default, so module-level caches or connection pools do not persist between calls | medium |
| Agent construction | Building the agent now needs an `await` on `get_tools()` | low |

The two high-severity rows are the whole migration. Everything else is a consequence.

## Pre-flight checklist

- **Python 3.10 or newer.** The MCP Python SDK requires it.
- **Install the three packages** and pin them: `pip install "mcp" "langchain==1.1.0" "langchain-mcp-adapters==0.3.0"`. Pinning `mcp` matters right now because the SDK's v2 beta (June 30, 2026) renames the bundled `FastMCP` class to `MCPServer`; on the current 1.x line the import below is correct.
- **List every `@tool`** and confirm each argument and return value is JSON-serializable. A tool that returns a `pandas.DataFrame` or a custom class needs a serialization step before it can move.
- **Pick a transport.** `stdio` for a local subprocess the agent launches itself; `streamable-http` for a shared server other clients also use. If you are unsure, the [stdio vs HTTP vs SSE breakdown](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) covers the trade-offs.
- **Decide where the server process runs.** For stdio it is launched on demand; for HTTP you need somewhere to host it.

## Migration steps

1. **Inventory the tools and confirm their contracts.** Open the agent module and list every `@tool`. For each one, write down the exact docstring and the type hints on its parameters and return. This is the contract that has to move unchanged. If any tool returns a non-JSON type, add a step to convert it to a dict, a primitive, or a Pydantic model that serializes cleanly. Verify by confirming every tool has a docstring and full type hints; an untyped parameter gives the MCP server nothing to build a schema from.

2. **Stand up an MCP server and move the tool bodies.** Create `inventory_server.py`. Instantiate `FastMCP`, swap each `@tool` for `@mcp.tool()`, and paste the function body verbatim. The signatures and docstrings do not change.

   ```python
   # mcp (Python SDK), FastMCP API, MCP spec 2025-11-25
   from mcp.server.fastmcp import FastMCP
   import httpx

   mcp = FastMCP("inventory")

   @mcp.tool()
   def get_stock_level(sku: str) -> int:
       """Look up stock level for a SKU across all warehouses."""
       resp = httpx.get(f"https://inventory.internal/stock/{sku}")
       resp.raise_for_status()
       return resp.json()["quantity"]

   @mcp.tool()
   def reserve(sku: str, quantity: int) -> str:
       """Reserve stock for an order. Returns the reservation id."""
       resp = httpx.post(
           "https://inventory.internal/reserve",
           json={"sku": sku, "quantity": quantity},
       )
       resp.raise_for_status()
       return resp.json()["reservation_id"]

   if __name__ == "__main__":
       mcp.run(transport="stdio")
   ```

   Verify by running `python inventory_server.py` and confirming it starts without printing anything to stdout. The full server pattern, including resources and prompts, is covered in the [Python MCP server guide](/2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk/).

3. **Smoke-test the server in isolation.** Before touching the agent, prove the server answers. The quickest check is the MCP Inspector (`npx @modelcontextprotocol/inspector python inventory_server.py`), which lists the two tools with their generated schemas and lets you call `get_stock_level` by hand. Verify that both tools appear, that each shows the docstring as its description, and that `sku` and `quantity` show the correct types. If a tool is missing a description here, it will be missing it for the model too.

4. **Point the LangChain agent at the server.** Replace the inline tool list with a `MultiServerMCPClient` that launches the server and a `get_tools()` call that fetches the migrated tools. This is where the agent stops importing your functions and starts calling them over MCP.

   ```python
   # langchain-mcp-adapters 0.3.0, langchain 1.1.0
   import asyncio
   from langchain_mcp_adapters.client import MultiServerMCPClient
   from langchain.agents import create_agent

   async def main():
       client = MultiServerMCPClient(
           {
               "inventory": {
                   "command": "python",
                   "args": ["inventory_server.py"],
                   "transport": "stdio",
               }
           }
       )
       tools = await client.get_tools()
       agent = create_agent("anthropic:claude-sonnet-4-6", tools)
       result = await agent.ainvoke(
           {"messages": "How many SKU-1042 are in stock?"}
       )
       print(result["messages"][-1].content)

   asyncio.run(main())
   ```

   Verify by running the script and confirming the answer matches what the inline agent returned for the same prompt.

5. **Commit to async everywhere.** The line that breaks most migrations is the invocation. MCP tools are awaited, so `agent.invoke(...)` becomes `await agent.ainvoke(...)`, and any caller up the stack has to be async too. If your agent runs inside a sync framework, wrap the entry point with `asyncio.run` as above, or move the call onto the existing event loop. Verify by running your existing agent test suite; a `RuntimeWarning: coroutine was never awaited` means a call site is still sync.

6. **Optional: move to streamable HTTP for a shared server.** Once the stdio version works, switching to a long-lived HTTP server is a two-line change. On the server, run `mcp.run(transport="streamable-http")`, which serves at `http://localhost:8000/mcp`. On the client, replace the `command`/`args` block with `{"transport": "http", "url": "http://localhost:8000/mcp"}`. Verify the agent still answers, and confirm a second client (Claude Code, the Inspector) can now reach the same server concurrently.

## Verifying the cutover

Run this checklist after the migration before you delete the old code:

- The server starts standalone and prints nothing to stdout.
- The MCP Inspector lists every migrated tool with its description and typed arguments.
- The agent answers the same prompts with the same results it gave in-process.
- A tool that raises (for example, an unknown SKU) surfaces to the model as an error the agent can retry, not an unhandled exception that crashes the run.
- Your test suite passes with no `coroutine was never awaited` warnings.

## Rollback plan

This migration is fully reversible, which is the nice part. You did not delete the original `@tool` functions; you copied their bodies. If the MCP path misbehaves in production, flip the agent back to the inline list in one line:

```python
# rollback: bypass MCP, use the original in-process tools
agent = create_agent("anthropic:claude-sonnet-4-6", [get_stock_level, reserve])
```

Keep both wiring paths behind a config flag during the first week so you can switch without a deploy. Once the MCP server has run clean for a few days, delete the inline definitions and the flag.

## Gotchas during the cutover

A few things that bite when you run this on a real codebase.

**Anything printed to stdout corrupts a stdio server.** The stdio transport uses stdout for JSON-RPC frames. A stray `print()` for debugging, or a library that logs to stdout, will garble the protocol and the client will either hang or reject every frame. Route all logging to stderr. This is the single most common way a first MCP server fails, and it is the same trap in the [TypeScript SDK](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/).

**Type hints are not optional anymore.** In LangChain, a loosely typed `@tool` still worked because the model could often guess from the docstring. MCP builds the JSON Schema from your type annotations. A `def reserve(sku, quantity)` with no hints ships a schema with untyped arguments, and the model will pass strings where you expected ints. Every parameter needs a real annotation.

**The docstring carries more weight than before.** When you owned the agent prompt, you could nudge tool selection in the system prompt. Over MCP the client owns the prompt, so the tool description (your docstring) is often the only steering the model gets. Tighten vague docstrings before you migrate, not after.

**Stateless means module-level state does not persist.** `MultiServerMCPClient` opens a fresh session per tool call by default, so a connection pool or cache you stashed at module scope is rebuilt every call, and in stdio mode the subprocess may be relaunched. If a tool genuinely needs to share state across calls, use the stateful `async with client.session("inventory") as session:` form with `load_mcp_tools(session)`, or move to a long-lived HTTP server.

**Errors change shape.** With inline tools, a raised exception propagated up your stack and you handled it. Over MCP, `langchain-mcp-adapters` returns tool failures to the model as a `ToolMessage` with `status="error"` so the agent can self-correct, and does not raise by default. That is usually what you want in an agent loop, but if you were relying on exceptions to abort the run, pass `handle_tool_errors=False` to `get_tools()` to restore the raising behavior.

**Watch the tool count.** Once tools live on a server, it is tempting to keep adding them, and a bloated tool list degrades model accuracy and can hit client tool-use limits. If your server grows past a dozen or so tools, read [how to reduce the number of MCP tools an agent loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/).

The migration is shorter than it looks because the hard part, deciding what the tools are, what they return, and what their descriptions say, was already done when you wrote the `@tool` functions. MCP is just a more interoperable place to run them, and moving from a bound tool list to a called-over-a-wire server is the same conceptual shift as choosing [MCP over OpenAPI plugins or bespoke tool calling](/2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents/) in the first place.

### Source links

- [`langchain-mcp-adapters` on GitHub](https://github.com/langchain-ai/langchain-mcp-adapters)
- [Model Context Protocol with LangChain (official docs)](https://docs.langchain.com/oss/python/langchain/mcp)
- [`langchain-mcp-adapters` on PyPI](https://pypi.org/project/langchain-mcp-adapters/)
- [MCP Python SDK on GitHub](https://github.com/modelcontextprotocol/python-sdk)
- [`create_agent` reference](https://reference.langchain.com/python/langchain/agents/factory/create_agent)
- [MCP specification, 2025-11-25 revision](https://modelcontextprotocol.io/)
