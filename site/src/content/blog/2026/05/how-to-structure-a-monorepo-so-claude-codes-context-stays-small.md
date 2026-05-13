---
title: "How to Structure a Monorepo So Claude Code's Context Stays Small"
description: "A 2026 playbook for keeping Claude Code's 200k token context lean in a monorepo: launch from the subtree you are touching, split CLAUDE.md into nested files that load on demand, push path-scoped rules into .claude/rules/, use skills and subagents for the noisy reads, and exclude other teams' files with claudeMdExcludes. Anchored to Claude Code 2.1.x, claude-sonnet-4-6, and claude-opus-4-7."
pubDate: 2026-05-13
tags:
  - "claude-code"
  - "ai-agents"
  - "agent-skills"
  - "subagents"
  - "developer-workflow"
---

The reason Claude Code feels worse in a 50-package monorepo than in a 5-file demo is almost never the model. It is the context window. Claude Code 2.1.x ships with a 200,000 token budget on `claude-sonnet-4-6` and `claude-opus-4-7`, and roughly the first 20% of that, around 40,000 tokens, is eaten before you type your first message: system prompt, auto memory, skill listings, MCP tool names, environment info, and every CLAUDE.md from your current working directory up to the filesystem root. In a flat repo that startup overhead is invisible. In a monorepo with a top-level CLAUDE.md plus rules for backend, frontend, mobile, infra, and shared libs, you can spend 15,000 tokens before Claude has read a single file of yours. Adherence drops, costs climb, and the model starts forgetting earlier instructions by the time it finishes the third tool call.

The short version: launch Claude Code from the subtree you are editing, keep the root CLAUDE.md small and skimmable, split everything else into nested CLAUDE.md files and path-scoped `.claude/rules/` so it loads on demand, push repeatable workflows into skills, and delegate "read a hundred files, return one sentence" work to subagents in their own isolated context. Use `claudeMdExcludes` to skip ancestor files from other teams when you have to share a workspace. This post walks through each lever with the exact files and settings to ship, anchored to the [official Claude Code memory docs](https://code.claude.com/docs/en/memory) and the [context window simulation](https://code.claude.com/docs/en/context-window).

## Where the startup budget actually goes

Before you optimise anything, look at what loads automatically. The [context window page](https://code.claude.com/docs/en/context-window) breaks the startup block down explicitly. On a typical project session you pay for: the core system prompt (around 4,200 tokens), MEMORY.md from auto memory (the first 200 lines or 25 KB, whichever comes first), environment info (working directory, OS, shell, git status), one-line skill descriptions for every active skill, MCP tool names, and every CLAUDE.md plus `.claude/rules/` file Claude can see from your cwd. In a monorepo, the last bucket is the one that explodes.

CLAUDE.md files load by walking up from your current working directory to the filesystem root. If you launch Claude Code in `monorepo/services/payments/`, you get `monorepo/services/payments/CLAUDE.md`, `monorepo/services/CLAUDE.md`, `monorepo/CLAUDE.md`, and any `CLAUDE.md` further up the tree, all loaded in full and concatenated into context. Files below your cwd do not load at launch. They load on demand the first time Claude reads a file underneath them. That asymmetry is the single most important fact for monorepo work.

Practical consequence: if you launch from the root of a 30-package monorepo and your root CLAUDE.md uses `@imports` to pull in every package's rules, you have built yourself a 12,000-line startup payload. The fix is not "shorter root CLAUDE.md," though that helps. The fix is "do not launch from the root in the first place."

## Launch from the smallest subtree you can

The cheapest optimisation is also the most ignored. Run `claude` from the package or service directory you are actually editing, not from the monorepo root. The startup walk only sees CLAUDE.md files on that path, the nested files in sibling packages stay completely out of context until you read a file in them, and any path-scoped rule whose glob does not match your cwd never fires.

```bash
# Claude Code 2.1.x
# Bad: loads root CLAUDE.md and walks every imported file
cd ~/work/monorepo
claude

# Good: walk is two levels, nested rules from siblings stay dormant
cd ~/work/monorepo/services/payments
claude
```

If you genuinely need to reach a sibling package mid-session (the payments service imports a shared library and you want Claude to see both), use `--add-dir` instead of starting from the root:

```bash
# Claude Code 2.1.x
# Working in payments, but need to read shared/billing-core
cd ~/work/monorepo/services/payments
claude --add-dir ../../shared/billing-core
```

By default, additional directories do not load their CLAUDE.md at startup, which is exactly what you want for a one-off cross-cutting task. If you do want the sibling's CLAUDE.md in context for the whole session, set `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` before launching and Claude will pull in `CLAUDE.md`, `.claude/CLAUDE.md`, and `.claude/rules/*.md` from the added directory. Treat that env var as opt-in per session, not a default.

## Split CLAUDE.md the way Claude Code reads it

The reading model rewards nested files. Each subtree's instructions live next to the code they describe, and they only enter the context window when Claude touches a file in that subtree. That maps cleanly onto a monorepo:

```text
monorepo/
├── CLAUDE.md                       # root: cross-cutting, very short
├── .claude/
│   ├── CLAUDE.md                   # optional, equivalent to root CLAUDE.md
│   ├── rules/
│   │   ├── commit-style.md         # no paths: applies everywhere
│   │   └── typescript.md           # paths: "**/*.ts,**/*.tsx"
│   └── skills/
│       └── release-notes/SKILL.md
├── services/
│   ├── payments/
│   │   ├── CLAUDE.md               # service-local, ~80 lines
│   │   └── .claude/rules/payments-domain.md
│   └── inventory/
│       ├── CLAUDE.md
│       └── .claude/rules/
├── apps/
│   ├── web/
│   │   └── CLAUDE.md
│   └── mobile/
│       └── CLAUDE.md
└── shared/
    └── billing-core/
        └── CLAUDE.md
```

The root file should be the smallest one. It should describe how to find things ("services live under `services/`, apps under `apps/`, shared libs under `shared/`"), the monorepo's tooling spine (the package manager, the build orchestrator, where the lockfile is authoritative), and a small number of rules that genuinely apply everywhere. The official memory docs target [under 200 lines per CLAUDE.md file](https://code.claude.com/docs/en/memory#write-effective-instructions); in a monorepo root, aim for closer to 80. Every line there is a line in every session, on every package.

Nested CLAUDE.md files carry the rest. A typical `services/payments/CLAUDE.md` covers the service's domain language, its public contract, which tests are slow, which migrations are dangerous, and whatever conventions only the payments team cares about. It does not get read until Claude touches a file under `services/payments/`. That deferral is the whole point.

## Use `.claude/rules/` for path-scoped instructions

Where nested CLAUDE.md scopes by directory, `.claude/rules/` scopes by glob. A rules file with `paths:` frontmatter only enters context when Claude reads a file matching the pattern:

```markdown
---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# TypeScript rules for this monorepo

- No `any` outside of `*.d.ts` shims.
- Imports use the workspace alias, not relative paths above two levels.
- Tests live next to the file as `*.spec.ts`, not in a parallel `__tests__/` tree.
```

That file lives in `.claude/rules/typescript.md`. It does not fire when Claude edits a Dart file in the mobile app, even if you launched from the monorepo root. The same pattern works for service-local rules: put `.claude/rules/payments-domain.md` inside `services/payments/.claude/rules/` with `paths: ["services/payments/**"]` and it stays out of context until needed.

Rules without `paths:` load unconditionally at session start with the same priority as the root CLAUDE.md, which makes them a useful place for the truly universal stuff (commit message format, security checklist) without bloating the readable CLAUDE.md itself.

## Stop using `@imports` to save tokens

A common mistake in monorepos is to keep a slim-looking root CLAUDE.md that `@imports` a dozen other files:

```markdown
# Monorepo guide

@README.md
@docs/architecture.md
@services/payments/CLAUDE.md
@services/inventory/CLAUDE.md
@apps/web/CLAUDE.md
@shared/billing-core/CLAUDE.md
```

This loads exactly the same amount of context as if you pasted every file inline. The memory docs are explicit on this: "Splitting into `@path` imports helps organization but does not reduce context, since imported files load at launch." Imports are organisational, not budget-saving. The maximum recursion depth for chained imports is [five hops](https://code.claude.com/docs/en/memory#import-additional-files), so a deeply pyramided import tree can also pin you to that limit silently.

If your goal is "Claude should only see the payments rules when working on payments," do not `@import` them from the root. Leave them as a nested `services/payments/CLAUDE.md` or a path-scoped rule. Save imports for things you genuinely want loaded every session everywhere, like a shared style guide stored under `docs/` that you would otherwise duplicate.

## Push repeatable workflows into skills, not CLAUDE.md

Skills are the right home for "how to release the payments service" or "how to bump the shared SDK." A skill at `.claude/skills/release-payments/SKILL.md` shows up at startup as a single one-line description in the skill index, costing tens of tokens. The body of the skill only enters context when Claude invokes it. Compare that to writing the same procedure into `services/payments/CLAUDE.md`, where the whole multi-step playbook lives in your message history any time anyone edits a payments file.

Two practical rules. First, name skills concretely (`release-payments`, not `release`) so the model can pick the right one in a multi-team repo. Second, put the most important steps at the top of `SKILL.md`. After [/compact](https://code.claude.com/docs/en/context-window#what-survives-compaction), invoked skill bodies are re-injected but capped at 5,000 tokens per skill and 25,000 tokens total, and truncation keeps the start of the file. A skill that buries its key step on line 400 will lose it after the first compaction.

For longer-form coverage of this split, see [how to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/), which goes deeper on the CLAUDE.md vs skills vs hooks decision.

## Delegate noisy reads to subagents

The other big lever is subagents. A subagent runs in its own context window, executes a task with its own tool calls, and returns only its final answer to the parent. Intermediate file reads, grep results, and reasoning never touch the parent's context. For a monorepo, that is exactly the right tool for the "audit every package for `X`" or "find every caller of this function across 40 services" task.

A subagent definition lives at `.claude/agents/<name>.md`:

```markdown
---
name: monorepo-finder
description: Searches the monorepo for symbols, callers, or config patterns and returns a short report. Use proactively when a question requires reading more than five files in different packages.
tools:
  - Glob
  - Grep
  - Read
---

You are a read-only auditor for a TypeScript and Dart monorepo. Use Glob and
Grep to locate matches, then Read only the files you need to confirm the
finding. Return at most a 20-line report with file:line references and a
one-sentence conclusion. Do not include excerpts longer than three lines.
```

Invoke it explicitly from the parent ("ask the monorepo-finder subagent to list every caller of `chargeCard`") and you trade one expensive call for a 20-line summary. For a deeper walk-through of the pattern, including how to give a subagent its own scoped tool list, see [how to write a Claude Code subagent that runs browser tests](/2026/05/how-to-write-a-claude-code-subagent-that-runs-browser-tests/).

## Exclude other teams' CLAUDE.md with `claudeMdExcludes`

In a shared monorepo you will sometimes find yourself with ancestor CLAUDE.md files that have nothing to do with your work, written by another team, full of their idioms and their rules. The `claudeMdExcludes` setting in `.claude/settings.local.json` lets you skip them by glob:

```json
{
  "claudeMdExcludes": [
    "**/other-team/CLAUDE.md",
    "/Users/marius/work/monorepo/legacy/**/CLAUDE.md"
  ]
}
```

Put this in `settings.local.json` so it does not leak into the team-shared config. Patterns match against absolute file paths. Arrays merge across settings layers (user, project, local, managed), and managed policy CLAUDE.md files cannot be excluded. The setting is purely subtractive: it does not affect the path-scoped rules under `.claude/rules/`, only `CLAUDE.md` and `CLAUDE.local.md` discovery.

A reasonable rule of thumb: if a CLAUDE.md is loading into your sessions and you cannot remember the last time it changed how Claude behaved on your code, exclude it. You can always re-enable it for a specific session by removing the pattern.

## Block big-file reads with a hook

The other failure mode in monorepos is Claude reading a 50,000-line generated file (build manifests, lockfiles, vendored SDKs) because it looked relevant. Hooks fire on tool events and can short-circuit the read. A `PreToolUse` hook in `.claude/settings.json` that vetoes oversized reads keeps the context budget intact regardless of what Claude decides to do:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/guard-read.js"
          }
        ]
      }
    ]
  }
}
```

The script (kept short, exits with code 2 and a stderr message to surface a refusal to Claude) checks the size of the path and tells Claude to use Grep instead for files over, say, 500 KB or generated paths under `**/dist/**` and `**/.next/**`. The pattern complements `.claudeignore`, which is honoured for proactive discovery but does not stop an explicit read. For sensitive files, prefer `permissions.deny` in the same settings file, which is enforced by the client.

## What survives `/compact` in a long monorepo session

Long sessions in a big repo will hit `/compact`. The [official table](https://code.claude.com/docs/en/context-window#what-survives-compaction) is short and worth memorising for monorepo work:

- Project-root CLAUDE.md is re-injected from disk after compaction.
- Nested CLAUDE.md files in subdirectories are not re-injected automatically; they reload the next time Claude reads a file in that subtree.
- Path-scoped rules behave the same way: they re-enter context only when a matching file is read again.
- Invoked skill bodies are re-injected, capped at 5,000 tokens per skill and 25,000 tokens total, oldest dropped first.
- The skill listing itself does not reload. Only skills you actually used in the session are preserved.

The implication for a monorepo: after `/compact`, Claude can lose the implicit knowledge of your current package until it reads a file there again. If you compact mid-task and the model starts behaving like it forgot the local conventions, a single Read of any file in the relevant subtree pulls the nested CLAUDE.md and rules back into context. A useful habit is to compact, then immediately ask Claude to re-read the file it was working on before you continue.

## Related on Start Debugging

- [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/)
- [How to write a Claude Code subagent that runs browser tests](/2026/05/how-to-write-a-claude-code-subagent-that-runs-browser-tests/)
- [How to schedule a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/)
- [How to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/)
- [How to cache multi-turn Claude conversations across API calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/)

## Sources

- [How Claude remembers your project (memory docs)](https://code.claude.com/docs/en/memory)
- [Explore the context window](https://code.claude.com/docs/en/context-window)
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- [Subagents in Claude Code](https://claude.com/blog/subagents-in-claude-code)
