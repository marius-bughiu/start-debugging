---
title: "Claude Code 2.1.126 Adds `claude project purge` to Wipe All State for a Repo"
description: "Claude Code v2.1.126 ships claude project purge, a new CLI subcommand that deletes every transcript, task, file-history entry, and config block tied to a project path in a single shot. Includes --dry-run, --yes, --interactive, and --all."
pubDate: 2026-05-03
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
---

The Claude Code v2.1.126 release on May 1, 2026 added a small command with an outsized cleanup story: `claude project purge [path]`. Run it against a repo and the CLI deletes every transcript, task, file-history entry, and `~/.claude/projects/...` config block tied to that project path in one operation. No more digging through `~/.claude/projects/` by hand to reset a project that has accumulated a year of session history.

## Why a dedicated command instead of `rm -rf`

Claude Code's per-project state lives in several places at once. There is a project directory under `~/.claude/projects/<encoded-path>/` that holds JSONL transcripts, the saved task list, and file-history snapshots. There are also entries in the global `~/.claude/settings.json` and the per-project config that point at that directory by absolute path. Removing only the project folder leaves dangling references; removing only the settings entries leaves megabytes of orphaned transcripts.

Until v2.1.126, the official answer was a careful manual cleanup. The new subcommand walks the same internal map the rest of the CLI uses, so transcripts, tasks, file history, and config entries all go in one consistent pass. If you run it against the directory you are currently sitting in, you can omit the path:

```bash
# Nuke everything Claude Code knows about the current repo
claude project purge

# Or target an absolute path from elsewhere
claude project purge /home/marius/work/legacy-monolith
```

## The flags that make this safe to script

The interesting part is the flag surface. The release ships four:

```bash
# Show what would be deleted without touching anything
claude project purge --dry-run

# Skip the confirmation prompt (CI-friendly)
claude project purge -y
claude project purge --yes

# Walk projects one at a time and choose
claude project purge --interactive

# Purge every project Claude Code has ever recorded
claude project purge --all
```

`--dry-run` prints the project IDs, transcript counts, and on-disk byte totals it would remove. `--all` is the heavy hammer, useful after a laptop migration where most of the recorded paths no longer exist on disk. `-i` is the in-between mode for triaging a long list.

## Where this fits into the v2.1.126 picture

Project purge is one of several state-management shifts in this release. The same build also lets `--dangerously-skip-permissions` write to previously protected paths like `.claude/`, `.git/`, `.vscode/`, and shell config files, which lines up with the purge model: Claude Code is leaning into giving you blunter tools for blowing away its own footprint, on the assumption that you know what you are doing. The earlier [Claude Code 2.1.122 Bedrock service-tier env var](/2026/04/claude-code-2-1-122-bedrock-service-tier/) was a similar "one knob, no SDK changes" kind of release; v2.1.126 continues that pattern.

If you are running Claude Code under a managed `~/.claude` (an organization-pinned settings policy), `--all` will only purge projects whose state lives under your user profile. The managed policy file itself is untouched.

Full notes are in the [Claude Code v2.1.126 release page](https://github.com/anthropics/claude-code/releases/tag/v2.1.126).
