---
title: "Agent Skills Land in Visual Studio 2026 18.5: Copilot Auto-Discovers SKILL.md From Your Repo"
description: "Visual Studio 2026 18.5.0 lets GitHub Copilot load Agent Skills from .github/skills, .claude/skills, and ~/.copilot/skills. Reusable SKILL.md instruction packs travel with your repo."
pubDate: 2026-04-20
tags:
  - "visual-studio"
  - "github-copilot"
  - "agent-skills"
  - "dotnet"
---

The April 14, 2026 release of Visual Studio 2026 (version 18.5.0) quietly added one of the most useful Copilot features of the year: [Agent Skills](https://learn.microsoft.com/en-us/visualstudio/releases/2026/release-notes). If you have been copy-pasting the same "here is how we review pull requests in this repo" paragraph into Copilot Chat for the last six months, you can stop. Agent Skills are reusable instruction packs that live alongside your code, and Copilot in Visual Studio now discovers them automatically.

## Where Visual Studio looks for skills

A skill is just a folder with a `SKILL.md` file inside it. Visual Studio 2026 18.5 scans six well-known locations, three tied to the workspace and three tied to your user profile:

- Workspace: `.github/skills/`, `.claude/skills/`, `.agents/skills/`
- Personal: `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/`

The duplication is intentional. The [agentskills.io specification](https://agentskills.io/specification) is an open format and the same folders are read by GitHub Copilot CLI, the Copilot cloud agent, and VS Code. Drop a skill into `.github/skills/` and every Copilot surface your team uses sees it, not just the IDE on your box.

## What a SKILL.md actually looks like

The file is Markdown with a YAML frontmatter header. The frontmatter has two required fields, `name` and `description`, plus a few optional ones for how the skill is invoked:

```markdown
---
name: efcore-migration-review
description: Reviews EF Core migration files in this repo. Use whenever the user asks Copilot to add, squash, or review a migration under src/Infrastructure/Migrations.
argument-hint: [migration file path]
user-invocable: true
disable-model-invocation: false
---

# EF Core migration review

When reviewing a migration under `src/Infrastructure/Migrations`:

1. Reject any migration that drops a column without a corresponding data backfill step.
2. Flag `AlterColumn` calls that change nullability on tables with more than 10M rows. Point at `docs/ops/large-table-playbook.md`.
3. Require a matching `Down()` that is a true inverse, not an empty stub.

Reference implementation: see `examples/add-index-migration.md` in this skill folder.
```

The `name` field must be lowercase, hyphen-separated, max 64 characters, and must match the folder name. The `description` field is what Copilot uses to decide whether to load the skill, so it is worth writing like a retrieval query, not like a tagline. The max length is 1024 characters and you should use them.

## Why this changes the default

Up to now the usual pattern was a sprawling `.github/copilot-instructions.md` or a custom agent defined in `.agent.md`. Agent Skills are narrower by design: each skill is a single concern, loaded on demand, and only its body enters the context window when the description matches. For a .NET monorepo with EF Core migrations, MAUI platform code, and ASP.NET Core controllers, you can ship three separate skills instead of one giant instructions file and stop burning tokens on guidance that is irrelevant to the current task.

Skills also compose with Custom Agents. An `.agent.md` file can scope which skills it pulls in, which is how teams end up with a "backend-reviewer" agent that only sees EF Core and ASP.NET Core skills while a "mobile-reviewer" agent sees MAUI and Flutter ones.

Microsoft notes the browsing and creation UI is still coming in a later 18.x update, so for now it is text files in folders. That is fine. Text files in folders are what version control is for.
