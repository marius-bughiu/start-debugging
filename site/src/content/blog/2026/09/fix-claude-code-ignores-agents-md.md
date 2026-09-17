---
title: "Fix: Claude Code ignores AGENTS.md (import it from CLAUDE.md or symlink it)"
description: "Claude Code 2.1.274 still loads only CLAUDE.md. Bridge AGENTS.md with an @AGENTS.md import or a symlink, then avoid the three traps: imports that don't expand from a subdirectory, symlinks that Windows checks out as a 9-byte text file, and Edit refusing to write through the link. Includes a CI check and a SessionStart hook for repos you don't own."
pubDate: 2026-09-17
template: error-page
tags:
  - "errors"
  - "claude-code"
  - "ai-agents"
  - "agents-md"
  - "claude-md"
  - "hooks"
---

Claude Code does not read `AGENTS.md`, and that is a product decision, not a bug you can configure away. As of **Claude Code 2.1.274** (September 17, 2026), the instruction loader only looks for `CLAUDE.md`, `.claude/CLAUDE.md`, and `CLAUDE.local.md`. The fix is a bridge file: put a `CLAUDE.md` containing `@AGENTS.md` at the repo root, or symlink `CLAUDE.md` to `AGENTS.md`. Then run `/context` and check that the file shows up under **Memory files**. Each bridge has a trap. Imports in a parent directory's `CLAUDE.md` don't expand when you launch from a subdirectory. A symlink checked out with `core.symlinks=false` turns into a plain file whose entire content is the word `AGENTS.md`. And the Edit and Write tools refuse to write through a symlinked `CLAUDE.md`. All three are fixable, and a 50-line CI check catches them before a teammate notices.

## What "ignores AGENTS.md" looks like

The symptom is Claude doing exactly what your `AGENTS.md` forbids, then reading the file halfway through the task and apologising. One report on the tracker describes a repo whose `AGENTS.md` had a single rule, "never run git commands". Claude Code ran several git commands first and only opened `AGENTS.md` afterwards. That order makes sense once you know what happened: nothing loaded the file at startup. Claude found it later the same way it finds `package.json`, by deciding to read it.

You can confirm this in ten seconds:

```bash
# Claude Code 2.1.274, macOS or Linux
mkdir agents-demo && cd agents-demo && git init -q
printf '# Rules\n- The canary word is PERSIMMON.\n' > AGENTS.md
claude
# inside the session:
#   /context              -> no project file listed under "Memory files"
#   what is the canary word?   -> Claude has to go and Read AGENTS.md to answer
```

Now add the bridge and start a fresh session:

```bash
printf '@AGENTS.md\n' > CLAUDE.md
claude
#   /context   -> CLAUDE.md and AGENTS.md both listed under "Memory files"
```

## Why Claude Code only loads CLAUDE.md

The [memory docs](https://code.claude.com/docs/en/memory#agents-md) put it plainly: Claude Code reads `CLAUDE.md`, not `AGENTS.md`. The feature request for native support, [anthropics/claude-code#6235](https://github.com/anthropics/claude-code/issues/6235), is the most upvoted issue in the repo. It was open from August 2025 until August 17, 2026, when a maintainer closed it by pointing to the import and symlink workarounds. The comments since then show that plenty of people don't accept that as an answer, but it is the current state.

So you are not waiting for a setting. You need a `CLAUDE.md` that points Claude at the same content every other agent reads. There are two documented ways to do that, plus a hook for repos where you can't commit a bridge.

## Fix 1: a CLAUDE.md that imports AGENTS.md

This is the form the docs recommend, and it is the only one that lets you add Claude-specific instructions:

```markdown
@AGENTS.md

## Claude Code

- Use plan mode for changes under `src/billing/`.
- Run `pnpm test --filter api` instead of the full suite.
```

Claude Code expands `@AGENTS.md` when it loads the file, so the shared rules arrive first and your Claude-only lines come after them. The import rules that matter here, per the memory docs:

- **Relative paths resolve against the file that contains the import**, not your working directory. `@AGENTS.md` in `services/api/CLAUDE.md` means `services/api/AGENTS.md`.
- **Imports inside code spans and fenced code blocks are ignored.** A `CLAUDE.md` that says "follow the rules in `` `@AGENTS.md` ``" imports nothing. This is the most common way a bridge silently does nothing.
- **Imports can nest up to four hops deep**, which matters if your `AGENTS.md` itself imports other files for Claude's benefit.
- **An import that resolves outside the working directory counts as external.** The first time Claude Code sees one, it shows an "Allow external CLAUDE.md file imports?" dialog. If you pick No, those imports stay disabled for the project and the dialog does not come back. The setting is under **External CLAUDE.md includes** in `/config`.

### The trap: imports in a parent directory's CLAUDE.md don't expand

The import form has a bug that hits monorepos directly. When you launch `claude` from a subdirectory, the root `CLAUDE.md` is loaded as an ancestor file. Its own text arrives, but its `@AGENTS.md` import is not expanded. The session gets a `CLAUDE.md` whose whole content is one line pointing at a file that never loaded. There's no warning, and `/context` shows a suspiciously small token count for the root file.

A maintainer reproduced this on 2.1.233 in [anthropics/claude-code#78697](https://github.com/anthropics/claude-code/issues/78697) and marked it as a genuine bug. A comment posted today, from a user logging sessions on 2.1.235 through 2.1.273 and re-checking on 2.1.274, covers the other direction: a `CLAUDE.md` *below* the working directory, loaded lazily when Claude reads files there, reached context with its import line unexpanded in 12 of 12 logged injections. An older duplicate, [#78216](https://github.com/anthropics/claude-code/issues/78216), was auto-closed for inactivity without a fix. On Windows there is one more variant: imports of an adjacent `AGENTS.md` failing only inside the VS Code extension ([#81189](https://github.com/anthropics/claude-code/issues/81189)).

The practical rule until a fix ships: an `@AGENTS.md` import is reliable only in the `CLAUDE.md` of the directory where you start `claude`. If people on your team start sessions from package directories, use a symlink for every file below the root.

## Fix 2: symlink CLAUDE.md to AGENTS.md

```bash
# macOS / Linux, run in each directory that has an AGENTS.md
ln -s AGENTS.md CLAUDE.md
git add CLAUDE.md
```

A symlink doesn't depend on import expansion. Reading follows the link, so the rules are the body of `CLAUDE.md` itself, not an import that still has to be expanded. That sidesteps #78697, which breaks import expansion, not file loading: the maintainer's repro shows the ancestor file's own body arriving intact. You give up Claude-only lines in that file. Put those in `.claude/rules/claude-code.md` instead: rules without `paths:` frontmatter load at launch with the same priority as `.claude/CLAUDE.md`.

Symlinks have their own traps.

### Trap: Windows checks the link out as a 9-byte text file

The docs warn that creating a symlink on Windows needs Administrator rights or Developer Mode. The worse problem is what happens on a machine that never enabled them. Git stores the link as mode `120000`. With `core.symlinks=false`, which is Git for Windows' default unless you opted in at install, git writes a regular file whose content is the link target. I reproduced this on macOS by cloning with the setting forced off:

```bash
# git 2.50.1
git clone -q -c core.symlinks=false origin winclone && cd winclone
ls -la CLAUDE.md    # -rw-r--r--  1 marius  wheel  9 Sep 17 12:10 CLAUDE.md
cat CLAUDE.md       # AGENTS.md
git status --short  # (nothing, git considers the checkout clean)
```

Claude Code loads that file without complaint. Your Windows teammates get a project instruction file that says `AGENTS.md` and nothing else: no `@`, so no import. Every rule is missing, and nothing in git or Claude Code flags it. Either have those machines run `git config --global core.symlinks true` with Developer Mode on and re-clone, or use the import form at the root for mixed-OS teams.

### Trap: Edit and Write refuse to write through the link

Ask Claude to update its project instructions and it fails with:

```text
Refusing to write through symlink: /repo/CLAUDE.md. Resolve the symlink and pass the real target path explicitly.
```

That is intentional. The file tools won't write through symlinks, so a write can't be silently redirected to a different file. A maintainer confirmed it on 2.1.234 in [#66559](https://github.com/anthropics/claude-code/issues/66559) and is treating the missing mention in the docs as a documentation gap. Claude usually recovers by editing `AGENTS.md` directly. To skip the failed first attempt, add a line to `AGENTS.md` saying edits to agent instructions go in `AGENTS.md`. Reading is unaffected. One more scope note: in Cowork desktop sessions, a `~/.claude/CLAUDE.md` that is itself a symlink is skipped. That applies only to the user-level file, not to project files.

## Which bridge to use where

| Situation | Bridge | Why |
| --- | --- | --- |
| Single-package repo, everyone launches from the root | `CLAUDE.md` with `@AGENTS.md` | Works everywhere and leaves room for Claude-only lines |
| Monorepo, nested `AGENTS.md` files | Symlink in every nested directory | Nested and ancestor imports don't expand (#78697) |
| Monorepo root, sessions often start in packages | Symlink at the root too, Claude-only lines in `.claude/rules/` | The root file is an ancestor for those sessions |
| Team includes Windows machines without symlink support | Import at the root, avoid nested symlinks or enforce `core.symlinks=true` | A text-file "symlink" loads as one useless word |
| Upstream or vendor repo you can't commit to | `SessionStart` hook in `~/.claude/settings.json` | No bridge file needed |

## Enforce the bridge in CI

Every broken shape above looks fine in a code review. This script fails the build when an `AGENTS.md` has no bridge Claude Code will load:

````bash
#!/usr/bin/env bash
# Fails when an AGENTS.md has no CLAUDE.md bridge that Claude Code will actually load.
# Tested with git 2.50 and bash 3.2 (macOS); loader behaviour as of Claude Code 2.1.274.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
fail=0

# succeeds if the file imports @AGENTS.md outside fenced code blocks and code spans
has_import() {
  awk '
    /^[[:space:]]*(```|~~~)/ { fence = !fence; next }
    fence { next }
    { gsub(/`[^`]*`/, "") }
    /(^|[[:space:]])@(\.\/)?AGENTS\.md([[:space:]]|$)/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$1"
}

while IFS= read -r agents; do
  dir=$(dirname "$agents")
  bridge="$dir/CLAUDE.md"
  [ -e "$bridge" ] || [ -L "$bridge" ] || bridge="$dir/.claude/CLAUDE.md"

  if [ ! -e "$bridge" ] && [ ! -L "$bridge" ]; then
    echo "FAIL  $agents has no CLAUDE.md next to it"; fail=1; continue
  fi

  if [ -L "$bridge" ]; then
    if [ "$bridge" -ef "$agents" ]; then
      echo "OK    $bridge -> $(readlink "$bridge")"
    else
      echo "FAIL  $bridge links to $(readlink "$bridge"), not to $agents"; fail=1
    fi
  elif [ "$(git ls-files -s -- "$bridge" | cut -c1-6)" = "120000" ]; then
    echo "FAIL  $bridge is a symlink in git but a plain file here (core.symlinks=false): \"$(cat "$bridge")\""
    fail=1
  elif has_import "$bridge"; then
    if [ "$dir" = "." ]; then
      echo "OK    $bridge imports @AGENTS.md (expands when claude starts at the repo root)"
    else
      echo "WARN  $bridge imports @AGENTS.md below the repo root; prefer a symlink (claude-code#78697)"
    fi
  else
    echo "FAIL  $bridge never imports AGENTS.md outside a code block"; fail=1
  fi
done < <(git ls-files -- 'AGENTS.md' '*/AGENTS.md')

exit $fail
````

I ran it against a test repo with one bridge of every shape. That includes a nested symlink pointing at the *root* `AGENTS.md` by mistake, which loads the root rules twice and the package rules never:

```text
OK    ./CLAUDE.md imports @AGENTS.md (expands when claude starts at the repo root)
OK    apps/web/CLAUDE.md -> AGENTS.md
FAIL  docs/guide/CLAUDE.md links to ../../AGENTS.md, not to docs/guide/AGENTS.md
FAIL  packages/ui/AGENTS.md has no CLAUDE.md next to it
WARN  services/api/CLAUDE.md imports @AGENTS.md below the repo root; prefer a symlink (claude-code#78697)
FAIL  tools/cli/CLAUDE.md never imports AGENTS.md outside a code block
exit=1
```

The same repo cloned with `core.symlinks=false` turns both symlinks into failures, with the useless file content printed:

```text
FAIL  apps/web/CLAUDE.md is a symlink in git but a plain file here (core.symlinks=false): "AGENTS.md"
FAIL  docs/guide/CLAUDE.md is a symlink in git but a plain file here (core.symlinks=false): "../../AGENTS.md"
```

Run it in a Windows CI job as well as Linux if your team is mixed. The Linux job alone will never see the text-file case.

## Fix 3: a SessionStart hook for repos you can't commit to

Sometimes the repo isn't yours: an upstream project, a vendor SDK, a client codebase with its own conventions. A user-level `SessionStart` hook can pass Claude the `AGENTS.md` files that no `CLAUDE.md` covers. This version walks from the working directory up to the repo root and skips any directory that already has a `CLAUDE.md`, so bridged repos don't get loaded twice:

```bash
#!/usr/bin/env bash
# ~/.claude/hooks/agents-md-context.sh
# SessionStart hook: hand Claude the AGENTS.md files it would otherwise skip.
# Directories that already have a CLAUDE.md are skipped, so bridged repos never load twice.
# Hook contract as of Claude Code 2.1.274; needs jq.
set -euo pipefail
cwd=$(jq -r '.cwd')
root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || echo "$cwd")

# collect cwd and every parent up to the repo root, root first
dirs=()
d=$cwd
while :; do
  dirs=("$d" ${dirs[@]+"${dirs[@]}"})
  if [ "$d" = "$root" ] || [ "$d" = "/" ]; then break; fi
  d=$(dirname "$d")
done

context=""
for d in "${dirs[@]}"; do
  [ -f "$d/AGENTS.md" ] || continue
  if [ -e "$d/CLAUDE.md" ] || [ -e "$d/.claude/CLAUDE.md" ]; then continue; fi
  rel=${d#"$root"}; rel=${rel#/}; rel=${rel:+$rel/}
  context+="${rel}AGENTS.md is this repository's shared agent instruction file. It says:"$'\n\n'
  context+="$(cat "$d/AGENTS.md")"$'\n\n'
done

[ -n "$context" ] || exit 0
if [ "${#context}" -gt 10000 ]; then
  echo "agents-md-context: ${#context} chars; over 10,000 Claude only gets a file path and a preview" >&2
fi
jq -n --arg ctx "$context" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
```

Register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/agents-md-context.sh" }
        ]
      }
    ]
  }
}
```

I couldn't run a logged-in Claude Code session on the machine I wrote this on, so I tested the hook the way Claude Code calls it: by piping the documented `SessionStart` input into the script. In an `AGENTS.md`-only repo, starting from `services/api`, it returns both files, root first:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "AGENTS.md is this repository's shared agent instruction file. It says:\n\n# Rules\n- Use pnpm, never npm.\n\nservices/api/AGENTS.md is this repository's shared agent instruction file. It says:\n\n# API\n- Return RFC 9457 problem details.\n\n"
  }
}
```

In the fully bridged test repo, it prints nothing from the root, and only `packages/ui/AGENTS.md` from `packages/ui`, the one directory without a bridge. Four details in that script are there on purpose:

- **The framing is descriptive.** The [hooks reference](https://code.claude.com/docs/en/hooks#add-context-for-claude) warns that injected text written as out-of-band system commands can trip Claude's prompt-injection defenses, so that Claude shows the text to you instead of using it. A header saying "this is the repository's instruction file" reads as project information. The imperative rules inside it then carry the weight a `CLAUDE.md` would.
- **The matcher includes `compact`.** The project-root `CLAUDE.md` is re-read from disk after compaction, but hook context is not, unless the hook runs again.
- **The 10,000-character cap is real.** Hook output strings over 10,000 characters are written to a file, and Claude only receives the path plus a preview. With a 12,001-byte `AGENTS.md`, the script reports 12,200 characters on stderr, so trim the file or accept that Claude has to read the rest itself.
- **It does not replace a bridge inside the repo.** Custom subagents load the `CLAUDE.md` hierarchy themselves, but they don't see the main conversation's `SessionStart` context. If a subagent needs the rules, add a `SubagentStart` hook that returns the same `additionalContext`, or commit a bridge file.

## Verify what actually loaded

`/context` is the quick check. For a record over time, the `InstructionsLoaded` hook (added in 2.1.69) fires for every instruction file, with a `load_reason` of `session_start`, `nested_traversal`, `path_glob_match`, `include`, or `compact`. An `AGENTS.md` pulled in by an import shows up with `load_reason: "include"` and a `parent_file_path` pointing at the `CLAUDE.md` that imported it. Log those events for a week. If sessions started in a subdirectory never produce that `include` line, you are hitting #78697:

```json
{
  "hooks": {
    "InstructionsLoaded": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "jq -c '{file_path, load_reason, parent_file_path, cwd}' >> \"$HOME/.claude/instructions-loaded.jsonl\""
          }
        ]
      }
    ]
  }
}
```

## Gotchas that look like the same problem

**`/import` makes a copy, not a bridge.** Since 2.1.213, `/import` brings Codex, Gemini CLI, and (from 2.1.265) Cursor configuration into Claude Code, including instruction files. The docs describe what it appends to `CLAUDE.md` as a one-time copy. From then on you have two files that drift apart, which is what `AGENTS.md` was supposed to prevent. Use it to migrate once, then replace the copied block with `@AGENTS.md`.

**Explore and Plan never see it.** The built-in Explore and Plan subagents skip all `CLAUDE.md` files, bridges included. Since 2.1.271, a custom subagent with `omitClaudeMd: true` does the same. If a rule must hold during research, restate it in the delegation prompt.

**`--safe-mode` drops it on purpose.** Since 2.1.169, `claude --safe-mode` starts without `CLAUDE.md`, hooks, or plugins. A session started that way ignores your bridge by design.

**Duplicated content across both files.** A `CLAUDE.md` that restates half of `AGENTS.md` instead of importing it loads both copies. Claude Code concatenates instruction files rather than picking a winner, so when the copies disagree the docs say Claude may pick one arbitrarily.

**A native switch exists in the binary, but it's off.** The 2.1.274 build contains a built-in `agents-md` plugin with a `projectInstructions` option: `claude` (default), `agents-fallback`, `both`, or `none`. It sits behind a server-side feature flag that defaults to off, and it appears in neither the docs nor the changelog. It wasn't in 2.1.197. Treat it as a sign of where things may go, not something to configure today.

## Related

- [How to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) covers what belongs in the bridged file once it loads: the 200-line target, path-scoped rules, and when to use a hook instead.
- [Copilot memory vs repository custom instructions vs AGENTS.md](/2026/09/copilot-memory-vs-repository-custom-instructions-vs-agents-md/) is the other half of a mixed-agent repo: in Copilot, `AGENTS.md` ranks below the Copilot-native files.
- [Structuring a monorepo so Claude Code's context stays small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/) explains the ancestor and nested loading that makes the #78697 trap bite.
- [Migrating Cursor rules to skills, subagents, and plugins](/2026/08/migrate-cursor-rules-to-skills-subagents-and-plugins/) shows where `AGENTS.md` fits when Cursor is the other agent in the repo.
- [A PreToolUse hook returns allow but a deny rule still blocks the call](/2026/09/fix-pretooluse-hook-allow-still-blocked-by-deny-rule/) goes deeper into writing and testing hook scripts with piped input.

## Sources

- [Manage Claude's memory](https://code.claude.com/docs/en/memory), Claude Code documentation: the `AGENTS.md` section, import rules, external import approval, `/context`, and `InstructionsLoaded` debugging.
- [Hooks reference](https://code.claude.com/docs/en/hooks), Claude Code documentation: `SessionStart` decision control, `additionalContext`, the 10,000-character cap, and `InstructionsLoaded` input.
- [Subagents](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup), Claude Code documentation: what loads at subagent startup and `omitClaudeMd`.
- [Commands](https://code.claude.com/docs/en/commands), Claude Code documentation: `/import` and `/init`.
- [anthropics/claude-code#6235](https://github.com/anthropics/claude-code/issues/6235): the native `AGENTS.md` request, closed August 17, 2026.
- [anthropics/claude-code#78697](https://github.com/anthropics/claude-code/issues/78697) and [#78216](https://github.com/anthropics/claude-code/issues/78216): imports in ancestor and nested `CLAUDE.md` files not expanding.
- [anthropics/claude-code#66559](https://github.com/anthropics/claude-code/issues/66559): Edit and Write refusing to write through a symlinked `CLAUDE.md`.
- [anthropics/claude-code#81189](https://github.com/anthropics/claude-code/issues/81189): `@AGENTS.md` import failing in the Windows VS Code extension.
- [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md): 2.1.69, 2.1.169, 2.1.271, 2.1.274.
- [AGENTS.md](https://agents.md/): the cross-agent format and its nearest-file-wins convention.
