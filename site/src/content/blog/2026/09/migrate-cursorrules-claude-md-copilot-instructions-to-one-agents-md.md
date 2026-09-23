---
title: "Migrate .cursorrules, CLAUDE.md, and copilot-instructions.md to One AGENTS.md (Claude Code 2.1.277+)"
description: "Claude Code 2.1.277 reads AGENTS.md natively, so Cursor, Claude Code, and most Copilot surfaces can now share one instructions file. Here is the checklist for merging three drifted rule files into AGENTS.md, which bridge files to delete, the one Copilot file you still have to generate, and a CI check that keeps them from drifting again."
pubDate: 2026-09-23
updatedDate: 2026-09-23
template: migration
tags:
  - "migration"
  - "agents-md"
  - "ai-agents"
  - "claude-code"
  - "cursor"
  - "github-copilot"
---

**Short answer:** make the root `AGENTS.md` the only file you edit, and move anything tool-specific into that tool's *scoped* rules folder (`.claude/rules/`, `.cursor/rules/*.mdc`, `.github/instructions/`) instead of a second always-on file. Since **Claude Code 2.1.277** (September 18, 2026), Claude reads `AGENTS.md` by itself when a project has no `CLAUDE.md`, and Cursor and the VS Code Copilot agent already did, so the `.cursorrules` and `CLAUDE.md` files can go. The one file you cannot delete is `.github/copilot-instructions.md`: github.com Copilot Chat, Visual Studio, JetBrains, and Copilot code review in most IDEs read only that file. Generate it from marked sections of `AGENTS.md` with a 30-line script and fail CI when it drifts. The whole migration takes about an hour for a typical repo, most of it spent deciding which of two contradicting rules is the real one.

Versions this post is pinned to: Claude Code 2.1.280 (AGENTS.md support since 2.1.277), the Cursor rules docs and help center as of September 2026, VS Code source on `main` in September 2026 (1.138 is the current release), and the GitHub Copilot custom-instructions docs revision of September 2026. Every claim below changes with those versions.

## Why one file is finally possible

Until last week, "one AGENTS.md for every tool" was a slogan with an asterisk. Claude Code ignored the file, so every repo that used it also needed a `CLAUDE.md` bridge, with the traps I covered in [the fix for Claude Code ignoring AGENTS.md](/2026/09/fix-claude-code-ignores-agents-md/). Teams that did not bother ended up with three files that started as copies and drifted apart.

The drift is the real cost. In the demo repo I built for this post, the inventory script below found that `.cursorrules` and `CLAUDE.md` said "Run `pnpm test --filter api` before committing" while `.github/copilot-instructions.md` said "Run `pnpm test` before committing". Nobody decided that Copilot should run the full suite. Someone edited one file and forgot the other two. Each agent then followed its own version, and the humans reviewing the PRs had no idea why Copilot's branches took four times longer in CI.

Three changes make consolidation practical now:

- **Claude Code 2.1.277** added the built-in `agents-md` plugin. By default it reads every `AGENTS.md` from the working directory upward when no `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md` exists there, expands `@path` imports inside it, and lazily loads a subdirectory's `AGENTS.md` when Claude reads a file in that directory.
- **Cursor** reads root and nested `AGENTS.md`, with more specific files taking precedence, and its help center now calls `.cursorrules` legacy.
- **VS Code's Local agent** loads `AGENTS.md` by default (`chat.useAgentsMdFile` defaults to `true`), and the Copilot cloud agent and Copilot CLI read it everywhere.

## What actually loads, per tool and surface

This table is the whole migration in one place. "Reads" means the file is attached automatically, not that the agent might open it with a tool.

| Surface | `AGENTS.md` | `CLAUDE.md` | `.cursorrules` | `.github/copilot-instructions.md` |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.277+ (first-party API) | Yes, only if no `CLAUDE.md`/`CLAUDE.local.md` | Yes | No | No |
| Claude Code on Bedrock, Vertex, Foundry, or telemetry off | No | Yes | No | No |
| Cursor agent | Yes, root and nested | Yes, always applied | Legacy, still read | No |
| VS Code, Copilot Local agent | Yes (nested off by default) | Yes (`chat.useClaudeMdFile`, default on) | No | Yes |
| Copilot cloud agent (any IDE or github.com) | Yes, nearest file wins | Yes, root only | No | Yes |
| Copilot CLI | Yes | Yes | No | Yes |
| Copilot code review on github.com | Yes | No | No | Yes |
| Copilot Chat on github.com | No | No | No | Yes |
| Copilot Chat in Visual Studio, JetBrains, Eclipse, Xcode | No | No | No | Yes |
| Copilot code review in VS Code, Visual Studio, JetBrains | No | No | No | Yes |

Two rows decide the design. The bottom four rows mean `.github/copilot-instructions.md` has to exist if anyone on the team uses Copilot outside VS Code agent mode. And the VS Code row means that whatever you put in *both* files is sent twice on that surface, so what you copy into the Copilot file should be a deliberate subset, not the whole of `AGENTS.md`.

## Pre-flight checklist

- Everyone who uses Claude Code is on **2.1.277 or later** (`claude --version`). Note that the first session after installing or upgrading does not read `AGENTS.md` yet; the next one does.
- You know who runs Claude Code through **Amazon Bedrock, Google Vertex AI, or Microsoft Foundry**, or with telemetry disabled. The `agents-md` plugin depends on feature-flag fetching, so those sessions still read `CLAUDE.md` only.
- Node 20 or later on the machine running the scripts below, and in CI.
- A branch. Every step here is a plain file change you can review and revert.

## Migration steps

1. Inventory every instruction file and find the duplicates and contradictions.
2. Write the merged root `AGENTS.md`, with a marked region for Copilot.
3. Move tool-specific rules into scoped rules folders, not into a second always-on file.
4. Split directory-specific rules into nested `AGENTS.md` files.
5. Delete `.cursorrules` and `CLAUDE.md`, and give Bedrock and Vertex users a local bridge.
6. Generate `.github/copilot-instructions.md` from `AGENTS.md` and check it in CI.

### 1. Inventory every instruction file

Do not merge by eye. Rule files use different bullet styles and punctuation, so near-duplicates hide easily. This script lists every file an agent treats as project instructions, shows its scope, and groups normalized lines that appear in more than one file:

```js
#!/usr/bin/env node
// scripts/agent-rules-inventory.mjs
// Lists every per-tool instruction file in a repo and shows which rule lines
// appear in which file, so you can merge them into one AGENTS.md by hand.
// Node 20+. No dependencies. Usage: node scripts/agent-rules-inventory.mjs [repoRoot]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] ?? ".";
const SKIP = new Set(["node_modules", ".git", "dist", "build", "bin", "obj"]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(relative(root, p));
  }
  return out;
}

// Files that some agent loads as always-on or scoped project instructions.
const isInstructionFile = (f) =>
  /(^|\/)(AGENTS|CLAUDE|CLAUDE\.local|GEMINI)\.md$/.test(f) ||
  f === ".cursorrules" ||
  f === ".github/copilot-instructions.md" ||
  /^\.github\/instructions\/.+\.instructions\.md$/.test(f) ||
  /^\.cursor\/rules\/.+\.mdc$/.test(f) ||
  /^\.claude\/rules\/.+\.md$/.test(f);

// Split off YAML frontmatter so we can report scoping (globs, applyTo, paths).
function parse(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  return { front: m ? m[1] : "", body: m ? text.slice(m[0].length) : text };
}

// Normalise a rule line so "- Use pnpm, never npm." and "Use pnpm (never npm)" collide.
const norm = (line) =>
  line
    .replace(/^\s*([-*+]|\d+\.)\s+/, "")
    .replace(/[`*_()[\],.;:!]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const files = walk(root).filter(isInstructionFile).sort();
if (files.length === 0) {
  console.log("No agent instruction files found.");
  process.exit(0);
}

const seen = new Map(); // normalised line -> { text, files: Set }
console.log("Instruction files:\n");
for (const f of files) {
  const { front, body } = parse(readFileSync(join(root, f), "utf8"));
  if (body.includes("GENERATED from AGENTS.md")) {
    console.log(`  ${f.padEnd(44)} generated from AGENTS.md, skipped`);
    continue;
  }
  // globs: a/**  |  applyTo: "a/**"  |  paths:\n  - "a/**"
  const scopeMatch = front.match(/^(globs|applyTo|paths):[ \t]*(.*)((?:\n\s+- .+)*)/m);
  const scope = scopeMatch
    ? (scopeMatch[2] || scopeMatch[3].replace(/\n\s+- /g, " ")).trim()
    : /alwaysApply:\s*true/.test(front) || !front ? "always" : "on request";
  const lines = body
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && !l.trim().startsWith("<!--"));
  console.log(`  ${f.padEnd(44)} ${String(lines.length).padStart(3)} lines  scope: ${scope}`);
  for (const l of lines) {
    const key = norm(l);
    if (key.length < 8) continue; // skip "ok", separators, etc.
    if (!seen.has(key)) seen.set(key, { text: l.trim(), files: new Set() });
    seen.get(key).files.add(f);
  }
}

const shared = [...seen.values()].filter((v) => v.files.size > 1);
const unique = [...seen.values()].filter((v) => v.files.size === 1);

console.log(`\nDuplicated across files (${shared.length}), move once into AGENTS.md:\n`);
for (const v of shared) console.log(`  ${v.text}\n    in: ${[...v.files].join(", ")}`);

console.log(`\nOnly in one file (${unique.length}), decide shared vs tool-specific:\n`);
for (const v of unique) console.log(`  [${[...v.files][0]}] ${v.text}`);

if (existsSync(join(root, ".cursorrules")))
  console.log("\nNote: .cursorrules is legacy in Cursor. Delete it once its rules are merged.");
```

Run against the demo repo before the migration (Node 26.4, but nothing past Node 20 is used), it printed:

```text
Instruction files:

  .cursor/rules/base.mdc                         1 lines  scope: always
  .cursor/rules/react.mdc                        1 lines  scope: apps/web/**/*.tsx
  .cursorrules                                   3 lines  scope: always
  .github/copilot-instructions.md                4 lines  scope: always
  CLAUDE.md                                      4 lines  scope: always

Duplicated across files (3), move once into AGENTS.md:

  - Prefer named exports.
    in: .cursor/rules/base.mdc, .cursorrules, .github/copilot-instructions.md, CLAUDE.md
  - Use pnpm, never npm.
    in: .cursorrules, .github/copilot-instructions.md, CLAUDE.md
  - Run `pnpm test --filter api` before committing.
    in: .cursorrules, CLAUDE.md

Only in one file (4), decide shared vs tool-specific:

  [.cursor/rules/react.mdc] - Components are function components.
  [.github/copilot-instructions.md] - Run `pnpm test` before committing.
  [.github/copilot-instructions.md] - Every PR needs a changelog entry.
  [CLAUDE.md] - Use plan mode for changes under `src/billing/`.

Note: .cursorrules is legacy in Cursor. Delete it once its rules are merged.
```

Read the "only in one file" section as a list of questions. `pnpm test` versus `pnpm test --filter api` is a contradiction that needs a human decision. "Every PR needs a changelog entry" is a shared rule that only one tool happened to learn. "Use plan mode" is genuinely Claude-specific. "Prefer named exports" appears four times, including an `alwaysApply: true` Cursor rule, which means Cursor users were getting it three times per request.

**Verify:** every line in the "only in one file" list has an owner: shared, tool-specific, or delete.

### 2. Write the merged root AGENTS.md

Put the shared rules in `AGENTS.md` and wrap the ones Copilot's `AGENTS.md`-blind surfaces must see in a marked region. For most repos that is the commands and the conventions a reviewer would enforce, not the repo tour:

```markdown
# Agent instructions

<!-- copilot:start -->
## Commands

- Use pnpm, never npm.
- Run `pnpm test --filter <package>` for the package you changed before committing.

## Conventions

- Prefer named exports.
- Every PR needs a changelog entry in `CHANGELOG.md`.
<!-- copilot:end -->

## Working in this repo

- Services live under `services/`, each with its own `AGENTS.md`.
- Never edit files under `generated/`; run `pnpm codegen` instead.
```

HTML comments are invisible in rendered Markdown and harmless to every agent that reads the raw file. Keep the file short. It is sent with every request in every tool, and the advice in [writing a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) applies unchanged: concrete commands beat adjectives, and a 600-line file gets skimmed by the model the same way it gets skimmed by people.

**Verify:** `AGENTS.md` contains no rule that mentions a specific tool by name.

### 3. Move tool-specific rules into scoped folders

The mistake that recreates the original mess is keeping a `CLAUDE.md` "just for the Claude bits". In Claude Code 2.1.277+ the existence of any `CLAUDE.md` in the working directory or above switches `AGENTS.md` loading **off** under the default `claude-md-or-agents-md` setting. You would be back to needing an import.

Each tool has a scoped folder that loads alongside `AGENTS.md` without overriding it:

```markdown
---
# .claude/rules/billing.md  (Claude Code 2.1.277+: loads with AGENTS.md, does not disable it)
paths:
  - "src/billing/**"
---
- Use plan mode before changing anything under `src/billing/`.
```

The Claude memory docs list `.claude/rules/` files as not counting toward the "is there a CLAUDE.md?" check, so they coexist with `AGENTS.md`. The Cursor equivalent is a `.cursor/rules/*.mdc` file with `globs` and `alwaysApply: false`; the Copilot equivalent is `.github/instructions/NAME.instructions.md` with `applyTo`. If you are converting a large set of `.mdc` rules, the [Cursor rules to skills and subagents migration](/2026/08/migrate-cursor-rules-to-skills-subagents-and-plugins/) sorts them further.

**Verify:** the inventory shows every remaining non-`AGENTS.md` file with a scope other than `always`.

### 4. Split directory rules into nested AGENTS.md files

A rule like "run `pnpm test --filter api`" belongs to `services/api/`, not the root. Put it in `services/api/AGENTS.md`. Cursor applies nested files automatically, the Copilot cloud agent uses the nearest one, and Claude Code loads a subdirectory's `AGENTS.md` when it reads a file there. VS Code's Local agent is the exception: nested files are listed for on-demand loading only when `chat.useNestedAgentsMdFiles` is on, and it defaults to `false`. Turn it on for the repo:

```json
// .vscode/settings.json  (VS Code 1.138, Copilot Local agent; applies in trusted workspaces)
{
  "chat.useNestedAgentsMdFiles": true
}
```

**Verify:** start a session in each tool, open a file under `services/api/`, and ask which test command to run.

### 5. Delete .cursorrules and CLAUDE.md

Delete `.cursorrules` outright. Cursor's help center calls it legacy, and while it is still read, it doubles every rule it shares with `AGENTS.md`.

Delete `CLAUDE.md` too, if it now contains nothing but an `@AGENTS.md` import or a symlink, *unless* part of the team runs Claude Code where the `agents-md` plugin cannot load. Removing it matters beyond Claude: Cursor always applies a root `CLAUDE.md`, and the Copilot cloud agent, CLI, and VS Code Local agent all read it, so a leftover file is one more thing each of them loads and has to reconcile. I have not been able to confirm whether Cursor or Copilot expand a Claude-style `@AGENTS.md` import; if one of them does, a one-line bridge becomes a full second copy.

For the Bedrock, Vertex, or Foundry users, the cleanest bridge is personal rather than committed. `CLAUDE.local.md` is meant to be gitignored, and Claude Code still loads it in sessions without `AGENTS.md` support:

```bash
# Claude Code on Bedrock / Vertex / Foundry, or telemetry disabled: sessions read CLAUDE.md files only
printf '@AGENTS.md\n' > CLAUDE.local.md
grep -qx 'CLAUDE.local.md' .gitignore || echo 'CLAUDE.local.md' >> .gitignore
```

The import resolves relative to the file, so it pulls in the root `AGENTS.md`. Keep this to the people who need it: for a first-party user the same file counts as a `CLAUDE.md`, so the root rules still arrive through the import, but Claude stops picking up nested `AGENTS.md` files on its own under the default setting.

**Verify:** start a fresh Claude Code session at the repo root on 2.1.277+ and look for the line `no CLAUDE.md found; AGENTS.md loaded: <path>/AGENTS.md`, then run `/context` and check the file under **Memory files**.

### 6. Generate copilot-instructions.md and check it in CI

This is the one file that has to stay, because github.com Chat, Visual Studio, JetBrains, Eclipse, and Xcode Chat, and code review in most IDEs, read nothing else. Generate it so nobody edits it by hand:

```js
#!/usr/bin/env node
// scripts/sync-copilot-instructions.mjs
// Generates .github/copilot-instructions.md from the marked regions of the root AGENTS.md.
// Copilot surfaces that ignore AGENTS.md (github.com Chat, Visual Studio, JetBrains,
// Eclipse and Xcode Chat, code review outside github.com) still get the core rules.
// Node 20+. Usage: node scripts/sync-copilot-instructions.mjs [--check]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const SRC = "AGENTS.md";
const OUT = ".github/copilot-instructions.md";
const HEADER =
  "<!-- GENERATED from AGENTS.md by scripts/sync-copilot-instructions.mjs. Do not edit. -->\n\n";

const src = readFileSync(SRC, "utf8");
const regions = [...src.matchAll(/<!-- copilot:start -->\n([\s\S]*?)<!-- copilot:end -->/g)].map(
  (m) => m[1].trimEnd(),
);
if (regions.length === 0) {
  console.error(`${SRC} has no <!-- copilot:start --> ... <!-- copilot:end --> region.`);
  process.exit(2);
}
const expected = HEADER + regions.join("\n\n") + "\n";

if (process.argv.includes("--check")) {
  const actual = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (actual !== expected) {
    console.error(`${OUT} is out of date. Run: node scripts/sync-copilot-instructions.mjs`);
    process.exit(1);
  }
  console.log(`${OUT} matches ${SRC}.`);
} else {
  mkdirSync(".github", { recursive: true });
  writeFileSync(OUT, expected);
  console.log(`Wrote ${OUT} (${regions.length} region(s), ${expected.length} chars).`);
}
```

Against the demo repo, the check failed on the old hand-written file (exit 1), then passed after one generate run (exit 0), producing a 305-character file with the two marked sections. Wire the check into CI:

```yaml
# .github/workflows/agent-instructions.yml  (actions/checkout@v5, actions/setup-node@v5)
name: agent-instructions
on:
  pull_request:
    paths: ["AGENTS.md", ".github/copilot-instructions.md", "CLAUDE.md", ".cursorrules"]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: node scripts/sync-copilot-instructions.mjs --check
      - name: No legacy instruction files
        run: |
          for f in .cursorrules CLAUDE.md; do
            if [ -e "$f" ]; then echo "::error file=$f::$f is retired, edit AGENTS.md"; exit 1; fi
          done
```

Why not a symlink from `.github/copilot-instructions.md` to `AGENTS.md`? VS Code's Local agent actually handles that well: its instruction locator skips a symlink whose target it has already loaded. But I found no GitHub documentation saying github.com Chat or code review follow a symlinked instructions file, and those are exactly the surfaces the file exists for. A generated regular file works everywhere.

**Verify:** the workflow is green on the migration PR, and an edit to only `.github/copilot-instructions.md` in a test PR turns it red.

## Smoke test after the migration

Put a canary rule in the shared region of `AGENTS.md`, for example "When asked for the canary word, answer PERSIMMON", regenerate, and ask each surface for the canary word in a fresh session:

- **Claude Code 2.1.277+:** the `AGENTS.md loaded` line appears at session start, and `/context` lists the file.
- **VS Code Copilot agent:** expand **References** under the answer; `AGENTS.md` and `copilot-instructions.md` should both be listed. The [Copilot custom instructions troubleshooting guide](/2026/05/fix-github-copilot-ignores-repository-custom-instructions-in-vs-code/) covers what to check when they are not.
- **Cursor:** ask in a new agent chat. It should answer without reading the file first.
- **github.com Copilot Chat and code review:** ask Chat in the repository; it only knows the canary if the generated file carries it.

Then remove the canary. An answer that comes back only after the agent visibly opens `AGENTS.md` is a failure: the file was found, not loaded.

## Rolling back

Everything here is file changes in one PR, so `git revert` restores the old three-file layout. For Claude Code alone there is also a switch: setting **Project instructions** to `claude-md` in `/config` (or `pluginConfigs["agents-md@builtin"].options.instructionFiles` in `~/.claude/settings.json` or managed settings; project settings files are ignored for it) makes Claude read only `CLAUDE.md` files again.

## Gotchas that undo the migration quietly

**A personal `CLAUDE.local.md` turns `AGENTS.md` off.** It counts toward the "is there a CLAUDE.md?" check. That is fine when it imports `AGENTS.md`, as in step 5, and silently wrong when a teammate creates one for their sandbox URLs. Either add `@AGENTS.md` at the top of it, or set **Project instructions** to `claude-md-and-agents-md` for that user.

**The first Claude Code session after an upgrade ignores `AGENTS.md`.** The plugin's feature flag arrives during that session. Restart once before concluding the migration broke something.

**`AGENTS.local.md`, `AGENTS.override.md`, and `.agents/` are not read by Claude Code.** Some other agents use those names. Do not move shared rules into them.

**`InstructionsLoaded` hooks do not fire for an `AGENTS.md` loaded natively.** They still fire when a `CLAUDE.md` imports or symlinks it. If you audit loaded instructions with that hook, keep the import for now.

**Precedence differs per tool, so contradictions still matter.** In Copilot, `AGENTS.md` ranks below both `copilot-instructions.md` and path-specific instruction files, as the [Copilot Memory vs custom instructions vs AGENTS.md comparison](/2026/09/copilot-memory-vs-repository-custom-instructions-vs-agents-md/) shows. Because the generated file is a copy of `AGENTS.md` text, the two can never disagree. A hand-edited one can, and Copilot will side with it.

**Remove old `SessionStart` hooks that print `AGENTS.md`.** Once Claude reads the file directly, the hook adds a second copy to every session.

One file does not mean one tool's behavior. It means one place where the rules are decided, reviewed in the same diff, and copied mechanically to the one surface that still needs a copy.

### Related

- [Fix: Claude Code ignores AGENTS.md](/2026/09/fix-claude-code-ignores-agents-md/) for the import and symlink bridges you still need on Bedrock, Vertex, or Claude Code before 2.1.277.
- [Copilot Memory vs repository custom instructions vs AGENTS.md](/2026/09/copilot-memory-vs-repository-custom-instructions-vs-agents-md/) for Copilot's precedence order and per-surface matrix.
- [Migrate Cursor rules to skills, subagents, and plugins](/2026/08/migrate-cursor-rules-to-skills-subagents-and-plugins/) for what to do with the `.mdc` rules that survive this migration.
- [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/), which applies line for line to `AGENTS.md`.
- [Fix: GitHub Copilot ignores repository custom instructions in VS Code](/2026/05/fix-github-copilot-ignores-repository-custom-instructions-in-vs-code/) when the smoke test fails in VS Code.

### Sources

- [Claude Code docs: How Claude remembers your project, AGENTS.md section](https://code.claude.com/docs/en/memory#agents-md)
- [Claude Code CHANGELOG, 2.1.277](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Cursor docs: Rules, AGENTS.md and nested AGENTS.md](https://cursor.com/docs/rules)
- [Cursor help: Rules, migrating from .cursorrules and how CLAUDE.md works in Cursor](https://cursor.com/help/customization/rules)
- [GitHub Docs: Support for different types of custom instructions](https://docs.github.com/en/copilot/reference/custom-instructions-support)
- [GitHub Docs: Adding repository custom instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions)
- [VS Code docs: Use custom instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions)
- [VS Code source: agentInstructionsLocator.ts](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/platform/promptFiles/vscode-node/agentInstructionsLocator.ts) and [chat setting defaults](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts)
- [agentsmd/agents.md](https://github.com/agentsmd/agents.md)
