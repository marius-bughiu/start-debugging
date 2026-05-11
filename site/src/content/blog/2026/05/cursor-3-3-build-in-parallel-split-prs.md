---
title: "Cursor 3.3 Adds Build in Parallel, Split PRs, and a Unified PR Review"
description: "Cursor 3.3 (May 7, 2026) ships async subagents that work on independent steps of a plan at the same time, a quick action that splits one chat into multiple pull requests, and a redesigned PR workflow that keeps reviews, commits, and changes in one place."
pubDate: 2026-05-11
tags:
  - "cursor"
  - "ai-agents"
  - "pull-requests"
  - "subagents"
---

On May 7, 2026, Cursor shipped [version 3.3](https://cursor.com/changelog/05-07-26). It is a release that doubles down on the same shift the [TypeScript SDK preview](/2026/05/cursor-typescript-sdk-programmatic-coding-agents/) hinted at: agents are no longer a single thread of work tied to one chat. The headline features, "Build in Parallel," "Split PRs," and a redesigned PR review surface, all push the editor closer to a multi-agent IDE where one human supervises several concurrent runs.

## Build in Parallel turns a plan into async subagents

Planning was already part of Cursor's loop: you draft a plan, the agent walks the steps. In 3.3, a new "Build in Parallel" action takes that plan, identifies independent steps, and spawns async subagents that work on each one at the same time. Cursor still keeps dependent steps sequential when the plan implies an order, so you do not have to manually mark the graph.

If you prefer the CLI flavour, there is a `/multitask` command that drives the same machinery from chat:

```text
/multitask
- Wire the Stripe webhook handler
- Add a Polly retry policy around the OpenAI client
- Rewrite the README install section
```

Each item runs in its own subagent context. The subagents share the workspace through snapshots, not the same buffer, so two concurrent edits to the same file no longer fight. The Explore subagent now also takes a model selector (`model: opus`, `model: parent`, or `disabled`), which means the cheap "find relevant code" hop can run on a smaller model than the writer.

## Split PRs slices one chat into many

Anyone who has let an agent run for an hour knows the pain: by the time you stop it, the diff covers four unrelated changes and reviewing it as a single PR is hopeless. The new "Split into PRs" quick action analyses the chat transcript, groups commits by logical concern, and opens one PR per group. Cursor keeps PRs independent unless it detects a real dependency, in which case it links them with a "depends on" note.

A safety snapshot is created before the split, and Cursor asks for approval before pushing.

## PR Review collapses three tabs into one workflow

The third piece is a redesigned PR view inside the editor. Three tabs replace the older split between GitHub and the agent panel:

- **Reviews**: inline review threads and top-level PR comments, with quick actions to reply or accept.
- **Commits**: a focused commit list for the PR, so you can step through the agent's history.
- **Changes**: a file tree plus a picker, which is the part you notice when the PR touches forty files.

Together, the three features sketch the same direction the [Cursor TypeScript SDK](/2026/05/cursor-typescript-sdk-programmatic-coding-agents/) pointed at: the unit of work is no longer "one prompt, one diff," it is "one plan, many subagents, many PRs."
