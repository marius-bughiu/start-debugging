---
title: "How to Gate Which Cursor SDK Tool Calls Run Automatically With Auto-Review and permissions.json"
description: "By default a local Cursor SDK agent runs every tool call without asking. Set local.autoReview to route Shell, MCP, and Fetch calls through the classifier, then steer it with the autoRun block in permissions.json. With code, the three-step evaluation order, and why none of it is a security boundary."
pubDate: 2026-06-16
tags:
  - "cursor"
  - "ai-agents"
  - "mcp"
  - "typescript"
  - "agent-security"
---

A headless Cursor SDK agent has no human sitting in front of it, so by default it runs every tool call the model emits the instant the model emits it. That is fine for a sandboxed read-only run and terrifying for anything that touches your shell, your filesystem, or a network it can reach. As of `@cursor/sdk@1.0.16` (the June 2026 SDK update that shipped custom tools, custom stores, and auto-review together), you get a middle ground: set `local.autoReview: true` and the SDK routes Shell, MCP, and Fetch calls through the same classifier the Cursor IDE uses, then you steer that classifier with an `autoRun` block in `permissions.json`. This post shows the exact option shape, the three-step order every call is evaluated against, the `permissions.json` schema, and the one thing you must internalize before you trust any of it: none of this is a security boundary.

Everything below assumes a local agent on `@cursor/sdk@1.0.16` with `model: { id: "composer-2.5" }`. Cloud agents have their own VM-level isolation and do not take these local options.

## What "no approval by default" actually means

When you create a local agent and call `send()`, the model plans, picks a tool, and the SDK executes it. There is no prompt, no pause, no `y/n`. In the IDE a person clicks through approvals; in a headless SDK run there is nobody to click, so the SDK's default is to just run. That default is correct for the common case the SDK was built for, which is a scripted agent doing scoped work inside a sandbox. It is the wrong default the moment the agent can run `rm`, `git push`, `curl` to an arbitrary host, or an MCP tool that mutates production.

`local.autoReview` is the switch that changes this. It is a plain boolean:

```typescript
// @cursor/sdk@1.0.16
import { Agent } from "@cursor/sdk";

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2.5" },
  local: {
    cwd: process.cwd(),
    autoReview: true,
  },
});
```

With `autoReview: true`, every Shell, MCP, and Fetch call the model makes is sent to a classifier before it runs. The classifier decides which calls run automatically and which to hold back for review, rather than bypassing review entirely. It is the exact same classifier the Cursor IDE uses when you turn on Auto-review mode there, so behaviour is consistent between the two surfaces. If you are coming from the [TypeScript SDK launch](/2026/05/cursor-typescript-sdk-programmatic-coding-agents/), this is the safety primitive that was missing from the first cut.

The catch is that "hold back for review" in a headless run means the call does not execute and surfaces as an event in the run stream. You decide what to do with it: surface it to a human over Slack, log it, or fail the run. Auto-review gives you the decision point. It does not invent a human to make the decision.

## The three checks every tool call passes through

A tool call does not go straight to the classifier. When auto-review is active, Cursor evaluates each Shell, MCP, and Fetch call against three checks, in order, and stops at the first that resolves it:

1. **Allowlist.** If the call matches an entry in your `mcpAllowlist` or `terminalAllowlist`, it runs immediately. No classifier, no latency, no token cost. This is your fast path for the calls you have already decided are always safe.
2. **Sandbox.** If sandboxing is enabled, the call runs under the sandbox's filesystem, shell, and network restrictions. A call that the sandbox blocks fails closed.
3. **Classifier.** Anything not resolved by the first two is sent to the LLM classifier, which reads your `autoRun` instructions from `permissions.json` and decides allow or hold.

Internalizing this order is the whole game. The allowlist is deterministic and cheap, so put your high-frequency safe calls there. The classifier is non-deterministic and costs a model round-trip per call, so let it handle only the long tail you cannot enumerate in advance. People who skip the allowlist and try to express everything as `autoRun` instructions end up paying for a classifier call on every `git status` and wondering why their agent is slow.

## The permissions.json schema, in full

`permissions.json` has exactly three top-level keys, all optional:

```json
{
  "mcpAllowlist": ["github:create_issue", "linear:*"],
  "terminalAllowlist": ["git", "npm:install*", "ls"],
  "autoRun": {
    "allow_instructions": [
      "Read-only inspections of build artifacts under ./dist are fine."
    ],
    "block_instructions": [
      "Always pause delete operations so I get a chance to review them."
    ]
  }
}
```

`mcpAllowlist` and `terminalAllowlist` are string arrays. `autoRun` is an object with two string arrays of natural-language instructions. Each field is independent: you can ship an allowlist with no `autoRun`, or `autoRun` instructions with no allowlist.

### MCP match syntax

MCP allowlist entries are `server:tool` patterns, matched case-insensitively, with `*` as a wildcard:

- `github:create_issue` matches exactly that tool on the `github` server.
- `linear:*` matches every tool on the `linear` server.
- `*:read_file` matches a `read_file` tool on any server.

This is the same naming Cursor uses to surface MCP tools elsewhere, so if you registered functions through [`local.customTools`](/2026/06/expose-functions-to-cursor-sdk-agent-with-local-customtools/) they appear under the synthetic `custom-user-tools` server and you allowlist them as `custom-user-tools:your_tool_name`.

### Terminal match syntax

Terminal entries are command-prefix strings, matched case-sensitively:

- `git` matches `git status`, `git diff`, and crucially also `git push`. A bare command name allowlists the entire command surface, so be deliberate.
- `npm:install*` uses a colon to separate the base command from an args glob, so it matches `npm install` and `npm install --save-dev foo` but not `npm publish`.

The colon-glob form is how you allowlist a safe subcommand without handing the model the whole binary. `git:status` and `git:diff` are a far tighter grant than `git`.

### autoRun instructions are prose, not patterns

The `autoRun` arrays are not globs. Each entry is a free-form sentence written the way you would brief a teammate: "Read-only inspections of build artifacts under ./dist are fine," or "Always pause delete operations so I get a chance to review them." The classifier reads them as steering signals. `allow_instructions` describes the call shapes to lean toward allowing; `block_instructions` describes the ones to hold for review.

The subtlety that trips people up: these instructions steer, they do not enforce. A call that matches an `allow_instructions` entry still goes through the safety check and can still be held. A call that matches a `block_instructions` entry can still be approved when Cursor's own safety logic insists otherwise. Treat both arrays as advice to a probabilistic classifier, not as rules.

## Where the file lives and how the layers merge

Cursor reads `permissions.json` from two locations:

- `~/.cursor/permissions.json`, per-user, applies to every workspace.
- `<workspace>/.cursor/permissions.json`, per-repo, applies only in that workspace.

For an SDK run, the workspace is whatever you passed as `local.cwd`, so the per-repo file is the one that lives next to the code your agent is editing. That is usually where you want the tight, project-specific rules, with broad personal defaults in the home-directory file.

Two rules govern how the layers combine, and they behave differently:

- **Allowlists concatenate.** When both the per-user and per-repo files define `terminalAllowlist`, the arrays are unioned. You cannot remove a per-user allowlist entry by leaving it out of the repo file.
- **A defined key replaces the IDE allowlist.** When `permissions.json` defines a given key, it fully replaces whatever you had configured in the IDE settings UI for that type. The IDE entries are not merged in.

The full precedence chain, highest to lowest, is: team admin settings from the dashboard, then `permissions.json` (per-user union per-repo), then the IDE settings UI. A team admin policy wins over anything a local file says, which is the property you want when you are governing a fleet of agents rather than your own laptop.

## A realistic gated agent

Put the pieces together and you get an agent that runs the safe stuff at full speed, sandboxes its shell, and routes the genuinely ambiguous calls through the classifier. The `permissions.json` from the schema section sits in `<cwd>/.cursor/permissions.json`; the agent itself is small:

```typescript
// @cursor/sdk@1.0.16
import { Agent } from "@cursor/sdk";

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2.5" },
  local: {
    cwd: process.cwd(),
    autoReview: true,
    sandboxOptions: { enabled: true },
  },
});

const run = await agent.send(
  "Run the test suite, then open a GitHub issue summarizing any failures."
);

for await (const event of run.stream()) {
  // Held calls surface here. Decide: notify a human, log, or abort.
  console.log(event);
}
```

With this config: `npm test` matches `npm:install*`? No, so it falls to the classifier unless you add `npm:test*`. `git status` matches `git`, so it runs immediately. The `github:create_issue` MCP call matches `mcpAllowlist`, so it runs without a classifier hop. A `curl` to an unknown host is not allowlisted, hits the sandbox network rules, and fails closed if the sandbox blocks the host. A `git push` matches `git` in the allowlist and runs, which is almost certainly not what you wanted, so tighten that entry to `git:status` and `git:diff` and let `git push` fall to the classifier where your `block_instructions` can catch it.

`sandboxOptions: { enabled: true }` is doing real work here that the classifier cannot. The classifier is a model reading prose; the sandbox is an OS-level constraint on filesystem, shell, and network for every shell call and shell-spawned process. When a call has to be both convenient and contained, you want both layers: the allowlist or classifier to decide intent, the sandbox to bound the blast radius regardless of what the classifier decided.

## Why none of this is a security boundary

Cursor says it in the docs and in the release notes, and it is worth repeating because the API makes it tempting to forget: "Allowlists and `autoRun` instructions are best-effort convenience. They are not a security guarantee." Auto-review carries the same warning: it is best-effort and not a security boundary.

The reason is structural. The classifier is a non-deterministic model. It makes mistakes in both directions: it passes calls it should have held, and it holds calls it should have passed. You cannot write `block_instructions` precise enough to close that gap, because the thing reading them is the same kind of model that wrote the malicious-looking call in the first place. If a prompt-injection payload talks the agent into running a dangerous command, it can also be shaped to read as benign to the classifier.

That has a concrete design consequence. For anything genuinely irreversible, do not rely on the classifier as the gate. Use a mechanism that cannot be talked out of its decision:

- Scope the dangerous capability to a single `send()` so it physically does not exist outside the one turn you intend, the way per-run `customTools` work.
- Keep it behind the sandbox, which is an OS constraint rather than a model judgment.
- Move the irreversible action out of the agent entirely and have the run emit an event that a deterministic, non-LLM step acts on after a real human approves it. If you have built human-in-the-loop approval in other stacks, this is the same pattern as [tool-approval gating in the Microsoft Agent Framework](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/): the model proposes, a deterministic gate disposes.

A reasonable question is whether SDK hooks can serve as that authoritative gate. Today they cannot: hooks let you observe and extend the agent loop, but there is an open request to support authoritative `allow`, `deny`, and `ask` verdicts from hooks, which tells you the current hooks surface is not a hard enforcement point. Until that lands, the enforcement story is sandbox plus single-`send()` scoping plus a human in the deterministic path, with auto-review and `permissions.json` as the convenience layer that cuts the noise so the human only sees the calls that actually need a look.

## Putting it in production

The shape that holds up: allowlist the high-frequency calls you have genuinely decided are safe so they never touch the classifier, turn on the sandbox so every shell call is OS-constrained no matter what the classifier thinks, write `autoRun.block_instructions` for the ambiguous-but-mostly-safe long tail, and route held calls in the run stream to a real human or a deterministic check for anything irreversible. Keep the broad defaults in `~/.cursor/permissions.json` and the tight, repo-specific rules in `<cwd>/.cursor/permissions.json`, and if you are running a fleet, put the non-negotiables in the team admin dashboard where no local file can override them.

If your agent also persists state between runs, the same `.cursor/` directory discipline applies to [how you store agent state across restarts](/2026/06/persist-cursor-sdk-agent-state-across-restarts-sqlite-vs-jsonl/), and if you are weighing whether a capability should be a gated shell command at all versus a structured tool, the [MCP vs custom tool calling tradeoffs](/2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents/) are worth a read before you wire it up.

The authoritative references are the [permissions.json reference](https://cursor.com/docs/reference/permissions), the [Cursor TypeScript SDK docs](https://cursor.com/docs/sdk/typescript), and the [June 2026 SDK changelog](https://cursor.com/changelog/sdk-updates-jun-2026) where auto-review landed. For the design philosophy behind treating it as convenience rather than a wall, Cursor's own [governing agent autonomy with auto-review](https://cursor.com/blog/agent-autonomy-auto-review) post is the clearest statement of intent.
