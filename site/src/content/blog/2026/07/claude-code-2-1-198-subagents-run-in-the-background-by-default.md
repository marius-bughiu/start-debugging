---
title: "Claude Code 2.1.198 Runs Subagents in the Background by Default"
description: "Claude Code v2.1.198 (July 1, 2026) flips subagents to background execution by default, so the main agent keeps working while they run, and background agents that touch code now auto-commit, push, and open a draft PR when they finish."
pubDate: 2026-07-06
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
---

Claude Code v2.1.198 shipped on July 1, 2026, and it changes the default execution model for subagents. Until now, launching a subagent (the Task tool, custom agents, agent teams) blocked the main loop: you delegated a chunk of work, the parent agent went quiet, and you waited for the child to return before anything else moved. As of 2.1.198, subagents run in the background by default, and the main agent keeps working while they run.

## Why blocking was the wrong default

The point of a subagent is isolation. You hand it a self-contained job (sweep a directory, verify a claim, draft a migration) with its own context window so the parent does not drown in file dumps. But if spawning one freezes the parent until it finishes, you lose the other half of the benefit: parallelism. Two independent searches that could have run at once ran one after the other, and the wall-clock cost was the sum, not the max.

Backgrounding by default fixes that. The parent fans out work and continues on the main thread. When a child finishes, its result comes back as a notification you can act on, rather than a barrier you sat behind. For anything decomposable, this is the difference between a pipeline and a queue.

## Background agents that finish the job

The second half of the release is what background agents do when they are done. If a background agent did code work in a git worktree, it no longer stops to ask what to do with the diff. It auto-commits, pushes, and opens a draft PR, then reports back.

That is a real workflow shift. The old loop was: spawn agent, wait, review its proposed changes, then commit and push yourself. The new loop is: spawn agent, keep working, and find a draft PR waiting for review when it lands. The draft state is the safety rail: nothing merges on its own, but the plumbing between "agent finished" and "I can review a real PR" is gone.

```bash
# Before 2.1.198: foreground subagent, main loop blocks until it returns.
# You then stage and push its changes by hand.

# 2.1.198+: subagent runs in the background, you keep working, and a
# code-writing background agent lands its work as a draft PR itself:
#   [background] agent "refactor-auth" finished
#   -> committed, pushed branch agent/refactor-auth, opened draft PR #482
```

Because the default flipped, it is worth re-reading any automation or docs that assumed subagents were synchronous. Steps that implicitly relied on a subagent finishing before the next line ran now need to await the result explicitly.

## The rest of 2.1.198

Two other items ship in the same release. Claude in Chrome is now generally available, moving the browser-driving tools out of preview. And there is a new `/dataviz` skill for building charts and dashboards. The release also tightens network resilience for transient errors and fixes a batch of background-task, agent-team, and Remote Control bugs, the same reliability push that continued into [2.1.200's background-session fixes](/2026/07/claude-code-2-1-200-renames-default-permission-mode-to-manual/).

If you lean on subagents at all, the headline is small to state and large in practice: they no longer make you wait. Full notes are on the [Claude Code changelog](https://code.claude.com/docs/en/changelog).
