---
title: "How to Expose Your Own Functions to a Cursor SDK Agent With local.customTools (Instead of a Separate MCP Server)"
description: "Pass local.customTools to a Cursor SDK agent and the model calls your in-process functions through the built-in custom-user-tools MCP server. No stdio handshake, no separate process, no transport bugs. Local agents only: cloud agents throw ConfigurationError."
pubDate: 2026-06-14
tags:
  - "cursor"
  - "ai-agents"
  - "mcp"
  - "typescript"
---

If you have ever wired a one-function tool into a Cursor SDK agent by standing up a whole MCP server, the June 4, 2026 SDK update kills that ceremony. As of `@cursor/sdk@1.0.16`, you can hand the local agent a plain object of functions through `local.customTools`, and the SDK registers them behind the scenes as an MCP server it calls `custom-user-tools`. The model discovers and calls them through the exact same path and permission gate as any real MCP server, except there is no second process, no `stdio` handshake, and no transport to misconfigure. The one hard rule: custom tools are local agents only. Pass `local.customTools` to a cloud agent and you get a `ConfigurationError`.

This post shows the exact tool shape, how it routes through the agent, where it differs from a real MCP server, and the gotchas that bite once you put it in front of the model.

## Why an in-process tool beats a server for code you own

The Model Context Protocol exists so a tool you write once can be reused across Claude Code, Cursor, and ChatGPT without rewriting it for each client. That is a great reason to build a real server, and if you are picking between approaches the tradeoffs are worth thinking through (I covered them in [MCP vs OpenAPI plugins vs custom tool calling](/2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents/)). But reuse is exactly the thing you do not need when the function is internal to one program: a lookup against a database you already have a connection to, a call to an internal HTTP API, a calculation that depends on state your Node process is already holding.

Wrapping that in a separate MCP server means you serialize arguments out of your process, spawn or connect to a second process, run the function there, and serialize the result back. You also inherit a class of failure modes that have nothing to do with your logic: the server starts before the client is ready and you get [`ECONNREFUSED`](/2026/05/fix-econnrefused-when-a-local-mcp-server-starts-before-the-client-is-ready/), or the `stdio` pipe hangs, or the transport is misconfigured. For a function that lives in the same file as your agent, that is a lot of moving parts to add to a closure you could have called directly.

`local.customTools` removes the process boundary. The function runs in your agent's process, with access to the same closures, the same database pool, and the same environment. The model still sees it as an MCP tool, so nothing about the model's behaviour or the permission model changes.

## The tool definition shape

A custom tool is an object keyed by tool name, where each value is an `SDKCustomTool`:

```typescript
// @cursor/sdk@1.0.16
interface SDKCustomTool {
  description?: string;
  inputSchema?: Record<string, SDKJsonValue>;
  execute: (
    args: Record<string, SDKJsonValue>,
    context: SDKCustomToolContext
  ) => SDKCustomToolResult | Promise<SDKCustomToolResult>;
}

interface SDKCustomToolContext {
  toolCallId?: string;
}
```

Three things to internalize:

- `description` is what the model reads to decide when to call the tool. It defaults to an empty string, which is the same as giving the model no reason to ever call it. Treat this field as a prompt, not documentation.
- `inputSchema` is **JSON Schema**, not Zod. If you have been writing MCP servers with the TypeScript SDK and Zod schemas, this is a different convention. Omit it and it defaults to an open object that accepts any properties, which means the model can pass you anything and you own all the validation.
- `execute` receives the parsed arguments and a context object whose only field today is an optional `toolCallId`. It can be sync or async.

The return type is forgiving. You can return a bare string, any JSON value, or a structured envelope:

```typescript
// @cursor/sdk@1.0.16
type SDKCustomToolResult =
  | string
  | SDKJsonValue
  | {
      content: SDKCustomToolContent[];
      isError?: boolean;
      structuredContent?: Record<string, SDKJsonValue>;
    };

type SDKCustomToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType?: string };
```

Returning a string is enough for most tools. Reach for the envelope when you need to signal a tool error to the model with `isError: true`, attach an image (a rendered chart, a screenshot), or hand back machine-readable `structuredContent` alongside the human-readable text.

## A working example at agent creation

Here is the canonical shape: define the tools when you create the agent, on `local.customTools`. This tool looks up a deployment status from an internal API the Node process can already reach.

```typescript
// @cursor/sdk@1.0.16
import { Agent } from "@cursor/sdk";

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2.5" },
  local: {
    cwd: process.cwd(),
    customTools: {
      get_deployment_status: {
        description: "Look up deployment status for a service.",
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string", description: "Service name" },
          },
          required: ["service"],
        },
        async execute({ service }) {
          const res = await fetch(`https://deploys.internal/api/${service}`);
          const body = await res.json();
          return `Service ${service} is ${body.status}`;
        },
      },
    },
  },
});

const run = await agent.send(
  "Is the checkout service deployed? If not, tell me why."
);

for await (const event of run.stream()) {
  console.log(event);
}
```

Note `model: { id: "composer-2.5" }`. The older `composer-2` id now reroutes to `composer-2.5`, so either works, but pin the explicit version if you care about reproducibility. The `local` block is what makes this a local agent, which is mandatory for custom tools; the same SDK runs cloud agents when you swap `local` for `cloud`, but cloud agents reject `customTools`.

When the model decides it needs the deployment status, it emits a tool call against `get_deployment_status` exactly as if it were calling a tool on an attached MCP server. The SDK routes that call to your `execute`, runs it in-process, and feeds the string back into the run.

## Per-run tools with send()

You do not have to commit to a tool set when you create the agent. You can pass `local.customTools` on an individual `send()`, which is the right move for a capability that should only exist for one task, or one that depends on values you only have at call time.

```typescript
// @cursor/sdk@1.0.16
await agent.send("Roll forward if canary is healthy", {
  local: {
    customTools: {
      promote_canary: {
        description: "Promote canary build to production.",
        async execute() {
          await promoteCanary();
          return { content: [{ type: "text", text: "Promoted." }] };
        },
      },
    },
  },
});
```

This `promote_canary` tool has no `inputSchema` because it takes no arguments, and it returns the structured envelope to make the success message explicit. Because it is scoped to this one `send()`, a different prompt in the same agent session will not see it. That scoping is the cleanest way to keep a dangerous action out of the model's reach except in the exact turn where you want it available.

## Custom tools flow down to subagents automatically

If your agent spawns subagents, a custom tool defined on the parent is visible to every subagent, including nested ones. From the SDK docs: "Each level reaches the same set of named subagents and custom tools. Nesting works out of the box." You define the tool once and it is available throughout the whole run hierarchy without re-declaring it at each level. This matches how a real MCP server attached to the parent would behave, so the mental model carries over: subagents inherit the parent's tool surface. If you are leaning on delegation, the subagent and hooks primitives are part of the same SDK surface that shipped with the [TypeScript SDK launch](/2026/05/cursor-typescript-sdk-programmatic-coding-agents/).

## The permission gate is the same one MCP tools use

A custom tool is not a back door around Cursor's safety machinery. Because the SDK presents it as the `custom-user-tools` MCP server, it sits behind the same gate as shell, fetch, and real MCP tools. Two controls matter:

- **Auto-review.** With `local.autoReview: true`, every custom tool call is routed through Cursor's safety classifier before it runs, the same as any other tool. The docs are blunt about what this is: "Auto-review is local agents only ... The classifier is best-effort convenience, not a security boundary." Do not treat a passing auto-review as proof a call is safe.
- **Sandbox.** Custom tools respect `sandboxOptions`. If you restrict filesystem or network access for the agent, your `execute` runs under those same restrictions. A tool that calls an internal URL will fail closed if the sandbox blocks that host, which is the behaviour you want.

The practical takeaway: if a custom tool does something irreversible, gate it. Combine auto-review with a sandbox or an allowlist, or scope the tool to a single `send()` so it physically does not exist outside the turn you intend. The classifier alone is convenience, not a wall.

## Where custom tools stop and a real MCP server starts

The line is reuse and reach.

Pick `local.customTools` when the function is internal to this one program, when it needs in-process state (a live DB pool, an authenticated client, an in-memory cache), and when you are running a local agent. The win is no second process, no transport, no startup race, and direct access to your closures.

Build a real MCP server when you want the same tool available to Claude Code, the Cursor desktop app, ChatGPT, and your SDK agent without four copies of the logic; when the tool genuinely is a separate service with its own lifecycle; or when you need a cloud agent to use it, since cloud agents cannot take `customTools` at all. If that is your situation, the [TypeScript MCP server walkthrough](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) covers the full server build, including the `stdout` trap that custom tools let you sidestep entirely.

The cloud restriction is the one that catches people. A natural design is to develop against a local agent with `customTools`, then flip to `cloud` for production, the way you might [hand a ticket to a Cursor cloud agent](/2026/05/how-to-assign-a-jira-ticket-to-a-cursor-cloud-agent-and-get-a-pr-back/). That flip throws `ConfigurationError` the moment a `customTools` object is present, because the cloud VM has no way to call back into your Node process. If a tool needs to survive the move to cloud, it has to be a real MCP server reachable over the network, not an in-process closure.

## Gotchas worth pinning before you ship

A few things that are easy to get wrong:

- **An empty `description` is a dead tool.** The model picks tools by their descriptions. A blank one means the tool exists but the model has no signal to call it. Write the description like a one-line prompt: what it does and when to use it.
- **No `inputSchema` means no validation.** The default open-object schema accepts anything, so the model can hand you malformed or missing fields. Either supply a real JSON Schema with `required`, or validate inside `execute` and return `{ isError: true, ... }` on bad input so the model can correct itself.
- **JSON Schema, not Zod.** Muscle memory from the MCP TypeScript SDK will steer you toward Zod. Custom tools want a plain JSON Schema object on `inputSchema`.
- **Errors should be returned, not thrown blindly.** Returning the structured envelope with `isError: true` gives the model a chance to react. An unhandled throw is a harsher failure for the run.
- **Tool names are the model's handle.** Use clear, action-shaped snake_case names like `get_deployment_status` and `promote_canary`. The name plus description is the entire interface the model reasons over.

For the full type surface and the latest field-by-field reference, the [Cursor TypeScript SDK docs](https://cursor.com/docs/sdk/typescript) are the authoritative source, and the [June 2026 SDK changelog](https://cursor.com/changelog/sdk-updates-jun-2026) is where custom tools, custom stores, and auto-review landed together.
