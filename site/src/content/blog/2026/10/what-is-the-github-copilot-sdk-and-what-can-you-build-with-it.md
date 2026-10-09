---
title: "What Is the GitHub Copilot SDK, and What Can You Build With It?"
description: "The GitHub Copilot SDK (1.0.18, October 8, 2026) is a thin client for the Copilot CLI runtime: your app speaks JSON-RPC to the same agent loop that powers Copilot CLI, with built-in file and shell tools, MCP, sub-agents, hooks, and BYOK. How it is wired, four things you can build with it, and the defaults that will bite you in production."
pubDate: 2026-10-09
template: "how-to"
tags:
  - "github-copilot"
  - "copilot-sdk"
  - "ai-agents"
  - "mcp"
  - "typescript"
  - "python"
---

**Short answer:** The GitHub Copilot SDK is a library for six languages (TypeScript, Python, .NET, Go, Java, Rust) that lets your code drive the same agent runtime that sits behind Copilot CLI. You do not get a chat-completions wrapper. You get a whole agent: planning, a tool loop, built-in file/shell/search tools, MCP clients, sub-agents, context compaction, hooks, and permission prompts, running in a runtime process your app talks to over JSON-RPC. Everything below is verified against `@github/copilot-sdk` 1.0.18 and `github-copilot-sdk` 1.0.18 on PyPI (both published October 8, 2026), which bundle Copilot CLI runtime 1.0.94 and speak SDK protocol version 3. The SDK went GA on June 2, 2026. You need a Copilot subscription (the free tier counts), or you can bring your own model key and skip GitHub auth entirely.

In June I covered [the GA announcement from a C# angle](/2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp/). This post answers the broader question people keep asking: what is this thing, really, and what is it good for once you leave the "hello world" sample?

## What the SDK actually is: a client for a runtime you do not write

The SDK repo's own architecture diagram is three boxes: your application, the SDK client, and "Copilot CLI (server mode)", connected by JSON-RPC. That last box is the important one. When you call `client.start()`, the SDK launches the Copilot runtime as a child process (stdio by default) and every session, tool call, and model request goes through it. Your process never talks to a model directly.

On a Mac you can see this in `node_modules`. Installing `@github/copilot-sdk@1.0.18` pulls a 9 MB SDK package plus an optional platform package, `@github/copilot-sdk-darwin-arm64`, that is 114 MB on disk. That second package *is* the runtime. For Node.js, Python, and .NET the runtime ships with the SDK, so there is no separate install. For Go, Java, and Rust you install the `copilot` CLI yourself and make it available on `PATH`.

Here is the smallest program that proves the wiring works without spending a single model request:

```typescript
// @github/copilot-sdk 1.0.18: start the bundled runtime and round-trip one JSON-RPC call, no model call
import { CopilotClient } from "@github/copilot-sdk";
const t0 = performance.now();
const client = new CopilotClient({ useLoggedInUser: false, logLevel: "error" });
await client.start();
const started = performance.now();
const pong = await client.ping("hello");
console.log(JSON.stringify(pong), `start=${Math.round(started - t0)}ms`);
console.log(await client.stop());
```

On an M4 MacBook with Node 26.4.0 the first run printed `{"message":"pong: hello",...,"protocolVersion":3} start=1273ms`, because it was unpacking the runtime. Every run after that started in 22 to 24 ms. The Python package behaves the same: `await client.ping("hello")` returned `PingResponse(message='pong: hello', ..., protocol_version=3)` from a Python 3.14 venv. The runtime is a single process. Several sessions share it, and in a backend several SDK clients can connect to one long-running runtime.

That split decides what the SDK is good for. The orchestration lives in a binary that GitHub maintains and ships to millions of Copilot CLI users. Your code configures it, gives it tools, listens to its events, and approves or denies what it does.

## What you get without writing it

If you have ever hand-rolled an agent on top of a raw LLM API (see [what tool calling actually is](/2026/10/what-is-tool-calling-and-why-json-schemas-matter-more-than-prompts/) for that layer), this is the list of things you no longer write:

- **The agent loop.** `session.send()` queues a prompt; the runtime plans, calls tools, feeds results back, and emits `assistant.message` and `session.idle` when it is done. `sendAndWait()` wraps that in a promise.
- **Built-in tools.** In the default mode a session has the Copilot CLI's own tools (`view`, `edit`, `grep`, `glob`, `bash`, web fetch and so on), equivalent to running the CLI with `--allow-all`, still filtered through your permission handler.
- **Custom tools** defined with Zod (TypeScript) or Pydantic (Python), executed in *your* process when the model calls them.
- **MCP servers**, stdio or HTTP, configured per session or per sub-agent.
- **Custom agents and skills.** Named sub-agents with their own prompt, tool allowlist, model, and preloaded `SKILL.md` content.
- **Infinite sessions.** On by default: background compaction starts at a configurable share of the context window, and session state persists under `~/.copilot/session-state/{sessionId}/` so you can `resumeSession()` later.
- **Hooks** for pre/post tool use, prompt submission, session start/end, errors, agent stop, and sub-agent start/stop.
- **Telemetry** via OpenTelemetry, and per-call token and cost events.

The price is that you accept Copilot's agent design. You cannot swap the planner or change how the loop decides to stop, beyond what hooks expose. If you need that control, a framework like Microsoft Agent Framework is the better layer. It can even use Copilot as the model via its [GitHub Copilot provider](/2026/08/agent-framework-github-copilot-provider-copilot-cli-as-aiagent/).

## Four things you can build

### 1. A repo-aware internal tool that uses your services

The default `mode: "copilot-cli"` gives a session the full coding toolset over a working directory. That is exactly what you want for internal tools run by a developer or a CI job: a CI failure triager, a migration checker, a "why is this flaky" bot. You add what Copilot does not know, your internal services, as custom tools, and you bolt on the GitHub MCP server for issues and Actions logs.

```typescript
// @github/copilot-sdk 1.0.18 (bundled Copilot CLI runtime 1.0.94), Node.js 22+
import { z } from "zod";
import { CopilotClient, defineTool, type PermissionRequest } from "@github/copilot-sdk";

const lookupOwner = defineTool("lookup_code_owner", {
    description: "Return the team that owns a file path, from our internal ownership service",
    parameters: z.object({ path: z.string().describe("Repository-relative file path") }),
    skipPermission: true, // read-only, safe to run without a prompt
    handler: async ({ path }) => {
        // Replace with a real call to your service.
        return { path, team: path.startsWith("billing/") ? "payments" : "platform" };
    },
});

await using client = new CopilotClient();
await client.start();

await using session = await client.createSession({
    model: "claude-sonnet-4.5",
    workingDirectory: process.argv[2] ?? process.cwd(),
    tools: [lookupOwner],
    mcpServers: {
        github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
            tools: ["*"],
        },
    },
    systemMessage: {
        mode: "append",
        content: "You triage failing CI runs. Never push, never open PRs. Report findings only.",
    },
    onPermissionRequest: (request: PermissionRequest) => {
        if (request.kind === "read" || request.kind === "mcp") return { kind: "approve-once" };
        if (request.kind === "shell") {
            return { kind: "reject", feedback: "Shell is disabled in the triage service." };
        }
        return { kind: "reject", feedback: "This service is read-only." };
    },
});

session.on("tool.execution_start", (e) => console.error(`[tool] ${e.data.toolName}`));

const reply = await session.sendAndWait(
    { prompt: "The test job on the latest failed run of main is red. Find the failing test, the file it covers, and the owning team." },
    10 * 60 * 1000,
);
console.log(reply?.data.content);
```

Two details worth noticing. `systemMessage` with `mode: "append"` adds to Copilot's system prompt rather than replacing it, so you keep the runtime's tool-use instructions. And the permission handler is the real security boundary: `request.kind` tells you whether the agent wants to `read`, `write`, run `shell`, call `mcp`, fetch a `url`, or call a `custom-tool`. A `reject` carries `feedback` back to the model, which usually makes it change course instead of retrying.

The same thing in Python is just as short:

```python
# github-copilot-sdk 1.0.18 (Python 3.14)
import asyncio
from pydantic import BaseModel, Field
from copilot import CopilotClient, define_tool
from copilot.session import PermissionHandler


class OwnerParams(BaseModel):
    path: str = Field(description="Repository-relative file path")


@define_tool(description="Return the team that owns a file path")
async def lookup_code_owner(params: OwnerParams) -> str:
    return "payments" if params.path.startswith("billing/") else "platform"


async def main() -> None:
    client = CopilotClient()
    await client.start()
    async with await client.create_session(
        model="claude-sonnet-4.5",
        tools=[lookup_code_owner],
        on_permission_request=PermissionHandler.approve_all,
    ) as session:
        reply = await session.send_and_wait("Which team owns billing/invoice.py?")
        print(reply.data.content if reply else "(no reply)")
    await client.stop()


asyncio.run(main())
```

### 2. A multi-user backend feature

This is where most people get the defaults wrong. The SDK's multi-tenancy guide is explicit: do not use the default `copilot-cli` mode on a shared server, because it "can expose ambient host filesystem capabilities". Use `mode: "empty"`, which disables the optional CLI defaults so your application has to decide explicitly which tools, MCP servers, skills, and workspace paths a session can reach. Pass each user's token per session and allowlist tools by name:

```typescript
// @github/copilot-sdk 1.0.18: one shared runtime, one locked-down session per user request
import { z } from "zod";
import { CopilotClient, RuntimeConnection, defineTool } from "@github/copilot-sdk";

const lookupOrder = defineTool("lookupOrder", {
    description: "Look up an order by ID for the signed-in customer",
    parameters: z.object({ orderId: z.string() }),
    skipPermission: true,
    handler: async ({ orderId }) => ({ orderId, status: "shipped" }),
});

const client = new CopilotClient({
    mode: "empty", // no ambient shell, file, or web tools
    connection: RuntimeConnection.forUri(process.env.COPILOT_RUNTIME_URL!),
});
await client.start();

export async function answer(user: { id: string; githubToken: string }, question: string) {
    await using session = await client.createSession({
        sessionId: `user-${user.id}-${crypto.randomUUID()}`,
        model: "gpt-5.4",
        gitHubToken: user.githubToken,
        tools: [lookupOrder],
        availableTools: ["custom:lookupOrder"],
        onPermissionRequest: () => ({ kind: "reject", feedback: "Not allowed." }),
    });
    const reply = await session.sendAndWait({ prompt: question });
    return reply?.data.content;
}
```

The runtime runs separately as `copilot --headless --port 4321` (loopback only unless you pass `--host`). There is no official container image. The backend-services guide gives a Dockerfile that downloads the CLI release tarball. With a per-session `gitHubToken`, each request is billed to the user who made it, which is the model GitHub intends for SaaS integrations. If tokens rotate, `gitHubTokenProvider` refreshes them per session instead.

### 3. A product feature on your own model key

BYOK changes who pays and who authenticates. With a `provider` block, the session talks to an OpenAI-compatible, Azure OpenAI, or Anthropic endpoint with your key, and no GitHub account is involved:

```typescript
// @github/copilot-sdk 1.0.18: BYOK against a local Ollama, no GitHub auth
const session = await client.createSession({
    model: "deepseek-coder-v2:16b", // required with a custom provider
    provider: {
        type: "openai",
        baseUrl: "http://localhost:11434/v1",
    },
});
```

For Azure OpenAI, `type` must be `"azure"` and `baseUrl` is just the host, with no `/openai/v1` suffix. BYOK is key-based only: the README says Entra ID, managed identities, and third-party identity providers are not supported directly. (A separate Azure managed identity guide works around that with a bearer-token provider callback that fetches fresh Entra tokens through `DefaultAzureCredential`.) This is the path for an ISV that wants Copilot's agent loop inside a product whose customers have never heard of GitHub. If you already run [Copilot in VS Code against Anthropic, Ollama, or Foundry Local](/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/), the concept is the same, just in your own process.

### 4. Specialized sub-agents with guardrails

`customAgents` lets one session carry several named agents, each with its own prompt, tool allowlist, model, and preloaded skills. Combine that with a `PreToolUse` hook and a permission handler and you get a reviewer that can read anything but cannot write or push:

```typescript
// @github/copilot-sdk 1.0.18
import { CopilotClient, type PermissionRequest } from "@github/copilot-sdk";

const client = new CopilotClient();
await client.start();

const session = await client.createSession({
    model: "claude-sonnet-4.5",
    skillDirectories: ["./.github/skills"],
    customAgents: [
        {
            name: "migration-reviewer",
            displayName: "Migration reviewer",
            description: "Reviews database migration files for destructive operations",
            prompt: "You review SQL and EF Core migrations. Flag DROP, column type narrowing, and missing down-migrations.",
            tools: ["view", "grep", "glob"],
            skills: ["migration-rules"],
            model: "claude-haiku-4.5",
        },
    ],
    hooks: {
        onPreToolUse: async (input) => {
            const args = JSON.stringify(input.toolArgs ?? {});
            if (input.toolName === "bash" && /git\s+push/.test(args)) {
                return { permissionDecision: "deny", permissionDecisionReason: "No pushes from the bot." };
            }
            return { permissionDecision: "allow" };
        },
    },
    onPermissionRequest: (r: PermissionRequest) =>
        r.kind === "write" ? { kind: "reject", feedback: "Read-only run." } : { kind: "approve-once" },
});

session.on("assistant.usage", (e) => {
    console.error(`${e.data.model}: in=${e.data.inputTokens ?? 0} out=${e.data.outputTokens ?? 0} cost=${e.data.cost ?? 0}`);
});

await session.sendAndWait({ prompt: "Use the migration-reviewer agent on every file under Migrations/ changed since main." });
await session.disconnect();
await client.stop();
```

The sub-agent runs on a cheaper model (`model` falls back to the parent's model if that one is not available), and `skills` injects the full `SKILL.md` content at startup instead of relying on the model to discover it. The `assistant.usage` handler prints token counts and the premium-request multiplier for every model call, sub-agent calls included, which is how you find out what a run cost before the invoice does. For hard caps, the SDK also takes [AI credit session limits](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/).

## Copilot SDK vs calling a model API directly

| | Copilot SDK 1.0.18 | Raw model API (Anthropic, OpenAI) |
|---|---|---|
| Agent loop | Provided by the runtime | You write it |
| File, shell, search tools | Built in (off in `mode: "empty"`) | You write them |
| MCP client | Built in, stdio and HTTP | You wire an MCP client SDK |
| Context management | Background compaction, persisted sessions | You manage the message list |
| Models | Everything in your Copilot plan, or BYOK | One provider per client |
| Billing | Copilot premium requests per prompt, or your key | Per token on your key |
| Deployment footprint | A ~114 MB runtime process next to your app | An HTTP client |
| Control over the loop | Hooks and permission handlers only | Total |

The honest framing: the Copilot SDK competes with "write my own coding agent", not with "call a model". If your feature is a single classification or a summarizer, the runtime is dead weight. If it needs to read a repo, run commands, call tools, and keep going until a task is done, the SDK saves you months.

## Gotchas before you ship it

- **`approveAll` is for demos.** In TypeScript it throws when managed settings are enabled, and in any mode it approves shell and writes. Write a handler that switches on `request.kind` and has a default branch, because the docs warn that more kinds may be added.
- **MCP tool names are prefixed.** A tool `list_issues` from a server keyed `github` is `github-list_issues` at runtime. In `availableTools`/`excludedTools`, use `mcp:github-list_issues` or `new ToolSet().addMcp(...)`. In `customAgents[].tools`, use the bare `github-list_issues`.
- **Overriding a built-in tool is opt-in.** Registering a custom `edit_file` throws unless you set `overridesBuiltInTool: true`.
- **`onPostToolUse` does not fire on failures.** Register `onPostToolUseFailure` too if you log tool calls.
- **Go, Java, and Rust do not bundle the runtime.** A deploy that works with the Node SDK can fail with the Go SDK simply because `copilot` is not on the container's `PATH`.
- **Every prompt is billed like a Copilot CLI prompt.** That includes the free tier's limits. Budget for it like any other premium-request consumer, and read `assistant.usage` rather than guessing.
- **Versions move daily.** `1.0.19-preview.0` through `.2` shipped within about four and a half hours on the night of October 8 (UTC), right after 1.0.18. Pin an exact version, because the SDK, the bundled runtime (1.0.94 here), and the protocol version (3) move together.

## Related

- [GitHub Copilot SDK hits GA: embed Copilot's agent runtime in C#](/2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp/)
- [Use the Copilot CLI as an AIAgent in Microsoft Agent Framework](/2026/08/agent-framework-github-copilot-provider-copilot-cli-as-aiagent/)
- [Set AI credit session limits in GitHub Copilot CLI and SDK](/2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk/)
- [How to build an MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/)
- [What is GitHub Agentic Workflows, and how is it different from GitHub Actions?](/2026/10/what-is-github-agentic-workflows-and-how-does-it-differ-from-github-actions/)

## Sources

- [Copilot SDK is now generally available (GitHub changelog, June 2, 2026)](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/)
- [github/copilot-sdk repository and FAQ](https://github.com/github/copilot-sdk)
- [Node.js / TypeScript SDK README](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)
- [Python SDK README](https://github.com/github/copilot-sdk/blob/main/python/README.md)
- [Choosing a setup path](https://github.com/github/copilot-sdk/blob/main/docs/setup/choosing-a-setup-path.md)
- [Multi-tenancy and server deployments](https://github.com/github/copilot-sdk/blob/main/docs/setup/multi-tenancy.md)
- [Backend services setup](https://github.com/github/copilot-sdk/blob/main/docs/setup/backend-services.md)
- [Custom agents](https://github.com/github/copilot-sdk/blob/main/docs/features/custom-agents.md)
- [Usage and billing metrics](https://github.com/github/copilot-sdk/blob/main/docs/features/usage-and-billing.md)
- [@github/copilot-sdk on npm](https://www.npmjs.com/package/@github/copilot-sdk)
