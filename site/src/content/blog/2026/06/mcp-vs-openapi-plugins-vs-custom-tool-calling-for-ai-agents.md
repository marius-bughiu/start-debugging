---
title: "MCP vs OpenAPI Plugins vs Custom Tool Calling for AI Agents: Which Should You Pick in 2026?"
description: "Use custom tool calling for one app you own end to end, MCP for any integration you want reused across Claude Code, Cursor, and ChatGPT, and OpenAPI plugins only as a bridge when you already have a spec. MCP is the cross-client standard in 2026; plugins are legacy."
pubDate: 2026-06-04
template: vs
tags:
  - "comparison"
  - "mcp"
  - "llm"
  - "ai-agents"
  - "anthropic-sdk"
  - "tool-calling"
---

When you give a model the ability to do something, not just say something, you are choosing one of three wiring patterns: hand the model a list of JSON-schema tools directly (custom tool calling), point it at an OpenAPI-described REST API behind a manifest (the ChatGPT plugin / GPT Actions style), or put your capabilities behind a Model Context Protocol server. They all compile down to the same primitive: the model emits a structured call, your code runs it, you feed the result back. The differences are about who owns the contract, how many clients can reuse it, and how much of your context window the tool definitions eat. The short answer: **use custom tool calling when you control both the model loop and the tools in a single app, use MCP when you want the same integration to work in Claude Code, Cursor, Claude Desktop, and ChatGPT without rewriting it, and reach for OpenAPI plugins only when you already have an OpenAPI spec and want a quick bridge. In 2026, MCP has won the cross-client story and OpenAI's own plugin format is deprecated.**

Everything below is pinned to versions current as of June 4, 2026: the Anthropic Messages API with `claude-opus-4-8` and `claude-sonnet-4-6`, the MCP specification revision `2025-11-25` (the first-anniversary release, with the much larger `2026-07-28` revision currently a release candidate announced May 21, 2026), and OpenAI's Responses API, which replaced the retired ChatGPT plugin and GPT Actions surfaces.

## Three answers to the same question

Every one of these patterns answers "how does a language model invoke my code?" The model never executes anything itself. It produces a structured request, your harness dispatches it, and the result goes back into the conversation. What changes is where the description of "what can be called" lives:

- **Custom tool calling**: the descriptions live in your application code, passed inline on every API request as a `tools` array of JSON schemas.
- **OpenAPI plugins**: the descriptions live in an `ai-plugin.json` manifest plus an OpenAPI document, hosted at a URL, and the client ingests both at install time.
- **MCP**: the descriptions live in a server that any compliant client can connect to and query with `tools/list` at runtime.

Hold that distinction while you read the matrix, because it explains every row.

## The feature matrix

| Feature | Custom tool calling | OpenAPI plugins | MCP |
| --- | --- | --- | --- |
| Where the contract lives | Inline in your code, per request | `ai-plugin.json` + OpenAPI doc at a URL | A server, queried via `tools/list` |
| Reused across clients | No, single app | Was ChatGPT-only; now deprecated | Yes: Claude Code, Cursor, Claude Desktop, ChatGPT, VS Code |
| Transport | Your API calls | HTTPS REST | stdio, Streamable HTTP |
| Statefulness | Whatever you build | Stateless HTTP | Stateless core in `2026-07-28`; sessions optional |
| Beyond "call a function" | No | No | Tools, resources, prompts, sampling, server UIs |
| Context cost | You curate exactly | Whole spec becomes tools | You curate; can still bloat |
| Auth model | Yours | API-key / OAuth in manifest | OAuth 2.1 aligned in `2025-11-25`+ |
| Status in 2026 | Stable primitive | Deprecated by OpenAI | De facto standard, shipping in every IDE |
| Best when | One app, both ends yours | You already have an OpenAPI spec | Integration reused across tools |

## Custom tool calling: the primitive everything else compiles to

If you call the Anthropic Messages API and pass a `tools` array, you are doing custom tool calling. You write a JSON schema for each tool, the model decides when to emit a `tool_use` block, and you run the loop yourself.

```python
# anthropic 0.49.x, model claude-opus-4-8, June 2026
import anthropic

client = anthropic.Anthropic()

tools = [
    {
        "name": "get_invoice",
        "description": "Fetch an invoice by its ID. Returns line items and totals.",
        "input_schema": {
            "type": "object",
            "properties": {
                "invoice_id": {"type": "string", "description": "The invoice ID, e.g. INV-2026-0042"}
            },
            "required": ["invoice_id"],
        },
    }
]

resp = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    tools=tools,
    messages=[{"role": "user", "content": "What's the total on INV-2026-0042?"}],
)

# resp.content contains a tool_use block; you dispatch it, then send a
# tool_result back in the next messages.create call to continue the loop.
```

The whole contract is those three keys: `name`, `description`, `input_schema`. The model picks tools based almost entirely on the descriptions and the schema, which is exactly why the [tool call arguments did not match schema error](/2026/05/fix-tool-call-arguments-did-not-match-schema-in-anthropic-tool-use/) is a schema problem far more often than a prompt problem. Custom tool calling gives you total control: you decide which tools are in context, you can swap them per turn, and there is no extra hop. The cost is that none of it is portable. The next app, or the next IDE, sees nothing. You ship the loop, the schemas, the dispatch, and the error handling again.

This is the right pattern when the model loop and the tools live in the same codebase and you have no intention of exposing them to another client. A support bot that calls your billing service, a RAG endpoint that fetches documents, an internal agent embedded in your product: custom tool calling, every time. If you are on .NET, the same idea wears a different coat through the abstraction in [adding tool calling to a Microsoft.Extensions.AI chat client](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/), where `[Description]`-annotated C# methods become the schema.

## OpenAPI plugins: describe the API once, let the model read the spec

The ChatGPT plugin model, and its successor GPT Actions, took a different bet: you already have a REST API documented with OpenAPI, so let the model consume that spec directly. You host a manifest and point it at your OpenAPI document.

```json
// ai-plugin.json - the ChatGPT plugin manifest (now deprecated)
{
  "schema_version": "v1",
  "name_for_model": "billing",
  "name_for_human": "Acme Billing",
  "description_for_model": "Look up invoices and payment status by invoice ID.",
  "description_for_human": "Check your Acme invoices.",
  "auth": { "type": "service_http", "authorization_type": "bearer" },
  "api": { "type": "openapi", "url": "https://acme.example/openapi.yaml" }
}
```

The model reads `description_for_model` plus every `operationId`, summary, and parameter description in the OpenAPI document, and from that decides which endpoint to call. The appeal is real: if you maintain an honest OpenAPI spec, you get model access almost for free, and the same spec keeps powering your SDKs and docs.

The problem is twofold. First, OpenAI deprecated this entire surface. ChatGPT plugins were retired and GPT Actions was pulled from the GPT builder; the official direction is the Responses API with built-in tools and the Agents SDK, which underneath is custom tool calling. So building new on the plugin format means building on a dead standard. Second, the spec-becomes-tools translation is lossy in the expensive direction: a 60-endpoint OpenAPI document turns into 60 tools, and a real-world spec carries verbose descriptions and nested schemas that balloon the context. You rarely want all 60 in front of the model at once. This is the same context-bloat failure mode that makes [reducing the number of MCP tools the model loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/) a recurring chore.

OpenAPI-as-tools is still defensible as a bridge: if you have a clean spec and want a quick agent over it, tooling exists to project an OpenAPI document into a tool list at runtime, filtering to the handful of operations you actually need. Treat it as a generator for custom tool calling, not as a client-facing integration standard.

## MCP: tool calling, but the contract lives in a server

MCP keeps the same call-and-return primitive but moves the contract out of your app and into a server that any client can connect to. The client calls `tools/list` to discover what is available and `tools/call` to invoke. Because the protocol is the same everywhere, one server works in Claude Code, Cursor, Claude Desktop, VS Code, and ChatGPT.

```typescript
// @modelcontextprotocol/sdk 1.x, MCP spec revision 2025-11-25, June 2026
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "acme-billing", version: "1.0.0" });

server.tool(
  "get_invoice",
  "Fetch an invoice by its ID. Returns line items and totals.",
  { invoice_id: z.string().describe("The invoice ID, e.g. INV-2026-0042") },
  async ({ invoice_id }) => {
    const invoice = await fetchInvoice(invoice_id);
    return { content: [{ type: "text", text: JSON.stringify(invoice) }] };
  }
);

await server.connect(new StdioServerTransport());
```

Look at the tool definition: a name, a description, and a Zod schema that serializes to the same JSON schema the Anthropic example passed inline. MCP did not invent a new way to describe a tool. It standardized where the description lives and how a client fetches it, then added capabilities that custom tool calling and OpenAPI plugins never had: **resources** (read-only context the client can pull in), **prompts** (reusable prompt templates the server exposes), and, in the `2026-07-28` release candidate, server-rendered UIs through MCP Apps and long-running work through the Tasks extension.

The 2026 revisions also fixed the operational pain. The `2025-11-25` spec aligned authorization with OAuth 2.1, and the upcoming `2026-07-28` revision makes the core stateless so a server runs on ordinary HTTP infrastructure behind a load balancer instead of needing a sticky session per client. That removes the single biggest reason teams used to avoid MCP for anything beyond a local stdio process. If you want to see the server side end to end, [building a custom MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) walks the full loop, and [exposing an EF Core database to an agent via MCP](/2026/05/how-to-expose-an-ef-core-database-to-an-ai-agent-via-mcp/) shows the same pattern guarding a real data source.

## The cost that actually differs: tokens, not transport

There is no benchmark that says one of these "runs faster" in any meaningful sense; a tool call is a tool call, and the network hop to your function dominates. The measurable cost difference is tokens, and it is real. Every tool definition you expose is injected into the model's context on every request, and you pay for those input tokens each turn.

- **Custom tool calling**: you pass exactly the schemas you choose. A 5-tool agent injects 5 schemas. You can drop tools the model does not need for a given turn. Tightest by construction.
- **OpenAPI plugins**: the whole described surface becomes tools. A large spec injects dozens of operations with verbose descriptions, and you have little say in pruning. This is where naive plugin usage gets expensive, especially with prompt caching off, where the schemas are re-billed every turn instead of cached.
- **MCP**: better than the plugin default because you choose which servers to connect, but a chatty server still floods the list. Real installs routinely hit the tool-use ceiling, which is exactly why [the tool-use limit error](/2026/05/fix-claude-reached-its-tool-use-limit-for-this-turn/) shows up mid-task. The fix is curation: expose fewer, coarser tools.

The lever that matters across all three is prompt caching. Tool definitions are stable across turns, so they belong in a cache breakpoint. With caching on, those schema tokens are billed at the reduced cache-read rate after the first turn, which turns "the spec is huge" from a per-turn tax into a one-time cost.

## The gotcha that picks for you

Two constraints override preference:

- **Reuse across clients forces MCP.** If the same integration has to work in your product and in the developer's Claude Code session and in Cursor, custom tool calling means writing the loop three times and OpenAPI plugins means building on OpenAI's deprecated format. Only MCP gives you write-once, connect-anywhere. This is the single most common reason to choose it.
- **A single embedded app forces custom tool calling.** If the model only ever runs inside your service and no external client will touch the tools, an MCP server is a process, a transport, and a discovery round trip you do not need. Inline schemas are simpler, cheaper, and easier to debug. Do not stand up a server to talk to yourself.

OpenAPI plugins almost never win the tiebreak in 2026. The one honest case is "I already have a maintained OpenAPI spec and want a throwaway agent over a few endpoints," and even then you are better off generating a filtered tool list from the spec and feeding it to custom tool calling.

## The call, restated

Default to **MCP for anything reusable**: it is the same tool-calling primitive with a standardized contract, OAuth-aligned auth, and a stateless HTTP story landing in `2026-07-28`, and every major agent and IDE speaks it. Default to **custom tool calling for a single app you own end to end**, because a server you only talk to yourself is pure overhead. Use **OpenAPI plugins only as a bridge** over an existing spec, knowing the client-facing format is deprecated and that the spec is best treated as a source to generate a curated tool list, not as an integration standard. Whichever you pick, the win condition is the same: keep the tool surface small and cache the definitions, because the tokens you spend describing tools are tokens you spend on every single turn.

## Related

- [How to build a custom MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/)
- [How to expose an EF Core database to an AI agent via MCP](/2026/05/how-to-expose-an-ef-core-database-to-an-ai-agent-via-mcp/)
- [How to add tool calling to a Microsoft.Extensions.AI chat client](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/)
- [How to reduce the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/)
- [Fix: Tool call arguments did not match schema in Anthropic tool use](/2026/05/fix-tool-call-arguments-did-not-match-schema-in-anthropic-tool-use/)

## Sources

- [The 2026-07-28 MCP Specification Release Candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/), Model Context Protocol blog
- [The 2026 MCP Roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/), Model Context Protocol blog
- [Anthropic tool use documentation](https://docs.anthropic.com/en/docs/build-with-claude/tool-use), Anthropic
- [ChatGPT plugins (deprecated)](https://github.com/openai/chatgpt-retrieval-plugin/blob/main/docs/deprecated/plugins.md), OpenAI
- [OpenAI API deprecations](https://developers.openai.com/api/docs/deprecations), OpenAI
