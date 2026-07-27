---
title: "How to Stream Nested Subagent Output From a Headless Claude Code Run"
description: "By default a headless Claude Code run emits only tool_use and tool_result blocks from its subagents, so the delegated reasoning is invisible. Pass --forward-subagent-text (Claude Code 2.1.211+) to get subagent text and thinking in the stream-json output, and demultiplex it by parent_tool_use_id."
pubDate: 2026-07-27
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
  - "observability"
  - "llm"
---

If you run `claude -p` in CI and the agent delegates work to subagents, your log has a hole in it. The main conversation streams fine, but everything the subagent actually reasoned about is gone: you get the tool calls it made and the results they returned, then a final report, with no text in between. The fix is one flag, `--forward-subagent-text`, added in Claude Code 2.1.211 and extended to nested subagents in 2.1.219. This post covers what the default stream contains, what the flag adds, and how to split the merged stream back into one transcript per subagent using `parent_tool_use_id`.

```bash
# Claude Code 2.1.211 or later
claude -p "Audit this repo for unhandled promise rejections" \
  --output-format stream-json \
  --verbose \
  --forward-subagent-text
```

## What the default stream-json output actually contains

`--output-format stream-json` emits newline-delimited JSON, one object per line. The first line is a `system` message with `subtype: "init"`, then `assistant` and `user` messages alternate as the turn progresses, and the last line is a `result` message with the final text, cost, and usage. Running it without `--verbose` is a hard error, not a warning:

```
Error: When using --print, --output-format=stream-json requires --verbose
```

The init line carries the session identity you will need later for correlation:

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/srv/build/checkout",
  "session_id": "070bf7f7-62a2-474c-aa40-574744d7410e",
  "tools": ["Bash", "Read", "Edit", "Agent"],
  "model": "claude-sonnet-4-6",
  "permissionMode": "auto",
  "agents": ["Explore", "general-purpose", "Plan"],
  "claude_code_version": "2.1.220",
  "uuid": "fac096e3-cd37-4f0f-85dd-bc3c4ff1279f"
}
```

Every subsequent `assistant` and `user` message carries three fields that matter for this problem: `session_id`, `uuid`, and `parent_tool_use_id`. That last one is the whole mechanism. Messages from the main conversation set it to `null`. Messages produced inside a subagent set it to the `tool_use` id of the `Agent` call that spawned that subagent.

So the routing information has always been in the stream. What was missing before 2.1.211 is the content. The [CLI reference](https://code.claude.com/docs/en/cli-reference) is explicit about the default: without the flag, Claude Code emits only subagent `tool_use` and `tool_result` blocks. The subagent's `text` and `thinking` blocks are dropped on the floor. You see that it ran `Grep`, you see what `Grep` returned, and you never see the sentence where it decided that the third match was the real one.

That gap is more visible now than it used to be, because since [subagents started running in the background by default](/2026/07/claude-code-2-1-198-subagents-run-in-the-background-by-default/) in 2.1.198, a single headless run can have several of them in flight at once and the main conversation carries on without them.

## Turning forwarding on

Two equivalent switches, per the [headless docs](https://code.claude.com/docs/en/headless):

```bash
# Flag form
claude -p "$PROMPT" --output-format stream-json --verbose --forward-subagent-text

# Environment form, useful when the invocation is buried in a wrapper script
CLAUDE_CODE_FORWARD_SUBAGENT_TEXT=1 claude -p "$PROMPT" \
  --output-format stream-json --verbose
```

The environment variable is the one you want in CI, because the actual `claude` invocation is often inside a composite GitHub Action or a Makefile target you would rather not fork. Set it once at the job level and every nested invocation inherits it.

Three preconditions, all enforced:

1. `--print` (or `-p`). This is a print-mode feature; there is no interactive equivalent.
2. `--output-format stream-json`. It does nothing under `text` or `json`, because neither of those formats has a place to put intermediate messages.
3. Claude Code v2.1.211 or later. On 2.1.210 and earlier the flag is not recognized and argument parsing fails with an unknown-option error, which in a CI script looks like a mysterious non-zero exit before the model is ever called. Guard it:

```bash
# Fail fast with a readable message instead of an argv parse error
required=2.1.211
have=$(claude --version | cut -d' ' -f1)
if [ "$(printf '%s\n%s\n' "$required" "$have" | sort -V | head -1)" != "$required" ]; then
  echo "claude $have is too old for --forward-subagent-text (need >= $required)" >&2
  exit 1
fi
```

## Reading parent_tool_use_id

Once forwarding is on, the stream is a single interleaved sequence containing the main conversation and every subagent, distinguished only by `parent_tool_use_id`. The cheapest useful thing you can do with it is filter to one channel.

Main conversation only, which is what you want for a human-readable CI summary:

```bash
claude -p "$PROMPT" --output-format stream-json --verbose --forward-subagent-text \
  | jq -r 'select(.type == "assistant" and .parent_tool_use_id == null)
           | .message.content[]? | select(.type == "text") | .text'
```

Subagent text only, prefixed with a short id so you can tell two concurrent subagents apart:

```bash
claude -p "$PROMPT" --output-format stream-json --verbose --forward-subagent-text \
  | jq -r 'select(.type == "assistant" and .parent_tool_use_id != null)
           | . as $m
           | .message.content[]? | select(.type == "text")
           | "[\($m.parent_tool_use_id[-6:])] \(.text)"'
```

To map those ids back to something human-readable, watch the main conversation for `tool_use` blocks whose `name` is `Agent`. The block's `id` is the value that will show up as `parent_tool_use_id` on the subagent's messages, and its `input` carries the prompt and the `subagent_type`. That is the join key.

## A demultiplexer that writes one file per subagent

For anything beyond a one-liner, buffer per channel and flush to disk. This reads the stream on stdin and writes `main.log` plus `subagent-<id>.log` for each delegated task, with a header line naming the agent type:

```js
// demux.mjs -- Claude Code 2.1.220, Node 20+
// usage: claude -p "..." --output-format stream-json --verbose \
//          --forward-subagent-text | node demux.mjs ./logs
import { createInterface } from 'node:readline';
import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? './logs';
mkdirSync(outDir, { recursive: true });

const streams = new Map();   // channel key -> WriteStream
const agentNames = new Map(); // Agent tool_use id -> subagent_type

function sink(key) {
  if (!streams.has(key)) {
    const name = key === 'main' ? 'main' : `subagent-${key.slice(-8)}`;
    const s = createWriteStream(join(outDir, `${name}.log`), { flags: 'a' });
    if (key !== 'main') s.write(`# ${agentNames.get(key) ?? 'unknown'} (${key})\n`);
    streams.set(key, s);
  }
  return streams.get(key);
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let msg;
  try { msg = JSON.parse(line); } catch { continue; } // never let one bad line kill the run

  if (msg.type === 'system' && msg.subtype === 'init') {
    console.error(`session ${msg.session_id} on ${msg.claude_code_version}`);
    continue;
  }
  if (msg.type === 'result') {
    console.error(`done in ${msg.duration_ms}ms, $${msg.total_cost_usd?.toFixed?.(4) ?? '0'}`);
    continue;
  }
  if (msg.type !== 'assistant' && msg.type !== 'user') continue;

  const key = msg.parent_tool_use_id ?? 'main';
  const out = sink(key);

  for (const block of msg.message?.content ?? []) {
    if (block.type === 'text') out.write(block.text + '\n');
    else if (block.type === 'thinking') out.write(`[thinking] ${block.thinking}\n`);
    else if (block.type === 'tool_use') {
      // Record the mapping before the subagent's first message arrives
      if (block.name === 'Agent') agentNames.set(block.id, block.input?.subagent_type ?? 'agent');
      out.write(`[tool] ${block.name} ${JSON.stringify(block.input).slice(0, 200)}\n`);
    } else if (block.type === 'tool_result') {
      const text = typeof block.content === 'string'
        ? block.content
        : (block.content ?? []).map((c) => c.text ?? '').join('');
      out.write(`[result] ${text.slice(0, 500)}\n`);
    }
  }
}

for (const s of streams.values()) s.end();
```

Two details in there are not cosmetic. The `try`/`catch` around `JSON.parse` matters because anything a hook or a subprocess writes to stdout can land in the stream and a single unparseable line should not abort a twenty-minute run. And the `agentNames` mapping is populated from the main conversation's `tool_use` block, which is guaranteed to arrive before any message carrying that id as `parent_tool_use_id`, so the header is always correct by the time the file is created.

## Nested subagents, and why 2.1.219 matters

Through 2.1.218, forwarding only reached depth 1. A subagent's own text came through; anything its children produced did not. Since [2.1.219 raised the default spawn depth back to three](/2026/07/claude-code-2-1-219-nested-subagents-three-layers-deep/), that gap became load bearing, so the same release closed it. The changelog line: "Added nested subagent forwarding in stream-json: subagents spawned at depth-2+ now appear when `--forward-subagent-text` is set, keyed by their spawning Agent `tool_use` id".

The important word is "keyed". Nesting does not add a depth field or a chain of ancestors to the message. A depth-3 subagent's messages carry the `tool_use` id of its immediate parent, exactly like a depth-1 subagent's do. The tree is implicit and you rebuild it the same way you rebuilt the flat case: by noticing that an `Agent` tool call appeared on a channel that was itself a subagent channel.

```js
// Build parent -> child edges from Agent tool_use blocks on any channel
const parentOf = new Map(); // child Agent tool_use id -> channel it was spawned from
// ... inside the block loop, replacing the agentNames.set line:
if (block.name === 'Agent') {
  agentNames.set(block.id, block.input?.subagent_type ?? 'agent');
  parentOf.set(block.id, key); // key is 'main' or the spawning subagent's id
}

function depthOf(id) {
  let d = 0;
  while (id !== 'main' && id !== undefined) { id = parentOf.get(id); d++; }
  return d;
}
```

If you are on 2.1.211 through 2.1.218 and want any nested output at all, you have neither the forwarding nor, after 2.1.216, the nesting. Those versions [dropped the default spawn depth to 1](/2026/07/claude-code-2-1-213-caps-runaway-subagent-fleets/), so a subagent could not delegate in the first place. Upgrade to 2.1.219 or later before building anything on nested transcripts.

## Gotchas worth knowing before you ship this

**Ordering is not per-channel sequential.** The stream is a merge of concurrently running agents. Two subagents writing at once interleave at line granularity, and a subagent's message can appear long after the main conversation has moved on to unrelated work. Never infer causality from adjacency; use `parent_tool_use_id` and, if you need ordering within a channel, the `uuid` field plus arrival order on that channel.

**Forwarding is separate from partial messages.** `--include-partial-messages` adds `stream_event` objects carrying token deltas. It composes with `--forward-subagent-text`, but the two answer different questions: partial messages give you tokens as they are produced, forwarding gives you which agent produced them. If you want live per-subagent token streams you need both, and your consumer has to handle `stream_event` objects that are not `assistant` messages at all.

**Your log volume goes up, sometimes a lot.** Forwarding turns on thinking blocks, which on an extended-thinking model are frequently longer than the visible answer. A fan-out of ten subagents that each think hard can multiply a CI log by an order of magnitude. Truncate `thinking` before you write it, or route it to a separate file you only fetch when a run fails.

**The process can outlive the last visible message.** Background subagents are exempt from the five-second grace period that kills stray background Bash tasks, because their results are part of the final output, and `claude -p` waits for them. That wait is capped at ten minutes by default, tunable with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`. A consumer that treats "no output for two minutes" as a hang will kill perfectly healthy runs.

**Drain the pipe.** If your consumer reads slowly, Claude Code waits for queued output before exiting, scaling the wait with the backlog and capping it at 30 seconds as of 2.1.214. Before 2.1.208, piping a large response could truncate the final line and omit the `result` message entirely, which is a nasty failure mode for a script that keys off `result`. If you are parsing `total_cost_usd` out of the last line, be on 2.1.208 or later.

**There is still no terminal equivalent.** The [feature request for streaming subagent output into the parent terminal session](https://github.com/anthropics/claude-code/issues/33199) was closed as not planned. `--forward-subagent-text` is a machine-readable channel for harnesses, not a UI change. If you want live subagent visibility while you work interactively, `claude agents` and the background agents view are the supported path.

The natural place to spend this data is a harness that already parses the stream. If you are building [an LLM-as-judge eval harness for a coding agent](/2026/05/how-to-set-up-an-llm-as-judge-eval-harness-for-a-coding-agent/), per-subagent transcripts let you score the delegated steps independently instead of grading only the final answer, which is where most of the interesting failures actually live. Cursor solves the same observability problem from the other direction, with [hooks that fire on prompts, thinking, and subagent starts](/2026/07/observe-cursor-cloud-agent-prompts-thinking-subagents-with-hooks/) rather than a flag on the output stream. Either way, the thing you want out of a headless agent run is not the final report. It is the reasoning that produced it.

## Sources

- [Claude Code CLI reference: `--forward-subagent-text`](https://code.claude.com/docs/en/cli-reference)
- [Run Claude Code programmatically: stream responses](https://code.claude.com/docs/en/headless)
- [Claude Code CHANGELOG, versions 2.1.211 and 2.1.219](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [anthropics/claude-code issue 33199, stream subagent output to parent terminal](https://github.com/anthropics/claude-code/issues/33199)
