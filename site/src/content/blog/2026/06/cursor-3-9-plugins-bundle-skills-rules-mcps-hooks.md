---
title: "Cursor 3.9 Bundles Your Agent Setup Into Portable Plugins"
description: "Cursor 3.9 ships a plugin system and a unified Customize page so skills, rules, MCP servers, commands, and hooks travel together as one versioned unit."
pubDate: 2026-06-24
tags:
  - "cursor"
  - "ai-agents"
  - "mcp"
---

Cursor 3.9 landed on June 22, 2026, and the headline is not a model swap or a faster apply. It is plumbing: a real plugin format plus a single Customize page that gathers plugins, skills, MCPs, subagents, rules, commands, and hooks into one screen you manage at the user, team, or workspace level.

If you have set up a Cursor agent for a team, you know why this matters. The pieces that make an agent useful on your codebase used to live in separate places: rules in `.mdc` files, MCP servers in their own config, slash commands somewhere else, hooks bolted on after. Onboarding a teammate meant replicating all of it by hand. A plugin makes that bundle one versioned, shareable artifact.

## What a plugin actually is

A plugin is a directory with a manifest at `.cursor-plugin/plugin.json`. Everything else is convention:

```
my-stack/
├── .cursor-plugin/
│   └── plugin.json     # manifest
├── skills/             # subdirs with SKILL.md
├── rules/              # .mdc rule files
├── commands/           # slash commands
├── hooks/hooks.json
└── mcp.json            # MCP server definitions
```

The manifest only requires `name` (lowercase kebab-case). Every component path is optional, and if you omit it Cursor auto-discovers the default folders above:

```json
{
  "name": "enterprise-plugin",
  "version": "1.2.0",
  "description": "Security scanning and compliance checks",
  "author": { "name": "ACME DevTools", "email": "devtools@acme.com" },
  "keywords": ["enterprise", "security", "compliance"],
  "rules": "rules/",
  "skills": "skills/",
  "commands": "commands/",
  "hooks": "hooks/hooks.json",
  "mcpServers": "mcp.json"
}
```

MCP servers use the same shape you already know from Cursor and Claude Desktop, so existing configs drop straight in:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "POSTGRES_CONNECTION_STRING": "${POSTGRES_URL}" }
    }
  }
}
```

Hooks ship in the bundle too. A plugin can enforce a format pass after every edit or gate dangerous shell calls without anyone editing local settings:

```json
{
  "hooks": {
    "afterFileEdit": [{ "command": "./scripts/format-code.sh" }],
    "beforeShellExecution": [
      { "command": "./scripts/validate-shell.sh", "matcher": "rm|curl|wget" }
    ]
  }
}
```

## Distribution is the real feature

The Customize page shows a leaderboard of the most-used plugins, skills, and MCPs across your team, and any of them install with one click. Team marketplaces now import plugin repositories from GitLab, BitBucket, or Azure DevOps, not just GitHub, so a company-internal registry no longer forces a vendor choice. Plugins can also carry prebuilt canvases, shared setup templates a teammate opens and reuses, with the Hex and Atlassian canvases as the first examples.

The pattern mirrors where Claude Code and the broader agent tooling are heading: the unit of reuse stops being a single rule file and becomes a portable bundle that encodes how your team wants the agent to behave. If you have been copy-pasting MCP blocks and `.mdc` rules between machines, pin them in a plugin and stop.

See the [plugin reference](https://cursor.com/docs/reference/plugins) and the [3.9 changelog](https://cursor.com/changelog) for the full field list.
