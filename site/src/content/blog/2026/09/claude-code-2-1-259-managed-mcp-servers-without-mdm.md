---
title: "Claude Code 2.1.259 Adds managedMcpServers: Ship MCP Servers Without MDM"
description: "Until now the only way to hand every developer the same MCP servers was managed-mcp.json, a file at a system path that takes exclusive control of MCP. Claude Code 2.1.259 adds a managedMcpServers setting for HTTP and SSE servers, and quietly narrows what allowedMcpServers governs."
pubDate: 2026-09-03
tags:
  - "claude-code"
  - "mcp"
  - "ai-agents"
  - "security"
---

Claude Code 2.1.259 shipped on September 2 with a one-line changelog entry that solves a problem administrators have been working around for months: a `managedMcpServers` managed setting that lets an organization provide HTTP and SSE MCP servers to every user. The same release changed `allowedMcpServers` to govern only the servers users add themselves. Those two lines together rearrange how MCP governance works, and the second one removes a backstop some teams are relying on today.

## Why managed-mcp.json was the wrong tool for "everyone gets Sentry"

Before 2.1.259 there were two mechanisms and neither did distribution well. Allowlists filter, they do not deploy: the [managed MCP docs](https://code.claude.com/docs/en/managed-mcp) are explicit that `allowedMcpServers` and `deniedMcpServers` "aren't a registry" and that a server still has to be added by a user, a plugin, or `managed-mcp.json` before either list applies to it.

That leaves `managed-mcp.json`, which does deploy servers but comes with two heavy conditions. It is a standalone file at a system path, so it needs Jamf, Intune, Group Policy, or something else with administrator rights on the box:

```json
{
  "mcpServers": {
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

Deploy that and Claude Code loads only what the file defines. Plugin servers stop loading. `--mcp-config` servers are refused. claude.ai connectors are suppressed unless you also set `allowAllClaudeAiMcps`. It is a lockdown mechanism that happens to distribute servers, not a distribution mechanism. And per the [server-managed settings docs](https://code.claude.com/docs/en/server-managed-settings), it "can't be distributed through server-managed settings", so an organization without MDM had no path at all.

`managedMcpServers` is a settings key rather than a standalone file, which means it rides the normal managed settings channel, including the claude.ai admin console:

```json
{
  "managedMcpServers": {
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

The HTTP and SSE restriction is the interesting design choice. A stdio entry would be an argv array executed on every developer machine, delivered over the network from a server. Limiting the key to remote transports keeps a settings payload from becoming remote code execution.

## The allowlist stopped being a backstop

The second changelog line matters more than it reads. The current docs still say that `allowedMcpServers` and `deniedMcpServers` "apply to managed servers too, so a managed server that doesn't pass them won't load". In 2.1.259 the allowlist governs only servers users add. Admin-pushed servers are already an admin decision, so re-checking them against the admin's own allowlist was redundant, but if you wrote a strict `serverUrl` allowlist as a belt-and-braces check over everything that loads, it no longer covers the managed set. Denylists are unchanged and still merge from every scope, which is the lever to keep.

The settings reference has not picked up the new key yet, so confirm the entry shape on one machine with `claude mcp list` before you roll it out to a fleet. If you are still standing up the filtering side of this, [how to centrally control which MCP servers your team can run](/2026/08/centrally-control-which-mcp-servers-a-team-can-run/) covers the matcher precedence that trips up most first rollouts.

Full details in the [Claude Code changelog](https://code.claude.com/docs/en/changelog).
