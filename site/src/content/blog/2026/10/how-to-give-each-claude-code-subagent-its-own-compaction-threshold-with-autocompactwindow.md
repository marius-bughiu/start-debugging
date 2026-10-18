---
title: "How to Give Each Claude Code Subagent Its Own Compaction Threshold with autoCompactWindow"
description: "Claude Code v2.1.296 lets a subagent auto-compact earlier than the main conversation. Set autoCompactWindow in the subagent's frontmatter or --agents JSON as a plain integer from 100000 to 1000000, and watch out for the 200k parsing trap, the CLAUDE_CODE_AUTO_COMPACT_WINDOW override, and the --agent session mode where the field does nothing."
pubDate: 2026-10-18
tags:
  - "claude-code"
  - "ai-agents"
  - "subagents"
  - "compaction"
  - "context-window"
---

**Short answer:** since Claude Code v2.1.296 (released 2026-10-09), every subagent can carry its own auto-compact window. Add `autoCompactWindow: 200000` to the YAML frontmatter of `.claude/agents/<name>.md`, or an `"autoCompactWindow": 200000` key to a `--agents` JSON definition, and that subagent compacts at 200k tokens while the main conversation keeps its own window (about 967k by default on `claude-opus-5-5`, `claude-sonnet-5-5` and the other native 1M models). The value must be a plain integer between `100000` and `1000000`, it can only lower the window the subagent would otherwise inherit, and it is ignored whenever `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set.

## Why one window for every agent was the wrong default

Before 2.1.296 there was exactly one auto-compact window per session. You set it with `/autocompact 500k`, the `autoCompactWindow` key in `settings.json`, the `--autocompact` flag, or the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment variable, and every subagent that session spawned inherited it.

That is a bad fit for how subagents actually behave. A subagent is a worker with a narrow job and a short life. The ones that grow large tend to be the noisy ones: a log reader that pulls 40 MB of CI output in slices, a test runner that pastes failure traces back into its own context, a docs researcher that fetches page after page. With a 1M-token model and the default threshold, such a subagent keeps every one of those tool results in context until it crosses roughly 967k tokens. Every turn it takes resends that whole history.

Two things go wrong at that size:

- **Cost per turn climbs linearly.** A subagent at 800k tokens of context sends 800k input tokens on each request. Prompt caching softens the price but not the volume, and the cache only helps while the prefix is unchanged.
- **Attention dilutes.** The model has to find the one relevant stack trace among hundreds of thousands of tokens of output it already processed and no longer needs. The previous posts on [what a context window is and how agents stretch it](/2026/10/what-is-a-context-window-and-how-do-agents-stretch-it-in-2026/) and [autocompact thrashing on large tool output](/2026/07/fix-claude-code-autocompact-thrashing-on-large-file-or-tool-output/) go deeper on both effects.

Lowering the window for the whole session fixes the subagent and hurts the main conversation, which is where you actually want long-lived continuity: your plan, the decisions made, the files touched. Per-subagent windows let you keep the parent large and the noisy workers small.

## The minimal setup

Create a subagent file. Project-level subagents live in `.claude/agents/`, user-level ones in `~/.claude/agents/`.

```yaml
# .claude/agents/log-reader.md
# Claude Code v2.1.296+
---
name: log-reader
description: Reads long CI and application log files and reports the distinct errors it finds, with file and line references. Use for any log over a few thousand lines.
tools: Read, Grep, Glob, Bash
model: sonnet
autoCompactWindow: 200000
---

You read log files and report errors. Work in slices: grep for error markers first,
then read only the surrounding ranges. Never paste whole files into your reply.

Return a list of distinct errors, each with:
- the first occurrence (file:line)
- the number of occurrences
- one representative message, trimmed to 3 lines
```

That is the entire change. When this subagent's own context reaches 200,000 tokens, Claude Code compacts it, summarizing older turns into a shorter history, and the subagent keeps going. The main conversation is untouched: it compacts on its own window, and its context only grows by whatever the subagent returns at the end.

The same field works for subagents defined on the command line, which is how you would configure a headless or CI run without committing files:

```bash
# Claude Code v2.1.296+
claude -p "Find out why last night's nightly build failed. Logs are in ./artifacts/logs" \
  --agents '{
    "log-reader": {
      "description": "Reads long log files and reports distinct errors with file:line references",
      "prompt": "You read log files in slices and report distinct errors. Never paste whole files.",
      "tools": ["Read", "Grep", "Glob", "Bash"],
      "model": "sonnet",
      "autoCompactWindow": 200000
    }
  }'
```

`--agents` definitions take the same field names as frontmatter, with the system prompt moved into `"prompt"`. Subagents defined this way exist only for that session.

## Write the value as a plain integer

This is the gotcha that will catch most people, because every other place in Claude Code that sets a compact window is forgiving. `/autocompact 200k`, `/autocompact 200` and `--autocompact 1M` all work: the command and flag accept a `k` or `M` suffix, and a bare number from 100 to 1000 means thousands.

Frontmatter does not. In a subagent file, `autoCompactWindow: 200k` is read as `200`. That is below the allowed minimum of `100000`, so the value is rejected and the subagent loads and compacts as if the field were absent. Nothing fails visibly. The subagent just quietly runs with the inherited window.

```yaml
# Wrong: read as 200, rejected, field ignored
autoCompactWindow: 200k

# Wrong: also read as a number below 100000
autoCompactWindow: 200

# Right
autoCompactWindow: 200000
```

To confirm whether Claude Code accepted the value, run with debug logging and search for the rejection message:

```bash
# Claude Code v2.1.296+
claude --debug
# Delegate a task to the subagent, then search the debug log for:
#   invalid autoCompactWindow
```

A hit means the value was out of range or unparseable. No hit, with the subagent loaded, means it was accepted.

## The value can only lower the window

The docs describe the field as lowering the auto-compact window for the subagent, and that is literal. The subagent's effective window starts from the one it would inherit from the session, and `autoCompactWindow` only has an effect when it is below that.

Some combinations that do nothing:

| Session window | Subagent `autoCompactWindow` | Result |
| --- | --- | --- |
| default (~967k on a 1M model) | `200000` | Subagent compacts at 200k |
| `autoCompactWindow: 300000` in settings.json | `200000` | Subagent compacts at 200k |
| `autoCompactWindow: 300000` in settings.json | `500000` | No effect, subagent compacts at 300k |
| any | `500000`, subagent on a 200k model | No effect, capped at the model's window |

The last row matters if you route cheap subagents to an older model. Claude Code caps every window at the model's own context window. `claude-haiku-4-5` and Sonnet 4.5 have a 200k window, so a subagent on either one already compacts near 200k and any `autoCompactWindow` above that is moot. Haiku 5.5, Sonnet 5 and later, Opus 4.7 and later, and the Fable models have native 1M windows, so the field is useful on all of them.

If you want the opposite, a subagent that holds more context than the main conversation, this field is not the tool. Raise the session window instead and lower it for the subagents that do not need it.

## The environment variable wins, and CI is where it is usually set

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` sits at the top of the precedence order. When it is set to a positive integer, it overrides `/autocompact`, `--autocompact`, the `autoCompactWindow` setting and, as of 2.1.296, every subagent's `autoCompactWindow` too. The subagent uses the variable's window and the frontmatter field has no effect.

That bites in exactly the place where per-subagent windows are most valuable: scheduled and headless runs. It is common to export `CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000` in a GitHub Actions workflow or a cron wrapper to keep a long unattended run cheap. With that line in place, the `log-reader` above compacts at 400k, not 200k.

Two ways to resolve it:

```bash
# Option 1: drop the env var and use the flag for the main conversation.
# The flag does not override subagent frontmatter.
claude -p "$PROMPT" --autocompact 400k

# Option 2: drop the env var and set the session window in project settings.
# .claude/settings.json
# { "autoCompactWindow": 400000 }
```

Either way the main conversation compacts at 400k and each subagent can go lower.

## When the field does nothing: running a session as the subagent

You can run an entire Claude Code session as a subagent definition, with `claude --agent log-reader` or the `agent` key in settings. In that mode the subagent's system prompt, tools and model become the main conversation's, but `autoCompactWindow` from its frontmatter is ignored. The session window comes from the usual places: `/autocompact`, `--autocompact`, the setting, or the environment variable.

So if you prototype a subagent by launching it with `--agent` to watch it work, you will not see the per-subagent window in action. Test it by letting the main conversation delegate to it instead.

## Combining it with the percentage override

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` sets the percentage of the auto-compact window at which compaction triggers, and it applies to subagents as well as the main conversation. It can only lower the trigger point: values above the default percentage are ignored. It also only applies in sessions that compact before the model's context limit, which, on the native 1M models, is the default case.

Since it is a percentage of each agent's own window, it composes with `autoCompactWindow` rather than replacing it:

```bash
# Main conversation window 600k, subagent window 200k, trigger at 80% of each
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80
claude --autocompact 600k
# main compacts near 480k, log-reader near 160k
```

In practice I leave the percentage alone and pick the window directly. Two knobs that multiply are harder to reason about at 2 a.m. when a scheduled run blew its budget.

## Verifying that a subagent actually compacted

Subagent transcripts are written to their own JSONL files, separate from the main conversation:

```
~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl
```

Each compaction leaves a `compact_boundary` system event in that file, with the token count just before compaction:

```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "compactMetadata": {
    "trigger": "auto",
    "preTokens": 201344
  }
}
```

So the check after a run is one `jq` command:

```bash
# Requires jq. Lists every compaction in the most recently written subagents folder.
latest=$(ls -td ~/.claude/projects/*/*/subagents | head -1)
for f in "$latest"/agent-*.jsonl; do
  jq -c --arg f "$(basename "$f")" \
    'select(.subtype == "compact_boundary") | {file: $f, trigger: .compactMetadata.trigger, preTokens: .compactMetadata.preTokens}' "$f"
done
```

If `preTokens` hovers just above your `autoCompactWindow` value, the field is working. If it sits near 967k, or there are no boundary events at all on a subagent you know read a lot, go back through the checklist: integer value, below the inherited window, no environment variable, not running under `--agent`. Compaction in the main conversation does not touch these files, and Claude Code deletes them after `cleanupPeriodDays`, 30 days by default.

## Picking a number

There is no universal right value, but the shape of the job gives you a good starting point:

- **Log readers, test runners, build-output triage:** `150000` to `250000`. Their old tool results are almost always dead weight once the error has been extracted. Compacting early keeps each turn cheap.
- **Code reviewers working on one diff:** `300000` to `400000`. They need the diff, the touched files and some callers in context at once, and losing them mid-review produces shallow feedback.
- **Researchers fetching docs:** `200000` to `300000`, combined with a prompt that tells them to write findings to a file as they go, so compaction cannot lose them.
- **Implementers that edit many files:** leave the field off. They benefit from the same long continuity as the main conversation.

One caveat applies to all of them: compaction is a request in its own right. It reads everything it summarizes. A subagent that compacts every few turns because its window is barely above its working set pays for that repeatedly. If the debug log or the transcripts show back-to-back boundaries a few turns apart, raise the value or, better, cut the size of the tool output at the source, as covered in the [autocompact thrashing fix](/2026/07/fix-claude-code-autocompact-thrashing-on-large-file-or-tool-output/).

Also remember what compaction drops. Subagents are subject to the same rules as the main conversation, so anything that was only present as a tool result before the boundary is now a summary line. MCP tools that were loaded lazily can need reloading, a problem covered in [Claude Code dropping MCP tools after auto-compaction](/2026/06/fix-claude-code-drops-mcp-tools-after-auto-compaction/).

## Related

- [Nested subagent depth: when it helps and when it burns tokens](/2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens/), for deciding whether a job should be a subagent at all.
- [Subtask vs fork vs background agent in Claude Code](/2026/08/subtask-vs-fork-vs-background-agent-in-claude-code/), which covers how much parent context each delegation mode carries.
- [Claude Code skills vs subagents vs MCP servers: when to build each](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/).
- [What is a context window and how do agents stretch it in 2026](/2026/10/what-is-a-context-window-and-how-do-agents-stretch-it-in-2026/), for the session-level `/autocompact` controls this post builds on.

### Sources

- [Create custom subagents](https://code.claude.com/docs/en/sub-agents), Claude Code docs: the frontmatter reference, "Set the auto-compact window for one subagent", and subagent transcripts.
- [Model configuration: context window and auto-compaction](https://code.claude.com/docs/en/model-config), for the session window, default thresholds and precedence.
- [Environment variables](https://code.claude.com/docs/en/env-vars), for `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.
- [Claude Code v2.1.296 release notes](https://www.havoptic.com/r/claude-code-2.1.296), which introduced `autoCompactWindow` in subagent frontmatter and `--agents`.
