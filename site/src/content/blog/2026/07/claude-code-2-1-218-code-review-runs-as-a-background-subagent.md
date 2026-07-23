---
title: "Claude Code 2.1.218 Runs /code-review as a Background Subagent"
description: "Version 2.1.218 moves /code-review off your main conversation into a background subagent, and fork-context skills now background by default. Here is what changed and how to opt out."
pubDate: 2026-07-23
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
---

Claude Code 2.1.218, released July 22 2026, changes where `/code-review` runs. Instead of expanding a long review inline and pushing your actual work up and out of view, the review now runs as a background subagent. Your conversation stays yours. The review happens off to the side, and you check on it when you want to.

## What 2.1.218 changes

The headline is small in the changelog and large in daily use: `/code-review` now runs as a background subagent. Three things follow from that.

Review output no longer fills your conversation. A code review can produce dozens of findings across many files. Previously that all landed in the main transcript, burying the thread you were working in. Now it lives in the subagent.

Stacked slash commands stay as the review target. If you queue `/code-review` behind other commands, the review still knows what it is supposed to look at rather than losing its target when it moves to the background.

Navigation got a safety rail. Pressing `Esc` in the agent view returns you to the conversation the review was backgrounded from, so you do not lose your place. The same release also fixed the left arrow key silently discarding a conversation with no undo. It now asks to confirm.

## The end of a shift that started in 2.1.215

This did not come out of nowhere. A few builds earlier, 2.1.215 (July 19) stopped Claude from running `/verify` and `/code-review` on its own. You invoke them when you want them. 2.1.218 extends the same idea to research: `/deep-research` now starts only when you invoke it manually, and Claude no longer launches it on its own.

Put together, the message is consistent. Long, noisy, expensive skills are opt-in and out-of-band. They do not fire automatically, and when you do fire them, they do not take over your session. This is the same instinct behind subagents [running in the background by default](/2026/07/claude-code-2-1-198-subagents-run-in-the-background-by-default/) from 2.1.198.

## Fork-context skills now background by default

There is a companion change worth knowing if you author skills. Skills with `context: fork` now run in the background by default. That matches the `/code-review` behavior for your own skills that spin up an isolated context.

If you want a fork skill to stay in the foreground, opt out per skill with a frontmatter flag:

```yaml
---
name: my-review-skill
context: fork
background: false
---
```

The boolean parser also got friendlier in 2.1.218: `yes`, `no`, `on`, `off`, `1`, and `0` are now accepted alongside `true` and `false` for skill and plugin frontmatter booleans, case-insensitive.

## Why this matters

The main conversation is where you think. Anything that dumps a wall of output into it costs you attention, not just tokens. Moving review and research into background subagents keeps the transcript readable and lets the slow work run without blocking you. If you have muscle memory of `/code-review` flooding the screen, update it: run it, keep working, and check the agent view when it is done.

Full details are in the [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
