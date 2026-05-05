---
title: "Claude Code 2.1.128 Loads Plugins From .zip Archives and Stops Dropping Unpushed Commits"
description: "Claude Code v2.1.128 (May 4, 2026) ships --plugin-dir support for .zip archives, makes EnterWorktree branch from local HEAD, and stops the CLI from leaking its own OTLP endpoint into Bash subprocesses."
pubDate: 2026-05-05
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
---

Claude Code v2.1.128 landed on May 4, 2026 with three changes that quietly fix workflow problems many of us hit without realising it: plugins can now be loaded straight from a `.zip`, `EnterWorktree` finally branches from local `HEAD` instead of `origin/<default>`, and subprocesses no longer inherit the CLI's own `OTEL_*` environment variables. None of these are flashy, all of them remove a class of "wait, why did that just happen?" support thread.

## `--plugin-dir` now accepts zipped plugin archives

Until v2.1.128, `--plugin-dir` only accepted a directory. If you wanted to share an internal plugin with a colleague or pin a version, you either pushed it to a marketplace, committed the unpacked tree into the repo, or wrote a wrapper script that unzipped before launching. None of that scaled past one or two plugins.

The new behaviour is exactly what you expect:

```bash
# Old: had to point at an unpacked directory
claude --plugin-dir ./plugins/my-team-tooling

# New in v2.1.128: zip works directly
claude --plugin-dir ./plugins/my-team-tooling-1.4.0.zip

# Mix and match in the same launch
claude \
  --plugin-dir ./plugins/local-dev \
  --plugin-dir ./dist/release-bundle.zip
```

There's also a fix in this release that pairs with it. The `/plugin` Components panel used to show "Marketplace 'inline' not found" for plugins loaded via `--plugin-dir`. v2.1.128 stops that. And the headless mode `init.plugin_errors` JSON now reports `--plugin-dir` load failures (corrupt zip, missing manifest) alongside the existing dependency demotion errors, so CI scripts can fail loudly instead of silently shipping a broken plugin set.

## `EnterWorktree` no longer drops your unpushed commits

This one is a real bug fix dressed up as a behaviour change. `EnterWorktree` is the tool Claude Code uses to spin up an isolated worktree for an agent task. Before this release, the new branch was created from `origin/<default-branch>`, which sounds reasonable until you realise what it means: any commit you had locally on `main` but hadn't pushed yet was simply not part of the worktree the agent saw.

In v2.1.128, `EnterWorktree` creates the branch from local `HEAD`, which is what the docs already claimed. Concretely:

```bash
# You're on main with a local-only commit
git log --oneline -2
# a1b2c3d feat: WIP rate limiter (NOT pushed)
# 9876543 chore: bump deps (origin/main)

# Agent calls EnterWorktree
# v2.1.126 and earlier: branch starts at 9876543, your WIP commit is GONE
# v2.1.128: branch starts at a1b2c3d, the agent sees your WIP
```

If you've ever had a long-running agent task quietly skip the change you made five minutes ago, this is probably why.

## OTEL env vars no longer leak into subprocesses

Claude Code itself is OpenTelemetry-instrumented and reads `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, and friends from the environment. Until v2.1.128 those variables were inherited by every subprocess the CLI spawned: Bash tool calls, hooks, MCP servers, LSP processes. If you ran a .NET app via the Bash tool that was itself OTel-instrumented, it would happily push its traces to the CLI's collector.

The fix in v2.1.128 strips `OTEL_*` out of the environment before exec. Your apps now use the OTLP endpoint they were configured with, not the one your editor happens to be reporting to. If you genuinely want a child process to share the CLI's collector, set the variable explicitly in your run script.

A few other notable items: bare `/color` now picks a random session color, `/mcp` shows the tool count per server and flags ones that connected with zero tools, parallel shell tool calls no longer cancel sibling calls when one read-only command (`grep`, `git diff`) fails, and sub-agent progress summaries finally hit the prompt cache for roughly 3x lower `cache_creation` cost on busy multi-agent runs. Vim mode also got a small but correct fix: `Space` in NORMAL mode moves the cursor right, matching real vi.

This continues the trend the [v2.1.126 project purge release](/2026/05/claude-code-2-1-126-project-purge/) started: small, targeted CLI changes that take blunt instruments out of the user's hands. Full notes on the [v2.1.128 release page](https://github.com/anthropics/claude-code/releases/tag/v2.1.128).
