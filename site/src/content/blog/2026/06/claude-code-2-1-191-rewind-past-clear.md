---
title: "Claude Code 2.1.191 Lets /rewind Reach Back Past a /clear"
description: "Claude Code v2.1.191 (June 24, 2026) extends /rewind so you can restore conversation and code state from before you ran /clear, recovering context that used to be gone for good."
pubDate: 2026-06-26
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
---

Claude Code v2.1.191 shipped on June 24, 2026, and the standout change is small in description but large in practice: `/rewind` can now travel back past a `/clear`. The context you wiped to get a clean slate is no longer gone, it is just one rewind away.

## What /clear used to cost you

`/clear` resets the conversation. It is the right move when the current thread is bloated, the model is anchored on a dead end, or you are switching tasks and want a fresh window. The cost was that it drew a hard floor under your history. Anything before the `/clear` was unreachable, even though Claude Code was already checkpointing your session as you went.

That floor is what 2.1.191 removes. The session checkpoints that back `/rewind` now survive a `/clear`, so the rewind picker can offer points from before the reset.

## How /rewind works

`/rewind` walks you backward through checkpoints Claude Code records at each step of a session. You open it with the `/rewind` command or by pressing `Esc` twice:

```text
Esc Esc          # open the rewind picker
/rewind          # same thing, typed
```

Pick a checkpoint and you choose what to restore: the conversation, the code on disk, or both. That distinction matters. You can roll the conversation back to a point three steps ago to re-ask a question without touching your working tree, or restore the files to a known-good state while keeping the discussion that got you there.

Before this release the list of available checkpoints stopped at your most recent `/clear`. Now it keeps going. A typical recovery looks like this:

```text
# A long debugging thread, then a reset
/clear
# ...new work, then you realize you need the earlier repro
Esc Esc
# the picker now lists checkpoints from before the /clear
# select one, restore conversation + code, keep going
```

## Why this changes how you use /clear

The honest reason people hesitated to run `/clear` was loss aversion. Clearing meant committing to the cut, so you would keep a stale, expensive context around just in case. Making the reset reversible flips that. `/clear` becomes a cheap, routine way to keep each window tight, because a wrong cut is recoverable instead of permanent.

It also pairs with the checkpoint-first direction of recent releases. Your session is a sequence of restore points you can move between, not a single linear transcript you either keep or destroy.

## The rest of the release

2.1.191 also fixes scroll position jumping during streaming responses, corrects a background-agent resurrection bug, and improves the `/voice` messaging shown when a policy disables it. The very next build, 2.1.193, adds `autoMode.classifyAllShell` to route Bash and PowerShell through the auto-mode classifier and surfaces auto-mode denial reasons in the transcript and `/permissions`.

Full notes are on the [Claude Code changelog](https://code.claude.com/docs/en/changelog).
