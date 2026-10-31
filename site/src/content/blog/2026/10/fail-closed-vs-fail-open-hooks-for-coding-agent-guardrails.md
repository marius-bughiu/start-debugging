---
title: "Fail-Closed vs Fail-Open Hooks for Coding Agent Guardrails: What Claude Code, Cursor, Copilot, Codex and Gemini CLI Actually Do"
description: "A guard hook that crashes or times out lets the dangerous command through in most coding agents. Fail closed for pre-action guards, fail open for everything else, and make the script fail closed by itself because Copilot, Codex and Gemini CLI treat a timeout as allow. Compared on Claude Code 2.1.295+, Cursor hooks, Copilot CLI 1.0.105, Codex and Gemini CLI, with a portable guard script."
pubDate: 2026-10-31
template: vs
tags:
  - "comparison"
  - "ai-agents"
  - "claude-code"
  - "cursor"
  - "github-copilot"
  - "hooks"
  - "agent-security"
  - "pretooluse"
---

**Short answer:** fail closed for any hook that runs before an irreversible action and exists to refuse things (a `PreToolUse` guard on shell, deploy or write tools). Fail open for everything that formats, logs, notifies or runs after the fact. The catch is that each agent applies a different default and a different switch. Claude Code fails open unless the handler sets `"onFailure": "block"` (v2.1.295+). Cursor fails open unless the hook sets `"failClosed": true`. Copilot CLI (1.0.105) already denies when a `preToolUse` command hook crashes, but lets the call through when it times out, and has no setting to change that. Codex and Gemini CLI have no fail-closed switch at all. So the only portable answer is a guard script that fails closed by itself: it turns its own errors into exit 2 and answers before the host's timeout fires.

## Why every agent defaults to fail-open

A hook is a user-supplied process sitting in the agent's hot path. If a broken Prettier hook or a dead Slack webhook could stop the agent, every misconfigured laptop would have a stuck agent, and the vendor would get the bug report. So every tool started with the same rule: exit 2 means "block", exit 0 means "fine", and anything else is a hook error that gets logged and skipped.

That is the right default for 90% of hooks and the wrong one for the 10% that matter. A `PreToolUse` guard that refuses `git push --force` fails open in all of these ordinary situations:

- The script moved, and the shell exits 127.
- `jq` is missing on a fresh CI runner, and the script exits 1.
- The guard calls a policy service that hangs past the hook timeout.
- The guard prints malformed JSON after a refactor.

In each case the agent runs the forced push, and the only trace is a warning line nobody reads in a headless run. A guardrail that quietly turns off when it breaks is not a guardrail.

## The feature matrix

| Behaviour on a `PreToolUse`-style guard | Claude Code 2.1.295+ | Cursor (hooks docs, Oct 2026) | Copilot CLI 1.0.105 | Codex | Gemini CLI |
| --- | --- | --- | --- | --- | --- |
| Exit 2 | Block | Block | Deny | Block | Block (turn continues) |
| Crash / other non-zero exit | Proceeds | Proceeds | **Deny** ("hook errored") | Not documented | Proceeds with warning |
| Timeout | Proceeds | Proceeds | **Proceeds, always** | Not documented (managed MCP hooks proceed) | Not documented |
| Invalid JSON on exit 0 | Non-blocking error | **Blocks** for permission hooks | Treated as no output, default flow | Hook marked failed, call continues | Defaults to allow |
| Per-hook fail-closed switch | `"onFailure": "block"` | `"failClosed": true` | None | None | None |
| Switch also covers timeouts | Yes | Yes | n/a | n/a | n/a |
| Default timeout | 600 s (command) | Platform default | 30 s (`timeoutSec`) | 600 s | 60 s (60000 ms) |
| HTTP hook on network error | Proceeds (blocks with `onFailure`) | n/a | Proceeds | n/a | n/a |

Three columns in that table surprise people:

- **Copilot is already half fail-closed.** Its CLI hooks reference says command `preToolUse` hooks are fail-closed on errors: a crash or non-zero exit denies the tool call, even if stdout says `"permissionDecision": "allow"`. Timeouts are the exception. The docs say timeouts are always fail-open, "even for `preToolUse` and admin-deployed policy hooks", so a slow hook cannot block work. HTTP `preToolUse` hooks fail open on everything.
- **Cursor blocks on bad JSON even without the switch.** For permission hooks (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `preToolUse` and a few others), invalid JSON or a response that does not match the schema blocks the action. Crashes and timeouts still fail open until you set `failClosed`.
- **Codex and Gemini CLI give you nothing to flip.** Codex documents that unsupported output fields mark the hook failed "and continue the tool call", and its MCP tool hooks state that errors "don't block the operation". Gemini CLI documents any exit code other than 0 and 2 as "a non-fatal failure", and invalid stdout "will default to 'Allow'".

## When a hook should fail closed

The rule I use: **fail closed when the hook runs before an action you cannot undo and its job is to say no.** Everything else fails open.

| Hook | Fail mode | Reason |
| --- | --- | --- |
| Shell guard (`PreToolUse` on Bash, `beforeShellExecution`, `preToolUse` on `bash`) | Closed | Its only job is to stop a call. A silent pass is the worst outcome. |
| MCP tool guard (`beforeMCPExecution`, `PreToolUse` on `mcp__*`) | Closed | MCP tools reach production systems the shell guard never sees. |
| Secret or path read guard (`beforeReadFile`) | Closed | A read of `.env` cannot be taken back once it is in the context. |
| Permission auto-approver (`PermissionRequest`) | Closed | Failing closed denies, which is the safe direction. |
| Formatter, linter (`PostToolUse`, `afterFileEdit`) | Open | The edit already happened. Blocking only confuses the agent. |
| Audit log, telemetry, notifications | Open | Observability must not take down the session. |
| Prompt gate (`UserPromptSubmit`) | Usually open | Fail-closed here locks you out of asking the agent to fix the hook. |
| Stop / completion gate | Open, move the check to CI | A broken gate loops the agent against a check it cannot repair. |

The last two rows are where fail-closed hurts most. A fail-closed prompt hook with a missing dependency makes the session unusable. A completion gate that blocks on failure produces exactly the loop described in [fixing a coding agent that loops re-running a check it cannot satisfy](/2026/09/fix-coding-agent-loops-re-running-a-check-it-cannot-satisfy/). Claude Code knows this and ignores `onFailure` on `Stop`, `SubagentStop`, `TaskCompleted` and `TeammateIdle`.

## A guard that fails closed by itself

Because Copilot, Codex and Gemini CLI let a timed-out hook through, and two of them have no switch at all, the host setting cannot be your only line of defence. Make the script fail closed on its own. The script below is the pattern I now use for every repo that runs more than one agent:

```bash
#!/usr/bin/env bash
# scripts/agent-guard.sh, tested with bash 3.2.57 (macOS) and jq 1.7.1
# Exit 0 = no objection. Exit 2 = deny. Every other outcome is turned into exit 2.
# Usage: agent-guard.sh [cursor]   (pass "cursor" when Cursor runs it natively)
set -uo pipefail

check() {
  set -e
  command -v jq >/dev/null || { echo "guard: jq not installed" >&2; return 3; }
  local payload cmd
  payload=$(cat)
  # Claude Code, Codex, Gemini CLI, Cursor (Claude format): .tool_input.command
  # Copilot CLI camelCase preToolUse: .toolArgs (a JSON string or an object)
  # Cursor beforeShellExecution: .command
  cmd=$(jq -r '.tool_input.command
               // (.toolArgs | if type == "string" then (fromjson? // {}) else . end | .command?)
               // .command
               // empty' <<<"$payload")
  [[ -n "$cmd" ]] || return 0          # not a shell call: no opinion
  if grep -Eq '(^|[;&| ])(rm -rf /|git push (-f|--force)|terraform apply)' <<<"$cmd"; then
    echo "guard: blocked: $cmd" >&2
    return 2
  fi
  return 0
}

# Run the check in the background so a signal can interrupt the wait.
check <&0 &
pid=$!
# Answer before the host's own timeout: several hosts treat a timeout as allow.
( sleep "${GUARD_DEADLINE:-4}"; kill -TERM "$pid" 2>/dev/null ) &
watchdog=$!

wait "$pid"; rc=$?
kill "$watchdog" 2>/dev/null

case $rc in
  0) # Cursor's failClosed counts "no output" as a failure, so say allow out loud.
     [[ "${1:-}" == "cursor" ]] && echo '{"permission": "allow"}'
     exit 0 ;;
  2) exit 2 ;;
  *) echo "guard: check failed or timed out (rc=$rc), denying" >&2; exit 2 ;;
esac
```

The design choices, each one tied to a row of the matrix:

- **Exit 2 is the only "no".** All five agents read exit 2 as block on their pre-tool event. A JSON deny is not portable (Copilot wants `permissionDecision`, Cursor wants `permission`, Gemini wants `decision`), but exit 2 with a reason on stderr is.
- **Any unexpected exit code becomes exit 2.** A missing `jq`, a parse error or a bug in the regex no longer reaches the host as exit 1, which four of five hosts would wave through.
- **The watchdog answers before the host times out.** This was the part I first got wrong. A `trap` on a signal does not fire while bash waits on a foreground child, so a `trap ... USR1` version with a 1-second deadline still took 6 seconds to answer when its stdin stalled. Running `check` in the background and calling `wait`, which a signal does interrupt, fixed it. Keep `GUARD_DEADLINE` well under the smallest host timeout you configure.
- **Cursor gets an explicit allow.** Cursor's `failClosed` description lists "no output" next to crash and timeout as a failure. A guard that exits 0 silently is fine everywhere else, but print `{"permission": "allow"}` for Cursor's native hooks.

I ran the failure paths on macOS against payloads in each host's shape:

| Input | Result |
| --- | --- |
| `{"tool_input":{"command":"ls -la"}}` | exit 0 |
| Claude-shape `git push --force origin main` | exit 2, `guard: blocked: ...` |
| Copilot `toolArgs` as a JSON string with `rm -rf /` | exit 2 |
| Copilot `toolArgs` as an object with `git push -f` | exit 2 |
| Cursor `{"command":"terraform apply"}` | exit 2 |
| Edit payload with no command | exit 0 |
| `nope` (not JSON) | exit 2, `rc=5` from jq |
| `PATH=/bin` (no jq) | exit 2, `jq not installed` |
| stdin stalls 6 s, `GUARD_DEADLINE=1` | exit 2 after 1 s |

One trap in testing: macOS 15 and later ship `/usr/bin/jq`, so `PATH=/bin:/usr/bin` does not simulate a missing dependency. Use `PATH=/bin`.

## Wiring the same script into each agent

Point every agent at the one script and add the host switch where one exists. The host switch is the second layer. If the script itself dies before it can run (wrong path, no `bash`), only the host setting catches it.

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
            "command": "bash",
            "args": ["${CLAUDE_PROJECT_DIR}/scripts/agent-guard.sh"],
            "timeout": 10,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

The full Claude Code side, including what counts as a failure and where `onFailure` is ignored, is in [how to make a Claude Code hook fail closed with onFailure: "block"](/2026/10/how-to-make-a-claude-code-hook-fail-closed-with-onfailure-block/). Below 2.1.295 the field is silently ignored.

```json
// .cursor/hooks.json, Cursor hooks (docs as of October 2026)
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [
      {
        "command": "bash scripts/agent-guard.sh cursor",
        "timeout": 10,
        "failClosed": true
      }
    ]
  }
}
```

`failClosed` defaults to `false`. The Cursor docs describe it as making "hook failures (crash, timeout, non-zero exit code, no output) block the action instead of allowing it through." Enterprise, team, project and user hook files all merge, and a `deny` from any of them wins.

```json
// .github/hooks/agent-guard.json, Copilot CLI 1.0.105
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "bash scripts/agent-guard.sh",
        "timeoutSec": 10
      }
    ]
  }
}
```

There is no fail-closed field to add here. Crashes already deny. Timeouts always pass, which is why the script's 4-second watchdog has to sit under `timeoutSec`. Use a command hook, not an HTTP hook, for a guard: HTTP `preToolUse` hooks fall through to the normal permission flow on any network error, timeout or non-2xx response.

For Codex and Gemini CLI, register the same script on `PreToolUse` and `BeforeTool` respectively. With no host switch, the script's own fail-closed logic is all the protection you get, so keep its dependencies minimal.

## The gotcha that picks for you: one `.claude/settings.json`, three behaviours

Here is the case that pushed me to write the script-side pattern. Cursor and Copilot both read hooks from a repository's `.claude/settings.json`:

- **Claude Code** honours `"onFailure": "block"`, so the guard fails closed.
- **Cursor** loads Claude hooks through "Third-Party Imports", which is on by default. Its third-party hooks page lists "Other exit codes: Hook failed, action proceeds (fail-open)" and never mentions `failClosed`. A [Cursor forum bug report from 2026-09-28](https://forum.cursor.com/t/cursor-agent-imported-claude-code-plugin-hooks-get-a-cursor-shaped-payload-so-pretooluse-gates-fail-open/173171) found imported hooks on cursor-agent 2026.09.26 are always converted with `failClosed: false` and get a Cursor-shaped payload (`tool_name` is `Shell`, not `Bash`), so a `Bash` matcher never fires. Cursor staff replied that this is "not intended behavior".
- **Copilot CLI** reads the same file with Claude-format matchers and its own failure rules: a crash denies, a timeout passes, and `onFailure` is not part of its schema.

So the same committed guard is fail-closed in one agent, fail-open (or not even triggered) in the second, and half fail-closed in the third. If your team runs more than one agent on a repo, do not trust a hook file shared across tools. Register the guard natively in each tool's own hook file, and let the script carry the fail-closed logic.

## Gotchas that bite after you switch to fail-closed

- **A JSON allow with a non-zero exit is a deny in two places.** Claude Code with `onFailure: "block"` and Copilot by default both deny a hook that prints `"allow"` and exits 1. When you return a JSON decision, exit 0.
- **Copilot drops a hook that prints two JSON objects.** Two `echo '{"permissionDecision": ...}'` lines concatenate into invalid JSON, which Copilot treats as no output, so the default flow runs. Emit exactly one object.
- **Cursor can cancel a hook before it starts.** A [Cursor forum feature request from 2026-08-17](https://forum.cursor.com/t/add-afterpretoolusefailure-hook-when-a-pre-tool-hook-itself-fails/168653) reports that a `beforeShellExecution` hook canceled by Cursor itself, combined with `failClosed: true`, blocks every following Shell call, and that no hook event fires when a pre-tool hook fails. Give fail-closed hooks a way to recover: keep the hook files editable from outside the agent.
- **A script that swallows its own error and exits 0 beats every host setting.** `cmd=$(jq ...) || true` turns a parse failure into "no opinion". No `onFailure` or `failClosed` can see that. Only the script can fail closed against its own bugs.
- **Fail-closed is one layer.** A hook allow still cannot override a deny rule, as covered in [why a PreToolUse allow is still blocked by a deny rule](/2026/09/fix-pretooluse-hook-allow-still-blocked-by-deny-rule/). A regex on command strings is also easy to dodge, so pair the guard with OS-level controls such as [Copilot local sandboxing](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/) or a [strict network egress allowlist](/2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist/).

## The recommendation, restated

Make guards fail closed and everything else fail open. Do not rely on the host for it. Write the guard so every unexpected outcome becomes exit 2 and it answers before the shortest host timeout. Then add `"onFailure": "block"` in Claude Code and `"failClosed": true` in Cursor as the second layer that catches a script that cannot even start. On Copilot, Codex and Gemini CLI the script is the only layer you control, so test its failure paths on purpose: rename `jq` out of the path, feed it garbage, stall its stdin, and confirm every case ends in a denial.

## Related

- [How to make a Claude Code hook fail closed with onFailure: "block"](/2026/10/how-to-make-a-claude-code-hook-fail-closed-with-onfailure-block/), the single-agent deep dive.
- [How to observe a Cursor cloud agent's prompts, thinking and subagents with hooks](/2026/07/observe-cursor-cloud-agent-prompts-thinking-subagents-with-hooks/), for the fail-open observability side.
- [Fix: a PreToolUse hook allow is still blocked by a deny rule](/2026/09/fix-pretooluse-hook-allow-still-blocked-by-deny-rule/).
- [How to turn on Copilot local sandboxing and restrict what an agent can touch](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/).
- [Fix: a coding agent loops re-running a check it cannot satisfy](/2026/09/fix-coding-agent-loops-re-running-a-check-it-cannot-satisfy/).

## Sources

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Cursor hooks documentation](https://cursor.com/docs/agent/hooks) and [Cursor third-party hooks](https://cursor.com/docs/reference/third-party-hooks)
- [GitHub Copilot CLI hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference) and [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)
- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Gemini CLI hooks](https://geminicli.com/docs/hooks/) and [Gemini CLI hooks reference](https://geminicli.com/docs/hooks/reference/)
- [Cursor forum: imported Claude Code plugin hooks fail open](https://forum.cursor.com/t/cursor-agent-imported-claude-code-plugin-hooks-get-a-cursor-shaped-payload-so-pretooluse-gates-fail-open/173171)
- [Cursor forum: add afterPreToolUseFailure when a pre-tool hook itself fails](https://forum.cursor.com/t/add-afterpretoolusefailure-hook-when-a-pre-tool-hook-itself-fails/168653)
