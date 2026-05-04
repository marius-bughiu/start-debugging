---
title: "Cursor Ships a TypeScript SDK That Turns Its Coding Agent Into a Library"
description: "Cursor's new @cursor/sdk public beta exposes the same runtime, harness, and models that drive the desktop app, CLI, and web UI as a TypeScript package. You get sandboxed cloud VMs, subagents, hooks, MCP, and token-based pricing in a few lines of code."
pubDate: 2026-05-04
tags:
  - "cursor"
  - "ai-agents"
  - "typescript"
  - "mcp"
---

On April 29, 2026, Cursor opened the public beta of `@cursor/sdk`, a TypeScript library that wraps the same runtime, harness, and models that power the desktop editor, CLI, and web app. The pitch is simple: the agent that has been hiding inside Cursor's UI is now a programmable component you can call from your own services. Same Composer model, same context engine, same tool surface, addressable from a Node process.

This is the same shift the Anthropic and OpenAI SDKs went through years ago, but for a coding-specialized agent rather than a raw chat model.

## What ships in `@cursor/sdk`

Install it like any other package:

```bash
npm install @cursor/sdk
```

The minimal "create an agent and run a prompt" looks like this in the [official docs](https://cursor.com/docs/sdk/typescript):

```typescript
import { Agent } from "@cursor/sdk";

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2" },
  local: { cwd: process.cwd() },
});

const run = await agent.send("Summarize what this repository does");

for await (const event of run.stream()) {
  console.log(event);
}
```

The interesting field is `local`. Pass it and the agent operates against your filesystem in the current working directory. Drop it and replace with `cloud: { ... }` and the same call now runs inside a sandboxed VM that Cursor provisions for you, complete with codebase indexing, semantic search, and grep on the remote side. The contract for `Agent.create`, `agent.send`, and the run stream is identical between the two.

That symmetry is the main feature. CI scripts that need to keep results local can stay local. Hosted agents that need to run untrusted prompts against ephemeral clones can move to the cloud runtime without rewriting the harness.

## Subagents, hooks, MCP, and skills

The SDK does not stop at one-shot prompts. It surfaces the same primitives the desktop app uses:

- `Run` exposes streaming, awaiting, and cancellation. The stream emits `SDKMessage` events: assistant tokens, tool calls, thinking, and status updates as a discriminated union.
- Subagents let a parent run delegate a self-contained subtask without polluting its own context window.
- Hooks fire before and after tool calls, so you can deny dangerous file writes, log every shell command, or rewrite prompts based on policy.
- MCP servers attach over `stdio` or `http`, which means any existing MCP integration (GitHub, Linear, your internal data) plugs in without code changes.
- The `Cursor` namespace handles account-level plumbing: listing models, listing repositories, managing API keys.

Errors are typed: `AuthenticationError`, `RateLimitError`, `ConfigurationError`, and friends. No more parsing message strings.

## Why this matters for .NET shops too

The SDK is TypeScript-only today, but the cloud runtime is language-agnostic, so you can spawn it from a small Node sidecar that a .NET service shells out to. Combined with the [Microsoft Agent Framework](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) on the C# side, the realistic 2026 pattern is starting to look clear: orchestrate from .NET, push code-editing tasks into a hosted Cursor agent over the SDK, and consume the results through MCP.

Pricing is standard token-based consumption with no separate seat for SDK use, so the experiment cost is whatever the model burns. The catch you have to keep an eye on is the cloud VM lifecycle. Long-running runs can stack up real money, and the SDK does not auto-cancel idle agents for you.

The full beta documentation lives at [cursor.com/docs/sdk/typescript](https://cursor.com/docs/sdk/typescript), and the launch post is [cursor.com/blog/typescript-sdk](https://cursor.com/blog/typescript-sdk).
