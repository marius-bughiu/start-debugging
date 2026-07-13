---
title: "Claude Code Auto Mode Now Catches the Empty-Variable rm -rf"
description: "Claude Code's Week 28 releases (v2.1.202-v2.1.206, July 6-10 2026) teach auto mode to pause before an rm -rf whose path came from a variable that expanded to nothing, closing the classic rm -rf / footgun."
pubDate: 2026-07-13
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
---

Every shell scripter has seen the disaster: a cleanup line like `rm -rf "$BUILD_DIR/bin"` where `$BUILD_DIR` was never set, so the command quietly expands to `rm -rf /bin`. Claude Code's Week 28 releases (v2.1.202 through v2.1.206, shipped July 6-10 2026) add a guard for exactly this case in auto mode: the agent now pauses and asks before running an `rm -rf` whose target path was built from a variable that resolved to nothing.

## Why an agent hits this more often than you do

You write a destructive command once and eyeball it. An agent in auto mode strings shell together on the fly, often reusing a variable it set three turns ago. If an earlier step failed and left that variable empty, the danger is not that the model types `rm -rf /` on purpose. It is that it types something that *looks* scoped and safe, and the shell turns it into a root-level wipe at expansion time.

```bash
# The agent set this earlier, but the step that populated it failed
BUILD_DIR=""

# Looks scoped. Expands to: rm -rf /bin
rm -rf "$BUILD_DIR/bin"

# Same trap with an unset var under `set -u` off
rm -rf $ARTIFACTS_DIR/*
```

The classifier in auto mode now inspects the resolved command, not just the literal text you would see in the transcript. When the path an `rm -rf` is about to delete traces back to an empty or unresolved variable, the agent stops and surfaces it for approval instead of executing.

## Intent, not a blanket ban

This is the same design line Claude Code drew back in [v2.1.183, which blocked destructive git and IaC commands the agent decided to run on its own](/2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands/). A deliberate `rm -rf ./build` that you asked for still runs without a prompt. The guard fires on the specific footgun where the expanded target is far broader than the intent, because a variable came up empty.

Before Week 28, auto mode weighed `rm -rf "$BUILD_DIR/bin"` on the surface string, which reads as a narrow, local delete. After it, the check happens against what the shell will actually remove, so an empty `$BUILD_DIR` turns a green light into a question.

## The rest of Week 28

The same batch of releases hardens auto mode against transcript tampering (the agent can no longer quietly rewrite its own session history), turns `/doctor` into a full setup checkup that diagnoses and can fix issues, with `/checkup` as an alias, and reworks the `claude agents` view so each row shows a colored state word and a classifier-written headline instead of raw tool output. The Desktop app also picked up a built-in browser this week, so Claude can open docs and designs the way it already drives your local dev-server previews.

If you run agents in auto mode against real repositories or CI checkouts, this is the kind of guard you only notice the day it saves you. Full notes are on the [Claude Code changelog](https://code.claude.com/docs/en/changelog).
