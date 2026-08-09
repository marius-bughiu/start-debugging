---
title: "Copilot MCP Allowlists Land in Enterprise Managed Settings"
description: "GitHub's August 6, 2026 changelog adds allowedMcpServers and deniedMcpServers to copilot/managed-settings.json. URL and argv matchers, deny-wins precedence, and a fail-closed default the older name-based registry never had."
pubDate: 2026-08-09
tags:
  - "github-copilot"
  - "mcp"
  - "ai-agents"
  - "security"
---

On 2026-08-06 GitHub shipped [MCP allowlists in enterprise managed settings](https://github.blog/changelog/2026-08-06-mcp-allowlists-in-enterprise-managed-settings/). Two keys, `allowedMcpServers` and `deniedMcpServers`, now decide which Model Context Protocol servers a Copilot client is permitted to start. It is generally available, and it applies to the GitHub Copilot app, Copilot CLI, and VS Code.

This closes a gap that has been open since MCP support went wide. The prior enterprise answer was the [custom MCP registry](https://docs.github.com/en/copilot/concepts/mcp-management), still in public preview, which matches servers by name or ID. Names are user-supplied labels, so a developer who wants a blocked server just renames it locally. GitHub's own docs are blunt about the consequence: users can bypass the restriction by editing configuration files.

## The matchers are the whole story

The file lives in the enterprise's `.github-private` repository at `copilot/managed-settings.json`, on the default branch. Each entry identifies a server by exactly one matcher.

```json
{
  "allowedMcpServers": [
    { "serverUrl": "https://api.githubcopilot.com/*" },
    { "serverCommand": ["npx", "@playwright/mcp@latest"] },
    { "serverCommand": ["cmd", "/c", "uvx", "markitdown-mcp"] }
  ],
  "deniedMcpServers": [
    { "serverUrl": "https://learn.microsoft.com/*" }
  ]
}
```

Note that `serverCommand` is an argv array, not a shell string, and it is matched exactly. `serverUrl` supports `*` wildcards and the URL is canonicalized before comparison, so encoding and trailing-slash tricks do not buy a different verdict. `serverName` still exists, but only as a fallback: for a remote server the match must come from a `serverUrl` entry, and `serverName` counts only when there are no `serverUrl` entries at all. Same relationship between stdio servers and `serverCommand`. Treat it as a convenience, not a security boundary.

## The defaults fail closed

The empty-versus-unset distinction is where teams will trip:

- `allowedMcpServers` unset allows every non-default server.
- `allowedMcpServers: []` blocks all of them. That is your deny-all switch.
- `deniedMcpServers` unset or empty blocks nothing.
- Deny always wins. A server matching both lists is blocked.
- First-party servers, such as the built-in GitHub MCP server, are exempt from both lists.

On top of that, a malformed or unverifiable configuration is blocked rather than allowed, and when policies arrive from more than one layer a server has to pass every layer. That is the inverse of the registry's failure mode, and it is the actual reason to migrate.

For teams that need their own list, wrap the matcher objects under `overridable` at the enterprise level, then use the plain syntax in each team's file. Where they conflict, the platform decision wins.

## Pair it with egress control, not instead of it

An allowlist governs which server processes start and which MCP endpoints get spoken to. It says nothing about where a tool connects once it is running, which is a separate control surface covered in [locking down a coding agent's network egress](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/). Two layers, two failure modes.

Full matcher syntax is in the [Enterprise managed settings reference](https://docs.github.com/en/copilot/reference/enterprise-managed-settings-reference).
