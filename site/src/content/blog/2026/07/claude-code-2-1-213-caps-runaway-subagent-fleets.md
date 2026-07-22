---
title: "Claude Code 2.1.213 Puts Hard Caps on Runaway Subagent Fleets"
description: "Version 2.1.213 caps concurrent subagents and stops nested spawns by default, building on the per-session limits from 2.1.212. Here are the new defaults and env vars."
pubDate: 2026-07-22
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
---

If you have ever watched a Claude Code workflow fan out, spawn subagents that spawn their own subagents, and quietly burn through your budget while you were getting coffee, the last two releases are for you. Claude Code 2.1.213, released this week, adds a concurrency cap on subagents and stops them from nesting by default. It builds directly on the per-session ceilings that shipped in 2.1.212. Together they turn "hope the loop terminates" into a set of explicit, tunable limits.

## What 2.1.213 changes

Two behaviors changed, and both are safety rails around parallel agent work.

First, there is now a cap on how many subagents run at once. The default is 20. If a workflow tries to launch more, the extras queue instead of all firing simultaneously. You override it with an environment variable:

```bash
export CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=8
```

Second, and more consequential, subagents no longer spawn nested subagents by default. Before 2.1.213, a subagent could delegate to another subagent, which could delegate again, and depth was effectively unbounded. That is how a single top-level prompt could balloon into dozens of concurrent sessions. Now the spawn depth is capped, and you opt into deeper nesting explicitly:

```bash
# Allow subagents to spawn one more level down
export CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2
```

The changelog for 2.1.213 also fixes a related gap: `--max-budget-usd` was not stopping background subagents. So if you relied on a dollar ceiling to halt a runaway job, it now actually halts the background ones too.

## The per-session ceilings from 2.1.212

The 2.1.213 caps sit on top of two session-wide limits from 2.1.212, a few builds after the [2.1.208 release](/2026/07/claude-code-2-1-208-vim-insert-mode-remaps-jj-to-escape/). A single session now has a hard budget for both subagent spawns and web searches, each defaulting to 200:

```bash
export CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION=50
export CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION=100
```

2.1.212 also moved long-running MCP tool calls off the critical path. Any MCP call that runs longer than two minutes now moves to the background automatically, so a slow tool no longer blocks the turn. You can tune the threshold or turn the behavior off:

```bash
# Background MCP calls after 90 seconds instead of 120
export CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=90000
```

## Why this matters

Agent fleets are cheap to start and expensive to run. The failure mode was never a single subagent, it was recursion: an orchestrator spawning workers, workers spawning helpers, and no single number bounding the total. Defaults of 20 concurrent, no nesting, and 200 spawns per session mean a misbehaving prompt now hits a wall instead of a bill. If you are building fan-out workflows, read the defaults, then raise the two or three that your real work actually needs rather than uncapping everything.

Full details are in the [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
