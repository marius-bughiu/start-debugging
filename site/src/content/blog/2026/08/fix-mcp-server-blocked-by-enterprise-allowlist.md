---
title: "Fix: An MCP Server Never Starts Because an Enterprise Allowlist Blocks Its Command or URL"
description: "A server that vanished from /mcp with no error is almost always an allowlist. Run claude mcp add on the same server: the add path prints the reason the load path swallows."
pubDate: 2026-08-29
template: error-page
tags:
  - "mcp"
  - "claude-code"
  - "github-copilot"
  - "cursor"
  - "ai-agents"
  - "errors"
---

Your MCP server worked yesterday, the config file is unchanged, and today it is simply not in `/mcp` or `claude mcp list`. There is no error, no failed connection, no entry in the debug log. That silence is the symptom: when an enterprise allowlist rejects a server, the load path drops it without a message. The fastest way to confirm it is to run `claude mcp add` against the same server, because the add path does print the reason. If it says `not allowed by enterprise policy`, your server's command or URL failed to match `allowedMcpServers`, and the most common cause is not a missing entry but the fallback rule: one `serverCommand` entry anywhere in the allowlist disables every `serverName` entry for stdio servers. Everything below is against the [Claude Code managed MCP documentation](https://code.claude.com/docs/en/managed-mcp) as of Claude Code 2.1.251, GitHub Copilot CLI 1.0.65, and the VS Code and Cursor enterprise policy surfaces current in August 2026.

## The failure has no error message, by design

This is what makes it expensive to debug. Every other MCP failure announces itself. A dead process gives you [MCP error -32000: Connection closed](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/). A bad handshake gives you an HTTP 400 with a protocol version in the body. A policy rejection gives you nothing, because the server never reaches the point where it could fail.

Anthropic's documentation states the behaviour outright. Under "How restrictions appear to users", the row for a previously working server reads:

```
A previously configured server is now blocked by policy
  -> The server silently disappears from /mcp and claude mcp list with no warning
```

The other clients are inconsistent about it. Here is what each one actually surfaces:

| Client | What a policy-blocked server looks like |
| :--- | :--- |
| Claude Code (load path) | Absent from `/mcp` and `claude mcp list`. No log line, no warning |
| Claude Code (`claude mcp add`) | `Cannot add MCP server "<name>": not allowed by enterprise policy` |
| GitHub Copilot CLI | A startup notice: `X MCP servers were blocked by policy: 'fetch', 'cloudflare', ...` |
| GitHub Copilot CLI (registry mismatch) | `MCP server is blocked by policy` per server |
| VS Code | The server stays visible but disabled, and the setting shows "Managed by your organization" |
| Cursor | The server does not run. No documented client-side message |

Copilot is the only one of the four that names the blocked servers at startup. Claude Code's silence is the reason a developer will spend an hour re-checking JSON syntax on a file that is perfectly valid.

## Use the add path as the diagnostic

The load path swallows the reason. The add path does not. Re-adding a server you already have configured is safe and non-destructive when the policy rejects it, because the policy check runs before anything is written or contacted. Anthropic's own validation instructions rely on this: the documented check uses `https://example.com/mcp`, which does not need to be a real endpoint.

```bash
# Claude Code 2.1.251. Re-add the server that vanished, exactly as configured.
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp

# Or for a stdio server, with the argv after the -- separator:
claude mcp add my-server -- npx -y @modelcontextprotocol/server-filesystem .
```

Three strings come back, and each one points at a different layer:

| Message | What is actually configured |
| :--- | :--- |
| `Cannot add MCP server: enterprise MCP configuration is active and has exclusive control over MCP servers` | A `managed-mcp.json` file is deployed. Nothing you configure will ever load |
| `Cannot add MCP server "<name>": server is explicitly blocked by enterprise policy` | The server matched a `deniedMcpServers` entry. Deny wins over everything |
| `Cannot add MCP server "<name>": not allowed by enterprise policy` | `allowedMcpServers` is set somewhere and your server matched no entry |

If the add succeeds and the server still does not load, you are not looking at a policy problem. Skip to the lookalikes at the end.

## Which layer is blocking you

The three messages map to three separate mechanisms, and they are not tried in the order you would guess.

**`managed-mcp.json` is exclusive control.** If this file exists, Claude Code loads only the servers it defines, plus in-process servers the host app registers. Plugin-provided servers and anything passed with `--mcp-config` are suppressed. On a workstation, a session that receives `--mcp-config` servers exits at startup with `You cannot dynamically configure MCP servers when an enterprise MCP config is present`. In a cloud session on a host where the file is deployed, the behaviour changed in 2.1.229: instead of exiting, the session starts with the managed servers only and names the skipped ones on stderr at debug level, where a self-hosted runner records them. Nothing in the session itself tells the user.

Check the three paths directly:

```bash
# macOS
ls -l "/Library/Application Support/ClaudeCode/managed-mcp.json"
# Linux and WSL
ls -l /etc/claude-code/managed-mcp.json
# Windows (PowerShell)
Get-Item "C:\Program Files\ClaudeCode\managed-mcp.json"
```

A file containing `{"mcpServers": {}}` is the documented way to disable MCP entirely. If that is what you find, the servers you configured stopped loading the moment it was deployed, with no warning that policy was the reason.

**`deniedMcpServers` merges from every scope.** This is the one that catches people out, because your own settings participate. The denylist combines across managed, project, user, and local settings, unconditionally, and nothing overrides a denylist match. A `{ "serverName": "github" }` you added to `~/.claude/settings.json` six months ago while debugging something else will still be silently killing that server today. Grep for it before you email your admin.

**`allowedMcpServers` merges too, unless it does not.** By default, allowlists from every settings scope combine, so a user can broaden what an admin permitted. When an admin sets `allowManagedMcpServersOnly: true`, only the managed allowlist is kept, and your own entries are discarded. Note that unset and empty are different states: unset means all servers are allowed, and `[]` means none are.

## The rule that blocks servers your admin thought they allowed

This is the actual root cause in most reports, and it is a matching rule, not a missing entry.

Each allowlist entry has exactly one matcher: `serverUrl`, `serverCommand`, or `serverName`. The first two are enforcement boundaries because a user cannot forge them without changing what the server is. `serverName` is just the label from `claude mcp add`, so it is a convenience, and Claude Code treats it as a fallback rather than a rule:

- A **remote** (HTTP or SSE) server must match a `serverUrl` entry. A `serverName` match counts only when the allowlist contains **no** `serverUrl` entries at all.
- A **stdio** server must match a `serverCommand` entry. A `serverName` match counts only when the allowlist contains **no** `serverCommand` entries at all.

So an allowlist that starts life as a list of names works fine, and the day someone appends a single `serverCommand` entry, every name-matched stdio server in the fleet stops loading. Nobody edited those servers. Nobody gets an error.

```json
// managed-settings.json. Claude Code 2.1.251.
{
  "allowedMcpServers": [
    { "serverName": "github" },
    { "serverCommand": ["npx", "-y", "approved-package"] }
  ]
}
```

| Server | Result |
| :--- | :--- |
| stdio `local-tool`, argv `["npx", "-y", "approved-package"]` | Allowed, matches the command |
| stdio `local-tool`, argv `["node", "server.js"]` | Blocked, command entries exist and it matches none |
| stdio `github`, argv `["node", "server.js"]` | Blocked. The name entry is dead for stdio once a command entry exists |
| HTTP `github` | Allowed, matches the name (no `serverUrl` entries exist) |
| HTTP `other-api` | Blocked |

Two more rules decide whether your entry matches at all:

**Commands match exactly, argument by argument, in order.** `["npx", "-y", "server"]` does not match `["npx", "server"]` and does not match `["npx", "-y", "server", "--flag"]`. Adding a flag to your own server config is enough to fall off the allowlist. This is why you inventory the argv arrays that are actually running before writing a list, a point I made from [the admin side of the same keys](/2026/08/centrally-control-which-mcp-servers-a-team-can-run/).

**URL wildcards are permissive, but only in the pattern.** `*` works anywhere including the scheme. Hostname matching is case-insensitive and ignores a trailing FQDN dot; paths stay case-sensitive. A pattern with no path matches any path, so `https://mcp.example.com` and `https://mcp.example.com/*` behave the same.

There is a subtler variant if your entries use variables. Since 2.1.219, both the policy entry and the server's configured value expand `${VAR}` and `${VAR:-default}` before matching, but they read different environments. An `allowedMcpServers` entry expands from the environment Claude Code started with plus `env` from managed settings; if a variable it references has no value there, Claude Code ignores the entry entirely. A `deniedMcpServers` entry in the same situation fills from settings files outside the repository and still matches. Allow fails closed, deny fails open, both in the direction of blocking you. If a server is being rejected against an entry that looks correct, check whether that entry contains a variable your shell does not export.

## Fixing it, in order

1. **Read the effective policy.** On Claude Code, `managed-settings.json` lives beside `managed-mcp.json` in the same system directory, so check both paths from the section above. Copilot reads `copilot/managed-settings.json` from the default branch of the enterprise `.github-private` repository. VS Code exposes it in Settings, where `chat.mcp.allowedServers` reads "Managed by your organization". Cursor's is in the team dashboard under MCP Configuration.
2. **Check your own settings first.** `grep -r deniedMcpServers ~/.claude/ .claude/` takes five seconds and rules out the self-inflicted case before you escalate.
3. **Make your server match an entry you already have.** For stdio, copy the argv array from the allowlist verbatim into your config, including flag order. For remote servers, confirm the URL is under an allowed pattern. Renaming does not help once command or URL entries exist, which is the whole point of the design.
4. **Ask for an entry, and hand over the exact string.** Send your admin the argv array or the URL, not the server's name. An admin who adds `{ "serverName": "your-tool" }` to an allowlist that already has command entries will believe they fixed it, and nothing will change.
5. **If `managed-mcp.json` is deployed, stop.** No local configuration path exists. The server has to be added to that file, or distributed through a [managed plugin marketplace](/2026/08/package-skills-and-an-mcp-server-as-one-agent-plugin/), or the admin has to set `allowAllClaudeAiMcps` for claude.ai connectors specifically.

## Lookalikes that are not the allowlist

**A plugin-bundled server that never starts.** [Issue 32882](https://github.com/anthropics/claude-code/issues/32882) reports that when `allowedMcpServers` is configured, servers declared in a plugin's own `.mcp.json` are skipped entirely: the plugin loads, and the debug log shows the plugin discovered with no MCP startup attempt at all, where an unrestricted run logs `MCP server "plugin:context7:context7": Starting connection`. It was closed as not planned. If your missing server came from a plugin rather than your own config, this is a distinct bug from a matcher mismatch, and no allowlist entry will fix it.

**Copilot's fail-closed registry.** Copilot CLI fetches a registry policy at startup and blocks non-default servers when it cannot. [Issue 2481](https://github.com/github/copilot-cli/issues/2481) shows the sequence: `Request to MCP registry policy at https://api.github.com/copilot/mcp_registry failed with status 404`, followed by `Failed to fetch MCP registry policy: 404. Non-default MCP servers will be blocked until the policy can be fetched.` Nobody configured a denial. The endpoint was unreachable, and the default is to block. There is a second variant in [issue 3934](https://github.com/github/copilot-cli/issues/3934), where the server is in the registry but the log reads `found in registry but local configuration does not match the registered server identity`, so the allowlist entry exists and the local config disagrees with it.

**Project scope, not policy.** A server in a repo's `.mcp.json` that you have not approved shows as pending rather than connected. Since 2.1.154, `claude mcp list` and `claude mcp get` display it as `⏸ Pending approval` instead of silently connecting. That is an approval prompt you dismissed, not an enterprise rule.

**The workspace is untrusted**, which suppresses `.mcp.json` before any policy runs. That has [its own failure signature](/2026/07/fix-mcp-json-servers-never-start-because-the-workspace-is-untrusted/).

**One malformed config file.** A single JSON syntax error can take out every server at once rather than just one, which is [a different shape of the same silence](/2026/07/fix-all-mcp-servers-fail-to-load-after-malformed-json-in-config/).

The general rule: if exactly one server disappeared and `claude mcp add` reprints a policy string, it is the allowlist. If every server disappeared, look at the config file or `managed-mcp.json`. If the server appears but its tools do not, you have a different problem entirely.

## Related

- [How to centrally control which MCP servers your team can run](/2026/08/centrally-control-which-mcp-servers-a-team-can-run/) is the admin-side counterpart, including a rollout order that avoids creating this outage.
- [Copilot MCP allowlists land in enterprise managed settings](/2026/08/copilot-mcp-allowlists-enterprise-managed-settings/) covers the GitHub keys and the name-based registry they supersede.
- [Fix: MCP error -32000: Connection closed in Claude Code](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/) is where to go when the server does start and then dies.
- [Fix: MCP server stdio hang when launched from Claude Code](/2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code/) covers the case where the process is alive but the handshake never completes.
- [Migrate off the archived MCP reference servers](/2026/08/migrate-off-archived-mcp-reference-servers/) is worth doing before you ask an admin to pin an argv array to a deprecated package.

Primary sources: [Control MCP server access for your organization](https://code.claude.com/docs/en/managed-mcp) for the matcher semantics, evaluation order, and the exact user-facing strings; [VS Code enterprise AI settings](https://code.visualstudio.com/docs/enterprise/ai-settings) for `ChatAllowedMcpServers`, `ChatDeniedMcpServers`, and `ChatMCP`; [Cursor model and integration management](https://cursor.com/docs/enterprise/model-and-integration-management) for the dashboard allowlist and its wildcard command matching; and the Claude Code and Copilot CLI issue threads linked above for the failure modes that are bugs rather than configuration.
