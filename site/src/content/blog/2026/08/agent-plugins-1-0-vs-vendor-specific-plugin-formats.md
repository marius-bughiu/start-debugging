---
title: "Agent Plugins 1.0 vs Vendor-Specific Plugin Formats: What the Shared Standard Actually Covers"
description: "Agent Plugins 1.0.0 standardizes exactly two component types: skills and MCP servers. Slash commands, hooks, subagents, rules, LSP servers, permission config and secrets all stay vendor-specific. Here is the field-by-field matrix across Claude Code, Cursor, Copilot and Codex, and which layout to author in."
pubDate: 2026-08-31
template: vs
tags:
  - "comparison"
  - "agent-skills"
  - "mcp"
  - "ai-agents"
  - "claude-code"
  - "cursor"
  - "github-copilot"
  - "llm"
---

Author your plugin in the [Agent Plugins 1.0.0](https://agent-plugins.org/specification) layout: `plugin.json` at the root, `skills/` beside it, `mcp.json` beside that. Six clients read it as published. But be clear-eyed about the size of the win, because the standard covers **exactly two component types**, skills and MCP servers, and nothing else. Slash commands, hooks, subagents, rules, LSP servers, permission models, secret configuration and the entire install path are explicitly out of scope. The escape hatch is a reverse-domain directory (`com.github.copilot/`, `com.example.client/`) that each client reads only for itself. And one major client, Claude Code, does not read the standard layout at all: on 2.1.197 a root-only `plugin.json` is a hard error, not a warning.

So the real question is not "standard or vendor format." It is "how much of my plugin fits in the portable half." If your bundle is a skill plus an MCP server, the portable half is 100 percent of it. If your bundle is four subagents, a `PreToolUse` hook and a permission policy, the portable half is the manifest and nothing else.

## The matrix

Versions in this table: Agent Plugins 1.0.0 (published August 6, 2026), Claude Code 2.1.197, Cursor 3.11, VS Code 1.133 with Copilot plugin support GA since August 12, 2026, and the Codex plugin docs as of August 2026.

| Component | Agent Plugins 1.0.0 | Claude Code 2.1.x | Cursor 3.x | Copilot (VS Code / CLI) | Codex / ChatGPT |
| --- | --- | --- | --- | --- | --- |
| Manifest | `plugin.json` (root) | `.claude-plugin/plugin.json` | `plugin.json` **or** `.cursor-plugin/plugin.json` | `plugin.json` (root) | `.codex-plugin/plugin.json` |
| Skills | `skills/<name>/SKILL.md` | same | same | same | same |
| MCP servers | `mcp.json` | `.mcp.json` | `mcp.json` | `mcp.json` | `.mcp.json` |
| Slash commands | not standardized | `commands/` | `commands/` | `com.github.copilot/commands/` | not documented |
| Subagents | not standardized | `agents/` | `agents/` | `com.github.copilot/agents/*.agent.md` | not documented |
| Hooks | not standardized | `hooks/hooks.json` | `hooks/hooks.json` | `com.github.copilot/hooks/hooks.json` | `hooks/hooks.json` |
| Rules | not standardized | `CLAUDE.md` (not a plugin component) | `rules/` (`.mdc`) | `com.github.copilot/rules/` | not documented |
| LSP servers | out of scope, named | `.lsp.json` | none | none | none |
| Path placeholders | `${PLUGIN_ROOT}`, `${PLUGIN_DATA}` | `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}` | none documented | standard placeholders | `PLUGIN_ROOT`, `PLUGIN_DATA` as hook env vars |
| User-supplied secrets | out of scope | `userConfig` (typed, `sensitive: true`) | `variables` (JSON Schema, stored in dashboard) | none | none |
| Install / distribution | out of scope | marketplaces, `claude plugin install` | Customize page, `.cursor-plugin/marketplace.json` | Awesome Copilot, **Chat: Install Plugin From Source** | `codex plugin marketplace add` |

Two rows carry the whole argument. The **skills row is identical everywhere**, including in Claude Code. The **manifest row disagrees in four different ways**. That asymmetry is not an accident: skills were already converging on `SKILL.md` before the standard existed, so the spec ratified reality. Everything else was still moving, so the spec left it alone.

## What 1.0.0 actually pins down

The portable core is four things. First, a manifest with two required fields:

```json
// plugin.json, Agent Plugins 1.0.0, at the plugin root
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "changelog-tools"
}
```

That is a complete, valid plugin manifest. `version`, `description`, `author`, `homepage`, `repository`, `license` and `keywords` are all optional, and the spec goes out of its way to say clients must not reject a manifest just because `version` is not valid SemVer.

Second, skill discovery, defined narrowly enough that two clients cannot disagree: each *immediate* child directory of `skills/` that contains a regular file named exactly `SKILL.md` is one skill. Recursive searching is prohibited, so a `skills/team/backend/deploy/SKILL.md` is not a skill anywhere.

Third, `mcp.json`, with a closed union of three server types:

```json
// mcp.json, Agent Plugins 1.0.0
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "notes": {
      "type": "stdio",
      "command": "node",
      "args": ["${PLUGIN_ROOT}/bin/server.js"]
    },
    "remote": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

`command` must be a single executable token, not a shell string, so `"command": "node bin/server.js"` is invalid even though several vendor formats historically tolerated it. Legacy `sse` is in the union for compatibility and nothing else.

Fourth, exactly two placeholders, `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, expanded only in `args`, `env` and `cwd`, as a single non-recursive textual replacement. Not in `command`. Not in `url`. Not in `headers`.

## What it deliberately does not cover

The spec is blunt about the boundary. Component types beyond skills and MCP servers, in the spec's own words, "remain too client-specific for a stable portable contract." The named exclusions are commands, hooks, agents, rules and LSP servers. Beyond component types, 1.0.0 also declines to define an install mechanism, a distribution protocol, a central registry, a permission model, sandboxing requirements, trust or provenance verification, OAuth and credential configuration, an archive format (a plugin is a directory, full stop), and fallback behaviour when a transport fails to connect.

That list is longer than the list of things it does cover, and it is worth sitting with. A plugin standard with no permission model and no provenance verification means "portable" describes the file layout and not the trust decision. Whether your team is allowed to run the MCP server inside a portable plugin is still a per-client policy question, and on the Claude Code side that is [`allowedMcpServers` and `deniedMcpServers`](/2026/08/centrally-control-which-mcp-servers-a-team-can-run/), which no standard touches.

## The namespaced escape hatch

Everything non-portable goes in a reverse-domain directory at the plugin root, with matching data under the manifest's `extensions` key. Copilot's is `com.github.copilot`, and the VS Code docs spell out the full layout:

```
my-plugin/
  plugin.json                 # portable: Agent Plugins 1.0.0
  skills/
    test-runner/
      SKILL.md
      run-tests.sh
  mcp.json                    # portable
  com.github.copilot/         # Copilot-only, ignored by every other client
    agents/
      test-reviewer.agent.md
    commands/
    rules/
    hooks/
      hooks.json
```

```json
// plugin.json with a client extension block
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "changelog-tools",
  "version": "1.0.0",
  "extensions": {
    "com.github.copilot": { "canvases": false }
  }
}
```

Clients must ignore namespaces they do not implement, without validating the contents. This is the part that makes the standard usable rather than merely tidy: you are not forced to drop your four Copilot subagents to be portable, you just move them one directory down. The cost is that the subagents are still four files you maintain per client, and the standard has done nothing to reduce that. A Cursor subagent in `agents/` and a Copilot subagent in `com.github.copilot/agents/` are still two authoring jobs, which is the same sorting problem covered in [migrating Cursor rules to skills, subagents, and plugins](/2026/08/migrate-cursor-rules-to-skills-subagents-and-plugins/).

## Claude Code is the holdout, and it fails loudly

Anthropic is not on the technical steering committee (Amazon, Cursor, Microsoft, OpenAI and Vercel founded it, with Google joining as a core maintainer), and Claude Code was not in the launch client list. I checked what that means in practice against 2.1.197 with a plugin built in pure spec layout: `plugin.json`, `skills/changelog-notes/SKILL.md`, `mcp.json`, and a `com.github.copilot/` directory.

```bash
# Claude Code 2.1.197, plugin dir in pure Agent Plugins 1.0.0 layout
$ claude plugin validate ./portable-demo
Validating plugin manifest: /tmp/portable-demo

✘ Found 1 error:

  ❯ directory: No manifest found in directory. Expected
    .claude-plugin/marketplace.json or .claude-plugin/plugin.json

✘ Validation failed
```

Not a warning about an unrecognized layout. The manifest at the root is invisible, so the directory reads as "not a plugin" and the skills inside it never get considered. The fix is two extra files, which [packaging skills and an MCP server as one agent plugin](/2026/08/package-skills-and-an-mcp-server-as-one-agent-plugin/) walks through in full: a `.claude-plugin/plugin.json` and a `.mcp.json` alongside the portable pair.

The interesting half is what happens when you copy the standard manifest verbatim into `.claude-plugin/plugin.json`:

```bash
# Claude Code 2.1.197, standard manifest copied into .claude-plugin/
$ claude plugin validate ./portable-demo --strict
⚠ Found 2 warnings:

  ❯ extensions: Unknown field 'extensions'. Claude Code ignores it at load time.
  ❯ author: No author information provided...

✘ Validation failed (--strict treats warnings as errors)
```

`$schema` passes silently. `extensions` warns but is tolerated at runtime. So a single manifest body works in both places, and the only genuinely duplicated content is the file itself. Note that `--strict` turns that `extensions` warning into a CI failure, which is worth knowing before you wire `claude plugin validate --strict` into a pipeline for a plugin you deliberately made portable.

## The gotcha that picks for you

The MCP half is where a dual-layout plugin silently half-works, and no tool catches it. I pointed Claude Code's manifest at the spec-shaped file:

```json
// .claude-plugin/plugin.json
{ "name": "portable-demo", "mcpServers": "./mcp.json" }
```

```bash
$ claude plugin validate ./portable-demo --strict
⚠ Found 1 warning:
  ❯ author: No author information provided...
```

No complaint about `mcp.json`. `claude plugin validate` is a metadata linter: it reads the manifest, checks field names and types, and does not open the MCP config or look at the placeholders inside it. That config declares `"args": ["${PLUGIN_ROOT}/bin/server.js"]`, and Claude Code expands `${CLAUDE_PLUGIN_ROOT}`, not `${PLUGIN_ROOT}`. The unexpanded string is passed to `node` as a literal path, the process exits, and you get a connection failure at session start instead of a validation error at build time. The same class of failure is behind [`MCP error -32000: Client Closed`](/2026/06/fix-mcp-error-32000-connection-closed-in-claude-code/).

Which means: keep two MCP config files, not one. `mcp.json` with `${PLUGIN_ROOT}` for the standard-reading clients, `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}` for Claude Code, and a check in CI that the two agree on server names and commands. Four files of duplication total (`plugin.json`, `.claude-plugin/plugin.json`, `mcp.json`, `.mcp.json`), no duplicated logic, and every skill and every script shared.

## When to author in the standard layout

- **Your bundle is skills plus MCP servers.** This is the case the standard was written for, and it is a clean 100 percent. Six clients (ChatGPT, Codex, Cursor, GitHub Copilot, Kiro, VS Code) load it as published, plus Kiro Powers natively and the AWS Agent Toolkit.
- **You are publishing for other people.** A vendor layout quietly halves your reach. Since the skills directory is identical across every client including Claude Code, a portable plugin plus a `.claude-plugin/` shim reaches everything that matters today.
- **Your MCP surface is small.** Skill descriptions are cheap, resident at roughly 60 tokens each; MCP tool schemas are a per-session cost paid whether the tool fires or not. If a portable plugin is going onto machines you do not control, keep the tool surface tight, per [reducing the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/).

## When to stay on a vendor format

- **Hooks or permission gating are the point of the plugin.** A `PreToolUse` hook that blocks a destructive command is not portable in any sense: the event names, the matcher syntax and the block semantics are per-client. Writing it in a namespaced directory does not make it portable, it just makes it tidy.
- **You need typed, user-supplied secrets.** Claude Code's `userConfig` (with `sensitive: true` and `${user_config.KEY}` interpolation) and Cursor's `variables` JSON Schema both solve the "do not hardcode a connection string into a shared bundle" problem. The standard says nothing about credentials, so a portable plugin needing an API token has to fall back to environment variables the user sets by hand.
- **You ship an LSP server.** `.lsp.json` is a Claude Code feature with no counterpart anywhere else, and the spec names LSP servers among the types it is not standardizing.
- **You are shipping internally to one client.** The portability tax is real (two manifests, two MCP configs, a namespaced directory) and buys nothing if everyone on the team runs the same agent.

## The recommendation, restated

Make the Agent Plugins 1.0.0 layout your source of truth, put every client-specific component in its reverse-domain directory, and add the `.claude-plugin/plugin.json` plus `.mcp.json` shim as a build step rather than a hand-maintained pair. Treat the standard as what it says it is: a package format and an interoperability floor, not a capability contract. It will not make your hooks run in Cursor or your subagents show up in ChatGPT, and if a plugin's value lives in those components, the standard has bought you a manifest and a naming convention. If a plugin's value lives in a skill and a tool, it has bought you six clients for the price of one.

## Related

- [How to Package Skills and an MCP Server as One Agent Plugin](/2026/08/package-skills-and-an-mcp-server-as-one-agent-plugin/) for the dual-layout directory in full, tested against a real plugin.
- [Migrate Cursor Rules to Skills, Subagents, and Plugins](/2026/08/migrate-cursor-rules-to-skills-subagents-and-plugins/) if your non-portable half is a folder of `.mdc` rules.
- [Cursor 3.9 Bundles Your Agent Setup Into Portable Plugins](/2026/06/cursor-3-9-plugins-bundle-skills-rules-mcps-hooks/) for the `.cursor-plugin/plugin.json` field list.
- [Claude Code Skills vs Subagents vs MCP Servers: When to Build Each](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/) for deciding what belongs in the portable half before you package anything.
- [How to Centrally Control Which MCP Servers a Team Can Run](/2026/08/centrally-control-which-mcp-servers-a-team-can-run/) because a portable plugin still has to clear your allowlist.

## Sources

- [Agent Plugins Specification 1.0.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md) for the manifest fields, the skills discovery rule, the `mcp.json` closed union, the `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` expansion rule, and the out-of-scope list naming commands, hooks, agents, rules and LSP servers.
- [Agent Plugins: scope and governance](https://agent-plugins.org/) for the interoperability-floor framing and the statement that distribution, installation, permissions and UX stay under each client's control.
- [Introducing Agent Plugins](https://vercel.com/blog/introducing-agent-plugins) for the August 6, 2026 launch date and the six launch clients.
- [Agent Plugins 1.0 in VS Code, Copilot CLI, and the Copilot app](https://github.blog/changelog/2026-08-12-agent-plugins-1-0-in-vs-code-copilot-cli-and-the-copilot-app/) and [Agent plugins in VS Code](https://code.visualstudio.com/docs/agent-customization/agent-plugins) for the `com.github.copilot/` layout, `chat.plugins.enabled`, and the install paths.
- [Cursor plugins reference](https://cursor.com/docs/reference/plugins) for Cursor reading both `plugin.json` and `.cursor-plugin/plugin.json`, and for the `variables` JSON Schema.
- [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference) for `.claude-plugin/plugin.json`, `.mcp.json`, `.lsp.json`, `userConfig`, and the three `${CLAUDE_*}` path variables.
- [Package your plugin (OpenAI)](https://developers.openai.com/plugins/build/plugins) for `.codex-plugin/plugin.json`, `.app.json`, and the `codex plugin marketplace` commands.
- [AWS supports Agent Plugins](https://aws.amazon.com/blogs/opensource/aws-supports-agent-plugins-an-open-standard-for-portable-agent-extensions/) for Kiro Powers and the AWS Agent Toolkit, and [Agent Plugins package your skills, tools, and more](https://developers.googleblog.com/agent-plugins-package-your-skills-tools-and-more/) for Google joining as a core maintainer and the explicit non-goals list.
