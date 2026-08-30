---
title: "PreModelSwitch: Claude Code Can Now Veto a Model Change"
description: "Claude Code 2.1.251 adds PreModelSwitch and PostModelSwitch hook events. The matcher fires on the canonical name of the model you are switching to, and exit code 2 cancels the switch."
pubDate: 2026-08-30
tags:
  - "claude-code"
  - "ai-agents"
  - "devops"
---

Every hook event Claude Code shipped before this week guarded something the model does: `PreToolUse` sees a Bash command before it runs, `PermissionRequest` sees the prompt before you answer it, `PreCompact` sees the transcript before it is summarized. Version 2.1.251, released on 2026-08-28, added the first pair that guards the model itself. `PreModelSwitch` and `PostModelSwitch` fire when the session changes which weights are answering.

## Why a model change deserves a gate

A session's model is not a preference, it is an input. Swap Opus for Haiku halfway through a refactor and the next tool call is planned by a different reasoner against the same transcript. Teams care about this for three separate reasons: cost (a `/model` switch upward can multiply the bill for the remaining turns), reproducibility (a bug report that says "Claude did X" is unfalsifiable if the model drifted mid-session), and policy (some orgs are only cleared to send code to specific models).

Until 2.1.251 there was no seam to enforce any of that. Now there is.

## Blocking a switch

Register the hook in `settings.json`. The matcher is not a tool name here, it matches the canonical name of the model the session is switching *to*:

```json
{
  "hooks": {
    "PreModelSwitch": [
      {
        "matcher": "claude-opus-5",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/check-model-switch.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Matchers are regexes, so `claude-opus-4-6|claude-opus-5` and `.*opus.*` both work if you want to catch a family rather than one ID.

The hook reads the event on stdin. `PreModelSwitch` and `PostModelSwitch` receive `from_model` and `to_model` in place of the usual tool fields, alongside `session_id`, `prompt_id`, `transcript_path`, and `cwd`:

```bash
#!/usr/bin/env bash
to_model=$(jq -r '.to_model')

if [ -n "$OPUS_BUDGET_EXHAUSTED" ]; then
  cat <<JSON
{
  "hookSpecificOutput": {
    "hookEventName": "PreModelSwitch",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Opus budget for this repo is spent. Staying on $to_model is blocked until the cycle resets."
  }
}
JSON
fi
exit 0
```

Exiting with code 2 blocks the switch as well, which is the one-liner version if you do not want to emit JSON. One sharp edge worth knowing: a `PreModelSwitch` hook that gets cancelled at its `timeout` also blocks the switch. This event fails closed, unlike most of the lifecycle.

## PostModelSwitch fires when you did not ask

`PostModelSwitch` is the audit half, and it covers more than your own `/model` calls. Per the docs it runs "after the session's model changes, including changes Claude Code makes on its own, such as restoring the model when you resume a session." That is exactly the case that makes a "which model wrote this" question hard to answer after the fact, so appending `from_model`, `to_model`, and `session_id` to a log file here is the cheapest observability you will add all week.

The same release also fixed Opus 5 requests failing with "effort is not supported when thinking is disabled" at xhigh or max effort, and closed [four separate ways around the permission check](/2026/08/claude-code-2-1-251-four-ways-around-the-permission-check/). Full details are in the [hooks reference](https://code.claude.com/docs/en/hooks).
