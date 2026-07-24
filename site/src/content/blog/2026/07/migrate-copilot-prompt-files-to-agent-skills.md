---
title: "Migrate Copilot Prompt Files to Agent Skills: the Full Checklist"
description: "How to convert .github/prompts/*.prompt.md into .github/skills/<name>/SKILL.md so GitHub Copilot loads them automatically. What breaks, what maps 1:1, and how to verify each skill fires."
pubDate: 2026-07-24
updatedDate: 2026-07-24
template: migration
tags:
  - "migration"
  - "github-copilot"
  - "agent-skills"
  - "prompt-files"
  - "ai-agents"
---

If your repo has a `.github/prompts/` folder full of `.prompt.md` files that everyone forgets to run, this is the migration that fixes it. Moving from Copilot prompt files to Agent Skills usually takes an afternoon for a handful of prompts, and the payoff is that Copilot starts invoking the right instructions on its own instead of waiting for someone to type `/review-migration`. The catch: it is not a rename. Prompt files are manually invoked, single-file, and IDE-only; Agent Skills are model-invoked folders that also run on the Copilot cloud agent and CLI. A few of your prompts should not become skills at all. This post is the checklist I run when converting a real repo, pinned to GitHub Copilot in VS Code 1.99+, Visual Studio 2026 18.5.0, and the GitHub CLI `gh` 2.90.0+, against the [Agent Skills specification](https://agentskills.io/specification) as of Q2 2026.

## Why move prompt files to skills at all

Prompt files (`.prompt.md`) were the first reusable-instruction format Copilot shipped, and they are still fine for what they do. But they have three hard limits that skills remove:

- **Prompt files only fire when a human types the slash command.** On a tired Friday nobody types `/review-migration`, so the rule that "every migration needs a non-empty `Down()`" quietly does not get enforced. Skills are auto-discovered: Copilot matches the task against each skill's `description` and loads the relevant one without being asked.
- **Prompt files are IDE-only.** Per the [VS Code prompt files docs](https://code.visualstudio.com/docs/copilot/customization/prompt-files), they run in VS Code, Visual Studio, and JetBrains. They do nothing on the [Copilot cloud agent](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills) or in the Copilot CLI. A skill in `.github/skills/` is read by every Copilot surface, plus Claude Code, Cursor, and Codex CLI, because they all implement the same open spec.
- **A prompt file is one file.** A skill is a folder that can bundle `references/`, `examples/`, and `scripts/` that load only when the skill body points at them, so the guidance can be deep without taxing every prompt.

If you are still deciding whether a given behavior even belongs in a skill versus a subagent versus an MCP server, [Claude Code skills vs subagents vs MCP servers](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/) draws the same lines that apply here.

## What actually changes

This is a migration, not a find-and-replace, because the two formats have different invocation models. Here is the breaking-change table I hand to teams before they start.

| Area | Prompt file (`.prompt.md`) | Agent Skill (`SKILL.md`) | Severity |
| --- | --- | --- | --- |
| Invocation | Manual `/name` slash command | Model-invoked via `description` match (or `/skills` if `user-invocable`) | high |
| Location | `.github/prompts/name.prompt.md` (one file) | `.github/skills/name/SKILL.md` (folder) | high |
| Body loading | Whole body injected every time you run it | `name` + `description` at startup, body only on activation | medium |
| `model` field | Pins the model per prompt | No per-skill model pin; the session model decides | medium |
| `agent` / `mode` field | `ask`, `agent`, `plan`, or custom agent | No equivalent; skills compose with agents, not vice versa | medium |
| `tools` field | Allowlist of tool names for that run | `allowed-tools` pre-approves narrow command patterns | medium |
| Variables | `${input:name}`, `${input:name:placeholder}`, `${selection}` | Not supported; skills describe intent, they do not template input | high |
| Surfaces | VS Code, Visual Studio, JetBrains | VS Code, VS 2026, Copilot CLI, cloud agent, plus other spec clients | low (gain) |

The two rows that trip people up are **variables** and the **`model` field**. If a prompt file leans on `${input:...}` or `${selection}` to slot in the code the user highlighted, there is no direct skill equivalent, because a skill is guidance the agent reads, not a template the user fills. And if a prompt pins `model: Claude Opus 4.7` because the task genuinely needs the stronger model, a skill cannot carry that; you set the model at the session level instead.

## Which prompts should not become skills

Before converting anything, sort your prompt files into three buckets. Only the first is a clean migration.

1. **Convention and review prompts.** "Review this migration," "check this PR against our rules," "scaffold a new endpoint the way we do it." These are the whole point of skills. Their instructions apply *when a matching task shows up*, which is exactly what description-based routing is for. Convert these.
2. **On-demand generators the user triggers deliberately.** "Generate a conventional-commit message from the staged diff," "write release notes for this milestone." These are genuinely user-initiated. You can still make them skills, but set `user-invocable: true` and lean on the `/skills` menu, or leave them as prompt files. There is no rule that says every prompt must migrate.
3. **Prompts that depend on `${selection}` or `${input}`.** A prompt whose entire job is "explain the code I have selected" is a templating tool, not reusable guidance. Skills cannot express that. Keep these as prompt files.

Getting this split right up front saves you from writing skills that never fire, or worse, skills that fire on everything. The [Copilot cloud agent docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills) are explicit that always-true, project-wide identity belongs in custom instructions, not in a skill at all; if a prompt file is really just "here is our stack," it may belong in `copilot-instructions.md`. See [why Copilot ignores repository custom instructions in VS Code](/2026/05/fix-github-copilot-ignores-repository-custom-instructions-in-vs-code/) for the layer below skills.

## Pre-flight checklist

Do these before touching a file:

- **Update tooling.** VS Code with GitHub Copilot 1.99+ (or Visual Studio 2026 18.5.0) for local skill discovery, and `gh` 2.90.0+ if you want `gh skills` to install and manage them. Confirm with `gh --version`.
- **Inventory your prompts.** `ls .github/prompts/*.prompt.md`. Tag each one with a bucket number from the section above.
- **Back up the branch.** This is reversible (see the rollback section), but do the migration on a feature branch and let it go through PR review like any code change, because a skill in `.github/skills/` ships in every clone.
- **Grab the validator.** The reference validator lives in [agentskills/agentskills](https://github.com/agentskills/agentskills/tree/main/skills-ref) and runs with `npx skills-ref validate`. Have it ready before you write the first `SKILL.md`.

## Migration steps

Here is the conversion, one bucket-1 prompt at a time. The example is a real prompt file that reviews EF Core migrations.

**1. Create the skill folder.** Every skill is a folder whose name matches the `name` frontmatter field: lowercase, hyphens only, no leading or trailing hyphen, no consecutive hyphens, max 64 characters.

```bash
# Agent Skills spec (agentskills.io), Q2 2026
mkdir -p .github/skills/efcore-migration-review/references
```

Verify: `test -d .github/skills/efcore-migration-review && echo ok`.

**2. Rewrite the frontmatter.** The prompt file's frontmatter does not carry over field-for-field. Start from this prompt file:

```markdown
---
description: 'Review an EF Core migration for our data-safety rules'
agent: 'agent'
model: 'Claude Sonnet 4.6'
tools: ['codebase', 'search']
---
Review the migration in ${selection} against our rules: no column drop without
a backfill, reversible Down(), and flag AlterColumn on large tables.
```

The migrated `SKILL.md` frontmatter drops `agent` and `model`, replaces `tools` with `allowed-tools`, and, critically, moves the *routing intent* into `description`:

```markdown
---
name: efcore-migration-review
description: Reviews EF Core migration files in this repo. Use whenever the user asks to add, squash, or review a migration under src/Infrastructure/Migrations, or whenever a generated migration touches AlterColumn, DropColumn, or RenameColumn. Do not use for general EF Core query questions.
license: Proprietary
metadata:
  owner: platform-team
  version: "1.0"
allowed-tools: Read Bash(dotnet ef:*) Bash(git:*)
---
```

Verify: the `name` value equals the folder name exactly, and `description` is under the 1024-character ceiling. A near-miss on the folder name is the single most common reason a skill silently never loads.

**3. Convert the body, and delete the variables.** The prompt body referenced `${selection}`. A skill has no selection to interpolate, so rephrase the instruction as guidance the agent applies to whatever migration is in play:

```markdown
# EF Core migration review

When the user asks you to add, squash, or review a migration under
`src/Infrastructure/Migrations/`, walk this checklist before producing code:

1. Reject any column drop without a retry-safe backfill in the same `Up()`.
2. Flag `AlterColumn` nullability changes on tables in
   `references/large-table-playbook.md` and require a batched-update plan.
3. Require `Down()` to be a true inverse, not an empty stub.
```

Verify: read the body back and confirm there are zero `${...}` tokens left. Any survivor is a bug, because Copilot will treat it as literal text.

**4. Move bundled context into `references/`.** If the prompt file inlined a long "large table playbook," pull it into `references/large-table-playbook.md` and point at it from the body with a relative path. Files under `references/` load only when the body tells the agent to read them, so the skill body stays small and cheap. Keep references one level deep; multi-hop "see X which references Y" chains lose the model partway through.

Verify: `npx skills-ref validate .github/skills/efcore-migration-review` exits clean. It catches a mismatched name, an over-length description, and the naming-rule violations.

**5. Delete the prompt file.** Once the skill validates, remove the source prompt so you are not maintaining both. `git rm .github/prompts/efcore-migration-review.prompt.md`.

Verify: `git status` shows the prompt deleted and the skill folder added, and a `grep -r efcore-migration-review .github/prompts` returns nothing.

**6. Repeat per bucket-1 prompt, then commit.** Convert each convention prompt into its own single-concern skill rather than one mega-skill. Narrow skills route better and stay quiet on unrelated tasks. The routing patterns are the same ones covered in [how to give a Copilot Agent Skill access to your repo conventions](/2026/05/how-to-give-a-copilot-agent-skill-access-to-your-repo-conventions/).

## Verification after the migration

Run this smoke test before you merge:

- **It validates.** `npx skills-ref validate .github/skills/<name>` for every new skill. Zero errors.
- **Copilot sees it.** In VS Code Copilot Chat, type `/skills` to open the Configure Skills menu. Each skill appears with its description. If one is missing, it is almost always in the wrong folder: it must be `.github/skills/`, not `.github/copilot/skills/` or `.github/prompts/`.
- **It fires when it should.** Send a prompt the skill should match ("review the migration I just added under `src/Infrastructure/Migrations/`") and confirm the skill activates. Then send one it should not ("explain the EF Core change tracker") and confirm it stays quiet. If it fires on the second, the `description` is too broad; tighten it with a "Do not use for X" clause.
- **The cloud agent picks it up.** Assign the cloud agent a task that should trigger the skill and confirm the same behavior you get locally. This is the surface prompt files never reached, so it is the one worth checking.

Test activation with the model your team actually runs. A description that fires reliably on `claude-sonnet-4-6` may need to be more explicit on a smaller local model, since smaller models are noticeably worse at skill selection. The same discipline that makes a `CLAUDE.md` change behavior applies to a skill description: see [how to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/).

## Rollback plan

This migration is fully reversible, which is a nice change from most. Because you did it on a branch, reverting is `git revert` on the merge commit, or just delete `.github/skills/<name>/` and restore the `.prompt.md` from history:

```bash
git checkout HEAD~1 -- .github/prompts/efcore-migration-review.prompt.md
git rm -r .github/skills/efcore-migration-review
```

There is no server-side state to unwind and no cache to purge beyond restarting the chat session. That said, do not run both formats for the same concern in parallel for long; a prompt file and a skill enforcing the same rule will step on each other, and you lose the clarity of a single source.

## Gotchas we hit

Real issues from converting a mid-size repo:

- **Skills do not refresh mid-session.** Editing a `SKILL.md` and asking Copilot to re-read it usually does nothing. Restart the chat, or reload the VS Code window.
- **Personal skills shadow workspace skills with the same `name`.** A `pr-review` in `~/.copilot/skills/` silently wins over the team's `.github/skills/pr-review`. Rename one during the migration or people will debug ghosts.
- **`allowed-tools` is opt-in trust, not a convenience.** The prompt file's `tools: ['codebase']` was harmless. Pre-approving bare `Bash` in a skill is a prompt-injection footgun the [VS Code Agent Skills docs](https://code.visualstudio.com/docs/copilot/customization/agent-skills) call out. Pre-approve narrow patterns like `Bash(dotnet ef:*)`, never the bare tool.
- **A dropped `model` pin can regress quality.** If a prompt worked only because it pinned Opus, the migrated skill runs on whatever the session uses. Decide the session model deliberately for those workflows rather than assuming the default is good enough.
- **A skill is not a substitute for a CI check.** If "every migration needs a non-empty `Down()`" truly matters, write the failing build check too. The skill is the polite path that helps the author get it right; the CI gate is the rude path that refuses to merge when they do not. Repos that care about the rule need both.

The honest summary: the mechanical conversion is quick, but the value is entirely in the `description`. A migrated skill with a lazy one-line description is strictly worse than the prompt file you deleted, because at least the prompt file fired when you asked it to. Spend the time you save on the mechanics writing descriptions that route.

## Related reading

- [How to give a Copilot Agent Skill access to your repo conventions](/2026/05/how-to-give-a-copilot-agent-skill-access-to-your-repo-conventions/)
- [Agent Skills land in Visual Studio 2026 18.5](/2026/04/visual-studio-2026-copilot-agent-skills/)
- [Claude Code skills vs subagents vs MCP servers: when to build each](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/)
- [Fix: GitHub Copilot ignores repository custom instructions in VS Code](/2026/05/fix-github-copilot-ignores-repository-custom-instructions-in-vs-code/)
- [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/)

## Sources

- [Use prompt files in VS Code](https://code.visualstudio.com/docs/copilot/customization/prompt-files)
- [Your first prompt file, GitHub Docs](https://docs.github.com/en/copilot/tutorials/customization-library/prompt-files/your-first-prompt-file)
- [Use Agent Skills in VS Code](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- [Adding agent skills for GitHub Copilot, GitHub Docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills)
- [Agent Skills specification, agentskills.io](https://agentskills.io/specification)
- [skills-ref validator, agentskills/agentskills](https://github.com/agentskills/agentskills/tree/main/skills-ref)
