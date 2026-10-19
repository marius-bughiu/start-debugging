---
title: "How to Make a Claude Code Hook Fail Closed with onFailure: \"block\""
description: "Since Claude Code v2.1.295, a command or HTTP hook can set onFailure to \"block\" so a guard that crashes, times out, cannot start or prints invalid JSON stops the tool call instead of waving it through. Here is the config, what counts as a failure, the events where it does nothing, and the exit-0 trap no setting can catch."
pubDate: 2026-10-19
template: "how-to"
tags:
  - "claude-code"
  - "ai-agents"
  - "hooks"
  - "agent-security"
  - "pretooluse"
---

**Short answer:** add `"onFailure": "block"` next to `type` and `command` (or `url`) in the hook handler. Since Claude Code v2.1.295, released 2026-10-08, a `command` or `http` hook with that field turns any failure into the same outcome as exit code 2: a `PreToolUse` guard that cannot start, times out, exits with a code other than 0 or 2, or returns JSON that fails validation now blocks the tool call, and a `PermissionRequest` hook that fails denies the request. Without the field, every one of those failures is a non-blocking error and the action goes ahead. It does not help a script that swallows its own error and exits 0, so pair it with `set -euo pipefail` and an explicit dependency check.

## Why a guard hook used to fail open

Claude Code hooks have a three-way exit code contract: exit 0 means success (stdout is parsed as JSON if it is a single object), exit 2 means "block this", and anything else is a non-blocking error. The action proceeds and you get a `<event> hook error` notice showing the first line of stderr.

That last rule is the right default for formatters and notifiers. Nobody wants a broken Slack webhook to stop an edit. It is the wrong default for a security guard. If you wrote a `PreToolUse` hook to refuse `rm -rf /`, `git push --force` or `terraform apply` against production, every way that hook can break lets the dangerous command through:

- The script path is wrong after someone moved `.claude/hooks/`, so the shell exits 127.
- `node` throws on an unexpected payload shape and exits 1.
- The hook calls a policy service that hangs, and the default `command` timeout is 600 seconds. After that the timed-out hook does not block; the call continues through the normal permission flow.
- The hook prints `{"decision": 5}` and Claude Code rejects it at schema validation.

In all four cases the agent keeps working and the only trace is a hook error line in the transcript. In a headless run, nobody reads it.

`onFailure` is the per-hook switch that flips this. Two values exist: `"continue"` (the current behaviour, and what you get when the field is unset) and `"block"`.

## The minimal config

Put the field on the handler object, not on the matcher group:

```json
// .claude/settings.json, Claude Code v2.1.295+
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/check-command.js"],
            "timeout": 5,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

Three choices in that snippet matter as much as `onFailure` itself:

- **Exec form.** `args` (available since well before 2.1.295) spawns `node` directly without a shell, so `${CLAUDE_PROJECT_DIR}` never needs quoting and a project path with spaces cannot split into two arguments. Fewer shell layers means fewer ways for the hook to fail in the first place.
- **A short `timeout`.** With `"block"`, a timeout blocks the call. A guard that does a regex check should finish in milliseconds, so 5 seconds is generous. Leaving the 600-second default means a hung guard stalls the agent for ten minutes before refusing.
- **One concern per handler.** `onFailure` is set per handler. A logging hook on the same matcher can stay fail-open while the guard next to it fails closed.

HTTP hooks take the same field:

```json
// Claude Code v2.1.295+
{
  "type": "http",
  "url": "http://localhost:8080/hooks/pre-tool-use",
  "timeout": 5,
  "onFailure": "block"
}
```

For an HTTP hook, a failed connection, a non-2xx status, a timeout, or a 2xx body that is neither empty nor a JSON object all count as failures.

## What counts as a failure, verified

I ran each failure mode against Claude Code 2.1.303 with a `UserPromptSubmit` hook, because a blocked prompt never reaches the model and the result is visible straight from `claude -p`. The same classification applies to `PreToolUse`; only the thing being blocked differs.

```bash
# Claude Code 2.1.303, macOS. t.json holds one UserPromptSubmit handler.
claude -p "say OK" --settings t.json < /dev/null
```

| Handler | Without `onFailure` | With `"onFailure": "block"` |
| --- | --- | --- |
| `"command": "exit 1"` | prompt goes through | `[exit 1]: failed; blocking because onFailure is "block"` |
| `"command": "sleep 10", "timeout": 2` | prompt goes through | `[sleep 10]: timed out; blocking because onFailure is "block"` |
| `"command": "/nope/guard.sh"` | prompt goes through | `failed; blocking ...` plus `/bin/sh: /nope/guard.sh: No such file or directory` |
| script prints `{"decision": 5}` | non-blocking error | `failed; blocking ...` plus `Hook JSON output validation failed`, naming the `decision` field |
| script prints `{"continue": true}` and exits 1 | JSON is honoured | `failed; blocking ...` |
| `"type": "http"` to a closed port | prompt goes through | `failed; blocking ...` plus `connect ECONNREFUSED 127.0.0.1:9` |
| `exit 2` with a reason on stderr | blocked with that reason | blocked with that reason |
| script prints plain text and exits 0 | text added as context | text added as context |

A few rows deserve a closer look.

**Exit 2 is never a "failure".** It already blocks on events that support blocking, and `onFailure` does not change it. Your intentional deny and your broken-guard deny produce different messages, which is useful when reading transcripts later.

**Exit 1 with allow JSON is now a failure.** Without `onFailure`, a hook that prints a valid JSON decision and exits 1 still has its JSON fields applied. With `"block"`, the non-zero exit wins and the action is blocked, even if the JSON said `permissionDecision: "allow"`. The rule to follow: when you return a JSON decision, exit 0. In my test, a script that printed `{"decision":"block","reason":"x"}` and exited 1 was blocked with reason `x`, so a JSON block still reads as a block. The JSON is only overruled when it tries to let something through.

**Plain text is fine.** Stdout that is not a single JSON object is treated as text, not as invalid JSON, and is not a failure. A stray `echo` in your guard will not start blocking everything.

**`claude -p` still exits 0.** The headless process exits 0 even when a hook blocks the prompt. If CI needs to know a guard fired, inspect the output (or use `--output-format stream-json`) instead of the process exit code.

## The trap onFailure cannot close: a script that exits 0 by accident

`onFailure` only acts on failures Claude Code can see. If the guard script itself fails open and exits 0, Claude Code reads that as "no opinion" and lets the call through. This is the shape of the canonical `rm -rf` guard most people copy:

```bash
#!/bin/bash
# naive.sh: fails open when jq is missing
cmd=$(jq -r '.tool_input.command')
if echo "$cmd" | grep -qE 'rm -rf /'; then
  echo "Blocked: destructive command" >&2
  exit 2
fi
exit 0
```

On a machine without `jq` (a fresh CI image, a teammate's Windows box, a devcontainer that dropped it), the assignment fails, bash keeps going because there is no `set -e`, `$cmd` is empty, `grep` finds nothing, and the script reaches `exit 0`:

```text
$ echo '{"tool_input":{"command":"rm -rf /"}}' | PATH=/minimal ./naive.sh
./naive.sh: line 2: jq: command not found
$ echo $?
0
```

Setting `onFailure: "block"` on this hook changes nothing. The fix belongs in the script: give each outcome a distinct exit code and make every unexpected path exit with something other than 0 or 2.

```bash
#!/usr/bin/env bash
# guard.sh, Claude Code 2.1.295+, PreToolUse guard for Bash.
# Exit 0 = no opinion, 2 = deny, anything else = guard is broken.
set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "guard: jq not found on PATH" >&2; exit 3; }

input=$(cat)
cmd=$(jq -er '.tool_input.command' <<<"$input") \
  || { echo "guard: no tool_input.command in payload" >&2; exit 4; }

if grep -qE '(^|[;&|[:space:]])rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f?[[:space:]]+/([[:space:]]|$)' <<<"$cmd"; then
  echo "Blocked by guard.sh: refusing to rm -rf /" >&2
  exit 2
fi

exit 0
```

Run against the same inputs:

```text
rm -rf / with jq        -> exit 2  (deny)
rm -rf / without jq     -> exit 3  (broken, onFailure blocks)
ls -la                  -> exit 0  (no opinion)
{"tool_input":{}}       -> exit 4  (broken, onFailure blocks)
not json                -> exit 4  (broken, onFailure blocks)
```

`jq -e` matters here: without it, a missing field prints `null` and exits 0, and the guard would happily test the string `null`. In Node the equivalent discipline is to not wrap the whole handler in a `try/catch` that logs and returns. Let malformed input throw; the uncaught exception exits 1, which `onFailure: "block"` turns into a block.

```js
// check-command.js, Node 22, Claude Code 2.1.295+
const input = JSON.parse(require("fs").readFileSync(0, "utf8")); // throws on bad JSON -> exit 1
const cmd = input.tool_input.command;                             // throws if tool_input missing
if (typeof cmd !== "string") throw new Error("command is not a string");

if (/\bgit\s+push\b.*--force(?!-with-lease)/.test(cmd)) {
  process.stderr.write("Blocked: use --force-with-lease\n");
  process.exit(2);
}
process.exit(0);
```

## Where onFailure does nothing

The docs list two places where the field is ignored:

- **`Stop`, `SubagentStop`, `TaskCompleted` and `TeammateIdle`.** On these events, exit 2 does not refuse anything; it sends Claude back to keep working. A broken hook there would loop the agent against a check it cannot repair, so Claude Code does not apply `"block"`. If you need a completion gate that fails closed, put the check in CI, not in a `Stop` hook. The failure mode is the same one described in [fixing a coding agent that loops re-running a check it cannot satisfy](/2026/09/fix-coding-agent-loops-re-running-a-check-it-cannot-satisfy/).
- **Background hooks.** A handler with `async` or `asyncRewake` set has already let the action proceed by the time it finishes, so there is nothing to block.

The field is also only defined for `command` and `http` handlers. `prompt`, `agent` and `mcp_tool` handlers do not accept it, which is a good reason not to use an LLM-judged hook as your only security gate.

## Which hooks should fail closed

A useful rule: fail closed when the hook runs before an irreversible action and its job is to refuse things. Fail open when the hook runs after the fact or only observes.

| Hook | Recommended `onFailure` | Why |
| --- | --- | --- |
| `PreToolUse` guard on `Bash`, `Write`, deploy tools | `"block"` | Its whole purpose is to stop a call. |
| `PermissionRequest` auto-approver/denier | `"block"` | A failure denies the request, which is the safe direction. |
| `PostToolUse` formatter or linter | unset | The edit already happened; blocking only confuses the agent. |
| Audit log, telemetry, notifications | unset | Observability must not take down the session. |
| `UserPromptSubmit` | usually unset | `"block"` stops every prompt until the hook is fixed. |

The last row deserves emphasis. A fail-closed `UserPromptSubmit` hook with a missing dependency makes the session unusable, including for asking Claude to fix the hook. Keep fail-closed guards dependency-light, and make sure you can edit `.claude/settings.json` from outside the session.

## Windows: two changes worth knowing

On Windows, shell-form command hooks run through Git Bash. Since v2.1.299, a `PreToolUse` or `PermissionRequest` command hook that sets no `shell` and fails because Git for Windows is not installed blocks the call even without `onFailure`, with this error:

```text
blocking because Git Bash wasn't found and this hook doesn't set "shell" to "powershell", so only exit code 0 or 2 counts as its verdict.
```

If you hit that, the documented fixes are to install Git for Windows or set `CLAUDE_CODE_GIT_BASH_PATH`, switch to exec form with `args` for a single `.exe` plus `"onFailure": "block"`, set `"shell": "powershell"` plus `"onFailure": "block"` for PowerShell hooks, or set `"onFailure": "continue"` explicitly when the action really should proceed on failure. That last option is the only reason to ever write `"continue"` by hand.

The same release also changed plugin hooks: actions a plugin hook can block are now refused, not let through, when the hook cannot be handed them.

## Rolling it out without bricking sessions

1. **Upgrade first.** Older versions ignore the unknown field: the same `exit 1` hook with `"onFailure": "block"` let the prompt straight through on Claude Code 2.1.197. Below 2.1.295 your `"block"` is a silent no-op. Check with `claude --version`.
2. **Harden the scripts** with distinct exit codes and dependency checks, as above, before turning on `"block"`. Otherwise you trade "guard silently off" for "agent silently stuck".
3. **Add a short `timeout`** to every fail-closed handler.
4. **Test the failure path on purpose.** Temporarily rename the guard script, ask the agent to run `ls`, and confirm you see `failed; blocking because onFailure is "block"`. Restore the script and confirm `ls` runs.
5. **Audit for gaps.** A quick check for guards that still fail open:

```bash
# Lists PreToolUse/PermissionRequest command or http handlers without onFailure: "block".
jq -r '.hooks | to_entries[]
  | select(.key == "PreToolUse" or .key == "PermissionRequest")
  | .key as $e | .value[] | .matcher as $m | .hooks[]
  | select((.type == "command" or .type == "http") and .onFailure != "block")
  | "\($e) \($m // "*"): \(.command // .url)"' .claude/settings.json
```

Run it against user, project and managed settings. It cannot find scripts that swallow errors and exit 0; only reading the scripts finds those.

`onFailure` also composes with the rest of the permission system rather than replacing it. A hook `allow` still cannot override a deny rule, as covered in [why a PreToolUse allow is still blocked by a deny rule](/2026/09/fix-pretooluse-hook-allow-still-blocked-by-deny-rule/), and a fail-closed guard is one layer next to permission modes and network controls, not a substitute for them.

## Related

- [Auto mode vs manual approval in Claude Code: what each mode actually allows through](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/), for what reaches your hooks in the first place.
- [PreModelSwitch: Claude Code can now veto a model change](/2026/08/claude-code-premodelswitch-hook-gates-model-changes/), another blocking hook event.
- [Migrate a Claude Code setup to manual permission mode without breaking headless runs](/2026/08/migrate-to-manual-permission-mode-without-breaking-headless-runs/), useful when guards run in CI.
- [How to lock down a coding agent's network egress with a strict host allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/), the layer to add when a shell guard is not enough.

### Sources

- [Hooks reference](https://code.claude.com/docs/en/hooks), Claude Code docs: the `onFailure` section, exit code output, hook handler fields and default timeouts.
- [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), entries for 2.1.295 (`onFailure: "block"`) and 2.1.299 (Windows Git Bash and plugin hook fail-closed changes).
- [Claude Code v2.1.294 to v2.1.295 updates](https://dev.classmethod.jp/en/articles/20261009-cc-updates-v2-1-295/), DevelopersIO, with the first public `UserPromptSubmit` test.
- [Claude Lab on the jq-missing fail-open case](https://claudelab.net/en/articles/claude-code/claude-code-hook-onfailure-block-jq-missing-fail-open-decision), which tested missing scripts, uncaught Node exceptions and hangs.
