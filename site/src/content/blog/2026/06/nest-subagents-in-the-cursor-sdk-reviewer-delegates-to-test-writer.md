---
title: "How to Nest Subagents in the Cursor SDK So a Reviewer Can Delegate to a Test-Writer"
description: "Define named subagents on agents in the Cursor SDK, let a code-reviewer delegate to a test-writer through the built-in Agent tool, and understand the real nesting depth cap: a subagent spawned by another subagent cannot spawn further ones, despite the changelog's 'and so on'."
pubDate: 2026-06-19
tags:
  - "cursor"
  - "ai-agents"
  - "subagents"
  - "typescript"
---

The June 2026 Cursor SDK update (`@cursor/sdk@1.0.16`) made subagents nest: a parent agent can delegate to a `code-reviewer`, and that reviewer can in turn delegate to a `test-writer`, each with its own system prompt and model. You wire this up with the `agents` field on `Agent.create()`, and the model decides when to hand work off through a built-in delegation tool. There is one constraint that the marketing copy glosses over and that will quietly cap your hierarchy: the main agent and its **direct** subagents can launch subagents, but a subagent that was itself launched by another subagent **cannot** launch further ones. That is a two-deep tree, not the infinite "and so on" the changelog implies.

This post shows the exact subagent shape, how delegation flows, how to build the reviewer-delegates-to-test-writer pattern, where the depth limit actually bites, and what inherits down the tree (custom tools, MCP, model selection).

## Why split a reviewer and a test-writer at all

You could put "review this diff and write tests for anything that lacks coverage" in one prompt. It works until it doesn't. A single agent carrying both jobs has to hold the review rubric, the diff, the existing test suite, and the new test code in one context window, and it tends to do one job well and the other halfheartedly. The reason to split is the same reason the SDK shipped subagents in the first place when it [turned Cursor's coding agent into a library](/2026/05/cursor-typescript-sdk-programmatic-coding-agents/): a subagent runs a self-contained subtask in its own context and reports back a result, without polluting the parent's window with the intermediate churn.

The reviewer-to-test-writer split maps cleanly onto that. The reviewer reasons about correctness and risk and produces a list of gaps. For each gap that needs coverage, it delegates the actual test authoring to a specialist whose entire system prompt is "write comprehensive tests," and whose context is just the function under test plus the surrounding test conventions. The reviewer never has to load the test framework's idioms into its own head; it just asks for tests and gets them.

## The agents field and the AgentDefinition shape

Subagents are named agents declared on the `agents` property of `Agent.create()`. Each entry is an `AgentDefinition`:

```typescript
// @cursor/sdk@1.0.16
const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2.5" },
  local: { cwd: process.cwd() },
  agents: {
    "code-reviewer": {
      description: "Expert code reviewer for quality and security.",
      prompt: "Review code for bugs, security issues, and proven approaches.",
      model: "inherit",
    },
    "test-writer": {
      description: "Writes tests for code changes.",
      prompt: "Write comprehensive tests for the given code.",
    },
  },
});
```

The `AgentDefinition` fields, per the [Cursor TypeScript SDK docs](https://cursor.com/docs/sdk/typescript):

- `description` (string) is the hint the **parent** reads to decide whether to delegate to this subagent. Treat it like a tool description, because that is functionally what it is: the model picks a subagent the same way it picks a tool, by matching the task to the description. A vague description means the parent never delegates.
- `prompt` (string) is the subagent's own system prompt. This is what the subagent operates under once it is spawned. The reviewer's `prompt` is its review rubric; the test-writer's `prompt` is its testing brief.
- `model` (`ModelSelection | "inherit"`, default `"inherit"`) overrides the model for that subagent. `"inherit"` reuses the parent's selection. This is where you can run the reviewer on a stronger model and the test-writer on a cheaper one, or vice versa.
- `mcpServers` (`Array<string | Record<string, McpServerConfig>>`, optional) attaches MCP servers. Reference a server already configured on the parent by name (a string), rather than redefining it inline.

Note the two definitions above differ on purpose: `code-reviewer` pins `model: "inherit"` explicitly, and `test-writer` omits `model`, which defaults to the same `"inherit"`. Both run on `composer-2.5` here because that is what the parent set. The older `composer-2` id reroutes to `composer-2.5`, so either string works, but pin the explicit version if you care about reproducibility.

## How the reviewer delegates to the test-writer

You do not call the test-writer yourself. You give the work to the parent, the parent delegates to the reviewer, and the reviewer delegates to the test-writer through the SDK's built-in delegation tool (the SDK exposes it as the `Agent` tool; in the Cursor app the same primitive surfaces as the `Task` tool). The model emits a delegation call the same way it emits any tool call, and the SDK routes it to the named subagent.

```typescript
// @cursor/sdk@1.0.16
const run = await agent.send(
  "Review the changes in src/checkout.ts. For any branch that lacks " +
    "test coverage, hand the function to the test-writer and have it " +
    "produce tests, then summarize what was reviewed and what was tested."
);

for await (const event of run.stream()) {
  // Subagent spawns and their tool calls show up as events in the stream.
  console.log(event);
}
```

The flow at runtime:

1. The parent reads the prompt and sees a review task. It delegates to `code-reviewer` because that description matches.
2. `code-reviewer` runs under its own prompt, inspects `src/checkout.ts`, and finds, say, two branches with no tests.
3. For each gap, the reviewer issues a delegation to `test-writer`. From the docs: when the agent has parallelizable work it "sends multiple `Task` tool calls in a single message, so subagents run simultaneously." So two independent test-writing jobs can run in parallel rather than one after the other.
4. Each `test-writer` instance returns its tests to the reviewer, which folds them into its summary and returns to the parent.

You can also force delegation explicitly rather than leaving it to the model. In a prompt, `/test-writer add tests for parseCart` invokes the named subagent directly, and natural-language mentions ("have the test-writer cover this") nudge the same path. Explicit invocation is the reliable way to guarantee the handoff happens when you are scripting a fixed pipeline rather than letting the agent decide.

## The nesting limit the changelog talks around

Here is the part to internalize before you design a deep hierarchy. The June SDK changelog says subagents "can now spawn their own subagents, and so on. A reviewer subagent can delegate to a test-writer, which can delegate further, with each level keeping its own prompt and model." The phrase "and so on" reads like unbounded recursion. It is not.

The mechanism is real: from the SDK docs, "when a subagent uses the `Agent` tool, the SDK hands it the same subagent executor the parent has, so a parent can delegate to a subagent that delegates further." But the same docs, and the [app-side subagents documentation](https://cursor.com/docs/subagents), state the hard cap plainly:

> "The main agent and its direct subagents can launch subagents, but a subagent launched by another subagent can't launch further ones."

So the true shape is two levels of delegation:

- **Level 0**: the main agent. Can delegate.
- **Level 1**: direct subagents (your `code-reviewer`). Can delegate.
- **Level 2**: subagents spawned by a level-1 subagent (the `test-writer` the reviewer called). **Cannot** delegate further.

For the reviewer-delegates-to-test-writer pattern this is fine, because the test-writer is a leaf: it writes tests and returns, it has no reason to spawn anyone. The trap is if you design the test-writer to itself delegate to, say, a `fixture-builder`. That third-level call will not launch. The work either silently does not happen or the test-writer has to do it inline, and you will burn tokens debugging why a subagent "ignored" its own subagent. Design your tree so that anything at level 2 is a leaf.

A couple of other things can block a spawn even within the limit: the current mode has to grant access to the delegation tool, and hooks or tool policies can deny it. If you have locked tool calls down with [auto-review and a permissions file](/2026/06/gate-cursor-sdk-tool-calls-with-auto-review-and-permissions-json/), make sure the delegation tool is not caught in that net, or the reviewer will be unable to reach the test-writer at all.

## What flows down the tree, and what doesn't

Subagents inherit the parent's tool surface, which is what makes this composable instead of a configuration chore.

- **Custom tools.** Anything you pass on `local.customTools` is visible to every subagent, including nested ones, with no re-declaration. The docs are explicit: "Custom tools reach subagents (including nested ones) too." So if your reviewer needs an in-process `lookup_coverage` function, you define it once on the parent and the test-writer sees it as well. This is the same inheritance behavior covered in the walkthrough on [exposing your own functions with local.customTools](/2026/06/expose-functions-to-cursor-sdk-agent-with-local-customtools/).
- **MCP servers.** A subagent's `mcpServers` array can reference parent-configured servers by name, so a GitHub or Linear MCP attached to the parent is reachable from the subagent without redefining the connection. One sharp edge for cloud runs: cloud subagents use the MCP servers configured for your team at `cursor.com/agents`, not the servers from your local session. If you develop locally and then [push work to a cloud agent](/2026/05/how-to-assign-a-jira-ticket-to-a-cursor-cloud-agent-and-get-a-pr-back/), the MCP surface your subagents see can change underneath you.
- **Model selection.** Does not inherit unless you ask for it. Each subagent picks its own model via `model`, defaulting to `"inherit"`. This is the lever for cost control: run the `code-reviewer` on `composer-2.5` for judgment and let the `test-writer` inherit or downgrade.

What does not flow down is context. That is the whole point. A subagent gets the task you delegate to it and its own system prompt, not the parent's accumulated conversation. The reviewer's running notes do not leak into the test-writer, and the test-writer's intermediate tool churn does not bloat the reviewer's window.

## Committing subagents to the repo instead of inlining them

Inline `agents` definitions are convenient for a one-file script, but you can also commit subagents as markdown files so the whole team and the desktop app share them. They live in `.cursor/agents/*.md` (the app also reads `.claude/agents/` and `.codex/agents/`) with YAML frontmatter:

```markdown
---
name: test-writer
description: Writes tests for code changes. Use after a review finds gaps.
model: inherit
readonly: false
---

You are a focused test author. Given a function and its surrounding test
conventions, write comprehensive tests covering happy paths, edge cases,
and error handling. Match the existing framework and assertion style.
```

The frontmatter fields are `name`, `description`, `model` (default `inherit`), `readonly` (default `false`, set it on a reviewer that should never write), and `is_background` (default `false`, runs without blocking the parent). Inline definitions passed to `Agent.create()` override file-based ones with the same name, so you can ship a sane default in the repo and tweak it per-script. A `readonly: true` reviewer plus a writable test-writer is a clean division of authority: the agent that judges cannot edit, the agent that edits does not judge.

## Putting the pipeline together

The full pattern is small. Define the two roles, give the reviewer write-free judgment and the test-writer the authoring job, let the parent orchestrate:

```typescript
// @cursor/sdk@1.0.16
import { Agent } from "@cursor/sdk";

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2.5" },
  local: { cwd: process.cwd() },
  agents: {
    "code-reviewer": {
      description:
        "Reviews a diff for correctness, security, and missing test " +
        "coverage. Delegates test authoring to test-writer.",
      prompt:
        "Review the given code for bugs and security issues. For each " +
        "untested branch, delegate to test-writer with the function and " +
        "the relevant test conventions. Do not write code yourself.",
      model: "inherit",
    },
    "test-writer": {
      description: "Writes comprehensive tests for a single function.",
      prompt:
        "Write tests covering happy paths, edge cases, and errors. " +
        "Match the existing framework and assertion style.",
      model: "inherit",
    },
  },
});

const run = await agent.send(
  "Review src/checkout.ts and ensure every branch is covered by a test."
);

for await (const event of run.stream()) {
  console.log(event);
}
```

The reviewer is the level-1 subagent that delegates; the test-writer is the level-2 leaf that does not. That respects the depth cap, keeps each context tight, and gives you a hierarchy you can reason about. If you later want the pipeline to survive restarts so a long review run can resume, that is a separate concern handled by the SDK's [agent state stores](/2026/06/persist-cursor-sdk-agent-state-across-restarts-sqlite-vs-jsonl/), which sit underneath this whole arrangement.

The authoritative references are the [Cursor TypeScript SDK docs](https://cursor.com/docs/sdk/typescript) for the `agents` field and `AgentDefinition` shape, the [subagents documentation](https://cursor.com/docs/subagents) for the two-level nesting rule and file format, and the [June 2026 SDK changelog](https://cursor.com/changelog/sdk-updates-jun-2026) where nested subagents, custom tools, and custom stores all landed together. When you design the tree, trust the docs' depth rule over the changelog's "and so on": keep your level-2 subagents as leaves and the hierarchy behaves exactly as written.
