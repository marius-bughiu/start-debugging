---
title: "How to Write a CLAUDE.md That Actually Changes Model Behaviour"
description: "A 2026 playbook for CLAUDE.md files that Claude Code actually follows: the 200-line target, when to use path-scoped rules in .claude/rules/, @import hierarchy and 5-hop max depth, the user-message vs system-prompt gap, the line between CLAUDE.md and auto memory, and when to give up and write a hook instead. Anchored to Claude Code 2.1.x and verified against the official memory docs."
pubDate: 2026-04-28
tags:
  - "claude-code"
  - "ai-agents"
  - "agent-skills"
  - "developer-workflow"
---

A CLAUDE.md that "doesn't work" almost always means one of three things: it is too long and important rules are getting drowned, it is too vague to verify, or the instruction needs to be a hook because CLAUDE.md is advisory by design. As of **Claude Code 2.1.x** the file is loaded into context as a user message after the system prompt, not into the system prompt itself, which is a non-obvious detail that explains a lot of the "Claude is ignoring my rules" frustration on `r/ClaudeAI` and `r/cursor` this month. Model behaviour does change in response to a good CLAUDE.md, but only if you treat it the way Anthropic's own [memory documentation](https://code.claude.com/docs/en/memory) describes it: as context, not configuration.

The short version: target under 200 lines, write specific verifiable instructions, push topic-specific rules into `.claude/rules/` with `paths:` frontmatter, push reusable workflows into skills, and use hooks for anything that absolutely must run. Use `@imports` to organise but understand they do not save tokens. And if you correct the same mistake twice, do not bury it deeper in CLAUDE.md, it is already losing the fight against your other rules.

This post assumes Claude Code 2.1.59+ (the version that ships auto memory) and `claude-sonnet-4-6` or `claude-opus-4-7` as the underlying model. The patterns work the same on both, but Sonnet is more sensitive to bloated CLAUDE.md files because adherence drops faster as context fills.

## Why "I told it to" is not enough

The single most useful sentence in the official [memory docs](https://code.claude.com/docs/en/memory#claude-isn-t-following-my-claude-md) is this one: "CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself. Claude reads it and tries to follow it, but there's no guarantee of strict compliance." This explains every "I literally wrote `NEVER use console.log` and it still did" thread. The model sees your CLAUDE.md the same way it sees the rest of your prompt: as instructions to weigh, not as a non-overridable directive.

Three concrete consequences flow from this:

1. **More text reduces adherence.** The longer the file, the more diluted any individual rule becomes. The official docs recommend "target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence."
2. **Vague rules get rounded off.** "Format code properly" is interpreted by the model the same way you would interpret it: do something reasonable. "Use 2-space indentation, no trailing semicolons except after imports" is a verifiable instruction the model can actually follow.
3. **Conflicting rules resolve arbitrarily.** If your root CLAUDE.md says "always write tests" and a nested one in a subfolder says "skip tests for prototypes," the model picks one without telling you which.

If you genuinely need a non-overridable directive, you have two options. The first is `--append-system-prompt`, which puts text into the system prompt itself. From the [CLI reference](https://code.claude.com/docs/en/cli-reference#system-prompt-flags), it has to be passed every invocation, which is fine for scripts and CI but unworkable for interactive use. The second, and almost always better option, is a hook, which we will get to.

## What belongs in CLAUDE.md, what does not

Anthropic's own [best-practices guide](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md) gives a tight include/exclude table that I have copied into every project I run. Rephrased and condensed:

**Include**: bash commands Claude cannot guess from your `package.json` or `Cargo.toml`, code style rules that differ from language defaults, the test runner you actually want it to use, branch and PR conventions, architectural decisions that are not obvious from reading the code, and gotchas like "the postgres test container needs `POSTGRES_HOST_AUTH_METHOD=trust` or migrations hang."

**Exclude**: anything Claude can read off `tsconfig.json`, framework conventions every developer knows, file-by-file descriptions of the codebase, history of how the code got to its current state, and self-evident practices like "write clean code." The best-practices doc is blunt: "Bloated CLAUDE.md files cause Claude to ignore your actual instructions." Every line you add lowers the signal-to-noise ratio for the rest.

A CLAUDE.md that survived this filter for a Next.js + Postgres backend looks like:

```markdown
# Project: invoice-api
# Claude Code 2.1.x, Node 22, Next.js 15

## Build and test
- Use `pnpm`, never `npm` or `yarn`. The lockfile is committed.
- Run `pnpm test --filter @app/api` for backend tests, NOT the full workspace.
- Migrations: `pnpm db:migrate` only inside the `apps/api` workspace.

## Code style
- Use ESM (`import`/`export`). Default export is forbidden except in
  Next.js page/route files where the framework requires it.
- Zod schemas for every external input. No `any`, no `as unknown as T`.

## Architecture
- Database access goes through `apps/api/src/db/repositories/`.
  Do not call `db.query` from route handlers.
- All money is `bigint` cents. Never `number`, never decimals.

## Workflow
- After a code change, run `pnpm typecheck` and `pnpm test --filter @app/api`.
- Commit messages: imperative, no scope prefix, max 72 chars on the title.
```

That is 17 lines and addresses every recurring correction this team had documented in their PR template. Notice what is not there: no "always write clean code," no "be careful with security," no "use TypeScript strict mode" (it is in `tsconfig.json`, the model can see it). Each line answers "would removing this cause a measurable mistake?" with yes.

## The 200-line ceiling and `.claude/rules/`

Once you cross 200 lines, the official memory docs recommend splitting topic-specific instructions into `.claude/rules/` with YAML frontmatter that scopes each file to a glob:

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "src/api/**/*.tsx"
---

# API endpoint conventions

- Every route under `src/api/` exports a `POST`, `GET`, `PUT`, or `DELETE`
  function. Never a default export.
- Validate the body with the matching Zod schema in `src/api/schemas/`
  before doing anything else. If no schema exists, write one first.
- Return errors with `Response.json({ error }, { status })`. Do not throw.
```

A rule with `paths:` only loads into context when Claude reads a file that matches one of the globs. The cost of having ten rule files at 100 lines each is much smaller than one CLAUDE.md at 1000 lines, because nine of them are not in context for any given task. Rules without `paths:` load every session at the same priority as `.claude/CLAUDE.md`, so do not put them there as a habit unless they really do apply to every file.

This is also where "scope creep into CLAUDE.md" goes to die. If a teammate proposes adding twelve lines about an obscure migration tool, the answer is "that goes in `.claude/rules/migrations.md` with `paths: ['db/migrations/**/*.sql']`," not "we will trim it later." We never trim it later.

## Imports, hierarchy, and the 5-hop limit

The `@path/to/file` import syntax is for organisation, not for saving tokens. From the [docs](https://code.claude.com/docs/en/memory#import-additional-files): "Imported files are expanded and loaded into context at launch alongside the CLAUDE.md that references them." If you split a 600-line CLAUDE.md into a 50-line root and an `@docs/conventions.md` of 550 lines, the model still sees 600 lines.

Imports are useful for three specific things:

1. **Re-using the same instructions across two repos** without copy-paste. Symlink or import a shared file from `~/shared/team-conventions.md`.
2. **Per-developer overrides** that should not be committed. `@~/.claude/my-project-instructions.md` lets you keep personal preferences in your home directory while everyone gets the team CLAUDE.md from git.
3. **Bridging to `AGENTS.md`** if your repo already has one for other coding agents. The docs explicitly recommend `@AGENTS.md` followed by Claude-specific overrides:

```markdown
@AGENTS.md

## Claude Code

Use plan mode for changes under `src/billing/`.
```

Imports resolve recursively up to **five hops deep**. Beyond that, the import is silently dropped. If you have a CLAUDE.md that imports a file that imports a file that imports a file four times over, you have built something fragile: flatten it.

The hierarchy itself is additive, not overriding. Project CLAUDE.md, user CLAUDE.md (`~/.claude/CLAUDE.md`), and any CLAUDE.md walking up the directory tree from the working directory are all concatenated. `CLAUDE.local.md` (gitignored) loads after `CLAUDE.md` at the same level, so your personal notes win on conflict. In a monorepo where you do not want sibling teams' CLAUDE.md files in your context, the [`claudeMdExcludes` setting](https://code.claude.com/docs/en/memory#exclude-specific-claude-md-files) takes a list of glob patterns:

```json
{
  "claudeMdExcludes": [
    "**/monorepo/CLAUDE.md",
    "/home/marius/monorepo/other-team/.claude/rules/**"
  ]
}
```

Put that in `.claude/settings.local.json` so the exclusion is yours and not the team's.

## CLAUDE.md is "your requirements," auto memory is "what Claude noticed"

Claude Code 2.1.59 added auto memory: notes Claude writes about itself based on your corrections. It lives in `~/.claude/projects/<project>/memory/MEMORY.md` and is loaded the same way as CLAUDE.md, except only the first 200 lines or 25KB of `MEMORY.md` are pulled in at session start. The rest of the directory is read on demand.

The cleanest way to think about the split:

- **CLAUDE.md** holds rules you want enforced from day one. "Run `pnpm test --filter @app/api`, not the full suite." You wrote it, you committed it, your team sees it.
- **Auto memory** holds patterns Claude noticed. "User prefers `vitest` over `jest` and corrected me when I generated a `jest.config.js`." Claude wrote it, it is per-machine, it is not in git.

Two practical rules that fall out of this. First, do not duplicate auto-memory entries into CLAUDE.md "to be safe." Auto memory is loaded every session too. Second, when auto memory accumulates a pattern that the entire team should know about, promote it: open `MEMORY.md`, copy the entry into CLAUDE.md, and `/memory` will let you delete the original. The promotion is the moment "Claude observed this about me" becomes "we as a team have decided this."

For more on the split, the post on [scheduling Claude Code routines](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) covers what survives an autonomous run with no human in the loop, which is a useful pressure test for whether your CLAUDE.md is actually self-contained.

## Tuning for adherence

Once the file is short and specific, you can squeeze more compliance out of it with three techniques the docs and field reports converge on:

1. **Use emphasis sparingly.** The official guidance is to "tune instructions by adding emphasis (e.g., `IMPORTANT` or `YOU MUST`) to improve adherence." Sparingly is the operative word. If everything is `IMPORTANT`, nothing is. Reserve emphasis for the rule that, if violated, would actually break a build or burn an oncall.
2. **Lead with the verb, then the constraint.** "Run `pnpm typecheck` after every code change in `src/`" is followed more reliably than "Type-checking should be performed regularly." The former is an action; the latter is a vibe.
3. **Co-locate the rule with the failure mode.** "Do not call `db.query` from route handlers; the connection pool is per-request and route handlers leak. Use `repositories/` instead." The failure mode is what makes the rule sticky between sessions.

If you correct the same mistake twice and the rule is already in CLAUDE.md, the right move is not to add another rule. It is to ask why the existing rule is not winning. Usually it is one of: the file is too long, two rules contradict each other, or the instruction is the kind of thing that needs a hook.

## When to give up on CLAUDE.md and write a hook

CLAUDE.md is advisory. Hooks are deterministic. From the [hooks guide](https://code.claude.com/docs/en/hooks-guide), they are "scripts that run automatically at specific points in Claude's workflow" and "guarantee the action happens." If your rule is in the "absolutely must run with zero exceptions" category, it does not belong in CLAUDE.md.

A `PostToolUse` hook that runs Prettier after every file edit is more reliable than a CLAUDE.md line that says "always run Prettier after edits." Same for "block writes to `migrations/`," which becomes a `PreToolUse` hook with a deny pattern. The same pattern is what makes the broader [Visual Studio 2026 agent skills story](/2026/04/visual-studio-2026-copilot-agent-skills/) work in practice: the skill is the soft instruction, the hook is the hard rail.

This is also the right moment to think about the line between CLAUDE.md and skills. A CLAUDE.md instruction loads every session and applies broadly. A skill in `.claude/skills/SKILL.md` loads on demand when the model decides the task is relevant, so deep workflow knowledge with side effects (like a "fix-issue" workflow that opens a PR) belongs there. The same logic applies to instructions that are huge but only matter for one part of your codebase: those want a path-scoped rule, not CLAUDE.md.

## Diagnosing what is actually loaded

When the model is doing the wrong thing, the first move is to confirm what it actually sees. Run `/memory` inside a Claude Code session. It lists every CLAUDE.md, CLAUDE.local.md, and rules file currently loaded, with paths. If the file you expected is not in the list, the rest of the conversation is irrelevant: Claude cannot see it.

For path-scoped rules and lazy-loaded subdirectory CLAUDE.md files, the [`InstructionsLoaded` hook](https://code.claude.com/docs/en/hooks#instructionsloaded) fires every time Claude pulls in instructions. Wire it up to a logger to confirm a `paths:` glob actually matched, or to debug why a nested CLAUDE.md never reloads after `/compact`. The compaction case is a known sharp edge: project-root CLAUDE.md is re-injected after `/compact`, but nested ones reload only on the next file read in that subdirectory. If you rely on a nested CLAUDE.md and instructions seem lost mid-session, that is why.

The other diagnostic worth knowing: HTML block comments (`<!-- like this -->`) are stripped from CLAUDE.md before injection. Use them for human-only notes (a `<!-- last reviewed 2026-04 -->` line) without paying token cost.

## Related

- [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) covers what a CLAUDE.md needs for autonomous runs.
- [Claude Code 2.1.119: launching from a PR with GitLab and Bitbucket](/2026/04/claude-code-2-1-119-from-pr-gitlab-bitbucket/) for the related "where do my instructions live in a cloud session" question.
- [Visual Studio 2026 Copilot agent skills](/2026/04/visual-studio-2026-copilot-agent-skills/) is the closest analogue from the Microsoft side: skill files vs persistent context.
- [Building an MCP server in TypeScript](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) for the case where the better answer than "more rules in CLAUDE.md" is "expose the tool to the agent."

## Sources

- Official: [How Claude remembers your project](https://code.claude.com/docs/en/memory) (Claude Code memory and CLAUDE.md docs).
- Official: [Best Practices for Claude Code](https://code.claude.com/docs/en/best-practices#write-an-effective-claude-md).
- Official: [Hooks reference](https://code.claude.com/docs/en/hooks-guide) and [`InstructionsLoaded` hook](https://code.claude.com/docs/en/hooks#instructionsloaded).
- Field notes: [Writing a good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md) (HumanLayer).
