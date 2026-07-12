---
title: "How to Observe a Cursor Cloud Agent's Prompts, Thinking, and Subagents with Hooks"
description: "Cursor 3.11 (July 10, 2026) lets cloud agents run hooks that see the conversation itself. Wire up beforeSubmitPrompt, afterAgentThought, afterAgentResponse, and subagentStart in .cursor/hooks.json to log every prompt, thinking block, and delegated task, then gate the risky ones."
pubDate: 2026-07-12
tags:
  - "cursor"
  - "ai-agents"
  - "llm"
  - "observability"
---

When a Cursor cloud agent runs on cursor.com/agents, you get a PR at the end and a transcript you can scroll. What you historically could not get was a machine-readable feed of what the agent was thinking, what it decided to ask itself, and which subagents it spawned along the way. Cursor 3.11, shipped July 10, 2026, closes that gap: cloud agents now run hooks that observe the conversation itself, not just the tools it calls. This post wires up a `.cursor/hooks.json` (schema version 1) that logs every prompt, every thinking block, every final response, and every subagent launch, and then shows how to turn the same hooks from passive observers into gates.

Before 3.11, the hooks that fired inside a cloud agent were the tool-surface ones: `beforeShellExecution`, `afterFileEdit`, `preToolUse`. Useful for policy, but blind to reasoning. 3.11 adds the conversation-level hooks (`beforeSubmitPrompt`, `afterAgentThought`, `afterAgentResponse`, `subagentStart`/`subagentStop`, `preCompact`, and `stop`) to the cloud allowlist, so you can build observability and self-correcting loops that run unattended in the cloud VM. The exact wording from the release is that you can now "observe and control the agent conversation itself: prompts, responses, thinking, subagents, compaction, and turn completion."

## Why cloud agents are the case that actually needs this

In the IDE you are watching. If an agent goes off the rails you see it in the chat panel and hit stop. A cloud agent has no one watching. It picks up a task, runs for minutes, spawns subagents, compacts its context, and either finishes or gets stuck, all while you are doing something else. The only artifacts you get afterward are the diff and a transcript you have to read by hand.

Hooks change the shape of that. Instead of reading a transcript after the fact, you emit structured events during the run: a JSONL line per thinking block, per response, per subagent. That feed is what you pipe into your own logging, cost tracking, or a "did the agent do something it should not have" alert. And because a hook can return a decision, the same wire that observes can also block, so a cloud agent that decides to spawn a `shell` subagent to run a destructive command never gets to.

## The minimal hooks.json that sees the whole conversation

Hooks live in `.cursor/hooks.json` at the repository root. That location matters for cloud agents: they run **command-based hooks from the repo only**. User-level hooks in `~/.cursor/hooks.json` do not run in the cloud, so anything you want a cloud agent to honor has to be committed to the repo.

Here is a config that attaches an observer to each conversation-level event 3.11 exposed to the cloud:

```json
// .cursor/hooks.json -- Cursor 3.11, hooks schema version 1
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      { "command": ".cursor/hooks/log-prompt.py" }
    ],
    "afterAgentThought": [
      { "command": ".cursor/hooks/log-thought.py" }
    ],
    "afterAgentResponse": [
      { "command": ".cursor/hooks/log-response.py" }
    ],
    "subagentStart": [
      { "command": ".cursor/hooks/gate-subagent.py" }
    ],
    "stop": [
      { "command": ".cursor/hooks/on-turn-complete.py" }
    ]
  }
}
```

Each event maps to an array, so you can chain multiple hooks per event. Each entry can also carry `type` (`command` or `prompt`), `timeout` (milliseconds), `loop_limit`, `failClosed`, and a `matcher` string to filter which invocations fire. The bare `command` form above is the common case: run this script, pass it JSON on stdin, read JSON back on stdout.

## Every hook gets the same envelope

Whatever the event, the JSON your script reads on stdin starts with a common base. The fields worth pinning to:

```json
{
  "conversation_id": "conv_abc123",
  "generation_id": "gen_def456",
  "model": "claude-sonnet-4-6",
  "hook_event_name": "afterAgentThought",
  "cursor_version": "3.11.0",
  "workspace_roots": ["/workspace/your-repo"],
  "user_email": "you@example.com",
  "transcript_path": "/path/to/transcript.jsonl"
}
```

`conversation_id` is the join key: every thinking block, response, and subagent for one agent run shares it, so a downstream aggregator can reconstruct the run. `transcript_path` points at the full JSONL transcript on disk if you want more than the event payload. `hook_event_name` lets one script handle several events if you would rather not write five files.

## Logging thinking, prompts, and responses

The three observation hooks are fire-and-forget: their input carries the payload, and their output is an empty object `{}`. They cannot block, which is exactly what you want for a pure observer.

`afterAgentThought` fires for each reasoning block the model emits. Its input is the thinking text plus how long it took:

```python
#!/usr/bin/env python3
# .cursor/hooks/log-thought.py -- Cursor 3.11, afterAgentThought
import json, sys, os
from datetime import datetime, timezone

payload = json.load(sys.stdin)

record = {
    "ts": datetime.now(timezone.utc).isoformat(),
    "conversation_id": payload.get("conversation_id"),
    "event": "thought",
    "duration_ms": payload.get("duration_ms", 0),
    "text": payload.get("text", ""),
}

# One JSONL line per thinking block, keyed by conversation.
log = os.path.join(payload.get("workspace_roots", ["."])[0], ".cursor", "agent-events.jsonl")
with open(log, "a", encoding="utf-8") as f:
    f.write(json.dumps(record, ensure_ascii=False) + "\n")

# Observational hooks return an empty object and never block.
print(json.dumps({}))
```

`afterAgentResponse` is the same shape with a `text` field holding the assistant's final answer for that turn. `beforeSubmitPrompt` sees the prompt before it is sent, with a `prompt` string and an `attachments` array. Point all three at variations of the script above and `.cursor/agent-events.jsonl` becomes a complete, ordered record of the run: prompt in, thinking, response out, keyed by `conversation_id`.

One caution on `beforeSubmitPrompt` in the cloud: it is on the supported list, but Cursor notes that hooks tied to the very start of a session (`sessionStart`, `sessionEnd`) do not run in a cloud agent because the VM does not exist yet when the session opens on cursor.com/agents. `beforeSubmitPrompt` fires per user turn, so it works, but do not lean on it to bootstrap environment state the way you would with `sessionStart` locally.

## Watching, and gating, subagents

`subagentStart` is where observation turns into control. Cursor's cloud agents spawn subagents through the Task tool (`generalPurpose`, `explore`, `shell`, and friends), and each spawn fires this hook with the subagent type and its task before the subagent runs. Unlike the observation hooks, `subagentStart` can return a permission decision:

```python
#!/usr/bin/env python3
# .cursor/hooks/gate-subagent.py -- Cursor 3.11, subagentStart
import json, sys, os
from datetime import datetime, timezone

payload = json.load(sys.stdin)
subagent_type = payload.get("subagent_type", "")
task = payload.get("task", "")

# Log every delegation for observability.
log = os.path.join(payload.get("workspace_roots", ["."])[0], ".cursor", "agent-events.jsonl")
with open(log, "a", encoding="utf-8") as f:
    f.write(json.dumps({
        "ts": datetime.now(timezone.utc).isoformat(),
        "conversation_id": payload.get("conversation_id"),
        "event": "subagent_start",
        "subagent_type": subagent_type,
        "task": task,
    }) + "\n")

# Gate the risky ones: deny a shell subagent whose task smells destructive.
banned = ("rm -rf", "drop table", "force push", "delete production")
if subagent_type == "shell" and any(b in task.lower() for b in banned):
    print(json.dumps({
        "permission": "deny",
        "user_message": f"Blocked shell subagent: task matched a banned pattern.",
    }))
    sys.exit(0)

print(json.dumps({"permission": "allow"}))
```

Return `{"permission": "allow"}` to let the subagent run, `{"permission": "deny"}` to stop it, and an optional `user_message` that surfaces in the transcript so the reason is not a mystery later. `subagentStop` fires when the delegated task finishes if you want to record duration or outcome. This is the mechanism behind "control subagents" in the release notes: a reviewer subagent can be allowed to delegate to a test-writer while a `shell` subagent that wants to touch production is refused. If you are weighing how Cursor's delegation model compares to the alternative, see [Cursor Subagents vs Claude Code Subagents for Multi-Agent Workflows](/2026/07/cursor-subagents-vs-claude-code-subagents/).

## Closing the loop with the stop hook

The `stop` hook fires when a turn completes, with a `status` of `completed`, `aborted`, or `error` and a `loop_count`. Its distinctive power is that it can return a `followup_message`, which feeds a new instruction back into the same agent. That is the primitive for a self-correcting loop that runs unattended:

```python
#!/usr/bin/env python3
# .cursor/hooks/on-turn-complete.py -- Cursor 3.11, stop
import json, sys, subprocess

payload = json.load(sys.stdin)

# Only nudge on a clean completion, and cap how many times we re-enter.
if payload.get("status") == "completed" and payload.get("loop_count", 0) < 3:
    result = subprocess.run(["npm", "test", "--silent"], capture_output=True, text=True)
    if result.returncode != 0:
        print(json.dumps({
            "followup_message": "The test suite is red after your change. "
                                "Read the failing output and fix it, then stop.",
        }))
        sys.exit(0)

print(json.dumps({}))  # No followup: let the turn end.
```

The `loop_count` guard is not optional. Without it, a hook that always returns a `followup_message` on failure spins the agent forever (and burns credits). Cap it, and pair it with the `loop_limit` field in `hooks.json` as a second backstop. This is the cloud-native version of running a review before you ship; if you would rather gate at push time in the IDE instead, [Cursor Bugbot's /review](/2026/06/how-to-run-bugbot-review-locally-before-pushing-in-cursor/) covers that path.

## What does not run in the cloud, and why

The cloud allowlist is deliberately narrower than the IDE. Do not expect these to fire in a cloud agent:

- `sessionStart` / `sessionEnd`: deferred while cloud agents can start in a read-only environment where the VM is not up when the session begins.
- `beforeMCPExecution` / `afterMCPExecution`: same read-only timing constraint. If your policy depends on gating MCP calls, that gate does not exist in the cloud yet, so enforce it another way.
- `beforeTabFileRead` / `afterTabFileEdit`: Tab is an IDE-only feature.
- `workspaceOpen`: an IDE lifecycle event with no cloud analog.
- User-level hooks in `~/.cursor/hooks.json`: cloud agents read repo hooks and team/enterprise hooks only.

The practical takeaway: anything you want a cloud agent to honor lives in the committed `.cursor/hooks.json`, and it has to be one of the supported events. The supported set for the cloud is the shell/file/tool hooks plus the conversation hooks this post uses.

## Fail-open, exit codes, and the security posture

Two behaviors will bite you if you skip them. First, hooks fail **open** by default. If your script crashes, times out, or exits non-zero for a reason other than a deliberate block, the action proceeds as if the hook had allowed it. That is the right default for an observability hook (a broken logger should not wedge the agent) and the wrong default for a security gate. For a gate, set `"failClosed": true` on that hook entry so a crash denies instead of allows.

Second, there are two ways to block. Return `{"permission": "deny"}` from a hook that supports permissions, or exit with code `2`, which Cursor treats as equivalent to a deny. Exit code `0` means success and Cursor uses your JSON output; any other non-zero code is a crash and falls open (unless `failClosed`). Keep the observation scripts returning `{}` with exit `0`, and reserve `2` and `deny` for the gates. When the gate is genuinely security-critical, treating hook output as a trust boundary matters, the same lesson the [DuneSlide prompt-injection chain](/2026/07/cursor-duneslide-prompt-injection-sandbox-escape-rce/) drove home for Cursor's own sandbox.

A last operational note: as of the January 2026 in-process runner, hook execution is 10-20x faster than the old shell-spawn model, so a per-thought logging hook is not the performance drag it would have been a year ago. Still, keep the hook body cheap. It runs on the agent's critical path, and a slow `afterAgentThought` slows every reasoning step. Write the JSONL line and get out; do the aggregation offline.

Wire these five hooks into a repo and a cloud agent stops being a black box. You get an ordered event stream per `conversation_id`, a place to deny the subagents you do not want, and a `stop` hook that can send the agent back to fix its own mess. That is the same observability story the [3.11 side chats release](/2026/07/cursor-3-11-side-chats-parallel-agent-threads/) introduced hooks alongside, now aimed at the runs where no one is watching.

## Sources

- [Hooks -- Cursor Docs](https://cursor.com/docs/hooks): the canonical event matrix, input/output schemas, cloud-agent support list, and exit-code behavior.
- [Cursor Changelog](https://cursor.com/changelog): the 3.11 release (July 10, 2026) adding conversation-level hooks to cloud agents.
- [Side Chats and Conversation Search -- Cursor](https://cursor.com/changelog/side-chat): the 3.11 release notes.
