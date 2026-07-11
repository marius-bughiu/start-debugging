---
title: "Migrate a Custom Tool-Calling Loop to an MCP Server (TypeScript, 2026)"
description: "A step-by-step checklist for lifting a hand-rolled Anthropic tool-calling loop onto a standalone MCP server. The tool bodies move almost verbatim; what changes is where the schema comes from, how results are wrapped, and how errors cross the process boundary."
pubDate: 2026-07-11
updatedDate: 2026-07-11
template: migration
tags:
  - "migration"
  - "mcp"
  - "ai-agents"
  - "llm"
  - "anthropic-sdk"
  - "typescript"
  - "tool-calling"
---

If you shipped an AI agent in 2025 without a framework, it almost certainly has a `while` loop at its core: call the Messages API, look for `tool_use` blocks, dispatch each one to a local function in a `Record<string, Function>`, push the results back, repeat until the model stops asking. That loop is the fastest way to get a working agent, and it stays fine right up until a second consumer wants the same tools. Nobody else can call your functions, because they only exist as closures inside your process. **MCP is the contract that makes them callable from anywhere**, and moving your tools onto it is smaller than it looks: the function bodies barely change. What changes is where the tool schema comes from, how a result is wrapped, and how an error crosses the process boundary.

This post is the migration checklist for a real hand-rolled loop built on the **Anthropic TypeScript SDK `@anthropic-ai/sdk` 0.110.0** (published July 2, 2026), moving its tools onto a standalone server built with the **MCP TypeScript SDK `@modelcontextprotocol/sdk` 1.20.x**, which implements the finalized **`2025-11-25`** spec revision. The v2 beta targeting the **`2026-07-28`** revision is out (the release candidate locked May 21, 2026), but v1.x is the production line, so that is what these examples pin. Model calls use `claude-sonnet-4-6`. The short version: for a handful of tools this is a half-day job, the tool logic moves nearly verbatim, and the one thing that genuinely breaks is that a tool call stops being a local function call and becomes a serialized request to another process.

## Why bother when the loop already works

A local tool is first-class inside one Node process: the loop dispatches it, the model sees its schema, and the call runs on the same event loop with access to every closure and module the loop can reach. None of that travels. Concretely, extracting the tools onto MCP buys you:

- **Reuse across clients.** The same `get_stock_level` tool becomes callable from Claude Code, Cursor, VS Code's MCP client, Claude Desktop, and any other agent, not just your one script. This is the whole reason MCP exists, and it is the same argument that applies when teams [migrate a Semantic Kernel plugin to an MCP server](/2026/05/migrate-a-semantic-kernel-plugin-to-an-mcp-server/): the moment a second agent wants your tools, MCP is the answer.
- **Process and deploy isolation.** The tools version, restart, and scale on their own schedule, decoupled from the loop's prompt orchestration. A crash in a tool no longer takes down the agent.
- **A language boundary.** The server can be TypeScript today and Go tomorrow. The loop never notices, because it only ever sees JSON-RPC over a transport.

The cost is that a tool call is now a request to another process, which changes the error model, the concurrency model, and what data can cross. If you are still deciding whether MCP is even the right shape for your case, the tradeoffs are laid out in [MCP vs OpenAPI plugins vs custom tool calling](/2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents/). This post assumes you have decided, and just want the cutover checklist.

## The loop we are migrating

Here is the shape almost every hand-rolled agent has somewhere: a tool registry, a JSON-schema `tools` array declared by hand, and a loop that dispatches `tool_use` blocks.

```typescript
// @anthropic-ai/sdk 0.110.0, Node 22+, ESM
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// 1. The tools, as local functions.
const registry: Record<string, (args: any) => Promise<string>> = {
  async get_stock_level({ sku }) {
    const r = await fetch(`https://inventory.internal/stock/${sku}`);
    const { quantity } = await r.json();
    return String(quantity);
  },
  async reserve({ sku, quantity }) {
    const r = await fetch("https://inventory.internal/reserve", {
      method: "POST",
      body: JSON.stringify({ sku, quantity }),
    });
    const { reservation_id } = await r.json();
    return reservation_id;
  },
};

// 2. The schema, declared by hand for the model.
const tools: Anthropic.Tool[] = [
  {
    name: "get_stock_level",
    description: "Look up stock level for a SKU across all warehouses.",
    input_schema: {
      type: "object",
      properties: { sku: { type: "string" } },
      required: ["sku"],
    },
  },
  {
    name: "reserve",
    description: "Reserve stock for an order. Returns the reservation id.",
    input_schema: {
      type: "object",
      properties: { sku: { type: "string" }, quantity: { type: "number" } },
      required: ["sku", "quantity"],
    },
  },
];

// 3. The loop.
const messages: Anthropic.MessageParam[] = [
  { role: "user", content: "How many SKU-1042 are in stock?" },
];

while (true) {
  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    tools,
    messages,
  });
  messages.push({ role: "assistant", content: res.content });

  if (res.stop_reason !== "tool_use") break;

  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const block of res.content) {
    if (block.type !== "tool_use") continue;
    const output = await registry[block.name](block.input);
    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: output,
    });
  }
  messages.push({ role: "user", content: results });
}
```

Three things are entangled here that MCP is about to pull apart: the tool bodies (registry), the schema (`tools`), and the dispatch (the `for` loop). After the migration, the bodies and schema live in the server, and the loop asks the server for both.

## What breaks

| Area | In the loop | After MCP | Severity |
| --- | --- | --- | --- |
| Tool dispatch | Direct function call, same process | JSON-RPC `tools/call` to another process | high |
| Tool schema | Hand-written `input_schema` JSON | Generated from a Zod shape via `tools/list` | medium |
| Return value | Any string you return | Must be `{ content: [...] }`, read back out | medium |
| Shared state | Closures, module globals, db handles | Gone; pass via env or tool arguments | high |
| Errors | A thrown error bubbles in-process | Must be returned as `isError: true` or the turn stalls | high |
| Startup | One process | Client spawns/connects the server first | low |

The two high-severity rows that bite hardest are **shared state** and **errors**, and both get their own gotcha below.

## Pre-flight checklist

- Node 22 or newer, ESM (`"type": "module"` in `package.json`). The MCP SDK ships ESM-only.
- `npm install @modelcontextprotocol/sdk zod`. The server SDK has a required peer dependency on `zod` for input validation.
- An inventory of every tool in your registry and, for each, exactly what external state its body touches (network, filesystem, database handle, auth token). Anything it currently reaches through a closure has to become an explicit input or an environment variable.
- Keep the loop running on the old registry until Step 3 verifies, so you can diff behavior.

## The migration, step by step

### 1. Scaffold the MCP server

Create `server.ts`. The v1 SDK entry point is `McpServer`, imported from the `server/mcp.js` subpath. Nothing is exposed yet.

```typescript
// @modelcontextprotocol/sdk 1.20.x, spec 2025-11-25, Node 22+
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "inventory", version: "1.0.0" });

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Verify**: `node --experimental-strip-types server.ts` should start and hang (stdio servers block on stdin, waiting for a client). No error means the transport is wired. Kill it with Ctrl+C.

### 2. Move each tool body into `registerTool`

This is the verbatim part. `registerTool` takes the name, a metadata object whose `inputSchema` is a **Zod shape** (a plain object of Zod validators, not `z.object(...)`), and an async handler. The handler body is the same code that was in your registry; only the return shape changes to `{ content: [...] }`.

```typescript
server.registerTool(
  "get_stock_level",
  {
    title: "Get stock level",
    description: "Look up stock level for a SKU across all warehouses.",
    inputSchema: { sku: z.string() },
  },
  async ({ sku }) => {
    const r = await fetch(`https://inventory.internal/stock/${sku}`);
    const { quantity } = await r.json();
    return { content: [{ type: "text", text: String(quantity) }] };
  },
);

server.registerTool(
  "reserve",
  {
    title: "Reserve stock",
    description: "Reserve stock for an order. Returns the reservation id.",
    inputSchema: { sku: z.string(), quantity: z.number() },
  },
  async ({ sku, quantity }) => {
    const r = await fetch("https://inventory.internal/reserve", {
      method: "POST",
      body: JSON.stringify({ sku, quantity }),
    });
    const { reservation_id } = await r.json();
    return { content: [{ type: "text", text: reservation_id }] };
  },
);
```

Notice you deleted the hand-written `input_schema` JSON entirely. The server now derives the JSON Schema the model sees from the Zod shape, so the schema and the validation can never drift apart again.

**Verify**: restart the server and, from a scratch client (or the MCP Inspector), call `tools/list`. Both tools should come back with `inputSchema` populated as JSON Schema, `sku` and `quantity` typed correctly.

### 3. Point an MCP client at the server

In the loop's file, replace the local `registry` with an MCP `Client` that spawns the server over stdio. `StdioClientTransport` launches the process for you.

```typescript
// @modelcontextprotocol/sdk 1.20.x
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcp = new Client({ name: "agent-loop", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: ["--experimental-strip-types", "server.ts"],
});
await mcp.connect(transport);
```

**Verify**: `console.log(await mcp.listTools())` from the loop prints both tool definitions. If it hangs, jump to the stdio gotcha below.

### 4. Generate the model-facing `tools` array from `tools/list`

The hand-written `tools` array is now redundant. Build it from the server's advertised tools, mapping MCP's `inputSchema` onto Anthropic's `input_schema`.

```typescript
const { tools: mcpTools } = await mcp.listTools();
const tools: Anthropic.Tool[] = mcpTools.map((t) => ({
  name: t.name,
  description: t.description ?? "",
  input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
}));
```

Both sides speak JSON Schema, so this is a rename, not a translation. Add a tool to the server and it appears in the model's tool list on the next run with no loop change.

**Verify**: the `tools` array has the same two entries with identical schemas to what you hand-wrote before. Diff them.

### 5. Dispatch `tool_use` through `callTool` and unwrap the result

The `for` loop changes only in its middle line: instead of `registry[block.name](block.input)`, call the server and pull the text back out of `result.content`.

```typescript
for (const block of res.content) {
  if (block.type !== "tool_use") continue;
  const result = await mcp.callTool({
    name: block.name,
    arguments: block.input as Record<string, unknown>,
  });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  results.push({
    type: "tool_result",
    tool_use_id: block.id,
    content: text,
    is_error: result.isError === true,
  });
}
```

`callTool` returns `{ content, isError, structuredContent }`. For a text tool you join the `text` blocks; if you later add an `outputSchema` to a tool, its typed JSON arrives in `structuredContent` and you can forward that instead.

**Verify**: run the full loop against the same prompt you used before the migration. The model's final answer should be identical to the pre-MCP run.

### 6. Turn thrown errors into tool results, not crashes

In the old loop, a `fetch` that threw would reject the `await` and, unless you caught it, crash the whole loop. On MCP, an uncaught throw inside a handler is caught by the SDK and returned to the client as an error result, but you should be explicit so the model gets a message it can act on.

```typescript
server.registerTool(
  "reserve",
  { /* ...as above... */ },
  async ({ sku, quantity }) => {
    const r = await fetch("https://inventory.internal/reserve", {
      method: "POST",
      body: JSON.stringify({ sku, quantity }),
    });
    if (!r.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `Reserve failed: HTTP ${r.status}` }],
      };
    }
    const { reservation_id } = await r.json();
    return { content: [{ type: "text", text: reservation_id }] };
  },
);
```

Because Step 5 forwards `isError` into the `tool_result` block's `is_error`, the model sees the failure text and can retry or ask the user, instead of the loop dying on an unhandled rejection.

**Verify**: point `reserve` at a URL that 500s and confirm the loop keeps running and the model reports the failure rather than throwing.

## Post-migration smoke test

Run this checklist once end to end before you delete the old registry:

- `tools/list` returns every tool the loop used to have, with matching schemas.
- The reference prompt produces the same final answer as the pre-MCP loop.
- A deliberately failing tool returns `isError` and the loop survives.
- The server survives a tool that takes several seconds (no client timeout surprises).
- Point a second client (Claude Code, via a `.mcp.json` entry) at the same server and confirm it lists and calls the tools. This is the payoff: the tools now work outside your loop.

## Rollback

This migration is fully reversible and low-risk, because you are not deleting anything until the smoke test passes. Keep the old `registry` and hand-written `tools` array in a branch. If the MCP path misbehaves, revert the loop's Step 3-5 changes and you are back to in-process dispatch in one commit. The server file is additive; it does not touch the old code path. There is no data migration and no schema change on any external system, so rollback is a git revert, not an operation.

## Gotchas we hit

**Never `console.log` in a stdio server.** This is the single most common failure. On stdio transport, stdout *is* the JSON-RPC channel. A stray `console.log` in a tool body writes non-JSON to that stream and the client's parser chokes, usually showing up as the connection silently hanging on `listTools`. Route all diagnostics to `console.error` (stderr) instead. If your server hangs on connect from an editor, this or a crash-on-launch is almost always why; the symptoms and fixes are cataloged in [the MCP server stdio hang writeup](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/).

**Closures do not cross the process boundary.** If a tool body in your old registry closed over a shared database connection, an authenticated HTTP client, or a request-scoped user object, that reference is gone the moment the tool moves to a separate process. The server has to establish its own connection (from an env var or config) and receive any per-call context as an explicit tool argument. Auditing this in the pre-flight step is what keeps Step 2 from being "verbatim except it throws `undefined is not a function`."

**Do not dump a huge internal API surface as one tool per endpoint.** Once tools live in a reusable server it is tempting to expose everything, but every tool definition costs context-window tokens on every request, and past roughly forty tools the model starts mis-selecting. Curate the set, or split into multiple servers the client mounts selectively; the token math is worked through in [how to reduce the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/).

**Pick the transport before you scale.** Stdio is perfect for a local, single-consumer server that the client spawns, which is where most migrations land. The moment you want the server hosted and shared over the network, you move to Streamable HTTP, and that is a different deployment story. If you are unsure which you will need, [the stdio vs HTTP vs SSE breakdown](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) covers when each pays off. Starting on stdio and switching later is cheap; the tool code does not change, only the transport wiring in Steps 1 and 3.

## Related

- [MCP vs OpenAPI plugins vs custom tool calling for AI agents](/2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents/) - the decision this migration assumes you already made.
- [Migrate a LangChain agent to the MCP tool-calling pattern](/2026/07/migrate-a-langchain-agent-to-the-mcp-tool-calling-pattern/) - the same cutover when your starting point is `@tool` and `create_agent` instead of a raw loop.
- [Migrate a Semantic Kernel plugin to an MCP server](/2026/05/migrate-a-semantic-kernel-plugin-to-an-mcp-server/) - the .NET flavor of the same move.
- [How to build an MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) - a from-scratch server if you would rather not lift an existing loop.
- [MCP stdio vs HTTP vs SSE transport: which to choose](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/) - picking the transport your migrated server should speak.

## Sources

- MCP TypeScript SDK, server and client APIs: [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk).
- The finalized spec revision these examples target: [MCP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25).
- The next revision and its stateless core: [The 2026-07-28 MCP Specification Release Candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/).
- Anthropic tool-use loop and `tool_result` shape: [Anthropic tool use documentation](https://platform.claude.com/docs/en/build-with-claude/tool-use).
