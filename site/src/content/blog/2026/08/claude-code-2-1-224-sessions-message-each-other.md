---
title: "Claude Code 2.1.224 Lets One Session Message Another"
description: "Cross-session messaging landed on August 7, 2026. ListAgents and SendMessage move plain text between your sessions, and crossSessionInbound decides what actually arrives."
pubDate: 2026-08-10
tags:
  - "claude-code"
  - "ai-agents"
  - "developer-tools"
---

Two terminals, same repository. The one running the migration just renamed a column the other is still writing queries against. Until last week the fix was you, copy-pasting between windows. Claude Code 2.1.224, published on August 7, 2026, closes that loop: one session can hand a message to another session on the same machine.

## ListAgents finds it, SendMessage delivers it

Two tools do the work, and you call neither. `ListAgents` enumerates the agents a session can reach, `SendMessage` addresses one of them by name. You describe the intent:

```text
Tell the session working on the payments API that the tenant_id column landed
```

Claude writes the message text itself. To see the roster yourself, run `/list-agents`, also aliased to `/peers`. A session answers to the name you set with `--name` or `/rename`; without one, Claude Code derives a name from the working directory, such as `myapp-3f`.

Same-machine delivery goes over a per-session Unix socket and never passes through Anthropic servers. `/status` shows the path in a `Peer address` row, and hooks and Bash commands receive it as `CLAUDE_CODE_MESSAGING_SOCKET`, which is how a script posts back into the session that spawned it.

The requirements are narrow: v2.1.224 or later, macOS or Linux (WSL 2 counts, native Windows does not), and not on Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry.

## What the channel refuses to carry

A message is plain text. Not conversation history, not files, not permissions. On arrival, Claude Code tells the receiving session that the text came from another agent rather than from you, and that framing has teeth: the message cannot answer a pending permission prompt, cannot talk the receiver into rewriting `CLAUDE.md` or its permission rules, and a `/compact` in the body arrives as inert text instead of a command.

Inbound handling is a setting, `crossSessionInbound`, with three values: `accept`, `hold`, and `refuse`. With nothing set, Claude Code decides per message by comparing the two sessions' permission-mode classes. A session in `bypassPermissions` holds anything sent by a session that prompts, and a prompting session holds anything sent by a bypassing one. Held messages open an approval dialog that expires after five minutes, tunable via `dialogExpiry`.

That default is why a headless worker goes quiet. A `claude -p` session binds an inbox socket and appears in the listing, but it cannot render an approval dialog, so a held message stays held. Give it an explicit accept in its `--settings` value:

```json
{
  "crossSessionInbound": "accept"
}
```

Turning it off is the mirror image, and administrators can push it through managed settings:

```json
{
  "permissions": {
    "deny": ["SendMessage", "ListAgents"]
  },
  "crossSessionInbound": "refuse"
}
```

Denying `SendMessage` also removes messaging to subagents and agent-team teammates, since the same tool serves both. If you rely on the [three-layer nesting 2.1.219 reopened](/2026/07/claude-code-2-1-219-nested-subagents-three-layers-deep/), that deny rule costs more than it looks.

## Across machines, one day later

Version 2.1.225, published August 8, extends the reach. Per the [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), `SendMessage` can now start a conversation with your Remote Control sessions on other machines by name, with `ListAgents` showing them as `name [ref]`. Before that, cross-machine traffic was reply-only, which is still how the [documentation](https://code.claude.com/docs/en/cross-session-messaging) describes it.

Those messages travel through Anthropic servers over the Remote Control connection, so there is a switch for it. Setting `isolatePeerMachines` to `true` requires your explicit approval before anything leaves the machine, even in `bypassPermissions` mode, and a `true` from any settings scope applies.

Runaway chatter is bounded by the transport rather than by good behavior: repeats are rate-limited per sender, identical ones inside a short window are dropped, and at most 50 accepted messages queue for an unread session.
