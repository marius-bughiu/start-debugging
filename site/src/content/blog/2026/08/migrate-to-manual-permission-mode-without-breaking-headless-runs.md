---
title: "Migrate a Claude Code Setup to Manual Permission Mode Without Breaking Headless Runs"
description: "Tightening a team's default permission mode to Manual is a one-line settings change interactively and a silent outage in CI, because headless runs turn every ask into a deny and still report success. Measured on Claude Code 2.1.224, including the trust gate that drops your allowlist but keeps your mode."
pubDate: 2026-08-13
template: migration
tags:
  - "migration"
  - "claude-code"
  - "ai-agents"
  - "permissions"
  - "ci"
---

Moving a team from `acceptEdits` (or worse, `bypassPermissions`) to Manual as the default permission mode takes about an hour of real work, and almost none of it is the mode change itself. Interactively, Manual just means more prompts. In a `claude -p` run there is nobody to prompt, so every gated action becomes a denial, and the run still exits reporting `"subtype": "success"` with the work undone. The second surprise is that a fresh CI checkout is an untrusted workspace, and an untrusted workspace silently drops the `permissions.allow` rules from `.claude/settings.json` while still applying the `defaultMode` from that same file. So your migration tightens the mode and discards the allowlist that was meant to keep automation alive. Everything below is measured on **Claude Code 2.1.224 on Windows 11**.

## Why tighten the default at all

Three concrete outcomes, not general caution:

- **`acceptEdits` is not an edits-only mode.** Its auto-approved Bash set includes `rm`, `rmdir`, `mv`, `cp`, and `sed`. A repo that leaves it on as a permanent default has pre-approved file deletion, not just file writes.
- **A checked-in mode is the only one that survives a new clone.** Per-folder mode choices live in the machine's own state. A teammate cloning the repo starts wherever their own settings put them, which on a `bypassPermissions` habit is nowhere good.
- **Manual is the only mode whose blast radius does not depend on a classifier.** Auto mode is a genuine improvement over clicking "yes" quickly, but if your reason for tightening is an audit requirement rather than prompt fatigue, "a human approved each action" is the property you can actually attest to.

The counterweight is that Manual is safer strictly in proportion to how carefully the prompts get read. If the migration's real goal is fewer unattended actions rather than more reading, compare the modes first in [what each permission mode actually allows through](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/) before committing to this one.

## What breaks

| Area | Change | Severity |
| ---- | ------ | -------- |
| Headless `-p` runs | Every prompt-worthy call is denied instead of asked. Writes, edits, and non read-only Bash all stop | high |
| CI allowlists in `.claude/settings.json` | Dropped entirely in an untrusted workspace, with only a stderr warning | high |
| CI failure detection | A fully denied run still reports `"subtype": "success"` | high |
| Scripts relying on the machine's saved mode | A per-folder mode choice outranks `defaultMode`, so behaviour differs per developer | medium |
| `bypassPermissions` sessions | Cannot be entered mid-session, so the fallback people reach for needs a relaunch | medium |
| Read-only Bash | Unaffected. `ls`, `git status` and the rest of the built-in read-only set still run | none |

## Pre-flight checklist

Before changing anything, collect four facts:

- **Where the mode is set today.** Check `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, and any managed settings your organisation ships. Permission *rules* merge across all of these; `defaultMode` resolves by precedence, with managed settings highest and user settings lowest.
- **Every non-interactive entry point.** Grep the repo for `claude -p`, `claude --print`, and the GitHub Action. Each one needs an explicit decision in step 3.
- **Which of those entry points writes anything.** A read-only reviewer that only reads a diff needs no allowlist at all and will survive this migration untouched.
- **Whether CI runs on a trusted workspace.** It almost certainly does not, and that is step 4.

Confirm your version first, because the `manual` alias and several behaviours below need v2.1.200 or later:

```bash
claude --version
# 2.1.224 (Claude Code)
```

## Migration steps

1. **Prove the failure mode before you change anything.** In a throwaway git repo, run the write probe under Manual and read the JSON rather than the prose:

   ```bash
   # Claude Code 2.1.224 - the mode is passed explicitly so nothing else can be blamed
   claude -p 'Use the Write tool to create the file src/new.txt containing exactly: ok' \
     --permission-mode default --max-turns 4 --output-format json \
     | jq '{subtype, denials: [.permission_denials[]?.tool_name]}'
   ```

   *Verify*: the output is `{"subtype": "success", "denials": ["Write"]}` and `src/new.txt` does not exist. That pairing, a success verdict next to a non-empty denial list, is the entire reason this migration needs a CI change and not just a settings edit. Substituting `--permission-mode manual` produces byte-identical behaviour on 2.1.224; the alias is real, but `default` is still the value to check into a shared repo.

2. **Set the mode in user or managed settings, then mirror it in the repo.** Project settings do apply, which is worth stating plainly because the `auto` exception has made people assume the opposite. With `{"permissions":{"defaultMode":"acceptEdits"}}` in `.claude/settings.json` and no flag at all, the same probe wrote the file. The mode in a project file is honoured. The documented exception is `auto`, which Claude Code v2.1.142 and later ignore from `.claude/settings.json` and `.claude/settings.local.json` precisely so a repository cannot grant itself the loosest practical mode.

   ```json
   // .claude/settings.json - checked in, applies to everyone who clones
   {
     "permissions": {
       "defaultMode": "default"
     }
   }
   ```

   *Verify*: run `claude` interactively in the repo and confirm the status bar shows the gray `⏸ manual mode on` badge. If it shows something else, a per-folder mode choice is winning: the mode you pick in the selector is remembered per folder and takes precedence over `defaultMode` for that folder.

3. **Give every headless entry point an explicit mode, and make it `dontAsk`.** Manual is the wrong mode for automation even when it is the right mode for humans, because "deny everything that would have prompted" is an accident of there being no terminal rather than a stated policy. `dontAsk` is the same behaviour as a deliberate choice: your allow rules, the read-only Bash set, and nothing else, and the session can never stall waiting for input.

   ```bash
   # CI: fails closed, never blocks on a prompt
   claude -p "$PROMPT" --permission-mode dontAsk --output-format json
   ```

   *Verify*: with no allow rules, the write probe under `dontAsk` returns `permission_denials: ["Write"]` and leaves the file absent, exactly as Manual did. Same outcome, but now it is declared.

4. **Move the CI allowlist out of `.claude/settings.json`.** This is the step that actually breaks things, and it fails loudly enough to miss. Running the probe in an untrusted workspace whose `.claude/settings.json` contained both a `defaultMode` and an allow rule produced this on stderr:

   ```text
   Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not
   been trusted. Run Claude Code interactively here once and accept the trust dialog, or set
   projects["<path>"].hasTrustDialogAccepted: true in C:\Users\<you>\.claude.json.
   ```

   The run continued. The `defaultMode` from that file was applied, the allow rule from the same file was not. One file, two keys, two different trust treatments. A CI runner clones fresh every time and has never seen a trust dialog, so this is the permanent state there, not an edge case. Pass the rules as a CLI argument instead, which carries no trust requirement:

   ```bash
   # Claude Code 2.1.224 - inline settings, honoured in an untrusted workspace
   claude -p "$PROMPT" --permission-mode dontAsk --output-format json \
     --settings '{"permissions":{"allow":["Edit(**)","Bash(npm test)"]}}'
   ```

   `--allowedTools` works the same way for the simple cases and composes with any mode, including Manual:

   ```bash
   claude -p "$PROMPT" --permission-mode default --allowedTools "Write"
   ```

   *Verify*: both forms wrote `src/new.txt` with an empty `permission_denials` array and produced no trust warning. If you would rather keep the rules in the repo file, the alternative is to mark the workspace trusted in the runner before invoking Claude Code, by setting `hasTrustDialogAccepted: true` for that path in `~/.claude.json`; that also worked, and it is the more fragile of the two because it depends on runner state you have to recreate on every machine.

5. **Gate CI on the denial list, not on the exit status.** Since a fully denied run still reports success, a pipeline that only checks whether the process failed will go green while Claude did nothing. Parse the array:

   ```bash
   claude -p "$PROMPT" --permission-mode dontAsk --output-format json > result.json

   denied=$(jq -r '[.permission_denials[]?.tool_name] | join(",")' result.json)
   if [ -n "$denied" ]; then
     echo "blocked tools: $denied" >&2
     exit 1
   fi
   ```

   *Verify*: run it once against a prompt you know is not allowlisted and confirm the job fails with the tool names printed. This guard is worth keeping permanently, because it is also how you discover that a prompt started needing a tool nobody pre-approved.

6. **Roll out interactively last.** Once CI is green under `dontAsk`, land the `defaultMode` change for humans. Tell people about `Shift+Tab`, which cycles `default` to `acceptEdits` to `plan`, so the migration reads as "your default changed" rather than "somebody took away accept-edits".

   *Verify*: a teammate clones the repo fresh, runs `claude`, and sees the manual badge without editing anything.

## Verification

Run the whole set after the migration lands:

- The write probe under your CI invocation writes the file and returns an empty `permission_denials`.
- The same invocation with the allowlist removed fails the new CI gate rather than passing quietly.
- `claude -p 'Run exactly this bash command and nothing else: ls src' --permission-mode default` returns no denials. Read-only Bash is exempt in every mode and is not configurable, so if this one denies, something other than the mode is involved.
- A fresh clone in a directory that has never been trusted produces no `Ignoring N permissions.allow entry` line on stderr.
- An interactive session shows the manual badge on a machine that never had a per-folder mode set.

## Rollback

This migration is fully reversible and needs no data migration: revert the `defaultMode` value in settings and drop the `--permission-mode` flag from the CI invocation. The one piece worth keeping regardless of which mode you end on is the denial gate from step 5, because a silent no-op run is a hazard in every mode, not just this one.

## Gotchas we hit

**The stderr warning is invisible in a lot of CI configurations.** The trust warning goes to stderr while the result goes to stdout, so a pipeline that captures only stdout, or pipes straight into `jq`, throws away the one line telling you the allowlist was dropped. The symptom is a run whose `permission_denials` is inexplicably full despite rules you can see in the repo. The same trust gate is what leaves project MCP servers stuck at "Pending approval", covered in [why `.mcp.json` servers never start in an untrusted workspace](/2026/07/fix-mcp-json-servers-never-start-because-the-workspace-is-untrusted/).

**`--bare` is a separate authentication decision, not just a speed flag.** The docs recommend it for scripted calls, and it will become the default for `-p` in a future release, but it never reads OAuth credentials or the system keychain. On a machine logged in with a subscription and no `ANTHROPIC_API_KEY`, a `--bare` run returns `"is_error": true` with the result string `Not logged in · Please run /login`. Bare mode also skips auto-discovery of hooks, skills, plugins, MCP servers, auto memory, and `CLAUDE.md`, which means it skips your project settings file too, making step 4's `--settings` flag mandatory rather than merely more robust.

**Write rules are not the tool you reach for.** If part of the tightening involves protecting specific paths, note that a `Write(src/**)` rule is accepted and then never consulted; the rule that fires is [`Edit(...)`](/2026/08/fix-write-rule-is-not-matched-by-file-permission-checks/). This bites during exactly this migration, because writing path rules is what people do immediately after tightening a mode.

**An `ask` rule outranks the mode and your allow list.** Rules evaluate deny, then ask, then allow, and specificity does not break the tie. That makes an explicit `ask` rule the durable way to force a checkpoint on one command while leaving the mode loose, and it makes an accidental `ask` rule a mystery denial in `dontAsk`, where ask rules are denied rather than prompted.

**Protected paths ignore your allow rules entirely.** Writes to `.git`, `.claude`, `.envrc`, `.mcp.json` and the rest of the protected set are never auto-approved outside `bypassPermissions`, no matter what allow rule you add, because the path check runs before settings rules are evaluated. Do not spend the migration trying to allowlist your way into them.

## Related

- [Auto mode vs manual approval in Claude Code](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/) compares all six modes and is the right read if you have not yet decided that Manual is the target.
- [Claude Code 2.1.200 renames the default permission mode to Manual](/2026/07/claude-code-2-1-200-renames-default-permission-mode-to-manual/) is the release that split the UI label from the `default` config value.
- [Why a `Write(src/**)` permission rule never matches](/2026/08/fix-write-rule-is-not-matched-by-file-permission-checks/) covers the rule syntax you will be writing right after this migration.
- [Fix: `.mcp.json` servers never start because the workspace is untrusted](/2026/07/fix-mcp-json-servers-never-start-because-the-workspace-is-untrusted/) is the same trust gate hitting a different subsystem.
- [How to run Claude Code in a GitHub Action for autonomous PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/) is the CI entry point most affected by step 3.

## Sources

- [Choose a permission mode](https://code.claude.com/docs/en/permission-modes), Claude Code documentation: the six modes, the `manual` alias and its v2.1.200 requirement, `dontAsk` semantics, the protected-path matrix, and per-folder mode precedence over `defaultMode`.
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless), Claude Code documentation: `-p`, `--output-format json`, `--allowedTools`, `--settings`, and the `--bare` credential and auto-discovery rules.
- [Claude Code settings](https://code.claude.com/docs/en/settings), Claude Code documentation: settings-file precedence and the `permissions` keys.
- Every probe result, the trust warning text, and the `--bare` authentication failure measured locally on Claude Code 2.1.224 (Windows 11) with `claude -p --output-format json` against fresh git repositories.
