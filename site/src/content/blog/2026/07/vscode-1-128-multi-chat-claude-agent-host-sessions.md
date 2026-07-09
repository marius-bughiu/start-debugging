---
title: "VS Code 1.128 Adds Multi-Chat Claude Agent-Host Sessions"
description: "VS Code 1.128 (July 8, 2026) lets one Claude agent-host session hold several parallel chats, each with its own history, title, and model. Here is what chat.agentHost.enabled actually unlocks and how the quick-chat and BYOK pieces fit."
pubDate: 2026-07-09
tags:
  - "claude-code"
  - "ai-agents"
  - "llm"
---

VS Code 1.128 shipped on July 8, 2026, and the headline is not a Copilot feature. It is that a single Claude agent-host session can now hold several related chats at once, each with its own history, title, and model selection, all grouped under one parent session. The agent-host mode is powered by Anthropic's Claude Agent SDK running directly inside VS Code, and this release turns it from a single-thread experience into something closer to a workbench.

## Why one session with many chats matters

Before 1.128, exploring two approaches to the same problem meant either clobbering your context by pivoting mid-thread or spinning up a whole new session and losing the shared setup. Multi-chat sessions fix that. You can branch from an earlier turn, keep the original chat intact, and run both in parallel. Each chat tracks its own model, so you can pit a cheaper model against a stronger one on the same task and compare the diffs side by side without leaving the session.

This is gated behind the agent-host mode. Turn it on in `settings.json`:

```json
{
  "chat.agentHost.enabled": true
}
```

With that set, the **Agents** window becomes the hub. New chats land in a **Chats** section under the parent session, and you focus the window with the `workbench.action.openAgentsWindow` command.

## Quick chats drop the workspace requirement

The second change that removes friction is quick chats. You can now start a conversation from the Agents window without opening a folder first. That sounds minor until you realize how often you want to ask an agent something that has nothing to do with the currently open project, and previously had to open a scratch workspace to do it. Quick chats are supported only by agent-host sessions, so they ride the same `chat.agentHost.enabled` switch.

Subagents get a mention too: the agent-host can delegate to a subagent, and you view the subagent transcript read-only, so a delegation does not pollute the parent chat's history.

## Bringing your own model keys

There is also an experimental setting for teams that want to route through their own model provider rather than the bundled path:

```json
{
  "chat.agentHost.byokModels.enabled": true
}
```

BYOK support is flagged experimental in 1.128, so treat it as a preview rather than something to standardize a team on this week. Pair it with `chat.byokUtilityModelDefault` if you want to steer which model handles the cheaper utility calls.

Rounding out the release, Copilot Vision went generally available, so pasting, dragging, or dropping images and PDFs into Chat is no longer a preview, and the agent can reach those attachments through a tool call.

The multi-chat piece is the one worth trying first. If you already run the Claude agent-host in VS Code, flip `chat.agentHost.enabled`, open the Agents window, and branch a chat instead of restarting one. Full notes are in the [VS Code 1.128 release notes](https://code.visualstudio.com/updates/v1_128).
