---
title: "How to Give a Copilot Agent Skill Access to Your Repo Conventions"
description: "Turn the unwritten rules in your repo into a SKILL.md that GitHub Copilot loads on demand. Frontmatter, descriptions that route, file references, and how to verify it actually fires."
pubDate: 2026-05-07
tags:
  - "github-copilot"
  - "agent-skills"
  - "ai-agents"
  - "claude-code"
  - "agentskills"
---

If you have ever pasted "we always wrap database calls in a `using var tx = ...` block, do not put `IDbConnection` in DI, and migrations live under `src/Infrastructure/Migrations` with one class per change" into Copilot Chat for the fourth time this week, you have already discovered the problem that Agent Skills exist to solve. As of the [GitHub Copilot Agent Skills changelog from December 2025](https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/), and the Visual Studio 2026 18.5 rollout in April, Copilot in VS Code, the Copilot CLI, and the Copilot cloud agent will all auto-discover a `SKILL.md` file from your repo and inject its instructions into context only when they are relevant. This post walks through how to capture a real repo convention as a skill, write a description that routes correctly, link out to convention docs without burning context, and verify the thing actually fires.

The format is governed by the open [Agent Skills specification](https://agentskills.io/specification) and read identically by Copilot, [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Cursor, and Codex CLI. Pin the moving parts: Visual Studio 2026 18.5.0, GitHub Copilot in VS Code 1.99+, Claude Code 2.x, and Agent Skills spec at `https://agentskills.io/specification` (last revised 2026 Q1).

## Why repo conventions belong in a skill, not in a chat prompt

A repo convention is a rule that is true some of the time. "Migrations must include a non-empty `Down()`" is true when you are touching `src/Infrastructure/Migrations/`. It is noise when you are debugging a Razor page. The whole point of a skill is that the agent only loads the rule when the task description sounds relevant.

Three places you could put the rule today: a chat prompt (lives in your head, gets forgotten on a tired Friday); an `AGENTS.md` or `CLAUDE.md` (always loaded, useful for project-wide identity but blows up if you stuff every domain rule in there); or a `SKILL.md` in `.github/skills/efcore-migration-review/` where only the `name` and `description` (~100 tokens) load at startup, and the rest is pulled in *only* when Copilot judges the request relevant.

The official guidance from the [Copilot cloud agent docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills) is explicit: use repository-wide custom instructions for things that are always true, and use skills for task-specific guidance. If you are tempted to put a 400-line "conventions" section into a single instructions file, that is the moment to split it into skills.

For the always-true layer, the rules you would have written into a `CLAUDE.md` still apply: see [how to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) for the patterns that survive contact with the model.

## Where Copilot looks for skills

Both VS Code and the cloud agent scan three workspace locations and three personal locations. The duplication exists because the same folders are read by every agent that implements the spec:

- Workspace: `.github/skills/`, `.claude/skills/`, `.agents/skills/`
- Personal: `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/`

For a convention that belongs to the team, the right answer is `.github/skills/`. It is the GitHub-native location, it travels with the repo, and it goes through pull request review the same way any code change does. The Visual Studio side of this story, including the additional `chat.agentSkillsLocations` setting, is covered in [Agent Skills land in Visual Studio 2026 18.5](/2026/04/visual-studio-2026-copilot-agent-skills/).

A skill is a *folder*, not a single file. The minimal layout the spec accepts is:

```
.github/skills/
└── efcore-migration-review/
    ├── SKILL.md
    ├── references/
    │   └── large-table-playbook.md
    └── examples/
        └── add-index-migration.md
```

The folder name `efcore-migration-review` must match the `name` field in the frontmatter. Lowercase, hyphens only, no leading or trailing hyphen, no consecutive hyphens, max 64 characters. Names like `EFCore-Migration-Review` or `efcore--migration` are rejected at validation time.

## Anatomy of a SKILL.md that captures a real convention

Here is a `SKILL.md` for a real repo rule: every EF Core migration has to backfill data before changing nullability, must reference the large-table playbook on tables over 10 million rows, and must ship a non-empty `Down()`.

```markdown
---
name: efcore-migration-review
description: Reviews EF Core migration files in this repo. Use whenever the user asks to add, squash, or review a migration under src/Infrastructure/Migrations, or whenever a generated migration touches AlterColumn, DropColumn, or RenameColumn. Enforces the team's data-backfill, large-table, and reversible-Down rules.
license: Proprietary
metadata:
  owner: platform-team
  version: "1.2"
allowed-tools: Read Bash(dotnet ef:*) Bash(git:*)
---

# EF Core migration review

When the user asks you to add, squash, or review an EF Core migration under
`src/Infrastructure/Migrations/`, walk through the checklist below before
producing any code or approving a diff.

## Checklist

1. Reject any migration that drops a column without a corresponding data
   backfill step in the same migration. The backfill belongs in `Up()`,
   guarded by an `Sql(...)` block that is safe to retry.
2. Flag any `AlterColumn` that changes nullability on a table listed in
   `references/large-table-playbook.md`. Point the user at the playbook and
   require an explicit batched-update plan.
3. Require `Down()` to be a true inverse, not an empty stub. If the change
   is genuinely irreversible, the migration must say so in a comment and
   throw `NotSupportedException("Migration is forward-only: ...")`.
4. New columns on existing tables must be nullable on the first migration,
   then made non-nullable in a follow-up after the backfill ships.

## Worked examples

- `examples/add-index-migration.md` shows the canonical shape for adding
  a new index without locking the table.
- `examples/non-nullable-column.md` shows the two-step pattern.

If the user pushes back on any of these, surface the specific risk
(downtime, lost rows, irreversible drift) rather than restating the rule.
```

A few things in here are doing real work. The frontmatter `name` matches the folder name exactly, which the Visual Studio Copilot loader and the [skills-ref validator](https://github.com/agentskills/agentskills/tree/main/skills-ref) both enforce. The `description` is over 350 characters, intentionally; it is the only thing Copilot sees during discovery and it has 1024 characters to use, so long and keyword-rich beats a 30-character tagline. `allowed-tools` pre-approves a narrow set of commands, which is a real productivity win for `dotnet ef`, but pre-approving `Bash` outright is a footgun the [VS Code docs](https://code.visualstudio.com/docs/copilot/customization/agent-skills) call out: broad shell approvals let prompt injection or attacker-controlled skills run arbitrary commands. Finally, the body links to `references/` and `examples/` with relative paths; those files are not loaded at startup or even on activation, only when the body explicitly says "see X."

## Writing the description so the skill actually fires

This is the part most teams get wrong on the first try. A skill that never gets selected is functionally invisible.

Copilot's [progressive disclosure model](https://code.visualstudio.com/docs/copilot/customization/agent-skills) loads only the `name` and the `description` from every installed skill at startup. When you send a prompt, the model decides which skill (if any) to activate by matching the prompt against those descriptions. It is closer to a retrieval problem than to a tagline-writing exercise.

Three rules I have landed on after burning through a few iterations:

1. **Lead with the activation triggers, not the abstract capability.** "Use whenever the user asks to add, squash, or review a migration under `src/Infrastructure/Migrations`" beats "EF Core migration helper." Copilot is matching the prompt against your description, so phrase the description like the prompt that should fire it.
2. **Use the words the user is actually going to type.** If your team says "rebase a migration" instead of "squash a migration," put both in. The model is doing semantic matching, not regex, but a near-miss costs you a missed activation.
3. **Be honest about when *not* to use it.** The agentskills spec recommends including both "what it does and when to use it." The corollary is that if the description sounds vaguely useful for everything, the model will fire it for everything, and the rules will leak into unrelated tasks.

A bad description (skill never fires reliably):

```yaml
description: Helps with EF Core migrations.
```

A good description (skill fires when it should, stays quiet when it should not):

```yaml
description: Reviews EF Core migration files in this repo. Use whenever the user asks to add, squash, or review a migration under src/Infrastructure/Migrations, or whenever a generated migration touches AlterColumn, DropColumn, or RenameColumn. Enforces the team's data-backfill, large-table, and reversible-Down rules. Do not use for general EF Core query questions or for non-migration schema changes.
```

The "do not use for X" line is the cheapest insurance you can buy against a skill that hijacks unrelated conversations.

## Linking to convention docs without burning context

Repo conventions usually already exist somewhere: an `ARCHITECTURE.md`, a `docs/playbooks/` folder, a Notion page that nobody can find. The temptation is to inline all of it into the `SKILL.md`. Resist.

The spec has a 5000-token soft ceiling on the `SKILL.md` body and a recommendation to keep it under 500 lines. The actual budget you have to work with is smaller than that, because the skill body is loaded *every* time the skill activates. A 4000-token skill that fires on every other prompt is a tax on every interaction.

The pattern that works is to keep `SKILL.md` short and decision-shaped, and push detail into `references/`. Files in `references/` are loaded only when the skill body explicitly tells the agent to read them. So if your skill says:

```markdown
For tables listed in `references/large-table-playbook.md`, follow the
batched-update pattern documented in section 3 of that file.
```

Copilot will only pull `large-table-playbook.md` into context when it has decided the playbook is needed for the task at hand. That same playbook can be 2000 lines without ever bloating an unrelated session.

A practical layout for a mid-size convention pack:

```
.github/skills/efcore-migration-review/
├── SKILL.md                         # 80-150 lines, decision-shaped
├── references/
│   ├── large-table-playbook.md      # detailed how-to
│   ├── irreversible-changes.md      # cases for forward-only
│   └── allowed-providers.md         # SQL Server vs PostgreSQL quirks
├── examples/
│   ├── add-index-migration.md
│   ├── non-nullable-column.md
│   └── data-backfill-pattern.md
└── scripts/
    └── check-down-method.sh         # CI-style sanity check
```

Keep references one level deep. The spec explicitly calls out that deeply nested chains are hard for the model to follow, and in practice multi-hop "see X which references Y which references Z" almost always loses the agent partway through.

## A second, smaller example: PR review conventions

Not every convention pack needs five reference files. A common starter skill is the team's PR review checklist:

```markdown
---
name: pr-review-conventions
description: Reviews pull requests against this team's checklist. Use whenever the user asks to review a PR, draft review comments, or check whether a diff is ready to merge. Covers commit-message style, required test coverage, the changelog rule, and the no-direct-main policy. Do not use for design review or security-only audits.
metadata:
  owner: platform-team
---

# PR review conventions

When asked to review a PR or a diff:

1. Confirm the branch is not `main`. If it is, stop and say so.
2. Check commit messages follow Conventional Commits. Anything outside
   `feat|fix|chore|refactor|docs|test|perf|build|ci` is a request-changes.
3. Any new public method under `src/Application/` or `src/Domain/` must
   have a matching test in the parallel folder under `tests/`.
4. If the diff adds a user-visible feature without a `CHANGELOG.md` entry
   under "Unreleased", ask the author to add one.
5. Tone: specific, non-blocking unless it is a real blocker, never sarcastic.
   Use severities `nit`, `question`, `suggestion`, `request-changes`.
```

This pairs naturally with [running Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/). The same `SKILL.md` works for the local Copilot session and for an automated cloud-agent run, because the spec is the same on both ends.

## Verifying the skill actually loads

A skill that does not fire is worse than no skill, because you think the rules are being enforced. Three checks I run after every change.

**1. Validate the file.** The reference validator in the [agentskills/agentskills repo](https://github.com/agentskills/agentskills/tree/main/skills-ref) catches frontmatter mistakes before they hit a session:

```bash
# Agent Skills spec validator, 2026 release
npx skills-ref validate .github/skills/efcore-migration-review
```

It will flag a name that does not match the folder, a description longer than 1024 characters, an invalid `compatibility` string, or any of the naming-rule violations.

**2. Check Copilot can see it.** In VS Code's Copilot Chat, type `/skills` to open the Configure Skills menu. Your skill should appear with its description. If it does not, the most common cause is putting `SKILL.md` in the wrong folder (`.github/copilot/skills/` does not work; it has to be `.github/skills/`).

**3. Probe activation.** Send a prompt the skill *should* fire on, and one it should *not*. For the migration skill, "review the EF Core migration I just generated under `src/Infrastructure/Migrations/`" should activate it; "explain the EF Core change tracker" should not. If the skill fires on the second prompt, the description is too broad. If it fails to fire on the first, the description is too generic or missing the user's vocabulary.

For Copilot specifically, the activation decision is also influenced by the model. If you are using a non-default model via [BYOK in Copilot for VS Code](/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/), test with that model, not with the default. Smaller models are noticeably worse at picking the right skill, and a description that fires reliably on Claude Sonnet 4.6 may need to be more explicit on a smaller local model.

## Gotchas worth knowing before you ship a skill

A short list of things that have bitten me or shown up in issue trackers since Agent Skills shipped.

- **Personal skills override workspace skills with the same `name`.** If you have a `pr-review-conventions` in `~/.copilot/skills/` and the team has one in `.github/skills/`, you will silently use yours. Rename one or the other.
- **Skills do not refresh mid-session.** Editing a `SKILL.md` and asking Copilot to re-read it usually does not work. Restart the chat session, or in VS Code, reload the window.
- **`allowed-tools` is opt-in trust.** The cloud agent docs are explicit: pre-approving `Bash` or `shell` removes the confirmation step and gives any future prompt-injection vector a way to run arbitrary commands. Pre-approve narrow patterns like `Bash(git:*)` or `Bash(dotnet ef:*)`, never the bare tool.
- **The spec is moving.** `allowed-tools`, `context: fork`, and a few other fields are still marked experimental and may change. Pin the spec date you tested against in your repo's contributing docs.
- **Do not bundle secrets.** A skill in `.github/skills/` ships in every clone of the repo. If your "API conventions" skill needs a token to talk to a private endpoint, the token does not belong in the skill. Reference the env var name and let the agent surface a useful error when it is missing.

The biggest meta-gotcha: *a skill is not a substitute for a real test*. If "every migration must have a non-empty `Down()`" really matters, write a CI check that fails the build, then add a skill that helps the human author the migration correctly the first time. The skill is the polite path; the CI check is the rude path. Repos need both.

## Related reading

- [Agent Skills land in Visual Studio 2026 18.5: Copilot auto-discovers SKILL.md from your repo](/2026/04/visual-studio-2026-copilot-agent-skills/)
- [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/)
- [How to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/)
- [GitHub Copilot in VS Code: BYOK with Anthropic, Ollama, and Foundry Local](/2026/04/github-copilot-vs-code-byok-anthropic-ollama-foundry-local/)
- [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)

## Sources

- [GitHub Copilot now supports Agent Skills (changelog, December 2025)](https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/)
- [Agent Skills specification, agentskills.io](https://agentskills.io/specification)
- [About agent skills, GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
- [Adding agent skills for GitHub Copilot, GitHub Docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills)
- [Use Agent Skills in VS Code](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- [skills-ref validator, agentskills/agentskills](https://github.com/agentskills/agentskills/tree/main/skills-ref)
