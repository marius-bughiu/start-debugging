---
title: "Claude Code 2.1.200 Renames the default Permission Mode to Manual"
description: "Claude Code v2.1.200 (July 3, 2026) renames the 'default' permission mode to 'Manual' across the CLI, VS Code, and JetBrains, and stops AskUserQuestion dialogs from auto-continuing. The config value stays 'default', with 'manual' accepted as an alias."
pubDate: 2026-07-04
tags:
  - "claude-code"
  - "ai-agents"
  - "cli"
---

Claude Code v2.1.200 shipped on July 3, 2026, and it does two things that touch anyone who runs the agent interactively: it renames the permission mode you have been calling "default" to "Manual", and it changes `AskUserQuestion` dialogs so they no longer advance on their own. Neither is a huge feature, but both change muscle memory and, in the second case, close a small foot-gun.

## Why "default" was a bad name

The permission mode that reviews every action and asks before running anything was historically labeled "default". That name told you where it sat in a list, not what it did. New users read "default" and assumed it was a passive setting rather than the mode that gates each tool call behind an approval prompt.

2.1.200 relabels it "Manual" everywhere a human reads it: the CLI picker, `claude --help`, and the VS Code and JetBrains extensions. The point is that the name now describes the behavior, you approve each step by hand.

Crucially, the config value did not change. Hooks, the SDK, and your existing `settings.json` still use `default`, so nothing breaks:

```jsonc
// Both of these mean the same mode
{ "permissions": { "defaultMode": "default" } }
{ "permissions": { "defaultMode": "manual" } }
```

```bash
# manual is accepted as an alias wherever you type the value
claude --permission-mode manual
claude --permission-mode default   # still valid
```

If you script Claude Code or share a committed config with a team, keep `default`, it is the stable, canonical value. Reach for `manual` only when you are typing it by hand and want the label to match what the UI now shows.

## AskUserQuestion stops auto-continuing

The second change is the one worth flagging in code review. The `AskUserQuestion` tool, which is how the agent presents you a multiple-choice decision mid-task, used to auto-continue after an idle period, picking a highlighted option if you stepped away. That is convenient right up until it silently commits you to a branch of work you did not read.

In 2.1.200 these dialogs no longer auto-continue by default. The agent waits for you. If you actually want the old walk-away behavior, you opt into an idle timeout explicitly through `/config` rather than getting it whether you asked or not. This is the same "do not decide irreversible things on the user's behalf" instinct behind [2.1.183 blocking destructive git and IaC commands in auto mode](/2026/06/claude-code-2-1-183-auto-mode-blocks-destructive-commands/).

## The rest of the release

2.1.200 is heavy on background-agent reliability. It fixes background sessions silently stopping after sleep/wake, a stale `daemon.lock` whose reused PID blocked agents from ever starting again, and subagents cut off by a rate limit returning an empty result instead of failing cleanly. There is also a startup crash fix for when `disabledMcpServers` or `enabledMcpServers` in `.claude.json` is set to a non-array value, plus a batch of screen-reader improvements and a tmux 3.4+ rendering-flicker fix.

If you keep a shared team config, the takeaway is small but real: your permission mode did not change, only its display name did, and your interactive dialogs are now a little less eager to move without you. Full notes are on the [v2.1.200 changelog](https://code.claude.com/docs/en/changelog).
