---
title: "How to Keep Unattended Claude Code Runs From Stalling on Permission Prompts With permissions.denyInsteadOfPrompting"
description: "Set permissions.denyInsteadOfPrompting to true in user, managed or --settings scope and Claude Code 2.1.319+ denies any tool call that would wait on a permission prompt, then keeps the turn going. Where it applies, how it differs from dontAsk mode and --permission-prompts none, what it also switches off, how to approve calls from a PermissionRequest hook, and the two dialogs it cannot skip."
pubDate: 2026-11-16
template: "how-to"
tags:
  - "claude-code"
  - "ai-agents"
  - "permissions"
  - "headless"
  - "automation"
---

**Short answer:** put `"denyInsteadOfPrompting": true` under `permissions` in `~/.claude/settings.json`, in managed settings, or in a `--settings` file or inline JSON string. From Claude Code v2.1.319 onward, any tool call that would otherwise sit on a permission prompt is denied on the spot, Claude reads a denial that says nobody can approve it, and the turn continues. It works in whatever permission mode you are in (Manual, `acceptEdits`, `auto`), in `-p` runs, interactive terminal sessions, the VS Code extension, local Desktop sessions, subagents and agent team teammates. A project's `.claude/settings.json` cannot turn it on for you, and it does not skip the workspace trust dialog or the project MCP server approval, so answer those once before you walk away. The current release at the time of writing is 2.1.325.

## Where an unattended session actually stops

The classic "my agent ran all night and did nothing" story is rarely a crash. It is a session that hit one tool call nothing had pre-approved, opened a permission dialog, and waited. Nothing times out. The process is alive, the token meter is flat, and the only sign is a session status that says it is waiting on you.

Which runs can do this depends on where the prompt goes:

- **A bare `claude -p` run with no permission host** already denies anything that would prompt. It does not stall, but Claude may retry the same call several times before giving up.
- **A `-p` run or Agent SDK session with a permission host**, meaning a [`canUseTool` callback](https://code.claude.com/docs/en/agent-sdk/user-input) or an MCP tool passed with `--permission-prompt-tool`, sends every prompt to that host and waits for the answer. If the host is a UI that nobody is watching at 3 a.m., the run waits too.
- **Interactive sessions you leave running**: a terminal session in tmux on a build box, a VS Code or Desktop session started before you went home, a `/loop` that self-paces through the night. These have a real approval surface, so they prompt and wait.
- **Subagents and agent team teammates** spawned from those interactive sessions. A background subagent that needs approval for `npm install` blocks on the same kind of dialog, often in a pane you are not looking at.

Before 2.1.319 the tools for avoiding this were all coarse. You could switch to `dontAsk` mode, which gives up auto mode's classifier. You could pass `--permission-prompts none`, which only exists for `-p` runs and only lasts for one invocation. Or you could run in `bypassPermissions` inside a container. `permissions.denyInsteadOfPrompting` is the piece that was missing: a persistent switch that says "keep my current mode, but when you would have asked, say no instead".

## Turning it on

The setting is a boolean under `permissions`. The example straight from the [settings reference](https://code.claude.com/docs/en/settings-reference#permissions-denyinsteadofprompting) pairs it with auto mode, which is the combination most unattended setups want:

```json
// ~/.claude/settings.json -- Claude Code 2.1.319 or later
{
  "permissions": {
    "defaultMode": "auto",
    "denyInsteadOfPrompting": true
  }
}
```

With this file, sessions start in auto mode. The classifier still reviews every action. Anything it approves runs, anything it blocks is blocked, and anything that would have fallen back to a prompt (auto mode prompts after repeated blocks, on `ask` rules, on actions it cannot classify) is denied instead.

### The three scopes that can set it

The key is honoured from exactly three places:

1. **User settings**: `~/.claude/settings.json`.
2. **Managed settings**: the organization's managed settings file or server-delivered policy.
3. **`--settings`**: a path or an inline JSON string passed on the command line.

It is ignored in `.claude/settings.json` and `.claude/settings.local.json`. That is deliberate. A repository you clone should not be able to change how your session asks for consent, in either direction. The settings docs also list it among the keys where a `true` from your own user settings or `--settings` is "honored even when a managed source sets `false`". In other words, `false` never re-enables prompting if any trusted source says `true`. The setting can only make a session stricter.

For a one-off run on a machine where you do not want to touch the user file, use the inline form of `--settings`:

```bash
# Claude Code 2.1.319+. Inline JSON is accepted by --settings.
claude --settings '{"permissions":{"denyInsteadOfPrompting":true}}' \
  --permission-mode acceptEdits
```

For a scheduled job or a CI runner that should never block, put it in the user settings of the account that runs the job. For a fleet, put it in managed settings.

## What Claude sees when a call is denied

The denial is not silent. Claude gets a tool result that opens with:

```text
Permission for this tool use was denied. It requires approval, and this session has no approval surface
```

That wording matters. A generic "permission denied" invites the model to try a slightly different spelling of the same command. This message tells it that no approver exists, so the useful move is to work around the blocked action or report that it could not do it.

If you run with `--output-format stream-json`, each refused call also shows up as a `permission_denied` system message with this `decision_reason`:

```text
no approval surface in this session; permission request denied automatically
```

The final `result` message carries the full list in `permission_denials`, and the [Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript#sdkpermissiondeniedmessage) notes that the streamed event is best-effort while `permission_denials` is authoritative. That makes a cheap post-run check easy:

```bash
# Claude Code 2.1.319+, jq 1.7
claude -p "Bump the lockfile and run the tests" \
  --settings '{"permissions":{"denyInsteadOfPrompting":true}}' \
  --permission-mode auto \
  --output-format json > run.json

jq -r '.permission_denials[] | "\(.tool_name)\t\(.tool_input | tostring)"' run.json
```

Every line printed is an action your allow rules or classifier did not cover. That list is the best input you will get for tightening `permissions.allow` before the next run.

### The 20-refusal stop in auto mode

There is one behaviour change in auto mode worth knowing. Normally, auto mode falls back to a prompt after 3 classifier blocks in a row or 20 in a session (the thresholds are fixed, per the [permission modes docs](https://code.claude.com/docs/en/permission-modes)). With `denyInsteadOfPrompting` on, there is no prompt to fall back to. Instead, the turn ends after 20 calls in a row that the classifier blocked or a safety check refused, with:

```text
20 actions were refused and no work went ahead in between, so Claude stopped.
```

A `-p` run reports that turn as `error_during_execution`, so a wrapper script can tell "the agent gave up because everything it tried was refused" apart from a clean finish. This is a good outcome for an unattended job: an agent stuck on refusals stops burning tokens instead of looping.

## What else the setting switches off

A permission prompt is not the only thing that waits for a human. The setting also handles the other ones:

- **Question and plan tools.** `AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode` are removed from the tool list, so Claude cannot ask a clarifying question nobody will answer. A side effect: a session that starts in plan mode cannot leave it on its own. Do not combine `defaultMode: "plan"` with this setting for unattended work. Agent team teammates are the exception and keep `EnterPlanMode` and `ExitPlanMode`.
- **MCP elicitation.** An MCP server's elicitation request is cancelled unless an `Elicitation` hook answers it. If a server needs an OAuth sign-in or a form value mid-run, it gets a cancel, not a hang.
- **Permission hosts.** Claude Code stops asking your `canUseTool` callback and your `--permission-prompt-tool`. If you built a Slack approval bot on `--permission-prompt-tool`, this setting bypasses it entirely.
- **The classifier billing notice.** Where auto mode would open a dialog about billed classifier requests, the dialog is skipped and the actions that need those requests are denied.

## Approving calls from code instead of from a person

Turning prompts into denials is only half of an unattended setup. The other half is approving the calls you do want, without a human. Two layers do that, and they run before the deny:

1. **Allow rules and the permission mode.** A call matched by `permissions.allow`, approved by your mode (file edits in `acceptEdits`, for example) or approved by auto mode's classifier never reaches the deny.
2. **A `PermissionRequest` hook.** This hook fires when Claude Code is about to ask, including in sessions that cannot show a prompt. If it returns a decision, that decision wins. If it returns nothing, the call is denied.

Since `canUseTool` and `--permission-prompt-tool` are skipped with the setting on, a `PermissionRequest` hook is the supported way to put code in the approval path. Here is a minimal one that approves `npm` and `pnpm` scripts from an allowlist and denies everything else with a reason Claude can act on:

```json
// ~/.claude/settings.json -- Claude Code 2.1.319+
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "denyInsteadOfPrompting": true
  },
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "python3 ~/.claude/hooks/approve_scripts.py" }
        ]
      }
    ]
  }
}
```

```python
# ~/.claude/hooks/approve_scripts.py -- Python 3.11+, Claude Code 2.1.319+
import json
import re
import sys

ALLOWED = re.compile(r"^(npm|pnpm) (run (lint|test|build)|test|ci)( .*)?$")

event = json.load(sys.stdin)
command = event.get("tool_input", {}).get("command", "").strip()

if ALLOWED.match(command):
    decision = {"behavior": "allow"}
else:
    decision = {
        "behavior": "deny",
        "message": "Only npm/pnpm lint, test, build and ci are allowed in this unattended run.",
    }

json.dump(
    {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}},
    sys.stdout,
)
```

Two details from the [hooks reference](https://code.claude.com/docs/en/hooks#permissionrequest-decision-control) keep this honest. First, a hook's `"allow"` does not override a matching deny rule, so your deny list still wins. Second, a hook that exits 2 without a `decision` object leaves the flow unchanged, which here means the call is denied. You cannot accidentally approve by crashing.

Some calls are denied before any hook is asked. The settings reference calls out a [critical-path removal](https://code.claude.com/docs/en/permission-modes#critical-path-removals-in-each-permission-mode) such as `rm -rf ~` in auto mode with no `ask` rule covering it. That is the behaviour you want.

## denyInsteadOfPrompting vs dontAsk vs --permission-prompts none

These three overlap enough to be confusing. The difference is what decides the calls and how long the choice lasts.

| | `permissions.denyInsteadOfPrompting` | `--permission-mode dontAsk` | `--permission-prompts none` |
| --- | --- | --- | --- |
| What it is | A setting layered on any mode | A permission mode of its own | A `-p` flag |
| Who approves | Your mode (incl. auto's classifier), allow rules, `PermissionRequest` hooks | Allow rules, read-only actions, `PreToolUse` hooks, some mods | Your mode, allow rules, `PermissionRequest` hooks |
| Lasts | Every session that loads the setting | The session | One run |
| Interactive sessions, VS Code, Desktop | Yes | Yes (terminal flag or `defaultMode`) | No, print mode only |
| Minimum version | 2.1.319 | Long-standing | 2.1.259 |

Pick by what you want deciding the grey areas:

- If you want **auto mode's classifier** to keep approving reasonable actions and only want the leftover prompts turned into denials, use `denyInsteadOfPrompting`. `dontAsk` cannot do this because it is a different mode.
- If you want **an exact allowlist** and nothing else, `dontAsk` with `--allowedTools` is still the tightest. The docs' own CI recipe is `claude -p "run the test suite" --permission-mode dontAsk --allowedTools "Bash(npm test)" "Read"`.
- If you have **one scheduled `-p` job** with an SDK host you want bypassed just for that run, `--permission-prompts none` is the narrowest change.

Note that cloud sessions ignore `defaultMode: "dontAsk"` from settings files, while `denyInsteadOfPrompting` is a separate key and not a mode.

## Gotchas before you leave the session alone

**Two dialogs still block.** The workspace trust dialog for a folder you have not opened before, and the approval for project-scoped MCP servers in `.mcp.json`, are not permission prompts. A session can still wait on either. Open the folder interactively once, accept trust, approve the MCP servers, then start the unattended run.

**Plan mode traps the session.** As above, with the plan tools removed, a session in plan mode stays there. Use `acceptEdits`, `auto` or Manual for unattended work.

**Your approval bot goes quiet.** If you rely on `canUseTool` or `--permission-prompt-tool` for human-in-the-loop approvals, turning this on in user settings disables that path for every session on the machine. Use `--permission-prompts none` per run instead, or move the logic into a `PermissionRequest` hook.

**Expect more denials, not fewer.** The first week with the setting on will surface every action you were approving by hand without noticing. Read `permission_denials`, add precise allow rules, and resist adding broad ones like `Bash(*)`. A denial with a clear message is the cheap failure mode. An over-broad allow rule is the expensive one.

**Mods are separate.** The changelog for 2.1.321 notes that mods' own tool calls raise no permission prompt even in `dontAsk` and `-p` runs, while deny rules and organization policy still apply. If a mod you installed calls tools, those calls are governed by its own rules, not by this setting.

**Version-gate it.** On a build agent with an older pinned Claude Code, the key is simply unknown and nothing changes: the session prompts and stalls as before. Check `claude --version` reports 2.1.319 or later on every machine you rely on it for.

## Related reading

If you are moving an existing setup off the old default mode name, the walkthrough on [migrating to Manual permission mode without breaking headless runs](/2026/08/migrate-to-manual-permission-mode-without-breaking-headless-runs/) covers the flags and settings that changed underneath scripts. For what the classifier actually lets through before this setting ever gets a say, see [auto mode vs manual approval in Claude Code](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/). The ordering between hooks and deny rules has its own trap, explained in [why a PreToolUse hook's allow can still be blocked by a deny rule](/2026/09/fix-pretooluse-hook-allow-still-blocked-by-deny-rule/). And for concrete unattended jobs to pair this with, there is [scheduling a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/) and [running a background coding agent that auto-commits and opens a draft PR](/2026/07/run-a-background-coding-agent-that-auto-commits-and-opens-a-draft-pr/).

## Sources

- [Settings reference: `permissions.denyInsteadOfPrompting`](https://code.claude.com/docs/en/settings-reference#permissions-denyinsteadofprompting)
- [Permissions: managing permission modes and rules](https://code.claude.com/docs/en/permissions)
- [Run Claude Code programmatically: turn off permission prompts in unattended runs](https://code.claude.com/docs/en/headless#turn-off-permission-prompts-in-unattended-runs)
- [Permission modes: `dontAsk`, auto mode thresholds, critical paths](https://code.claude.com/docs/en/permission-modes)
- [Hooks reference: `PermissionRequest`](https://code.claude.com/docs/en/hooks#permissionrequest)
- [Agent SDK TypeScript reference: `SDKPermissionDeniedMessage`](https://code.claude.com/docs/en/agent-sdk/typescript#sdkpermissiondeniedmessage)
- [Claude Code changelog, 2.1.319](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
