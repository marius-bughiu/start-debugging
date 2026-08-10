---
title: "Migrate Cursor Rules to Skills, Subagents, and Plugins (Cursor 3.11)"
description: "Cursor did not delete rules. It split them. This checklist sorts a .cursorrules file and a folder of .mdc rules into the four things they should be in Cursor 3.11: an AGENTS.md, a small set of surviving rules, skills, and subagents, then bundles the result as a plugin."
pubDate: 2026-08-10
updatedDate: 2026-08-10
template: migration
tags:
  - "migration"
  - "cursor"
  - "ai-agents"
  - "agent-skills"
  - "llm"
---

If you have a `.cursorrules` file from 2024 or a `.cursor/rules/` folder that has quietly grown to twenty `.mdc` files, the migration in front of you is a sorting problem, not a rewrite. Cursor 3.11 (released July 10, 2026) still loads rules exactly as it always has. What changed is that three newer homes now exist for things that used to be crammed into a rule: skills, subagents, and plugins. The built-in `/migrate-to-skills` skill, shipped in Cursor 2.4, moves one specific slice automatically and deliberately refuses to touch the rest. Expect an hour for a mid-sized repo. Nothing breaks if you do nothing, but the token bill and the "why did the agent ignore my rule" complaints do not go away on their own.

The most common thing I see people get wrong here is reading "migrate to skills" as "rules are deprecated." They are not. Cursor's rules documentation is still a live page with four rule modes, team/project/user precedence, and nested `AGENTS.md` support. The migration is a split, and knowing where the seams are is the whole job.

## Why bother when rules still work

- **Always-on rules cost tokens on every request.** A single `.cursorrules` file loads unconditionally, in full, whether you are renaming a variable or designing a schema. A skill loads its `description` line into context and pulls the body only when the agent decides it is relevant. On a 400-line rules file that is the difference between a fixed per-request tax and a one-time cost on the turns that need it.
- **Rules cannot carry code.** A skill directory supports `scripts/` (executables the agent can run), `references/` (docs loaded on demand), and `assets/` (templates, images, data files). A deploy procedure that currently exists as 80 lines of prose telling the agent what commands to type can become a 10-line skill plus a script.
- **Rules cannot get their own context window.** Anything in your rules that reads like "when reviewing a PR, do X, Y, Z, and be strict" is describing a job, not a convention. That is a subagent, and it gets a separate context so it does not pollute the main thread.
- **Rules alone are not distributable.** Since Cursor 3.9 the shareable unit is a plugin: one manifest that carries rules, skills, agents, commands, hooks, and MCP servers together. I covered the format when it shipped in [Cursor 3.9 bundling your agent setup into portable plugins](/2026/06/cursor-3-9-plugins-bundle-skills-rules-mcps-hooks/).

## What actually changes

| Area | Change | Severity |
| --- | --- | --- |
| `.cursorrules` (single legacy file) | No longer documented on the rules page. Gets no scoping, no activation modes, loads unconditionally. | high |
| Dynamic rules (`alwaysApply: false`, no `globs`) | Superseded by skills. `/migrate-to-skills` converts these. | medium |
| Slash commands (`.cursor/commands/`) | Converted to skills with `disable-model-invocation: true`. The docs URL for commands now serves skills content. | medium |
| Always-apply rules (`alwaysApply: true`) | Unchanged. Stays a rule. Not migrated. | none |
| Glob-scoped rules (`globs: "src/**/*.tsx"`) | Unchanged. Stays a rule. Not migrated. | none |
| User rules (set in Customize) | Not migrated, because they are not on the file system. | none |
| Team rules | Unchanged. Still first in precedence: Team, then Project, then User. | none |

The severity column is the point. Two of the seven rows are "none," and one of the automatic conversions is genuinely automatic. This is a smaller migration than the phrase "migrate to skills" implies.

## Pre-flight checklist

- **Cursor 2.4 or newer** for `/migrate-to-skills`; 3.9 or newer if you intend to finish with a plugin. Check Help, About against the [changelog](https://cursor.com/changelog).
- **Commit first, on a branch.** The migration skill writes files. You want a clean diff to review.
- **Know your four locations.** Skills load from `.cursor/skills/`, `.agents/skills/`, `~/.cursor/skills/`, and `~/.agents/skills/`. Subagents load from `.cursor/agents/`, `.claude/agents/`, or `.codex/agents/`, with `~/`-prefixed equivalents for user level. Project definitions win over user definitions on a name collision.
- **Decide `.agents/` vs `.cursor/`.** If your team also runs Claude Code or Codex, `.agents/skills/` is the portable directory and `.cursor/skills/` is the Cursor-specific one. Pick one per repo and stay there.

## Migration steps

### 1. Inventory what you have

Before touching anything, get the full list. From the repo root:

```bash
# Cursor 3.11, August 2026
ls -la .cursorrules AGENTS.md 2>/dev/null
find .cursor/rules -name '*.mdc' | sort
find .cursor/commands -type f 2>/dev/null | sort
find . -name AGENTS.md -not -path './node_modules/*' | sort
```

Then read the frontmatter of every rule at once, because the frontmatter is what decides the destination:

```bash
# prints "file: <frontmatter block>" for each rule
for f in .cursor/rules/*.mdc; do
  echo "== $f"
  awk '/^---$/{n++; next} n==1' "$f"
done
```

**Verify:** you have a list where every `.mdc` file shows either `alwaysApply: true`, a `globs:` line, a `description:` line, or nothing at all. Files showing nothing are manual `@`-mention rules.

### 2. Sort every rule against the frontmatter table

This is the decision that makes the rest mechanical. A rule's frontmatter already encodes its activation mode, and the activation mode maps cleanly onto a destination:

| Frontmatter | Cursor calls it | Destination |
| --- | --- | --- |
| `alwaysApply: true` | Always Apply | Stays a rule, or folds into `AGENTS.md` |
| `globs: "..."` set | Apply to Specific Files | Stays a rule |
| `description:` only | Apply Intelligently | Becomes a skill |
| No frontmatter | Apply Manually | Becomes a skill with `disable-model-invocation: true` |

Two overrides on top of that table, both based on content rather than frontmatter:

- If an always-apply rule is longer than roughly 40 lines and reads as a procedure ("first do this, then run that"), it is a skill wearing a rule's frontmatter. Move it and accept that the agent now has to choose to load it.
- If a rule describes a role rather than a convention, it is a subagent. "You are a security reviewer, check for X" is a role. "Use tabs, not spaces" is a convention.

**Verify:** every file in your inventory has exactly one destination written next to it.

### 3. Retire the legacy `.cursorrules` file

Do this before running the migration skill, because `/migrate-to-skills` works on `.cursor/rules/` and commands, not on the legacy single file. You have two sensible targets.

If the content is portable repo guidance that other agents should also read, `AGENTS.md` at the repo root is the better home. Nested `AGENTS.md` files in subdirectories now apply automatically when the agent works in that directory or below, and more specific files take precedence, so a monorepo can split what used to be one file:

```
repo/
  AGENTS.md                 # house style, build commands
  apps/web/AGENTS.md        # React conventions
  services/api/AGENTS.md    # API conventions
```

If the content is genuinely Cursor-specific and you want per-rule activation, split it into `.cursor/rules/*.mdc` files instead, one concern per file:

```md
<!-- .cursor/rules/typescript-style.mdc -->
---
description: "TypeScript conventions for this repo"
globs: "src/**/*.{ts,tsx}"
alwaysApply: false
---

- Strict mode is on. No `any`, use `unknown` and narrow.
- Prefer `type` over `interface` unless declaration merging is needed.
```

Then delete `.cursorrules`.

**Verify:** open a chat, ask "what rules are active right now", and confirm the agent lists the new files and not the deleted one. Cross-check against the Customize panel, which groups everything by activation mode.

### 4. Run `/migrate-to-skills` and read the diff

In a Cursor chat:

```
/migrate-to-skills
```

It converts dynamic rules (`alwaysApply: false` or undefined, and no `globs`) into standard skills, and converts both user-level and workspace-level slash commands into skills with `disable-model-invocation: true` so their explicit-invocation behaviour survives. It leaves always-apply rules, glob-scoped rules, and user rules alone.

The output for each converted rule is a directory:

```
.cursor/skills/api-error-handling/
  SKILL.md
```

with frontmatter that looks like this:

```md
---
name: api-error-handling
description: How this service maps domain errors to HTTP responses. Use when adding or changing an API endpoint.
---

# API error handling

Use when adding an endpoint under `services/api/` or changing an error response shape.

- Domain errors derive from `AppError` and carry a `code`.
- The middleware in `src/middleware/errors.ts` maps `code` to status.
- Never return a raw exception message to the client.
```

**Verify:** `git diff --stat` should show new directories under `.cursor/skills/` and deletions under `.cursor/rules/`. Read every generated `description` line. That single line is the entire basis on which the agent decides whether to load the skill, and a description copied verbatim from an old rule title is usually too vague. "React conventions" is a bad description; "React component conventions for this repo. Use when creating or refactoring a component under `apps/web/`" is a good one.

### 5. Hand-convert what the skill deliberately skipped

The migration is conservative by design, so the interesting cases are the ones it refused. Take an always-apply rule that you classified as a procedure in step 2 and convert it manually, including the parts a rule could never hold:

```
.cursor/skills/release-checklist/
  SKILL.md
  scripts/
    verify-changelog.sh
  references/
    versioning-policy.md
```

```md
---
name: release-checklist
description: Cut a release for this repo. Use when the user asks to release, tag, or publish a version.
disable-model-invocation: true
---

# Release checklist

- Run `scripts/verify-changelog.sh` first. It fails if the unreleased section is empty.
- Version rules live in `references/versioning-policy.md`. Read it before choosing the bump.
- Tag as `v<major>.<minor>.<patch>` and push the tag, not the branch.
```

`disable-model-invocation: true` is the right call for anything destructive: the skill exists, the agent can see it, but it only runs when you type `/release-checklist`. `references/versioning-policy.md` is not loaded until the agent reaches the versioning step, which is the progressive-disclosure behaviour you cannot get from a rule.

If instead you want the skill to auto-attach based on files rather than on the agent's judgement, use `paths` rather than moving it back to a rule:

```md
---
name: migration-conventions
description: Database migration conventions for this repo.
paths: "db/migrations/**"
---
```

**Verify:** type `/` in chat and confirm each new skill appears by name. Then open a file that matches a `paths` glob and confirm the scoped skill attaches.

### 6. Promote role-shaped rules into subagents

Anything you flagged as a role in step 2 becomes a markdown file in `.cursor/agents/`. The frontmatter is different from a skill's:

```md
<!-- .cursor/agents/security-reviewer.md -->
---
name: security-reviewer
description: Reviews a diff for injection, authz, and secret-handling problems. Delegate before opening a PR.
model: claude-opus-5[effort=high,context=300k]
readonly: true
is_background: false
---

You review diffs for security problems only. Report findings as a list with
file, line, and severity. Do not fix anything. If the diff is clean, say so
in one line.
```

`model` defaults to `inherit`; you can pin a specific ID such as `composer-2`, and model IDs accept bracketed parameters. `readonly: true` is the flag that makes a reviewer safe to delegate to freely, since it cannot write. `is_background: true` returns immediately and lets the subagent work without blocking the parent, which is what you want for a long verification pass and not what you want for something whose answer you need next.

Invoke with `/security-reviewer check the auth changes`, or just describe the task and let the agent delegate based on the `description`. Since Cursor 2.5 a subagent can launch child subagents, so a reviewer can hand off to a test-writer without coming back to the main thread. The tradeoffs against the equivalent Claude Code feature are in [Cursor subagents vs Claude Code subagents](/2026/07/cursor-subagents-vs-claude-code-subagents/), and the wider "which abstraction do I even want" question is worked through in [skills vs subagents vs MCP servers](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/).

**Verify:** run `/security-reviewer` on a deliberately bad diff and confirm it reports rather than edits.

### 7. Bundle the result as a plugin

Once the split is done you have four kinds of artefact scattered across `.cursor/`. A plugin makes them one installable unit. Add `.cursor-plugin/plugin.json`:

```json
{
  "name": "acme-repo-conventions",
  "version": "1.0.0",
  "description": "Rules, skills, and review subagents for the ACME monorepo",
  "rules": "rules/",
  "skills": "skills/",
  "agents": "agents/",
  "commands": "commands/",
  "hooks": "hooks/hooks.json",
  "mcpServers": "mcp.json"
}
```

Only `name` is required, and every component path is optional because Cursor auto-discovers the conventional folders. The manifest also accepts `author`, `homepage`, `repository`, `license`, `keywords`, `logo`, and `variables` (a JSON Schema declaring user-configurable variable names, which is how you avoid hardcoding a connection string into a shared bundle). Note the field is `agents`, not `subagents`.

If your plugin also ships MCP servers, the config shape is the same one you already use, and the team-distribution side of that is covered in [distributing a team MCP config across cloud agents and the IDE](/2026/07/distribute-team-mcp-config-across-cursor-cloud-agents-and-ide/).

**Verify:** install the plugin from the Customize page on a second machine or a clean clone, and confirm skills, subagents, and rules all appear.

## The smoke test after you finish

- Open a chat in a clean session and ask what rules and skills are loaded. Compare against your step-1 inventory. Nothing should be missing.
- Trigger one skill by slash command, one by natural-language description, and one by `paths` glob.
- Confirm no skill you marked `disable-model-invocation: true` fires on its own.
- Delegate to one subagent and confirm the main thread's context did not swallow its intermediate reasoning.
- Check the Customize page. Everything should be grouped under the mode you intended, and anything sitting in "Agent Decides" that you meant to be always-on is a misclassification.

## Rolling back

This migration is fully reversible because it is file moves. Rules, skills, and subagents are all plain files in the repo, so `git revert` on the migration commit restores the previous behaviour exactly. There is one asymmetry worth knowing: a rule converted to a skill loses its guaranteed inclusion, so if the agent starts missing a convention after the migration, the fix is to move that one file back to `.cursor/rules/` with `alwaysApply: true` rather than to revert the whole thing.

## What bites people

- **Assuming rules are deprecated and deleting the folder.** They are not. Always-apply and glob-scoped rules are still the correct mechanism for short, unconditional conventions, and `/migrate-to-skills` skipping them is a statement of intent, not an oversight.
- **Skipping the description rewrite.** A skill that never loads is worse than a rule that always loads, and a vague `description` is the single cause. The description is matched against the task, so it should name both what the skill does and when to use it.
- **Converting a destructive procedure without `disable-model-invocation`.** A "deploy to staging" skill with an inviting description is a skill the agent will eventually decide is relevant on its own.
- **Duplicating guidance across `AGENTS.md` and an always-apply rule.** Both load unconditionally, so you now pay twice for the same sentence, and when they drift the agent gets contradictory instructions with `AGENTS.md` and project rules both in context.
- **Forgetting user-level state.** User rules set in Customize are not on disk and are not migrated. If a teammate's "helpful" global rule is what actually made your setup work, moving the repo to a plugin will not carry it, and the plugin will look broken on a clean machine.
- **Mixing `.agents/skills/` and `.cursor/skills/` in one repo.** Both load, so you get two copies of a half-renamed skill and no error telling you why.

## Related

- [Cursor 3.9 Bundles Your Agent Setup Into Portable Plugins](/2026/06/cursor-3-9-plugins-bundle-skills-rules-mcps-hooks/) for the plugin manifest in full.
- [Cursor Subagents vs Claude Code Subagents for Multi-Agent Workflows](/2026/07/cursor-subagents-vs-claude-code-subagents/) before you decide how many subagents to define.
- [Claude Code Skills vs Subagents vs MCP Servers: When to Build Each in 2026](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/) for the same sorting problem on the Anthropic side.
- [How to Distribute a Team MCP Server Config Across Cursor Cloud Agents and the IDE](/2026/07/distribute-team-mcp-config-across-cursor-cloud-agents-and-ide/) if your plugin carries MCP servers.
- [How to Build a Cursor Automation with the /automate Skill and GitHub Triggers](/2026/07/build-a-cursor-automation-with-automate-skill-and-github-triggers/) for what built-in skills can do once yours are in place.

## Sources

- [Cursor docs: Rules](https://cursor.com/docs/context/rules) for the four activation modes, the `description` / `globs` / `alwaysApply` frontmatter, nested `AGENTS.md`, and the Team, Project, User precedence order.
- [Cursor docs: Agent Skills](https://cursor.com/docs/skills) for the `SKILL.md` frontmatter table, the `scripts/` / `references/` / `assets/` layout, the four load locations, and the `/migrate-to-skills` scope.
- [Cursor docs: Subagents](https://cursor.com/docs/agent/subagents) for `.cursor/agents/`, the `model` / `readonly` / `is_background` fields, and child-subagent nesting since 2.5.
- [Cursor docs: Plugins reference](https://cursor.com/docs/reference/plugins) for the `plugin.json` field list including `agents`, `skills`, `rules`, `commands`, `hooks`, `mcpServers`, and `variables`.
- [Cursor changelog](https://cursor.com/changelog) for the 3.9 plugin release on June 22, 2026 and 3.11 on July 10, 2026.
