---
title: "Fix: \"Write(src/**) is not matched by file permission checks\" in Claude Code"
description: "Claude Code only consults Edit(path) and Read(path) rules. A Write(src/**) allow or deny rule is accepted and then silently ignored. Use Edit() instead."
pubDate: 2026-08-03
template: error-page
tags:
  - "errors"
  - "claude-code"
  - "ai-agents"
  - "security"
---

Rename the rule from `Write(...)` to `Edit(...)` and keep the same path pattern. Claude Code checks file paths against `Edit(path)` and `Read(path)` rules only. A `Write(src/**)` rule parses fine, appears in `/permissions`, and is never consulted. `Edit` rules cover every file-editing tool, including `Write`, `NotebookEdit`, and the legacy `MultiEdit`.

## The warning, verbatim

On Claude Code v2.1.210 and later, a `Write` path rule in project settings prints this at startup:

```text
Permission deny rule (.claude/settings.json): Write(docs/**) is not matched by file permission checks — only Edit(path) rules are. Use Edit(docs/**) instead (Edit rules cover all file-editing tools).
```

Before v2.1.210 there is no warning at all. The rule is simply inert. That is the version most of these bug reports come from: the setting looks right, `/permissions` lists it, and the agent still asks for approval on every write, or, worse, writes to a path you believed you had denied.

## Why a Write rule does nothing

Claude Code has more than one tool that modifies a file. `Write` creates or replaces a whole file, `Edit` does a string replacement, `NotebookEdit` changes a notebook cell, and `MultiEdit` (now legacy) batched several edits. If each of those had its own permission namespace, an allowlist would leak by construction: you would deny `Edit(secrets/**)` and the agent would reach the same path through `Write`.

So the permission layer collapses them. There is exactly one file-modification namespace and it is spelled `Edit`. Quoting the [permissions reference](https://code.claude.com/docs/en/permissions): "Claude Code checks file permissions against `Edit(path)` and `Read(path)` rules only. If you write a path rule for `Write`, `NotebookEdit`, `Glob`, or the legacy `MultiEdit` tool instead, Claude Code accepts the rule but never consults it."

The same collapsing happens on the read side. `Glob(docs/**)` is not consulted either; the read namespace is `Read`. The one documented exception is a `Glob` rule passed through `--allowedTools`.

## Minimal repro

Two directories, identical prompts, one character of difference in the settings file. Measured on Claude Code 2.1.123 on Windows 11, in headless mode so the result is a hard allow or deny rather than an interactive prompt.

```json
// .claude/settings.json - Claude Code 2.1.123, permission rule uses the Write tool name
{
  "permissions": {
    "allow": ["Write(src/**)"],
    "deny": [],
    "defaultMode": "default"
  }
}
```

```bash
# Claude Code 2.1.123
claude -p "Use the Write tool to create src/new.ts containing: export const a = 1;" \
  --max-turns 4 --output-format json
```

Result: `"permission_denials": [{"tool_name": "Write", ...}]`. The file is not created. Now change one token:

```json
// .claude/settings.json - same project, Edit tool name, same path pattern
{
  "permissions": {
    "allow": ["Edit(src/**)"],
    "deny": [],
    "defaultMode": "default"
  }
}
```

Same prompt, same `Write` tool call from the model, and this time the run reports `Created src/new.ts` with an empty `permission_denials` array. The `Edit` rule authorised a `Write` call. That is the whole bug and the whole fix.

## The dangerous direction: a deny rule that does not deny

The allow-side failure is annoying: you get prompted for things you meant to pre-approve. The deny-side failure is a security hole, because the settings file reads as if a path is protected.

```json
// .claude/settings.json - Claude Code 2.1.123. This deny rule does nothing.
{
  "permissions": {
    "allow": ["Edit(**)"],
    "deny": ["Write(protected/**)"],
    "defaultMode": "default"
  }
}
```

Asking the agent to create `protected/note.txt` with the `Write` tool produced `Created protected/note.txt`, no denial recorded, and the file on disk. Swap the deny rule to `Edit(protected/**)` and the identical prompt is refused with "the `protected/` directory is blocked by your permission settings" before any tool call reaches the filesystem.

If you have a `Write(...)`, `NotebookEdit(...)`, or `MultiEdit(...)` deny rule in a repository right now, it has never blocked anything. Grep for it:

```bash
# check every settings scope for inert path rules
grep -rn 'Write(\|NotebookEdit(\|MultiEdit(\|Glob(' \
  .claude/settings.json .claude/settings.local.json ~/.claude/settings.json
```

One deliberate exception: a bare tool name with no parentheses does work. A deny rule of `"Write"` removes the `Write` tool from Claude's context entirely, everywhere, and Claude Code does not warn about it. That is a blunt instrument, not a path scope, but it is a legitimate rule. The warning fires only when you attach a path.

## Path patterns, once the tool name is right

Fixing the tool name is necessary but not sufficient, because the pattern shape has its own rules. `Read` and `Edit` rules use [gitignore](https://git-scm.com/docs/gitignore) syntax with four anchors, and the leading-slash case is the one that surprises people:

| Pattern            | Anchored at                          | Example                          |
| ------------------ | ------------------------------------ | -------------------------------- |
| `//path`           | Filesystem root                      | `Read(//Users/alice/secrets/**)` |
| `~/path`           | Home directory                       | `Read(~/.zshrc)`                 |
| `/path`            | The settings file that defines it    | `Edit(/src/**/*.ts)`             |
| `path` or `./path` | Current directory                    | `Read(*.env)`                    |

A single leading slash is not an absolute path. `Edit(/Users/alice/file)` anchors at whatever directory owns the settings file, so in `~/.claude/settings.json` it resolves to `~/.claude/Users/alice/file` and matches nothing you care about. Absolute paths need two slashes. On Windows, paths are normalised to POSIX form before matching, so `C:\Users\alice` becomes `/c/Users/alice` and a rule for `.env` files across every drive is `Read(//**/.env)`.

The anchor for `/path` depends on which file the rule lives in:

| Rule defined in                             | `/path` resolves to        |
| ------------------------------------------- | -------------------------- |
| `.claude/settings.json` (project)           | `<project root>/path`      |
| `~/.claude/settings.json` (user)            | `~/.claude/path`           |
| `--settings <file>`                         | `<directory of file>/path` |
| CLI flags, `/permissions`, session rules    | `<original cwd>/path`      |

That third row is why a user-level `Read(/secrets/**)` deny rule protects a directory under `~/.claude` and not the `secrets/` folder in your project. For a user-settings rule that applies inside every repository, use `//` or `~/`.

## The depth rule changed, so check your version

For a relative pattern with a single directory segment, the current documentation splits behaviour by rule type: `Edit(src/**)` as an **allow** rule matches only `<cwd>/src` and its contents, while `Read(secrets/**)` as a **deny or ask** rule matches a `secrets` directory at any depth. Every other pattern shape matches at one depth regardless of rule type: `Edit(/src/**)` only at its anchor, `Edit(**/src/**)` at any depth.

That asymmetry is newer than it looks. On 2.1.123, an allow rule of `Edit(src/**)` also authorised an edit to `vendor/pkg/src/lib.js`, the nested copy, which the current docs say it should not. If you are pinned to an older CLI, a single-segment allow rule is broader than the documentation now describes. Write `Edit(/src/**)` when you mean the project's own `src/` and nothing else. It is unambiguous in every version.

The reverse trap also exists. A bare filename follows gitignore semantics and matches at any depth, so `Read(.env)` and `Read(**/.env)` are the same rule, and an allow rule of `Edit(src)` (no `/**`) covers files under `src/` at arbitrary depth. That reads like a narrow rule and is not one.

## Other reasons a correct rule still does not fire

Once the tool name and the pattern are right, four things can still swallow the rule.

**Workspace trust.** `permissions.allow` entries and `additionalDirectories` in a project's `.claude/settings.json` grant capability, so Claude Code applies them only after you accept the workspace trust dialog for that folder. Until then it reads the rules and ignores them. In headless mode with `-p` there is no dialog, so the rules stay ignored for the entire run. This is the same mechanism behind [project MCP servers that sit at Pending approval forever](/2026/07/fix-mcp-json-servers-never-start-because-the-workspace-is-untrusted/): trust is keyed on the git repository root, and trusting a parent directory does not cover a nested project.

**Precedence.** Rules evaluate deny, then ask, then allow, and the first match wins. Specificity does not break the tie. A broad `Edit(**)` deny in managed settings beats a surgical `Edit(src/app.ts)` allow in project settings, and a deny at any scope beats an allow at any other. Deny rules cannot carry allowlist exceptions.

**Canonical tool names.** The label in the transcript is not always the rule name. The tool shown as `Stop Task` is canonically `TaskStop`, and a rule written as `Stop Task` matches nothing. Deny and ask rules with an unknown tool name produce a startup warning; names containing `_` or `*` are exempt from that check, so MCP rules do not get the safety net.

**A stale in-memory cache.** [Issue #41259](https://github.com/anthropics/claude-code/issues/41259) reports that when the `Edit` tool itself modifies `.claude/settings.local.json` mid-session, the in-memory permission state stops matching the file on disk and previously approved rules start prompting again. Let `/permissions` or the "Yes, don't ask again" button manage that file rather than editing it with the agent.

## What the rules do not cover

`Read` and `Edit` deny rules apply to the built-in file tools and to file commands Claude Code recognises inside Bash, such as `cat`, `head`, `tail`, and `sed`. They do not apply to a Python or Node script that opens the same file itself. A deny rule is a guardrail against the agent's own tools, not an access control boundary. For enforcement that survives an arbitrary subprocess you need the OS-level sandbox, which is also where [egress policy and the `sandbox.credentials` block](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/) live.

Related to that: as of v2.1.208 a `Read` deny rule also blocks the `Edit` tool on the same path, including creating a new file there. `Write` and `NotebookEdit` are not covered by that inheritance, which is one more reason the `Edit` rule is the one you want. For paths no tool may change, write the `Edit` deny rule explicitly.

## Related

- [Claude Code 2.1.200 renames the default permission mode to Manual](/2026/07/claude-code-2-1-200-renames-default-permission-mode-to-manual/) covers the modes these rules sit inside, and why the config value stayed `default`.
- [Locking down a coding agent's network egress](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/) is the other half of the same threat model: file rules stop the read, the allowlist stops the exfiltration.
- [Project MCP servers stuck at Pending approval](/2026/07/fix-mcp-json-servers-never-start-because-the-workspace-is-untrusted/) is the workspace-trust failure mode in a different config file.
- [Writing a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) is worth reading alongside this, because instructions in `CLAUDE.md` shape what the model tries and never change what the harness allows.
- [Gating Cursor SDK tool calls with auto-review and permissions.json](/2026/06/gate-cursor-sdk-tool-calls-with-auto-review-and-permissions-json/) shows how the same problem is modelled in a different agent.

## Sources

- [Configure permissions](https://code.claude.com/docs/en/permissions), Claude Code documentation, including the `Edit(path)` and `Read(path)` restriction, the four path anchors, and the rule-type depth table.
- [gitignore pattern format](https://git-scm.com/docs/gitignore), the syntax `Read` and `Edit` rules borrow.
- [anthropics/claude-code issue #41259](https://github.com/anthropics/claude-code/issues/41259), permission rules in `settings.local.json` not respected after the `Edit` tool modifies the file.
- Behaviour in the repro sections measured locally on Claude Code 2.1.123 (Windows 11) with `claude -p --output-format json`, reading the `permission_denials` array.
