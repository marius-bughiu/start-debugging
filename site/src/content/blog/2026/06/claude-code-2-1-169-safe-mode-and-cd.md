---
title: "Claude Code 2.1.169 Adds --safe-mode and a /cd That Keeps the Prompt Cache Warm"
description: "Claude Code v2.1.169 (June 8, 2026) ships a --safe-mode flag that disables every customization for clean troubleshooting, and a /cd command that moves your session to a new directory without breaking the prompt cache mid-run."
pubDate: 2026-06-09
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
---

Claude Code v2.1.169 landed on June 8, 2026 with two changes that target the two most annoying moments in a long agent session: the "is it my config or the tool?" debugging spiral, and the prompt-cache reset you eat every time you need to work in a different directory. Both are small flags. Both remove a real tax.

## `--safe-mode` gives you a clean baseline to bisect against

When Claude Code starts behaving oddly, a hook fires when it should not, an MCP server hangs on launch, a skill hijacks a slash command, the hard question is whether the bug is in the CLI or in your own stack of customizations. Until now, answering that meant manually moving `CLAUDE.md` aside, commenting out hooks in `settings.json`, and disabling plugins one at a time.

v2.1.169 collapses that into one flag:

```bash
# Start with CLAUDE.md, plugins, skills, hooks, and MCP servers all disabled
claude --safe-mode

# Same thing via env var, handy in CI or a wrapper script
CLAUDE_CODE_SAFE_MODE=1 claude
```

If the problem disappears in safe mode, it is yours, and you can re-enable customizations group by group until it comes back. If it persists, it is the CLI, and you have a clean repro to file. This is the agent-CLI equivalent of booting Windows into safe mode or launching an editor with `--disable-extensions`: not a fix, but the fastest path to a verdict.

## `/cd` moves the session without resetting the cache

The other change is subtler and saves real money on long runs. Claude Code caches the conversation prefix with Anthropic's prompt cache, which has a short TTL and is what keeps follow-up turns fast and cheap. Changing your working directory used to mean exiting and relaunching, which threw that cache away. The next turn re-read your whole context uncached: slower, and billed at the full `cache_creation` rate instead of the cheap cache-read rate.

The new `/cd` command moves an active session to a new directory in place:

```text
# Working in the API project, now need to touch the shared library
/cd ../shared-lib

# Absolute paths work too
/cd C:\S\start-debugging\site
```

The session keeps its history and its warm cache, so the turn right after `/cd` is still a cache hit. On a multi-repo task where you bounce between a backend and a frontend tree, this is the difference between paying for one cached context and re-paying for it every directory switch.

## A third knob worth knowing

The same release adds `disableBundledSkills` (and `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`), which hides Claude Code's built-in skills, workflows, and slash commands from the model. If you have your own opinionated set and the bundled ones are getting in the way, that is your off switch.

This continues the pattern from the [v2.1.128 plugin and worktree fixes](/2026/05/claude-code-2-1-128-plugin-zip-worktree-fix/): unglamorous CLI changes that take a class of papercut out of the daily loop. Full notes are on the [v2.1.169 release page](https://github.com/anthropics/claude-code/releases/tag/v2.1.169).
