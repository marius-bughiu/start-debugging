---
title: "How to Build a Custom MCP Server in Python with the Official SDK"
description: "Build a working Model Context Protocol server in Python using the official mcp 1.27 SDK and FastMCP. Covers Pydantic schemas, the stdio stdout trap, mcp dev / mcp install, and registration with Claude Desktop and Claude Code."
pubDate: 2026-04-25
tags:
  - "mcp"
  - "ai-agents"
  - "python"
  - "claude-code"
---

The Python ecosystem has the deepest catalogue of "thing I want my agent to use": SQLAlchemy ORMs, pandas dataframes, scikit-learn pipelines, AWS boto3 clients, internal scripts your data team already wrote. Wrapping any of that as a Model Context Protocol server takes 30 lines with the official SDK, and the result is callable from Claude Desktop, Claude Code, Cursor, and any client that speaks the MCP spec.

This guide builds a real, runnable Python MCP server using the `mcp` 1.27.0 SDK (released April 2026) on Python 3.10+, with `FastMCP` as the high-level API. By the end you will have a `db-mcp` server that exposes a SQLite database to an agent through three tools, with proper Pydantic schemas, error handling, and the two debug commands (`mcp dev` and `mcp install`) that the docs glance over but you will use every day.

## Why Python is the right choice for this kind of server

The TypeScript SDK is fine. The C# SDK is fine. But if the system you want to expose is already a Python script, a FastAPI app, or a notebook export, rewriting it in another language to bolt MCP onto it is wasted work. The Python SDK lets you put `@mcp.tool()` on top of an existing function and ship.

Two specific cases where Python wins decisively:

- **Data tooling.** Anything involving pandas, NumPy, DuckDB, Polars, or a SQL ORM is a one-decorator change in Python. Doing the same in TypeScript means re-implementing the data layer or shelling out.
- **ML / LLM glue code.** If the tool itself calls an LLM (e.g. a RAG retriever, a re-ranker, a small classifier), the libraries already live in Python. Wrapping them as MCP tools keeps the call graph in one process.

The official SDK is at [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk). Note that **FastMCP 1.0 was merged into this official SDK in late 2024**. There is also a separate, third-party `fastmcp` package on PyPI (currently 3.x) that is a different project. For new code, prefer the official `mcp` package and import `FastMCP` from `mcp.server.fastmcp`. Mixing the two leads to subtle import errors and version drift.

## Project setup with uv

You need Python 3.10 or later. The 1.27 SDK supports 3.10 through 3.13. The recommended package manager in the SDK docs is `uv` because it powers the `mcp install` and `mcp dev` commands, but `pip` works for the install step itself.

```bash
# Python 3.10+, uv 0.5+
mkdir db-mcp
cd db-mcp
uv init
uv add "mcp[cli]"
```

The `[cli]` extra pulls in the `mcp` command-line tool that gives you `mcp dev` and `mcp install`. Without it, you can still run the server, but the inspector and Claude Desktop registration commands will not exist.

Create the source file:

```bash
mkdir src
touch src/server.py
```

Add a SQLite seed script (`seed.py`) so the example has data to query. This is just for the demo, not part of the server:

```python
# seed.py -- creates a sample SQLite DB for the MCP server to expose
import sqlite3

conn = sqlite3.connect("inventory.db")
cur = conn.cursor()
cur.executescript("""
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO products (sku, name, stock) VALUES
  ('SKU-001', 'Mechanical keyboard', 12),
  ('SKU-002', 'Trackball mouse', 0),
  ('SKU-003', 'USB-C dock', 4);
""")
conn.commit()
conn.close()
```

Run `python seed.py` once. The MCP server will read this file in read-only mode.

## The stdout trap that breaks every Python stdio server

Before writing a single tool handler, internalize this: **never print to stdout in a stdio MCP server**.

When a stdio MCP server starts, the client (Claude Desktop, Claude Code, Cursor) communicates with it over `stdin` and `stdout` using line-delimited JSON-RPC. Any byte you write to stdout that is not a valid JSON-RPC message corrupts the stream. The client logs a generic "MCP server disconnected" or "failed to parse response" error and gives up.

In Python the offenders are obvious once you know to look for them:

```python
# mcp 1.27.0, stdio transport

# Bad -- corrupts the JSON-RPC stream
print("Loaded 47 rows from inventory.db")

# Bad -- logging.basicConfig() defaults to stderr in modern Python,
# but if you reroute it to stdout you have the same problem
import logging
logging.basicConfig(stream=sys.stdout)  # do not do this

# Good -- write diagnostics to stderr
import sys
print("Loaded 47 rows from inventory.db", file=sys.stderr)

# Good -- the standard logging module defaults to stderr
import logging
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("db-mcp")
log.info("Loaded 47 rows from inventory.db")
```

The reason this catches Python authors more often than TypeScript authors: `print()` is the default debug instrument in Python, and a stray one inside a tool handler does not crash anything locally. You only see the failure when the MCP client tries to parse the response and finds garbage in front of the JSON. Add `file=sys.stderr` everywhere you would normally `print()`, and use `logging` for anything structured.

## The minimal server with FastMCP

Open `src/server.py`. Start with a one-tool server to confirm the wiring works:

```python
# src/server.py
# mcp 1.27.0, Python 3.10+, MCP spec 2025-03-26

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("db-mcp")

@mcp.tool()
def ping() -> str:
    """Return 'pong' to confirm the server is reachable."""
    return "pong"

if __name__ == "__main__":
    mcp.run(transport="stdio")
```

That is the entire surface area required for a working server. The decorator infers the input schema from the type hints (none here) and the description from the docstring. `mcp.run(transport="stdio")` blocks the process and reads JSON-RPC messages from stdin until the client disconnects.

Test it without configuring any client by running the inspector:

```bash
uv run mcp dev src/server.py
```

`mcp dev` launches the server, attaches the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) UI on localhost, and shows you the raw JSON-RPC traffic. You can call `ping`, see the response, and confirm there is no stray output corrupting the stream. This is the single most useful command in the SDK and the docs bury it in a sub-page.

## Real tools with Pydantic schemas

Replace the `ping` placeholder with three useful tools backed by Pydantic models. The SDK uses Pydantic for both input validation and structured output, which is what makes the tool schemas robust without writing JSON Schema by hand:

```python
# src/server.py
# mcp 1.27.0, Pydantic 2.x

import sqlite3
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, Field
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("db-mcp")

DB_PATH = Path(__file__).parent.parent / "inventory.db"

class Product(BaseModel):
    """A row from the products table."""
    id: int
    sku: str
    name: str
    stock: int = Field(description="Units currently in stock")

class StockUpdate(BaseModel):
    """Result of a stock-adjustment call."""
    sku: str
    previous_stock: int
    new_stock: int

def _connect() -> sqlite3.Connection:
    # Open read/write but with a timeout so a long write doesn't wedge the agent
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn

@mcp.tool()
def list_products(
    low_stock: Annotated[
        bool,
        Field(description="If true, return only products with stock < 5."),
    ] = False,
) -> list[Product]:
    """List products in the inventory database."""
    with _connect() as conn:
        if low_stock:
            rows = conn.execute(
                "SELECT id, sku, name, stock FROM products WHERE stock < 5"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, sku, name, stock FROM products"
            ).fetchall()
        return [Product(**dict(r)) for r in rows]

@mcp.tool()
def get_product(
    sku: Annotated[str, Field(description="Stock-keeping unit, e.g. SKU-001")],
) -> Product:
    """Look up a single product by SKU."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, sku, name, stock FROM products WHERE sku = ?",
            (sku,),
        ).fetchone()
        if row is None:
            raise ValueError(f"No product found with sku={sku!r}")
        return Product(**dict(row))

@mcp.tool()
def adjust_stock(
    sku: Annotated[str, Field(description="SKU to adjust")],
    delta: Annotated[
        int,
        Field(
            description="Positive to add stock, negative to remove. "
                        "Tool will refuse to drive stock below zero.",
        ),
    ],
) -> StockUpdate:
    """Adjust stock for a SKU by a positive or negative delta."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT stock FROM products WHERE sku = ?", (sku,)
        ).fetchone()
        if row is None:
            raise ValueError(f"No product found with sku={sku!r}")
        previous = row["stock"]
        new = previous + delta
        if new < 0:
            raise ValueError(
                f"Refusing to set stock below zero (would be {new})."
            )
        conn.execute(
            "UPDATE products SET stock = ? WHERE sku = ?", (new, sku)
        )
        conn.commit()
        return StockUpdate(sku=sku, previous_stock=previous, new_stock=new)

if __name__ == "__main__":
    mcp.run(transport="stdio")
```

A few details that matter:

- **`Annotated[T, Field(...)]` over plain defaults.** The SDK uses `Field(description=...)` to populate the JSON Schema description that the agent sees when deciding which tool to call. A vague description like "the SKU" gets confused with arbitrary strings; "Stock-keeping unit, e.g. SKU-001" anchors the agent to the right format.
- **Pydantic models as return types.** `list[Product]` and `StockUpdate` are converted to structured output automatically. The client receives both a JSON document and a human-readable text rendering, and a downstream agent can reason about typed fields directly. If you returned a plain `dict`, the SDK would still serialise it, but the agent loses the schema and any type guarantees.
- **`raise ValueError` for tool-level errors.** FastMCP catches the exception and returns it as a tool error to the client, which the agent can see and react to. You do not need to construct `CallToolResult` objects by hand for the common case. Reserve manual `CallToolResult` construction for cases where you need to set fields like `isError` alongside extra metadata.
- **Parameterised SQL only.** `?` placeholders, never f-strings. An LLM will happily pass a SKU like `'; DROP TABLE products; --` if the tool is exposed to user input upstream, and `sqlite3` will treat the parameterised version as a literal string instead of running it.

## Wiring it to Claude Desktop

You have two paths. The simple one uses the SDK's own `mcp install` command:

```bash
uv run mcp install src/server.py --name "Inventory DB"
```

This patches the Claude Desktop config for you and points it at the server with the right `uv run` invocation, including the working directory. If you need environment variables (an API key, a database URL, anything secret), pass them with `-v`:

```bash
uv run mcp install src/server.py --name "Inventory DB" \
  -v DB_URL=postgres://... -v API_KEY=abc123
```

If you prefer to manage the config by hand, edit `claude_desktop_config.json`. On macOS it lives at `~/Library/Application Support/Claude/claude_desktop_config.json`; on Windows at `%AppData%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "inventory-db": {
      "command": "uv",
      "args": [
        "--directory",
        "/absolute/path/to/db-mcp",
        "run",
        "python",
        "src/server.py"
      ]
    }
  }
}
```

Restart Claude Desktop. The MCP indicator should list `list_products`, `get_product`, and `adjust_stock`. Ask: "Which products are low on stock?" and watch Claude call `list_products(low_stock=True)`.

To wire it to Claude Code, run from the project directory:

```bash
claude mcp add inventory-db -- uv run python src/server.py
```

Or add the same `mcpServers` block to `.claude/settings.json` under the project root.

## Gotchas in production Python servers

**Async tools when you need them.** The handlers above are sync. FastMCP also accepts `async def` handlers, which is the right choice when the tool calls a remote API (httpx) or another LLM. Mixing sync and async is fine: do not wrap a synchronous library in `asyncio.to_thread` unless it actually blocks.

**Working directory surprises.** When Claude Desktop spawns the server, the process working directory is wherever Claude Desktop launched it from, not your project. Anchor file paths using `Path(__file__).parent` (as in the example) or pass absolute paths through tool arguments. Relying on `os.getcwd()` will break the moment the user opens a different chat session.

**Virtual environment isolation.** If the Claude Desktop config invokes plain `python`, it uses whatever Python is on the system PATH, not your project's `.venv`. The `uv run python ...` form solves this: `uv` resolves the project's environment from `pyproject.toml` and runs the right interpreter every time. Hand-rolled configs that point at `python3` directly will fail the first time you add a dependency.

**Large query results.** Returning a million rows as a list of Pydantic models will hit the client's content-size limit and stall. Either paginate with explicit `limit` and `offset` parameters, or summarise (count, aggregate) in the tool and let the agent ask follow-ups. The MCP spec does not enforce a hard ceiling, but practical client limits sit around a few hundred KB of structured content.

**Concurrency.** SQLite serialises writes by default. If two tool calls fire `adjust_stock` simultaneously and one holds a write lock past the 5-second `timeout`, the other raises `OperationalError: database is locked`. For real workloads, switch to PostgreSQL or use a connection pool. For local agent demos, the 5-second timeout in `_connect()` is enough.

**Streaming HTTP transport.** The SDK supports `transport="streamable-http"` and the older `transport="sse"` for remote deployments. If you plan to run the server as a long-lived service rather than spawn it per-client, switch transports here and put the server behind a reverse proxy. For local agent work, stdio is correct.

## What this pattern unlocks

The core move -- decorate a function, return a Pydantic model, raise on errors -- scales to every Python integration your team already has. A few easy next steps:

- Wrap a SQLAlchemy session and expose schema introspection plus a parameterised `query` tool, so an agent can answer "how many orders shipped last week" without you writing the SQL.
- Wrap an internal LLM-pipeline you already deploy (RAG retrievers, classifiers) and let other agents call it as a tool instead of re-implementing it.
- Wrap a notebook-shaped script the data team uses (load CSV, run the model, dump the report) into a tool the on-call agent can invoke during incident response.

If you primarily work in TypeScript, [the same pattern in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) covers the Node.js side with `@modelcontextprotocol/sdk` 1.29. On the .NET side, [Microsoft's MCP wiring for Model Context Protocol servers from C# on .NET 10](/2026/01/microsoft-mcp-wiring-model-context-protocol-servers-from-c-on-net-10/) shows the C# equivalent. For a sense of how MCP looks when an IDE bundles servers natively, [the Azure MCP Server inside Visual Studio 2022 17.14.30](/2026/04/azure-mcp-server-visual-studio-2022-17-14-30/) is a useful real-world reference. And if you are looking past raw MCP into multi-agent orchestration, [Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) is the SDK that picks up where MCP leaves off.

The MCP server itself does not care whether your tool wraps a database, a REST client, or a 200-line pandas pipeline. It only needs a typed input schema (Pydantic gives you that for free), a return value the SDK can serialise, and a transport that does not have stray bytes in it.

## Source links

- [MCP Python SDK -- modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk)
- [mcp 1.27.0 on PyPI](https://pypi.org/project/mcp/)
- [Official MCP build-server guide](https://modelcontextprotocol.io/docs/develop/build-server)
- [MCP spec (2025-03-26)](https://spec.modelcontextprotocol.io)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
