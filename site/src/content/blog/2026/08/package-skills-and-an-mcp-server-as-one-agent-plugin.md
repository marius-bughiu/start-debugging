---
title: "How to Package Skills and an MCP Server as One Agent Plugin"
description: "Agent Plugins 1.0 says plugin.json at the root and mcp.json beside it. Claude Code 2.1.x wants .claude-plugin/plugin.json and .mcp.json. Here is what each client actually loads, tested against a real plugin, and the dual-layout directory that satisfies both."
pubDate: 2026-08-17
tags:
  - "agent-skills"
  - "mcp"
  - "claude-code"
  - "ai-agents"
  - "llm"
---

If you want one directory that carries both a skill and the MCP server that skill depends on, the packaging format is [Agent Plugins 1.0.0](https://agent-plugins.org/): a `plugin.json` manifest at the plugin root, a `skills/` folder whose immediate children each hold a `SKILL.md`, and an `mcp.json` describing the servers. That is the portable contract, published by a steering committee with core maintainers from Amazon, Cursor, Microsoft, OpenAI, and Vercel. **But Claude Code 2.1.224, the version I tested against, does not read that layout as written.** It discovers `skills/` fine and ignores `mcp.json` completely, because it looks for a dot-prefixed `.mcp.json` and a manifest at `.claude-plugin/plugin.json`. The fix is a directory that carries both spellings, which costs you two extra files and no duplicated logic.

Everything below is measured, not paraphrased from a docs page. I built a plugin called `relnotes` with one skill and one stdio MCP server (`@modelcontextprotocol/sdk` 1.30.0 on Node 24.14.1), loaded it with `--plugin-dir`, and had a headless Claude Code run report which components it could actually see.

## Why the bundle is the unit, not the two halves

A skill and an MCP server answer different questions, and I have written before about [when to build a skill, a subagent, or an MCP server](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/). The short version: a skill changes how the agent does a task, an MCP server gives the agent a capability it otherwise lacks. The interesting case is when one is useless without the other.

Release notes is the canonical example. The MCP server knows how to query merged pull requests between two tags. The skill knows your changelog conventions: which sections you use, how you word a breaking change, where the file lives. Ship the server alone and every teammate reinvents the prose rules. Ship the skill alone and it references a tool nobody has. Bundled, `install` is the whole onboarding step.

The token accounting also favours the bundle, and it is lopsided in a way worth knowing before you design. Here is `claude plugin details` on the finished plugin:

```
relnotes 0.1.0
  Source: relnotes@skills-dir

Component inventory
  Skills (1)  release-notes
  Agents (0)
  Hooks (0)
  MCP servers (1)  relnotes  (tool schemas resolved at runtime; not counted)

Projected token cost
  Always-on:   ~57 tok   added to every session

  component      always-on  on-invoke
  release-notes        ~60        ~70
```

The skill costs about 60 tokens in every session, because only its `description` line is resident, and pulls its body in on invocation. The MCP server's tool schemas are not counted there at all, since they resolve at runtime. That is the asymmetry: skills are cheap to have and cheap to skip, MCP tool schemas are a per-session cost you pay whether or not the tool fires. Put the prose in the skill and keep the server's tool surface small. If you have already hit the ceiling on that, [reducing the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/) covers the triage.

## The two layouts, side by side

This is the entire incompatibility:

| Component | Agent Plugins 1.0.0 | Claude Code 2.1.x |
| --- | --- | --- |
| Manifest | `plugin.json` (root) | `.claude-plugin/plugin.json` |
| Skills | `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` |
| MCP servers | `mcp.json` (root) | `.mcp.json` (root) |
| Path placeholders | `${PLUGIN_ROOT}`, `${PLUGIN_DATA}` | `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` |
| Client extras | `extensions` key, `com.vendor/` dirs | dedicated keys in the manifest |

Skills are the part that already travels. Everything else needs a second spelling.

I confirmed the split by building the plugin in pure Agent Plugins layout, pointing Claude Code at it, and asking a headless run to enumerate what it found:

```bash
# Claude Code 2.1.224, plugin dir contains plugin.json + skills/ + mcp.json
claude -p "List every MCP tool name available containing 'merged'. \
Then list every skill name available." \
  --plugin-dir . --output-format json < /dev/null
```

The skill came back as `apstd:release-notes`, correctly namespaced under the plugin name. The MCP tool list came back empty. Copying `mcp.json` to `.mcp.json` and changing nothing else made the tool appear as `mcp__plugin_apstd_apstd__list_merged_prs`, which is the `mcp__plugin_<plugin>_<server>__<tool>` naming Claude Code uses for plugin-supplied servers. So the failure is purely the filename, and it fails silently: no warning, no error tab entry, just an agent that never calls the tool your skill told it to call.

## Building the plugin

Start with the layout that works everywhere, then add the Claude Code spellings.

```
relnotes/
├── plugin.json                     # Agent Plugins 1.0.0 manifest
├── .claude-plugin/
│   └── plugin.json                 # Claude Code manifest
├── skills/
│   └── release-notes/
│       └── SKILL.md                # portable, both clients read this
├── mcp.json                        # Agent Plugins 1.0.0
├── .mcp.json                       # Claude Code
└── server/
    └── index.js
```

### The manifest

The Agent Plugins spec is strict about what may appear at the top level: only `$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, and `extensions`. Anything client-specific has to live under a reverse-domain key inside `extensions`. `name` is 1 to 64 characters, lowercase alphanumerics with hyphens and periods.

```json
// plugin.json - Agent Plugins 1.0.0
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "relnotes",
  "version": "0.1.0",
  "description": "Release-notes toolkit: a skill that writes the changelog entry and an MCP server that reads merged PRs.",
  "author": { "name": "Marius Bughiu" },
  "license": "MIT"
}
```

The Claude Code manifest carries the same metadata plus its own component-path keys, and points at a different schema:

```json
// .claude-plugin/plugin.json - Claude Code 2.1.x
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "relnotes",
  "version": "0.1.0",
  "description": "Release-notes toolkit: a skill that writes the changelog entry and an MCP server that reads merged PRs.",
  "author": { "name": "Marius Bughiu" },
  "license": "MIT"
}
```

Only `name` is required by either. Both files are small and static, so keeping them in sync is a copy step in your release script, not a maintenance burden.

### The skill

This is the part you write once. Both specs read `skills/<name>/SKILL.md`, and both stop at immediate children: a `SKILL.md` nested two levels deep is not discovered.

```markdown
<!-- skills/release-notes/SKILL.md -->
---
name: release-notes
description: Draft the changelog entry for a release. Use when the user asks for release notes, a changelog entry, or "what shipped in vX".
allowed-tools:
  - Read
  - Write
---

Call `mcp__relnotes__list_merged_prs` for the tag range, then group the PRs
under Added / Changed / Fixed and write them to CHANGELOG.md.
```

Set `name` in the frontmatter explicitly. Claude Code falls back to the directory basename, and marketplace installs can produce version-stamped directory names that leak into the invocation name if you leave it out.

Write the `description` for a router, not a human. It is the only text resident in context, so it has to contain the words a user would actually type. "Use when the user asks for release notes, a changelog entry" earns its tokens; "Handles release documentation" does not.

### The MCP server

A stdio server with one tool, using the official TypeScript SDK:

```javascript
// server/index.js - @modelcontextprotocol/sdk 1.30.0, Node 24.14.1
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "relnotes", version: "0.1.0" });

server.registerTool(
  "list_merged_prs",
  {
    title: "List merged PRs",
    description: "List pull requests merged between two git tags.",
    inputSchema: { from: z.string(), to: z.string() },
  },
  async ({ from, to }) => ({
    content: [{ type: "text", text: `merged PRs between ${from} and ${to}` }],
  })
);

await server.connect(new StdioServerTransport());
```

Set `"type": "module"` in `package.json` for the ESM imports. If you are writing the server itself rather than just packaging one, [building an MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) goes through the transport and schema decisions in detail.

Now the two config files. Same content, different placeholder names:

```json
// mcp.json - Agent Plugins 1.0.0
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "relnotes": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/server/index.js"],
      "env": { "RELNOTES_CACHE": "${PLUGIN_DATA}/cache" }
    }
  }
}
```

```json
// .mcp.json - Claude Code 2.1.x
{
  "mcpServers": {
    "relnotes": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server/index.js"],
      "env": { "RELNOTES_CACHE": "${CLAUDE_PLUGIN_DATA}/cache" }
    }
  }
}
```

Never hardcode a path. I had the server echo its resolved environment back through a tool call to check the substitution really happens:

```
RANGE=a..b
CACHE=C:/Users/mariu/.claude/plugins/data/relnotes-inline/cache
ARGV1=C:\...\scratchpad\relnotes\server\index.js
```

Both placeholders expanded. Note the data directory ID: `relnotes-inline`, not `relnotes`. A plugin loaded with `--plugin-dir` gets a different `${CLAUDE_PLUGIN_DATA}` directory than the same plugin once installed, so anything you cache during development does not carry over to the installed copy. That is correct behaviour, but it will look like a cache bug the first time you hit it. Do not store anything in `PLUGIN_DATA` that the plugin cannot regenerate.

## Three gotchas that cost real time

### `claude plugin validate` is a metadata linter, not a wiring check

This is the one that surprised me most. Run it on the finished plugin and it passes, which feels like confirmation that the whole thing is wired up. It is not. I built a deliberately broken plugin: `mcpServers` pointing at a `./nope.json` that does not exist, and a `skills/` directory misplaced inside `.claude-plugin/` (the mistake the docs explicitly warn about).

```bash
claude plugin validate ./broken
```

```
⚠ Found 3 warnings:
  ❯ version: No version specified...
  ❯ description: No description provided...
  ❯ author: No author information provided...

✔ Validation passed with warnings
```

Three warnings, all about missing metadata. Nothing about the dangling MCP path, nothing about the misplaced skills directory. The validator reads `plugin.json` and checks that file's contents. It caught `"name": "Broken Plugin"` with an error ("Plugin name cannot contain spaces"), and it caught malformed JSON, but it never walks the tree.

`--strict` promotes those three warnings to failures, which makes it useful in CI for enforcing that every published plugin has a version, description, and author. It still does not verify a single component loads:

```bash
claude plugin validate ./my-plugin --strict
```

The only real check is loading the plugin and asking what the agent can see. Add this to CI and you have an actual smoke test:

```bash
# fails loudly if the skill or the MCP tool did not register
claude -p "List your available skill names and MCP tool names." \
  --plugin-dir ./my-plugin --output-format json < /dev/null \
  | grep -q "relnotes" || exit 1
```

### `.mcp.json` accepts two different shapes and Anthropic's own plugins disagree

The documented format wraps servers in an `mcpServers` key. But the official `claude-plugins-official` marketplace ships both. The `discord`, `telegram`, and `imessage` plugins use the wrapped form:

```json
{
  "mcpServers": {
    "discord": { "command": "bun", "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--silent", "start"] }
  }
}
```

while `github`, `context7`, and the official `example-plugin` use a bare map with no wrapper at all:

```json
{
  "github": {
    "type": "http",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" }
  }
}
```

I tested both against the same plugin and both loaded the server and exposed the tool. Claude Code accepts either. **Use the wrapped form anyway**, because Agent Plugins 1.0 requires `mcpServers` as a top-level key in `mcp.json`, so the wrapped shape is the one that lets a single JSON body serve both files. The bare form is a Claude Code-only dialect and it will not survive the trip to another client.

Whichever you pick, get the JSON right. A single trailing comma takes down more than the one server, as covered in [why all MCP servers fail to load after one malformed-JSON error](/2026/07/fix-all-mcp-servers-fail-to-load-after-malformed-json-in-config/).

### Component directories go at the plugin root, never inside `.claude-plugin/`

Only the manifest lives in `.claude-plugin/`. `skills/`, `agents/`, `hooks/`, `commands/`, `.mcp.json`, and `bin/` all sit at the plugin root. Since the validator does not catch this, the symptom is a plugin that installs cleanly and exposes nothing. Check the component inventory instead:

```bash
claude plugin details relnotes
```

If `Skills (0)` comes back on a plugin that clearly has skills, this is why.

## Getting it onto teammates' machines

For iteration, `--plugin-dir` loads a directory without installing, and takes the flag more than once:

```bash
claude --plugin-dir ./relnotes --plugin-dir ./other-plugin
```

If you would rather not pass the flag every launch, `claude plugin init relnotes` scaffolds into `~/.claude/skills/relnotes/`, where it auto-loads on the next session as `relnotes@skills-dir`. That is the source label in the `plugin details` output above. Edits to `SKILL.md` take effect immediately; changes to `.mcp.json` or the manifest need `/reload-plugins` or a restart.

For distribution, put the plugin in a git repository and publish a marketplace entry, then teammates run `/plugin marketplace add your-org/your-marketplace` followed by an install. A private repository works for internal-only plugins. Set `version` in both manifests and bump it deliberately, since Claude Code resolves the plugin version from `plugin.json` first and users only get updates when that string changes. `claude plugin tag` creates a `{name}--v{version}` git tag and validates that the manifest and the marketplace entry agree on the number, which is worth wiring into your release step.

If your team is on Cursor rather than Claude Code, the equivalent bundle predates the shared standard and uses `.cursor-plugin/plugin.json`. I covered that format in [Cursor 3.9 bundling your agent setup into portable plugins](/2026/06/cursor-3-9-plugins-bundle-skills-rules-mcps-hooks/), and the sorting exercise for existing config in [migrating Cursor rules to skills, subagents, and plugins](/2026/08/migrate-cursor-rules-to-skills-subagents-and-plugins/). Agent Plugins 1.0 is the convergence point for all of these, and skills are already portable today. The manifest and MCP config are the parts still carrying vendor spellings, which is exactly why the dual-layout directory is worth the two extra files rather than a rewrite per client.

## Sources

- [Agent Plugins specification](https://agent-plugins.org/) and the [specification repository](https://github.com/agentplugins/agent-plugins-spec)
- [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Create plugins (Claude Code docs)](https://code.claude.com/docs/en/plugins)
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [`anthropics/claude-plugins-community` catalog](https://github.com/anthropics/claude-plugins-community)
