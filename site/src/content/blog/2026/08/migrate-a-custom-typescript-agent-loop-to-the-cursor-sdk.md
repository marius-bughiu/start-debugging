---
title: "Migrate a Custom TypeScript Agent Loop to the Cursor SDK (@cursor/sdk 1.0.26)"
description: "A step-by-step checklist for retiring a hand-rolled while-loop agent and running the same job on @cursor/sdk 1.0.26. The tool bodies survive, the loop does not, and three things you probably rely on have no equivalent: a system prompt string, a tool allowlist, and per-turn control."
pubDate: 2026-08-09
updatedDate: 2026-08-09
template: migration
tags:
  - "migration"
  - "cursor"
  - "ai-agents"
  - "llm"
  - "typescript"
  - "anthropic-sdk"
---

If you built a coding agent in TypeScript before the vendors shipped SDKs, you own a `while` loop. It calls the model, scans the response for tool-call blocks, dispatches each one to a local function, pushes the results back as a single user message, and repeats until the model stops asking. Around that core you have accumulated the unglamorous half: path confinement so a model-supplied `path` cannot escape the repo, a turn cap so a confused model cannot spin forever, retry logic for `429`, and a `stop_reason` switch that grew a new branch every time the API added one.

Migrating that to **`@cursor/sdk` 1.0.26** deletes most of it. What you get in exchange is Cursor's harness: its context engine, its file-edit tools, its permission gate, and its persistence, addressable from a Node process. The trade is real, though, and it is not the trade the launch post implies. **The tool bodies survive almost verbatim as `local.customTools`. The loop, the schema plumbing, and the retry code go away. Three things you probably depend on have no equivalent in the 1.0.26 option surface: a system prompt string, a tool allowlist, and per-turn control of the conversation.** Budget half a day for a small agent with a handful of tools, longer if your prompt does heavy persona work.

Everything below is verified against `@cursor/sdk` 1.0.26 installed from npm (1.0.27 shipped August 6, 2026 and is the current latest), with `@anthropic-ai/sdk` 0.115.0 on the outgoing side. Both code samples in this post typecheck clean under TypeScript 7.0.2. The SDK's `package.json` pins `"node": ">=22.13"`, so this is not a migration you can do on Node 20.

## Why give up a loop that already works

A hand-rolled loop is maximally flexible and that is exactly its problem: every capability Cursor already has, you are maintaining a worse version of. Concretely, moving to the SDK buys:

- **The context engine and file tools, for free.** Your loop's `read_file` and `write_file` are two functions. Cursor's agent arrives with semantic search, grep, glob, and edit tools plus codebase indexing, which is the part of a coding agent that takes months to get right and cannot be bolted on later.
- **Persistence and resume.** `Agent.resume("agent-id")` reattaches to a conversation whose process died. In a hand-rolled loop your `messages` array lives in memory, so a killed worker loses the run. This is the piece most teams discover the hard way; the storage backends behind it are covered in [persisting Cursor SDK agent state across restarts](/2026/06/persist-cursor-sdk-agent-state-across-restarts-sqlite-vs-jsonl/).
- **A permission gate you did not write.** `local.autoReview` routes shell, MCP, and fetch calls through Cursor's classifier before they run. Your loop either executes what the model asks or it does not.
- **One runtime switch to hosted.** Swap `local: { cwd }` for `cloud: { repos: [...] }` and the same call runs in a Cursor-provisioned VM with a branch and an optional pull request at the end. `Agent.create`, `agent.send`, and the run stream keep the same shape across both.

The cost, and it is the honest reason some teams stay on their loop: you stop controlling the turn. There is no hook that fires between the model's tool request and its execution where you can rewrite arguments or inject a message. If your loop earns its keep by doing something clever mid-turn, read the "What breaks" table twice before you start.

## The loop we are migrating

This is the shape almost every hand-rolled agent has. Tools declared twice (once as JSON schema, once as a dispatch branch), a hand-written safety check on model-supplied paths, and a turn cap.

```typescript
// @anthropic-ai/sdk 0.115.0, Node 22+, ESM
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";

const client = new Anthropic();
const ROOT = process.cwd();

const tools: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 file relative to the repository root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  // ...write_file, run_tests
];

// ...plus a `dispatch(name, input)` switch with one branch per tool.

// The model supplies `path`, so resolve and verify before touching disk.
function safeResolve(p: string): string {
  const abs = path.resolve(ROOT, p);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error(`path escapes repository root: ${p}`);
  }
  return abs;
}

export async function run(prompt: string, maxTurns = 40): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      system: "You are a coding agent working in a TypeScript repository.",
      tools,
      messages,
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`refused: ${response.stop_details?.explanation ?? "none"}`);
    }
    if (response.stop_reason === "end_turn") {
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }

    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      try {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: await dispatch(block.name, block.input as Record<string, unknown>),
        });
      } catch (err) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: err instanceof Error ? err.message : String(err),
          is_error: true,
        });
      }
    }

    // All results in ONE user message, or the model stops calling tools in parallel.
    messages.push({ role: "user", content: results });
  }

  throw new Error(`gave up after ${maxTurns} turns`);
}
```

Roughly 120 lines with the omitted tool bodies. About 90 of them are scaffolding.

## What breaks

| Area | Change | Severity |
| --- | --- | --- |
| System prompt | `AgentOptions` in 1.0.26 has no `system` or `systemPrompt` field. Persona and rules come from filesystem config layers via `local.settingSources`, or from a named subagent's `prompt` | high |
| Tool allowlist | 1.0.26's `AgentOptions` and `SendOptions` expose no `tools` / `disallowedTools` fields, and `disallowedTools` appears nowhere in the shipped bundle. The docs describe both | high |
| Per-turn control | No hook between tool request and execution. `onStep` / `onDelta` observe, they do not gate | high |
| Model IDs | Anthropic and OpenAI IDs are gone. `model: { id: "composer-2.5" }`, or `auto-smart` with an `optimize_for` param for Cursor Router | medium |
| Error types | Catch `AuthenticationError`, `ConfigurationError`, `RateLimitError`, `NetworkError`, `AgentBusyError`, `AgentNotFoundError` (all under `CursorSdkError`). The docs also list `RequestError` and `ValidationError`; neither is exported by 1.0.26 | medium |
| Tool result shape | Return a `string`, a JSON value, or `{ content: [...], isError?, structuredContent? }`. No `tool_use_id` to thread | low |
| Retry logic | `local.enableAgentRetries` defaults to `true` for transport and stall failures. Your backoff code is dead | low |
| Node version | `engines` requires `>=22.13`, plus per-platform binaries for sandboxing and ripgrep | low |

The two `high` rows are where migrations stall, so deal with them before you write any code. If your loop's system prompt is 400 words of behavioural rules, that text has to become project-level Cursor rules on disk (loaded through `settingSources: ["project"]`) or the `prompt` of a named subagent. There is no string field to paste it into.

## Pre-flight checklist

- Node 22.13 or later on every machine that runs the agent, CI included.
- A `CURSOR_API_KEY` (user key or service account key) available as an env var, or passed explicitly as `apiKey`. Do not plan on driving the browser login flow from code yet: `Cursor.auth.login()` / `.status()` / `.logout()` are documented, but `Cursor.auth` is not present on the exported `Cursor` class in 1.0.26 (only `configure`, `me`, `models`, and `repositories` are).
- Your system prompt relocated into repo-level Cursor rules, committed. Verify it loads by running the SDK against a trivial prompt and confirming the behaviour it encodes.
- An inventory of your tools split into two lists: tools Cursor's built-in toolset already covers (file read, write, edit, grep, glob, shell) and tools that are genuinely yours (ticket systems, internal APIs, deploy hooks). Only the second list migrates.
- A pinned version. `npm i @cursor/sdk@1.0.26` rather than a range: the option surface has moved between 1.0.x releases, and the published docs currently run ahead of npm.

## The migration, step by step

### 1. Install the SDK and confirm the runtime

```bash
npm install @cursor/sdk@1.0.26
```

**Verify:** `node -p "require('@cursor/sdk/package.json').engines.node"` prints `>=22.13`, and `node --version` is at or above it. Check this before anything else: npm treats an engine mismatch as a warning by default rather than a hard failure, so an unsupported Node version does not announce itself at install time.

### 2. Delete the tools Cursor already owns

Drop `read_file`, `write_file`, and any grep or glob wrapper from your registry, along with their JSON schemas and their dispatch branches. Delete `safeResolve` too: file access now goes through Cursor's own tools, and `local.sandboxOptions: { enabled: true }` confines execution rather than your string comparison. Sandboxing is off by default, so set it explicitly.

**Verify:** your remaining tool registry contains only functions that call something outside the repository.

### 3. Port the surviving tools to `local.customTools`

Each survivor becomes an `SDKCustomTool`: a `description`, an `inputSchema`, and an `execute(args, context)`. The body is unchanged from your dispatch branch. Return a string, a JSON value, or the full content-block form.

```typescript
// @cursor/sdk 1.0.26
import type { SDKCustomTool } from "@cursor/sdk";

const customTools: Record<string, SDKCustomTool> = {
  post_status: {
    description: "Post a one-line status update to the team channel.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(args) {
      await fetch(process.env.STATUS_WEBHOOK!, {
        method: "POST",
        body: JSON.stringify({ text: args.text }),
      });
      return "posted";
    },
  },
};
```

These run in your host process, which is what makes them a straight port. It also means they bypass the approval gate entirely: because they are host callbacks rather than a real MCP server, they execute even on sandboxed or `autoReview` runs where MCP tool calls fail closed. That is a feature when your tool is a status webhook and a hole when it is a deploy trigger. The mechanics are worked through in [exposing your own functions with `local.customTools`](/2026/06/expose-functions-to-cursor-sdk-agent-with-local-customtools/).

**Verify:** ask the agent to call one tool and nothing else, and assert your function ran.

### 4. Replace the loop with `Agent.create` and `agent.send`

The whole `for` loop, the `stop_reason` switch, the assistant-turn bookkeeping, and the tool-result assembly collapse into this:

```typescript
// @cursor/sdk 1.0.26, Node 22.13+
import { Agent, ConfigurationError, RateLimitError } from "@cursor/sdk";
import type { SDKMessage } from "@cursor/sdk";

export async function run(prompt: string): Promise<string> {
  await using agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY!,
    model: { id: "composer-2.5" },
    local: {
      cwd: process.cwd(),
      settingSources: ["project"],
      autoReview: true,
      sandboxOptions: { enabled: true },
      customTools,
    },
  });

  const run = await agent.send(prompt);

  for await (const event of run.stream()) {
    logEvent(event);
  }

  const result = await run.wait();
  if (result.status !== "finished") {
    throw new Error(`run ${result.status}: ${result.error?.message ?? "no detail"}`);
  }
  return result.result ?? "";
}

function logEvent(event: SDKMessage): void {
  switch (event.type) {
    case "assistant":
      for (const block of event.message.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
      break;
    case "tool_call":
      console.log(`[${event.status}] ${event.name}`);
      break;
    case "usage":
      console.log(`tokens: ${event.usage.totalTokens}`);
      break;
    default:
      break;
  }
}
```

`model` is required for local agents and optional for cloud ones, where the server resolves your configured default. `await using` disposes the agent at scope exit; if your toolchain does not support explicit resource management, call `await agent[Symbol.asyncDispose]()` or the fire-and-forget `agent.close()` instead.

**Verify:** the run reaches `status === "finished"`, and your turn counter, retry helper, and `stop_reason` switch are all deleted rather than merely unused.

### 5. Rewrite the error handling around the real classes

Your `catch` block is checking for things that no longer happen and missing things that do. The classes exported by 1.0.26 all extend `CursorSdkError`:

```typescript
try {
  return await run(prompt);
} catch (err) {
  if (err instanceof ConfigurationError) return `bad options: ${err.message}`;
  if (err instanceof RateLimitError) return `slow down: ${err.message}`;
  throw err;
}
```

`ConfigurationError` is the one to handle first, because it is what a wrong option shape produces: passing `local.customTools` to a cloud agent throws it, and so does calling `getUsage` on a local agent ID. Note the two names that are *not* exported: `RequestError` and `ValidationError` appear in the published docs but not in the 1.0.26 bundle, so a `catch` written from the docs will silently never match.

**Verify:** force one failure per branch. An empty `apiKey` should surface an `AuthenticationError`; `local.customTools` on a `cloud` agent should surface a `ConfigurationError`.

### 6. Wire persistence and pick a runtime

Local runs persist to disk automatically, so `Agent.resume(agentId)` is the recovery path for a crashed worker. Runtime is inferred from the ID prefix: IDs starting with `bc-` route to the cloud API, everything else to the local store. Inline `mcpServers` are not persisted, so pass them again on resume.

If the job should run in a hosted VM, swap the `local` block for `cloud: { repos: [{ url }], autoCreatePR: true }` and keep the rest. Note what you lose in that direction: `customTools`, `autoReview`, `sandboxOptions`, `settingSources`, and `store` are all local-only.

**Verify:** kill the process mid-run, call `Agent.resume` with the stored ID, and confirm the conversation continues instead of starting over. If a previous run is wedged, `agent.send(msg, { local: { force: true } })` expires the stuck run first.

## Post-migration smoke test

- The agent edits a file and the change lands on disk.
- Each custom tool is exercised at least once and its side effect is observable.
- `Agent.resume` recovers a killed run.
- Every rule from the old system prompt still visibly holds. This is the check people skip, and it is the one that fails.
- Token spend per task is within a factor of two of the old loop. Cursor's harness sends more context than your hand-rolled prompt did.
- `result.usage.totalTokens` is being recorded somewhere. On cloud agents `agent.getUsage()` also reports dollar cost; on local agents it throws `ConfigurationError`.

## Rollback

Straightforward, if you plan for it: keep the old loop as an exported function behind a flag rather than deleting it in the same commit. Two caveats. Sessions do not port, so a run started on one path cannot be resumed on the other. And the harness change is one-way in practice: any prompt you retuned for Cursor's context engine will read as under-specified back on your own loop, because it no longer carries the file contents your loop used to paste in.

## Gotchas we hit

- **The docs are ahead of npm.** `tools` / `disallowedTools`, `Cursor.auth`, `RequestError`, and `ValidationError` are all documented and none of them are in 1.0.26. Read `node_modules/@cursor/sdk/dist/cjs/options.d.ts` before you build on a documented field; it is the actual contract.
- **`autoReview` is not a security boundary.** It is a classifier deciding which shell, MCP, and fetch calls need approval, and your in-process `customTools` skip it by design. Treat it as a guardrail, not a sandbox, and pair it with `sandboxOptions`. The wider version of this argument is in [locking down a coding agent's network egress](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/).
- **`settingSources` defaults to loading nothing.** Omitting it or passing `[]` resolves to an empty set of setting layers, so your committed project rules are ignored and it reads as the model having quietly forgotten your prompt. Pass `["project"]` at minimum. Two validation rules to know: an unrecognised value throws `Unsupported setting source "..."`, and `"all"` cannot be combined with individual sources (`settingSources cannot mix "all" with individual setting sources`), so `["all", "project"]` throws rather than being tolerated.
- **Model selection changed shape.** `Cursor.models.list()` returns entries with parameters attached; Cursor Router shows up as `auto-smart` with an `optimize_for` parameter taking `cost`, `balanced`, or `intelligence`. That is a per-request policy decision now, not a hardcoded ID, and it is worth reading [how Cursor Router turns Auto into a per-request choice](/2026/07/cursor-router-makes-auto-a-per-request-model-decision/) before you pin `composer-2.5` forever.
- **Streaming twice is a design decision, not a bug.** `run.stream()` yields buffered `SDKMessage` events; `onDelta` on `send()` gives you token-level `InteractionUpdate` values. Use the stream for control flow and `onDelta` only if you are rendering tokens.

If you concluded halfway through this that what you actually want is your tools callable from more than one agent, the other exit from a hand-rolled loop is [migrating the tool-calling loop to an MCP server](/2026/07/migrate-a-custom-tool-calling-loop-to-an-mcp-server/), which keeps your orchestration and moves only the tools.

## Sources

- [Cursor TypeScript SDK reference](https://cursor.com/docs/sdk/typescript)
- [`@cursor/sdk` on npm](https://www.npmjs.com/package/@cursor/sdk)
- [Cursor changelog](https://cursor.com/changelog)
- [Anthropic tool use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
- [`@anthropic-ai/sdk` on npm](https://www.npmjs.com/package/@anthropic-ai/sdk)
