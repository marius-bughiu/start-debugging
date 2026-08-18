---
title: "How to Centrally Control Which MCP Servers Your Team Can Run"
description: "Claude Code and GitHub Copilot both ship allowedMcpServers and deniedMcpServers, but the matchers behave differently. serverName is a fallback that a single serverCommand entry silently disables, deny is a union while allow is not, and an invalid allowlist locks everything out."
pubDate: 2026-08-18
tags:
  - "mcp"
  - "claude-code"
  - "github-copilot"
  - "ai-agents"
  - "security"
---

Two coding agents now expose the same pair of enterprise keys, `allowedMcpServers` and `deniedMcpServers`, and they do not mean quite the same thing. In Claude Code (verified against 2.1.224) they live in `managed-settings.json` in a system directory the user cannot write to. In GitHub Copilot they live in `copilot/managed-settings.json` on the default branch of the enterprise `.github-private` repository. Both accept three mutually exclusive matchers per entry, and in both the `serverName` matcher is a fallback rather than a rule: adding a single `serverCommand` entry to your allowlist silently stops every `serverName` entry from matching any stdio server. That is the failure mode that will bite you, and it fails in the direction of blocking, so your rollout looks like an outage rather than a misconfiguration.

## Why the server name was never the control you wanted

The first generation of MCP governance matched on names. GitHub's [custom MCP registry](https://docs.github.com/en/copilot/concepts/mcp-management) still does. The problem is structural: the name is a key in the user's own config file. A developer who wants a blocked server back renames it. GitHub's documentation says as much, noting that users can bypass the restriction by editing configuration files.

The two matchers that are actual boundaries are the ones a user cannot forge without changing what the server *is*:

- `serverCommand`, an argv array matched element by element against the stdio launch command.
- `serverUrl`, a URL pattern with `*` wildcards, matched against the canonicalized remote endpoint.

Rename `github` to `definitely-not-github` and `serverCommand: ["npx", "-y", "@modelcontextprotocol/server-github"]` still matches. That is the point.

## Where the file goes

Claude Code reads managed settings from a fixed system path per platform:

| Platform | Path |
|---|---|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux and WSL | `/etc/claude-code/managed-settings.json` |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json` |

The old Windows location under `C:\ProgramData\ClaudeCode\` stopped being read in 2.1.75, so if your MDM package predates that release it is deploying a file nothing loads. There is also a `managed-settings.d/` drop-in directory beside the main file, merged systemd-style: the base file loads first, then every `*.json` in the directory in alphabetical order. Scalars from later files win, arrays concatenate and de-duplicate, objects deep-merge. Numeric prefixes (`10-telemetry.json`, `20-mcp.json`) are the usual way to pin the order.

Copilot's file is a single blob in source control instead, which means your review process is your change control. The tradeoff is that a repo file is trivially auditable and a system file is trivially tamper-resistant, and you probably want both.

## The three matchers, and the rule that exactly one is allowed

A Claude Code entry validates against a schema that requires exactly one of the three keys:

```json
{
  "allowedMcpServers": [
    { "serverName": "github" },
    { "serverUrl": "https://mcp.internal.example.com/*" },
    { "serverCommand": ["npx", "-y", "@playwright/mcp@latest"] }
  ],
  "deniedMcpServers": [
    { "serverName": "filesystem" },
    { "serverUrl": "https://*.ngrok.io/*" }
  ]
}
```

Set two keys on one object and the entry is rejected with "Entry must have exactly one of serverName, serverCommand, or serverUrl". The allowlist form of `serverName` is additionally constrained to letters, numbers, hyphens and underscores only, so a name containing a dot or a slash cannot be allowlisted at all and has to be expressed as a command or URL. The denylist form is looser, accepting any non-empty string, but it rejects leading or trailing whitespace with an explicit warning that names are compared verbatim and a padded name would never match. That validation exists because somebody shipped `" github"` and wondered why nothing was blocked.

## The trap: serverName is a fallback, not an entry

This is the part that is not in either vendor's prose, and it is the reason most first rollouts break.

When Claude Code evaluates the allowlist for a given server, it first asks a question about the *list as a whole*: does it contain any `serverCommand` entry, and does it contain any `serverUrl` entry. Then, for a stdio server, if the list contains at least one `serverCommand` entry, only the `serverCommand` entries are consulted. The `serverName` entries in the same list are not examined at all. Only when the list contains no `serverCommand` entry does it fall back to matching stdio servers by name. Remote servers behave identically with respect to `serverUrl`.

So this configuration does not do what it reads like:

```json
{
  "allowedMcpServers": [
    { "serverName": "github" },
    { "serverName": "postgres" },
    { "serverCommand": ["npx", "-y", "@playwright/mcp@latest"] }
  ]
}
```

If `github` and `postgres` are stdio servers, that one Playwright line disables both name entries. Playwright runs. GitHub and Postgres are blocked, with `Blocked by enterprise policy (allowedMcpServers/deniedMcpServers)` as the only explanation the user sees. The fix is to commit to the precise matchers and stop mixing tiers:

```json
{
  "allowedMcpServers": [
    { "serverCommand": ["npx", "-y", "@modelcontextprotocol/server-github"] },
    { "serverCommand": ["npx", "-y", "@playwright/mcp@latest"] }
  ]
}
```

Which raises the obvious problem: `server-github` is archived and deprecated, and pins an SDK that cannot negotiate past protocol revision `2024-11-05`. Pinning an allowlist to an argv array is a good moment to check what you are actually pinning, which is the audit covered in [migrating off the archived MCP reference servers](/2026/08/migrate-off-archived-mcp-reference-servers/).

Note also that `serverCommand` is matched exactly, argument for argument. `["npx", "@playwright/mcp@latest"]` and `["npx", "-y", "@playwright/mcp@latest"]` are different commands. Neither vendor supports wildcards inside the array, so a floating `@latest` tag is fine but an inconsistently applied `-y` flag is not.

## The denylist has no such fallback

The deny path is a plain union. It walks every entry, checks `serverName` against the label unconditionally, then checks `serverCommand` against the argv and `serverUrl` against the endpoint. Any hit blocks. There is no "does the list contain a command entry" precondition, so a `serverName` deny entry always applies no matter what else is in the list.

That asymmetry is deliberate and it is the right default. The allowlist is the thing that must be precise, because a sloppy allow entry grants access. The denylist is the thing that must be broad, because a missed deny entry is an unblocked server. It also means the two lists have genuinely different operational characteristics, and you should treat `deniedMcpServers` as your fast incident lever (add a name, done) and `allowedMcpServers` as the slow, reviewed, argv-precise baseline.

Deny wins over allow in both products. A server matching both lists is blocked.

## Unset, empty, and invalid are three different states

```text
allowedMcpServers undefined  -> every server permitted, subject to the denylist
allowedMcpServers []         -> nothing permitted except built-in first-party servers
allowedMcpServers invalid    -> treated as [], i.e. full lockdown
deniedMcpServers undefined   -> nothing blocked
deniedMcpServers []          -> nothing blocked
```

The third line is the one to internalise. Claude Code parses managed settings tolerantly: a bad entry elsewhere in the file is stripped, a warning is recorded, and every remaining valid policy is still enforced, so one typo cannot disable your whole security posture. But the security-enforcement fields are handled per field, and `allowedMcpServers` specifically degrades to "enforcing an empty allowlist (no MCP servers admitted) until it is fixed". Same for `allowManagedMcpServersOnly`, which is treated as `true` when present but invalid.

Fail-closed is correct, and it also means a JSON error in your policy file presents to developers as every MCP server disappearing at once. `claude doctor` lists stripped entries with the source file and field name, and in headless `-p` runs the summary goes to stderr, which is where your CI should be looking. This is a different failure mode from a malformed `.mcp.json`, where [one syntax error stops every server in the file from loading](/2026/07/fix-all-mcp-servers-fail-to-load-after-malformed-json-in-config/); here the file parses but one field self-disables into lockdown.

First-party servers are exempt from both lists in both products, so the built-in GitHub MCP server in Copilot and Claude Code's own bundled tooling survive a `[]` allowlist. Do not plan a deny-all around blocking those.

## Environment variables in patterns fail closed on the allowlist only

Both `serverCommand` elements and `serverUrl` patterns support `${VAR}` expansion against the policy environment. Claude Code guards this on the allow path and does not on the deny path.

On the allow path, if an expansion is judged unsafe the entry is skipped entirely, which means it cannot match, which means the server is blocked. Unsafe means the substituted value changed the shape of the pattern rather than just filling a hole: it injected wildcard semantics, it changed whether the URL has a parseable hostname, or it dropped a hash or query component the literal pattern had. Missing variables also count. The warning is explicit that allowlist URL entries using an unsafe expansion fail closed while denylist entries are unaffected.

So `{ "serverUrl": "https://${TEAM}.mcp.example.com/*" }` is fine when `TEAM` is `payments` and silently stops matching when `TEAM` is unset or contains a `*`. If you cannot guarantee the variable is populated in the policy environment on every machine, write the URLs out literally. A wildcard in a hostname you control is cheaper than a variable you do not.

## Layering sources, and who wins

This is where the two products diverge most.

Copilot composes across sources set-theoretically: the effective allowlist is the *intersection* of every source and the effective denylist is the *union*, so a server has to be permitted by every layer to run. Enterprise administrators who want teams to narrow the list further wrap the matcher objects under `overridable` at the enterprise level, and each team file then uses the plain syntax. Worth checking the current compatibility table before you plan around it: the reference lists both keys as supported in Copilot CLI and VS Code, and not in the GitHub Copilot app or the JetBrains IDEs.

Claude Code does not intersect. `allowedMcpServers` is managed-settings-only and is taken from the highest-priority managed source that defines it, while `deniedMcpServers` merges from all sources. Add `allowManagedMcpServersOnly: true` and the allowlist is read from managed settings exclusively; users can still register their own MCP servers, but only the admin allowlist decides whether they start. Deny keeps merging, which is intentional: a developer is always allowed to block more for themselves, never less.

Two adjacent keys are worth setting at the same time. `strictPluginOnlyCustomization` rejects `--plugin-dir`, `--plugin-url`, `--agents`, and non-SDK `--mcp-config` flags at startup, closing the CLI bypass. Its own documentation is candid that it does not gate the other MCP entry points: the SDK's `setMcpServers`, `claude mcp add`, and `.mcp.json` all still work, and per-server control has to come from `allowedMcpServers`. And `disableClaudeAiConnectors` (2.1.182 and later) stops claude.ai cloud connectors from being auto-fetched at all; `true` in any scope wins, so a checked-in project setting can opt a repo out, and a project-level `false` cannot undo a policy-level `true`.

If your fleet is on VS Code, there is a third layer underneath both. The `ChatMCP` device policy configures `chat.mcp.access`, whose values include `all`, `none`, and a registry-only mode, and `McpGalleryServiceUrl` points the client at a private registry. That is a coarser switch than a per-server allowlist, which makes it a good backstop: the device policy decides whether MCP exists on the machine, the allowlist decides which servers.

## A rollout order that does not page you

1. Ship `deniedMcpServers` first with the handful of servers you actually want gone, matched by `serverUrl` and `serverCommand`, adding `serverName` only as a convenience alias. Deny is a union, so this is additive and cannot lock anyone out.
2. Inventory what is actually running before you write an allowlist. Argv arrays have to be exact, and you will not guess them.
3. Ship `allowedMcpServers` to a pilot group. Expect the fallback trap on day one if the list mixes `serverName` with `serverCommand`.
4. Only then set `allowManagedMcpServersOnly: true`, and pair it with `strictPluginOnlyCustomization` so the CLI flags do not route around you.
5. Wire `claude doctor` output into whatever checks machine health, because a stripped `allowedMcpServers` field is indistinguishable from a working lockdown until someone complains.

An allowlist governs which server processes start and which endpoints get spoken to. It says nothing about where a tool connects once it is running, which is why this pairs with rather than replaces [a strict host allowlist on the agent's network egress](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/), and it is orthogonal to [what each permission mode lets through at the tool-call level](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/). Three layers, three failure modes.

## Related

- [Copilot MCP allowlists land in enterprise managed settings](/2026/08/copilot-mcp-allowlists-enterprise-managed-settings/) covers the GitHub changelog that shipped these keys and the registry they replace.
- [How to reduce the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/) is the other half of the problem: scoping servers so the tool budget survives.
- [Distributing a team MCP config across Cursor cloud agents and the IDE](/2026/07/distribute-team-mcp-config-across-cursor-cloud-agents-and-ide/) handles the same question for a vendor with no managed-settings equivalent.
- [Migrating off the archived MCP reference servers](/2026/08/migrate-off-archived-mcp-reference-servers/) is worth doing before you pin argv arrays to packages that are already deprecated.

Primary sources: the [Claude Code settings reference](https://code.claude.com/docs/en/settings), GitHub's [enterprise managed settings reference](https://docs.github.com/en/copilot/reference/enterprise-managed-settings-reference), and the [VS Code enterprise AI settings guide](https://code.visualstudio.com/docs/enterprise/ai-settings). Matcher precedence, the `serverName` fallback rule, and the fail-closed expansion behaviour were verified against the Claude Code 2.1.224 binary rather than taken from prose.
