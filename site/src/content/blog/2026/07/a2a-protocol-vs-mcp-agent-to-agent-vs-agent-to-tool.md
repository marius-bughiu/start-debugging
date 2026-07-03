---
title: "A2A vs MCP: Agent-to-Agent vs Agent-to-Tool, and Why You Need Both in 2026"
description: "MCP connects one agent to its tools, A2A connects independent agents to each other. They are not competitors. Add MCP first, reach for A2A only when you have multiple separately deployed agents. Here is the wire-level difference and the code."
pubDate: 2026-07-03
template: vs
tags:
  - "mcp"
  - "ai-agents"
  - "a2a"
  - "comparison"
  - "agent-protocols"
---

If you are trying to decide between the Agent2Agent protocol (A2A) and the Model Context Protocol (MCP), stop: they are not alternatives. MCP, on the `2025-11-25` spec revision (with the `2026-07-28` revision now in release candidate), connects a single agent to its tools and data. A2A, which reached `v1.0` under the Linux Foundation and now has SDKs in Python, JavaScript, Java, Go, and .NET, connects independent agents to each other. If you only have one agent, you need MCP and you do not need A2A yet. The moment you have two agents that were built and deployed separately and need to hand work between them, that is when A2A earns its place. Add MCP first. Reach for A2A when, and only when, you have crossed the multi-agent line.

That is the whole decision in one paragraph. The rest of this post is why that is the right call, what each protocol actually puts on the wire, and the exact code for the seam where they meet.

## The one axis that decides it: structured tool vs opaque agent

The cleanest way to keep these two straight is a distinction the A2A spec itself draws. A tool is a primitive with well-defined, structured inputs and outputs. A calculator, a database query, a REST endpoint. You know its schema, it does one thing, and it is usually stateless. An agent is an opaque, autonomous system. It reasons, it plans, it uses several of its own tools, it holds state across a multi-turn exchange, and you do not get to see inside it.

MCP is built for the first case. You expose a `tool` with a JSON schema and the model fills in the arguments. A2A is built for the second. You send another agent a task in natural language plus structured parts, and you do not care how it accomplishes the task, only that it reports back.

The A2A docs use an auto repair shop to make this concrete. When you take your car in, you have an agent-to-agent conversation with the shop manager: you describe a problem ("it makes a noise"), you go back and forth, you agree on work. The manager, in turn, has agent-to-agent conversations with a parts supplier. But when the mechanic actually lifts your car, reads the diagnostic scanner, and looks up the torque spec in a repair manual, those are tool calls: structured, deterministic, single-purpose. The manager-to-supplier and customer-to-manager links are A2A. The mechanic-to-scanner link is MCP.

Map that onto software: A2A is horizontal integration between peers, MCP is vertical integration down to capabilities. Once you see it that way, the "vs" dissolves. A serious multi-agent system runs both at once.

## The feature matrix

| Feature | MCP (`2025-11-25`) | A2A (`v1.0`) |
| --- | --- | --- |
| Connects | one agent to tools/data | agent to agent |
| Governed by | Anthropic + open working group | Linux Foundation (from Google) |
| Core primitives | tools, resources, prompts | Agent Card, Task, Message, Artifact |
| Discovery | client config / registry | `/.well-known/agent-card.json` |
| Transport | stdio, Streamable HTTP | JSON-RPC 2.0, gRPC, HTTP+JSON |
| Wire format | JSON-RPC 2.0 | JSON-RPC 2.0 (default) |
| Streaming | Streamable HTTP + SSE | `message/stream` over SSE |
| Long-running work | Tasks extension (RC) | first-class `Task` with states |
| Counterparty | a passive server you own | an autonomous agent you may not own |
| Trust model | you wrote or vetted the tool | opaque peer, treat as untrusted |

The last two rows are the ones people miss. An MCP server is something you (or a vendor you chose) built to be driven. It is passive. An A2A peer is another agent making its own decisions, and it may belong to a different team or a different company. That difference drives everything about how you secure the two.

## What A2A actually puts on the wire

A2A discovery starts with an Agent Card, a JSON document an agent publishes at a well-known path. It advertises identity, endpoint, capabilities, and skills:

```json
// A2A v1.0 Agent Card, served at /.well-known/agent-card.json
{
  "protocolVersion": "1.0",
  "name": "Invoice Reconciler",
  "description": "Matches invoices against purchase orders and flags mismatches.",
  "url": "https://agents.example.com/invoice-reconciler",
  "preferredTransport": "JSONRPC",
  "capabilities": { "streaming": true, "pushNotifications": true },
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["application/json"],
  "securitySchemes": {
    "bearer": { "type": "http", "scheme": "bearer" }
  },
  "skills": [
    {
      "id": "reconcile",
      "name": "Reconcile invoice",
      "description": "Given an invoice and PO number, return matched, unmatched, and disputed line items.",
      "tags": ["finance", "reconciliation"]
    }
  ]
}
```

A client agent fetches that card, then sends work as a `Task` via a JSON-RPC call. The default method is `message/send`, or `message/stream` when you want incremental updates over Server-Sent Events:

```json
// A2A v1.0, JSON-RPC 2.0 request to message/send
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [
        { "kind": "text", "text": "Reconcile invoice INV-4471 against PO-9982." }
      ],
      "messageId": "m-1"
    }
  }
}
```

The response is a `Task` object that carries a lifecycle state. A2A defines a fixed set: `submitted`, `working`, `input-required`, `completed`, `canceled`, `failed`, `rejected`, and `auth-required`. That `input-required` state is the important one. It is how one agent pauses and asks a peer for more information mid-task, a multi-turn negotiation that has no equivalent in a single tool call. You poll with `tasks/get` or subscribe to updates, and you cancel with `tasks/cancel`. For work that outlives an HTTP connection, the agent calls back to a webhook you registered via `tasks/pushNotificationConfig/set`.

Compare that to MCP, where the counterpart is a `tool` the model invokes with structured arguments and gets a single structured result. There is no notion of the tool asking you a follow-up question in natural language, no task state machine, no peer that might decline the work with a `rejected`. MCP models capabilities. A2A models a conversation between two reasoning systems. If you have read the [MCP stdio vs HTTP vs SSE transport breakdown](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/), the A2A transport story will feel familiar: both default to JSON-RPC 2.0, both stream over SSE, but A2A also ships first-class gRPC and HTTP+JSON bindings because inter-company agent traffic tends to want them.

## When to pick MCP (which is almost always your first move)

- **You are giving one agent access to tools, data, or an API.** This is the default and it covers the overwhelming majority of what people call "building an agent." Exposing a database, a filesystem, a ticketing system, or your internal API to Claude Code or Cursor is an MCP job, full stop. See [MCP vs OpenAPI plugins vs custom tool calling](/2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents/) for how MCP won the cross-client integration slot.
- **You want the integration reused across clients.** One MCP server works in Claude Code, Cursor, ChatGPT, and any other MCP host. You write it once.
- **The work is a bounded operation with a known schema.** "Run this query", "read this file", "create this ticket". Structured in, structured out. That is a tool, not a peer.
- **You have exactly one agent.** If there is no second autonomous agent in your architecture, there is nothing for A2A to connect. Adding it now is pure overhead.

## When to pick A2A (a narrower, real set of cases)

- **You have two or more agents deployed independently.** Different repos, different teams, different release cadences, maybe different companies. A2A is the standardized seam so you are not inventing a bespoke REST contract per pair. The [Microsoft Agent Framework, LangChain, and LlamaIndex comparison](/2026/06/microsoft-agent-framework-vs-langchain-vs-llamaindex-in-2026/) covers frameworks that now speak A2A natively for exactly this.
- **You need cross-vendor agent interop.** A2A has 150-plus supporting organizations and integrations across Azure AI Foundry, Copilot Studio, Amazon Bedrock AgentCore, and Google Cloud. If a partner exposes an A2A endpoint, you can call it without a custom SDK.
- **The delegated work is long-running or needs negotiation.** The `Task` state machine, `input-required` round-trips, and push-notification callbacks exist because real inter-agent work takes minutes and sometimes needs a clarifying question. A synchronous tool call cannot model that.
- **You want capability discovery at runtime.** An orchestrator can fetch Agent Cards, read each peer's `skills`, and route a task to whichever agent advertises the matching skill, without hardcoding endpoints.

If none of those bullets describe you, you do not have an A2A problem yet. Do not build the orchestration layer for agents you have not written.

## The pattern where they meet

Here is the shape almost every production multi-agent system converges on. A coordinator agent uses A2A to reach specialist agents. Each specialist uses MCP to reach its own tools. The protocols never overlap; they stack.

```text
Coordinator agent
  │  A2A (message/send, Task states)   <- agent-to-agent
  ▼
Specialist "Invoice Reconciler" agent
  │  MCP (tools/call over Streamable HTTP)   <- agent-to-tool
  ▼
Accounting-DB MCP server  (SQL tool, invoice resource)
```

The seam is clean because A2A treats the specialist as opaque. The coordinator sends a natural-language task and gets an artifact back. It has no idea the reconciler is calling three MCP tools under the hood, and it should not. That opacity is the entire point: you can swap the reconciler's internal tooling, change its MCP servers, even rewrite it in another language, and the coordinator's A2A contract does not move. Meanwhile the reconciler's MCP tools stay simple and testable because they only ever face one agent. If your monorepo hosts several of these specialists, the same context-hygiene rules apply as in any agent workspace; the [guide to reducing how many MCP tools an agent loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/) matters per-specialist, because each one still pays the tool-token cost for its own MCP surface.

A minimal reconciler that speaks A2A outward and MCP inward looks like this:

```python
# A2A Python SDK (v1.0) inbound + MCP client outbound
from a2a.server import AgentExecutor, RequestContext
from a2a.types import TaskState
from mcp import ClientSession  # MCP Python SDK, 2025-11-25 spec

class InvoiceReconciler(AgentExecutor):
    async def execute(self, ctx: RequestContext, events):
        # A2A gave us an opaque, natural-language task from a peer agent.
        prompt = ctx.get_user_input()

        # Fan out to our OWN tools over MCP. The coordinator never sees this.
        async with ClientSession(*ctx.deps["accounting_mcp"]) as mcp:
            await mcp.initialize()
            result = await mcp.call_tool(
                "match_invoice",
                {"invoice": parse_invoice_id(prompt)},
            )

        # Report back to the peer as a completed A2A Task with an artifact.
        await events.complete(
            state=TaskState.completed,
            artifact=result.content,
        )
```

Two protocols, two directions, one agent in the middle. The A2A side never learns about the MCP tool, and the MCP tool never learns it was triggered by a peer agent.

## The gotcha that picks for you: trust boundaries

The decision axis that overrides preference is trust. An MCP server is code you shipped or a vendor you vetted; it is inside your boundary, driven by your agent. An A2A peer is another autonomous agent, possibly across an organizational line, making its own decisions with its own prompt. You treat A2A input the way you treat any untrusted network input: authenticate every request with the `securitySchemes` the Agent Card declares, validate and bound what a peer can ask for, and never let a peer's task text flow unfiltered into a privileged tool call.

This is precisely where prompt-injection risk lives in multi-agent systems. A malicious or compromised peer can put instructions in a task message, and if your specialist blindly relays that text into an MCP tool, you have handed an outsider your tools. So the rule that falls out of the trust boundary: A2A messages are data, not instructions to your MCP layer. Parse them, validate them, then decide what tool to call. Do not pipe a peer's free text straight through. Get this wrong and no amount of protocol choice saves you; get the boundary right and the A2A-over-MCP stack is genuinely safe to expose.

## The recommendation, restated

Build MCP first, because a single agent with good tools is where nearly all the value is and it is the thing you almost certainly need. Treat A2A as the protocol you add the day you have a second, independently built agent that must take work from the first. When that day comes, layer them: A2A for the peer-to-peer orchestration seam, MCP for each agent's private tool access, with a hard trust boundary at the A2A edge. The question was never "which one wins." It is "how few agents can I get away with," and for most teams in 2026 the honest answer is one agent and a stack of MCP servers, with A2A held in reserve until the architecture actually forces it.

## Related

- [MCP vs OpenAPI Plugins vs Custom Tool Calling for AI Agents](/2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents/)
- [MCP stdio vs HTTP vs SSE Transport: Which Should You Choose in 2026?](/2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose/)
- [Microsoft Agent Framework vs LangChain vs LlamaIndex in 2026](/2026/06/microsoft-agent-framework-vs-langchain-vs-llamaindex-in-2026/)
- [How to Reduce the Number of MCP Tools Claude Loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/)

## Sources

- [A2A Protocol, official docs: A2A and MCP](https://a2a-protocol.org/latest/topics/a2a-and-mcp/)
- [Linux Foundation: A2A surpasses 150 organizations in its first year](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
- [Model Context Protocol: the 2026-07-28 spec release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [MCP specification, 2025-11-25 revision](https://modelcontextprotocol.io/specification/2025-11-25)
