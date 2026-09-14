---
title: "Fix: a coding agent loops forever re-running a check it can't satisfy"
description: "When a Stop hook, /goal condition, or CI-style gate demands a check the agent's environment can never pass, Claude Code keeps re-running it until the 8-consecutive-block cap (2.1.143+) ends the turn. Here is why it happens and the hook patterns that let the agent give up correctly."
pubDate: 2026-09-14
template: error-page
tags:
  - "claude-code"
  - "ai-agents"
  - "hooks"
  - "stop-hook"
  - "agent-loops"
---

**Short answer:** the agent is not stupid, your gate is. A Stop hook (or a `/goal` condition, or a "run the tests before you finish" rule) that blocks on a check the agent has no way to pass, such as integration tests that need a database the sandbox does not have, turns every attempt to finish into another instruction to try again. On Claude Code 2.1.143 and later the loop ends after 8 consecutive blocks with a warning. Before that it ran until you pressed Esc or the budget ran out. The fix is to make the gate tell "failed" apart from "cannot run here", give it a memory so an identical failure is not retried forever, and put hard ceilings (`--max-turns`, `--max-budget-usd`, `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) on anything headless.

Everything below targets Claude Code 2.1.270 (the current release on 2026-09-14). The hook fields it relies on are `stop_hook_active` and the 8-block cap (2.1.143+), plus `hookSpecificOutput.additionalContext` on Stop (2.1.163+).

## What the loop looks like

The shape varies, but the transcript always reads the same way: the agent runs a command, it fails, the agent says it has fixed the problem, and then it runs the same command again. Three variants show up in bug reports and in my own sessions:

1. **A gate that cannot be satisfied.** A Stop hook runs `npm run test:integration`, which needs Postgres. The agent's sandbox has no Postgres. The hook blocks with "tests failed, fix them", the agent edits code that was already correct, re-runs the tests, gets `ECONNREFUSED 127.0.0.1:5432`, tries to stop, and gets blocked again.
2. **An identical failing tool call.** No hook involved: the model simply re-issues the same command. [anthropics/claude-code#19699](https://github.com/anthropics/claude-code/issues/19699) shows Claude Code 2.1.12 on `claude-opus-4-5-20251101` running the same `ssh ... "make run-runner"` seven times in a row after `No rule to make target 'run-runner'`, without changing a character.
3. **A polling loop that feeds itself.** [anthropics/claude-code#90930](https://github.com/anthropics/claude-code/issues/90930) (Claude Code 2.1.236, opened 2026-08-31) describes an agent that waited for subagents by backgrounding `sleep N; echo ok`. Each finished sleep re-woke the agent, which scheduled another sleep. One `/code-review` run took 33 minutes of wall clock, the last 5 of which were pure timer noise, and needed a manual `TaskStop`.

The first variant is the one you cause, and the one you can fix completely, so most of this post is about it.

## Why the agent can't get out on its own

A Stop hook that returns `{"decision": "block", "reason": "..."}` does not just veto the stop. Per the [hooks reference](https://code.claude.com/docs/en/hooks#stop-decision-control), the `reason` is delivered to Claude as its next instruction. So when your hook says "check.sh failed: DATABASE_URL is not set. Fix it before finishing.", the model does exactly what a diligent engineer would do with that sentence from their lead: it looks for something to fix. There is nothing to fix in the code, so it reruns the check to see if the problem went away, or it "fixes" something harmless to have something to report.

Three properties combine to make this a loop instead of a single wasted turn:

- **The failure is environmental.** No edit the agent can make changes the result. It has no tool that starts Postgres, no network route to your staging database, or no permission to run the command at all.
- **The gate has no memory.** A typical hook script is stateless. It runs the check, sees a failure, and blocks. Call nine is indistinguishable from call one.
- **The instruction says "fix".** The reason text frames an environment problem as a code problem, which rules out the one correct answer: stop and tell the human.

## A minimal repro

This is the smallest setup that reproduces variant 1. The check needs a database the environment does not have:

```bash
#!/bin/sh
# check.sh: integration check that needs a database the agent's sandbox does not have.
if [ -z "$DATABASE_URL" ]; then
  echo "integration: DATABASE_URL is not set, cannot reach Postgres" >&2
  exit 1
fi
echo "integration: ok"
```

The gate is the kind of Stop hook that gets copy-pasted into a lot of repositories:

```bash
#!/bin/sh
# .claude/hooks/require-check.sh: naive gate. Claude Code 2.1.x
out=$(cd "$CLAUDE_PROJECT_DIR" && ./check.sh 2>&1)
if [ $? -ne 0 ]; then
  jq -n --arg r "check.sh failed: $out. Fix it before finishing." '{decision:"block", reason:$r}'
fi
```

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/require-check.sh" } ] }
    ]
  }
}
```

I drove this hook with the exact Stop input Claude Code sends (`session_id`, `hook_event_name: "Stop"`, `stop_hook_active` set to `false` on the first call and `true` after that), nine times in a row, with `DATABASE_URL` unset. The headless CLI on this machine was not logged in, so this is a hook harness, not a live model loop. That is enough here, because the hook's output is the only thing that decides whether the turn can end:

| Call | `stop_hook_active` | Naive gate returns |
| --- | --- | --- |
| 1 | `false` | `decision: "block"` |
| 2 to 8 | `true` | `decision: "block"` every time |
| 9 | `true` | `decision: "block"` |

The gate never lets go. What ends the loop in a real session is not your hook but Claude Code itself: since 2.1.143 the [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) entry reads "the turn now ends with a warning after 8 consecutive blocks", and the [hooks guide](https://code.claude.com/docs/en/hooks-guide#stop-hook-hits-the-block-cap) documents it under "Stop hook hits the block cap". So each time the agent tries to finish, you pay for up to eight extra model turns, each one re-running a check that cannot pass. On Claude Code older than 2.1.143 there is no cap at all.

## Fix 1: make "cannot run here" a distinct outcome

The most effective fix lives in the check, not in the agent. Give "this environment cannot run me" its own exit code, and let the gate treat it as a pass-with-warning. `78` is `EX_CONFIG` from `sysexits.h`, which is as close to a convention as shell scripts have:

```bash
#!/bin/sh
# check.sh: integration check that needs a database the agent's sandbox does not have.
if [ -z "$DATABASE_URL" ]; then
  echo "integration: DATABASE_URL is not set, cannot reach Postgres" >&2
  exit 78   # EX_CONFIG: this environment cannot run the check
fi
echo "integration: ok"
```

In the hook, exit 78 allows the stop and uses `systemMessage` so the human sees why the gate stepped aside. `systemMessage` is shown to the user and does not become an instruction for Claude:

```bash
if [ $code -eq 78 ]; then
  jq -n --arg m "Stop gate skipped: $out" '{systemMessage:$m}'
  exit 0
fi
```

Re-running the same nine-call harness against this version, every call returned `{"systemMessage": "Stop gate skipped: integration: DATABASE_URL is not set, cannot reach Postgres"}` and no `decision` field, so the turn ends on the first attempt. The same idea applies to any gate: a missing API key, a missing Docker socket, or a test that requires a GPU should say so explicitly instead of failing like a broken assertion.

## Fix 2: give the gate a memory

Environment detection does not catch everything. Sometimes the check really does fail on the code, but the agent has already shown it cannot fix it. The gate needs to remember what it saw last time. Here is the full hook, combining both fixes:

```bash
#!/usr/bin/env bash
# .claude/hooks/require-check.sh: gate that knows when to give up.
# Claude Code 2.1.143+ (stop_hook_active, 8-block cap), jq 1.7
set -u
input=$(cat)
session=$(jq -r .session_id <<<"$input")
state="${TMPDIR:-/tmp}/stop-gate-$session"

out=$(cd "$CLAUDE_PROJECT_DIR" && ./check.sh 2>&1); code=$?
if [ $code -eq 0 ]; then rm -f "$state"; exit 0; fi

# 1. The environment cannot run the check: no amount of editing will fix that.
if [ $code -eq 78 ]; then
  jq -n --arg m "Stop gate skipped: $out" '{systemMessage:$m}'
  exit 0
fi

# 2. Same failure as last time: the agent already had its chance.
sig=$(printf '%s' "$out" | shasum | cut -c1-12)
prev=$(cat "$state" 2>/dev/null || true)
echo "$sig" > "$state"
if [ "$sig" = "$prev" ]; then
  jq -n --arg m "Stop gate gave up: identical failure twice ($out)" '{systemMessage:$m}'
  exit 0
fi

jq -n --arg r "check.sh failed (exit $code): $out" '{decision:"block", reason:$r}'
```

With `check.sh` switched back to `exit 1`, the harness shows the intended behaviour: call 1 blocks with the failure text, call 2 sees the same fingerprint and lets the agent stop with "Stop gate gave up: identical failure twice". If the agent's edit changes the failure (a different assertion fails, a new error appears), the fingerprint changes and the gate blocks again, so real progress still gets another round.

Why not the one-liner from the docs? The hooks guide suggests exiting early when `stop_hook_active` is `true`. That works, but it is blunt: it allows exactly one continuation per stop attempt, regardless of whether the agent is converging. The fingerprint version allows as many rounds as the agent keeps producing *different* results, and stops as soon as it is going in circles. Both are far better than a gate with no exit.

Two details matter in the hook:

- **Keep the reason neutral.** "check.sh failed (exit 1): <output>" gives the model facts. "Fix it before finishing" gives it an order that assumes the fix exists in the code.
- **Key state by `session_id`.** Two parallel sessions in the same repository must not share a fingerprint file, or one agent's failure will release the other's gate.

## Fix 3: catch identical failing commands inside a turn

Variant 2 never reaches the Stop hook, because the model re-runs the command inside the same turn. `PostToolUseFailure` fires after every tool call that started and failed, and its input carries the command and an `error` string whose first line is `Exit code N` for Bash. You can count identical failures and inject a nudge through `additionalContext`:

```bash
#!/usr/bin/env bash
# .claude/hooks/repeat-failure.sh: PostToolUseFailure, matcher "Bash". Claude Code 2.1.143+
set -u
input=$(cat)
session=$(jq -r .session_id <<<"$input")
key=$(jq -r '[.tool_input.command, (.error | split("\n")[0:3] | join("\n"))] | @json' <<<"$input" | shasum | cut -c1-12)
log="${TMPDIR:-/tmp}/repeat-fail-$session"
echo "$key" >> "$log"
count=$(grep -c "^$key\$" "$log")
if [ "$count" -ge 3 ]; then
  jq -n --arg c "$(jq -r .tool_input.command <<<"$input")" --argjson n "$count" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUseFailure",
      additionalContext: "You have run `\($c)` \($n) times and it failed the same way each time. Do not run it again unchanged. Either change the command or the code it depends on, or stop and report what blocks you."
    }
  }'
fi
```

```json
{
  "hooks": {
    "PostToolUseFailure": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/repeat-failure.sh" } ] }
    ]
  }
}
```

Fed four identical failures of `npm run test:integration` with `Error: connect ECONNREFUSED 127.0.0.1:5432`, the hook stayed silent on calls 1 and 2 and returned the nudge on calls 3 and 4. Only the first three lines of the error go into the key, because Claude Code middle-truncates long output and can append lines like `Command timed out after 2m 0s`, which would otherwise make two identical failures look different.

Know the blind spots: per the [reference](https://code.claude.com/docs/en/hooks#posttoolusefailure), `PostToolUseFailure` does not fire for permission denials or for tool input that fails validation. A loop of denied calls needs a `PreToolUse` or `PermissionDenied` hook instead.

## Fix 4: let a model-evaluated gate say "impossible"

If your gate is a prompt-based Stop hook or a `/goal` condition, a small fast model decides whether the agent may stop, and it needs an explicit way out. The [prompt hook response schema](https://code.claude.com/docs/en/hooks#response-schema) has one: `{"ok": false, "reason": "...", "impossible": true}`. On `Stop` and `SubagentStop`, `impossible: true` lets the turn end instead of feeding the reason back. Say so in the prompt, or the evaluator will almost never use it:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Decide whether Claude may stop. Input: $ARGUMENTS\nReturn {\"ok\": true} if the integration tests passed. If they failed for a reason Claude cannot change from this environment (missing service, missing credentials, no network), return {\"ok\": false, \"reason\": \"...\", \"impossible\": true}. Otherwise return {\"ok\": false, \"reason\": \"...\"}."
          }
        ]
      }
    ]
  }
}
```

`/goal` is a wrapper around exactly this kind of session-scoped prompt hook. According to the [`/goal` docs](https://code.claude.com/docs/en/goal), the goal clears itself when the evaluator judges the condition impossible, and Claude Code stops the loop when Claude keeps answering the evaluator without tool use for several turns. The evaluator only reads the transcript, it does not run anything itself. So "all tests in `test/integration` pass" in a sandbox without a database is a goal that can only end by being judged impossible. Append a bound such as `or stop after 20 turns` to any goal you leave running.

## Fix 5: hard ceilings for anything headless

Hooks fix the cause. Ceilings cap the damage when you did not anticipate the cause. For `claude -p` in CI or on a schedule, set both:

```bash
# Claude Code 2.1.217+ for the budget to also cover and stop subagents
claude -p "Fix the failing unit tests in src/billing" \
  --max-turns 30 \
  --max-budget-usd 3.00 \
  --output-format json
```

`--max-turns` exits with an error when reached. `--max-budget-usd` counts subagent spend and, from 2.1.217, stops running background subagents at the cap. In the Agent SDK the same limits are `maxTurns` / `max_turns` and `maxBudgetUsd` / `max_budget_usd`, and the result arrives as `error_max_turns` or `error_max_budget_usd`, which a scheduler should treat as "needs a human", not "retry" ([agent loop docs](https://code.claude.com/docs/en/agent-sdk/agent-loop#turns-and-budget)).

Claude Code also ships its own circuit breakers, which are worth knowing so you can tell them apart from your hooks:

- `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises or lowers the 8-consecutive-block cap. Lower it for CI, where one extra round is usually all a gate deserves.
- Since 2.1.212 there is a session-wide cap of 200 WebSearch calls (`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`) and 200 subagent spawns (`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`).
- In auto mode, 3 consecutive or 20 total classifier blocks pause auto mode and fall back to prompting ([permission modes](https://code.claude.com/docs/en/permission-modes)). These thresholds are not configurable.
- Since 2.1.246, a subagent that hits its `maxTurns` returns its output marked as partial instead of looking finished, so the parent does not treat a truncated result as success.

## Gotchas that recreate the loop

- **An untrusted workspace ignores project allow rules.** When I first ran the repro headless, Claude Code 2.1.197 printed "Ignoring 3 permissions.allow entries from .claude/settings.json: this workspace has not been trusted." If the agent is not allowed to run `./check.sh` but a Stop hook demands that it passes, you have built variant 1 out of permissions instead of a missing database. Accept the trust dialog once, or check that the command the gate needs is actually runnable in that mode.
- **Blocked Stop hooks used to be expensive per round.** 2.1.259 fixed blocking Stop hooks dropping the model's reasoning from the blocked turn and, on some models, missing the prompt cache. If you are on an older build, every round of the loop cost more than it should have. That is one more reason to upgrade before tuning the cap.
- **Polling is a loop too.** For variant 3, end the turn after fanning out work and let task notifications wake the agent, or use `Monitor`, instead of backgrounded `sleep` calls. Stop hooks can check `background_tasks` in their input to tell "done" from "waiting".
- **Cursor has its own breaker.** Cursor surfaces "Unrecoverable agent model looping detected." when it catches a loop. Cursor staff's advice in the [forum thread](https://forum.cursor.com/t/bricked-unrecoverable-agent-model-looping-detected/132538) is to start a new chat, because a conversation that has already looped is more likely to loop again. The hook-side fix does not carry over, but the root cause does: a success condition the agent cannot verify from where it runs.

If you do only one thing, change the check's exit code and the reason text. An agent that is told "this cannot run here" stops and says so, and that is the behaviour you wanted from the gate in the first place.

## Related

- The other "why won't it stop" banner is different: [Claude reached its tool-use limit for this turn](/2026/05/fix-claude-reached-its-tool-use-limit-for-this-turn/) is a `pause_turn` pause, not a loop.
- Context loops look similar from the outside: [autocompact thrashing on a large file or tool output](/2026/07/fix-claude-code-autocompact-thrashing-on-large-file-or-tool-output/).
- Which calls get through without you: [auto mode vs manual approval](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/).
- Putting turn and budget caps on a CI agent: [running Claude Code in a GitHub Action for PR review](/2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review/).
- The Cursor equivalent of a long-running goal and its guard rails: [giving a Cursor cloud agent a long-lived objective with `/goal`](/2026/09/how-to-give-a-cursor-cloud-agent-a-long-lived-objective-with-goal/).

## Sources

- [Claude Code hooks reference: Stop, PostToolUseFailure, prompt hook response schema](https://code.claude.com/docs/en/hooks)
- [Claude Code hooks guide: Stop hook hits the block cap](https://code.claude.com/docs/en/hooks-guide#stop-hook-hits-the-block-cap)
- [Claude Code `/goal` documentation](https://code.claude.com/docs/en/goal)
- [Agent SDK: how the agent loop works (turns and budget)](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)
- [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) (2.1.143, 2.1.163, 2.1.212, 2.1.217, 2.1.246, 2.1.259)
- [anthropics/claude-code#19699: infinite loop repeating the same failing command](https://github.com/anthropics/claude-code/issues/19699)
- [anthropics/claude-code#90930: agent stuck in a loop with backgrounded sleep timers](https://github.com/anthropics/claude-code/issues/90930)
- [Cursor forum: "Unrecoverable agent model looping detected"](https://forum.cursor.com/t/bricked-unrecoverable-agent-model-looping-detected/132538)
