---
title: "Fix: Claude Code High Memory Usage and Context Window Overflow"
description: "High memory usage and context overflow are two different problems in Claude Code. Raise the Node heap for RAM, use /context and /compact for the window, /heapdump to diagnose."
pubDate: 2026-07-01
template: error-page
tags:
  - "errors"
  - "claude-code"
  - "ai-agents"
  - "context-window"
  - "memory-leak"
---

If Claude Code shows `High memory usage (7GB) · /heapdump` in the status bar, or crashes with `FATAL ERROR: ... JavaScript heap out of memory`, that is the Node.js process running out of RAM. Raise the ceiling with `NODE_OPTIONS=--max-old-space-size=8192` and restart. If instead the context bar is near full and answers get vague, that is the model's context window filling, and the fix is `/context` then `/compact`, not more RAM. These are two different problems people constantly conflate. This is written against Claude Code 2.1.x.

## The two errors, verbatim

Searchers land here from two very different symptoms. The first is process memory pressure, surfaced either in the status bar or as a hard crash:

```
High memory usage (7GB) · /heapdump

FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

The second is the context window filling up. There is no exception string for this one. You see the context meter climb toward 100%, then a summarization pass replaces your history, or you get a thrashing message when a single oversized item refuses to shrink:

```
Context low. Auto-compacting conversation to free up space.
```

The status-bar `High memory usage` warning is about the operating-system memory the `claude` process holds. The context meter is about tokens inside the model. They move independently: you can blow the context window while the process sits at 400 MB, and you can leak 20 GB of RAM with a nearly empty context. Fixing the wrong one wastes an afternoon, so the first job is telling them apart.

## Why the process runs out of RAM

Claude Code is a Node.js application, and Node caps the V8 "old space" heap by default. When the working set of the session (transcript, tool results, file buffers, MCP payloads) grows past that cap, V8 gives up and the process dies with `JavaScript heap out of memory`. Two things push you into that wall.

The first is legitimately large state. Loading a big conversation on `claude --resume` parses the whole `.claude.json` state file into memory at once, and on large files that alone can exceed the default heap, as tracked in [issue #10592](https://github.com/anthropics/claude-code/issues/10592) and [issue #3178](https://github.com/anthropics/claude-code/issues/3178). Wide tool outputs (a `find` over a monorepo, a multi-megabyte log) also spike the heap.

The second is a genuine leak. Several 2.1.x builds grew unboundedly over a long session: the process starts around 300 MB and climbs to multiple gigabytes with no ceiling. [Issue #22188](https://github.com/anthropics/claude-code/issues/22188) reports heap allocation reaching 93 GB, and [issue #51179](https://github.com/anthropics/claude-code/issues/51179) reports `claude.exe` on Windows consuming roughly 40 GB of virtual memory and triggering a system-wide out-of-memory condition. A leak is not something you tune around; you cap it, then roll back or update.

## Diagnose before you tune: /doctor and /heapdump

Before changing any flag, find out which problem you have.

Run `/doctor` first. It checks the install and runtime and flags obvious misconfiguration:

```text
# Claude Code 2.1.x
/doctor
```

If the status bar is nagging about memory, capture a heap snapshot with `/heapdump`. This writes a `.heapsnapshot` file you can open in Chrome DevTools (the Memory tab, "Load profile") to see what is holding the RAM:

```text
# Claude Code 2.1.x, writes a V8 heap snapshot to disk
/heapdump
```

Two gotchas here. First, the snapshot is large: a 7 GB process produces a multi-gigabyte file, and the write itself briefly spikes memory further, which is exactly why [issue #33116](https://github.com/anthropics/claude-code/issues/33116) flags high memory on startup when a dump runs. Do it when you can spare the headroom. Second, on Windows the command is unreliable. In 2.1.72 it fails outright with `EEXIST: file already exists, mkdir 'C:\Users\{user}\Desktop'` because it tries to create the Desktop directory that already exists, per [issue #32690](https://github.com/anthropics/claude-code/issues/32690). If you hit that, capture the snapshot from a WSL session or a Unix host instead, or skip straight to the RAM ceiling below.

## Fix 1: raise the Node heap ceiling

For a large-but-legitimate workload, give V8 more room. Set `NODE_OPTIONS` before launching Claude Code so the flag reaches the underlying Node runtime. The value is in megabytes, so 8192 is 8 GB:

```bash
# macOS / Linux, Claude Code 2.1.x. 8192 MB = 8 GB old-space heap.
NODE_OPTIONS="--max-old-space-size=8192" claude
```

```powershell
# Windows PowerShell, Claude Code 2.1.x
$env:NODE_OPTIONS = "--max-old-space-size=8192"
claude
```

Make it stick by exporting it in your shell profile (`~/.zshrc`, `~/.bashrc`, or a PowerShell `$PROFILE`) so every session inherits it. 4096 is a reasonable floor; 8192 is the value most reliably clears the `--resume` crash on a large state file. Do not set it larger than your physical RAM: telling V8 it may use 32 GB on a 16 GB machine just moves the failure from a clean crash to system swap thrashing, which is worse.

This flag treats the symptom. It buys headroom for a big working set, and it is the right fix when a specific heavy operation (a resume, a wide search) tips you over. It is the wrong fix for a leak, because a leak will climb through any ceiling you set. If memory grows steadily while the session sits idle, you have a leak, not a workload.

## Fix 2: cap a real leak, then update or roll back

If `/heapdump` shows memory climbing with no bound, or growth continues while you are not typing, stop tuning and contain it.

The fastest containment is a periodic restart. Long sessions are where the leaks show up, so end the session and start a new one every hour or two on a known-bad build. Pair that with `/clear` between unrelated tasks (more on that below) so you are not carrying dead weight into the next stretch.

Then get onto a good build. Memory behavior has swung sharply between patch releases. [Issue #23252](https://github.com/anthropics/claude-code/issues/23252) reports 2.1.19 sitting around 12 GB on macOS, with a rollback to 2.1.16 returning to a normal 200 to 400 MB per process. If your current version regressed, pin a known-good one:

```bash
# Pin a specific Claude Code build if the current one leaks
npm install -g @anthropic-ai/claude-code@2.1.16
```

Check the [Claude Code release notes](https://code.claude.com/docs/en/release-notes) and the [open memory issues](https://github.com/anthropics/claude-code/issues?q=is%3Aissue+label%3Aperf%3Amemory) before you pin, because a later patch usually fixes what an earlier one broke, and you would rather move forward than freeze on an old build. Rolling back is a stopgap, not a home.

## Fix 3: the context window is a different meter

Now the other problem. When answers drift, the model repeats itself, or you see an auto-compaction notice, the issue is tokens, not RAM. Claude Code keeps the whole conversation in the model's context window, and when that window approaches its limit the client summarizes older turns into a compressed form to free room. That is auto-compaction, and it fires around 95% of the window. You cannot disable it, but you can control it.

Start with `/context`. It shows exactly what is eating the window: system prompt, memory files, tool definitions, and the transcript itself. Over about 80% it will suggest compacting:

```text
# Claude Code 2.1.x, shows token usage by category
/context
```

When it is full, `/compact` summarizes the history down in place, and you can steer what survives by passing an instruction:

```text
# Keep the decisions that matter through the summary
/compact focus on the API contract and the migration plan, drop file dumps
```

Between unrelated tasks, prefer `/clear`. It wipes the conversation but keeps your project memory (`CLAUDE.md`), so you start the next task at near-zero tokens instead of dragging the last one along. This is the single most effective habit for keeping both meters low. If you need to keep an earlier state recoverable rather than gone, `/rewind` rolls code and conversation back to a checkpoint, which the [2.1.191 release made able to reach past a /clear](/2026/06/claude-code-2-1-191-rewind-past-clear/).

## When compaction thrashes

There is a failure mode where the two problems look like one. If a single tool result or file is so large that the context refills the instant a summary completes, Claude Code stops looping and shows a thrashing error instead of auto-compacting forever. That is not a bug to fight, it is a signal that something oversized is pinned in the window. Run `/context`, find the offending item, and remove it: read the file in smaller ranges, narrow the search that produced the giant output, or move reference material into a skill that loads on demand rather than into `CLAUDE.md`, which is always in context.

That oversized-item problem is also where the two meters interact. A multi-megabyte tool result inflates the context window and spikes the process heap on the same turn. Fixing the input fixes both.

## Keep both meters low without thinking about it

A handful of habits keep you off this page entirely. Trim what is always loaded: a lean `CLAUDE.md` costs tokens on every turn, and the guidance in [writing a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) applies to size as much as content. Cut the MCP surface: every connected server ships its tool schemas into the window, and [reducing the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/) shrinks the baseline. In a large repo, [structure the monorepo so Claude Code's context stays small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/) instead of letting broad searches dump the tree into memory. And know the neighboring failure: when [Claude Code drops MCP tools after auto-compaction](/2026/06/fix-claude-code-drops-mcp-tools-after-auto-compaction/), that is a compaction side effect, not a memory leak, and it has its own fix.

The short version: `High memory usage` and the context meter are separate systems. RAM problems get `--max-old-space-size`, a `/heapdump`, and a version check. Window problems get `/context`, `/compact`, and `/clear`. Reach for the right one and both stay boring.

## Sources

- [Claude Code commands reference](https://code.claude.com/docs/en/commands) - `/context`, `/compact`, `/clear`, `/doctor`.
- [Compaction, Claude platform docs](https://platform.claude.com/docs/en/build-with-claude/compaction) - how auto-compaction summarizes the window.
- [Issue #10592: JavaScript heap out of memory parsing a large .claude.json](https://github.com/anthropics/claude-code/issues/10592).
- [Issue #22188: process grows to 93 GB heap allocation](https://github.com/anthropics/claude-code/issues/22188).
- [Issue #23252: 2.1.19 ~12 GB on macOS, rollback to 2.1.16 fixes it](https://github.com/anthropics/claude-code/issues/23252).
- [Issue #32690: /heapdump fails with EEXIST on Windows](https://github.com/anthropics/claude-code/issues/32690).
- [Issue #51179: claude.exe consumes ~40 GB virtual memory on Windows](https://github.com/anthropics/claude-code/issues/51179).
