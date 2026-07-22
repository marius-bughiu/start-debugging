---
title: "Fix: Claude Code Autocompact Thrashing on a Large File or Tool Output"
description: "Claude Code compacts, then a single oversized file read or tool result immediately refills the window and it compacts again. Drop the item with /clear, read files in slices, and force big output to disk."
pubDate: 2026-07-22
tags:
  - "claude-code"
  - "ai-agents"
  - "context-window"
  - "mcp"
---

If Claude Code keeps flashing `Context low. Auto-compacting conversation to free up space.` every turn and never makes progress, one oversized item in your context is the cause. A single file read, a verbose command output, or an MCP tool result is large enough that each compaction frees space and the very next turn puts the same item straight back, crossing the auto-compact threshold again. The fix is to evict the item, not to compact harder: `/clear` and reload only what you need, read large files with `offset`/`limit` instead of whole, and redirect noisy tool output to a file. This is written against Claude Code 2.1.x on `claude-opus-4-8` and `claude-sonnet-4-6`.

## What thrashing looks like

Normal compaction is a one-time event. The context meter climbs toward full, Claude Code summarizes the older turns, the meter drops to something like 30 to 50 percent, and you keep going. Thrashing is when that cycle repeats back-to-back with no useful work in between:

```
Context low. Auto-compacting conversation to free up space.
... [a few seconds pass, one short exchange] ...
Context low. Auto-compacting conversation to free up space.
... [again] ...
Context low. Auto-compacting conversation to free up space.
```

There is no exception string for this. It is a behavioral failure, which is exactly why it is hard to search for. The tell is that the post-compaction context meter never settles low. It compacts, jumps to maybe 6 to 10 percent free, you send one message, and it is full again. People have reported the extreme version where auto-compact resets the remaining budget to 4 to 6 percent and loops, for example in [issue #6461](https://github.com/anthropics/claude-code/issues/6461) and the infinite-loop report in [issue #6004](https://github.com/anthropics/claude-code/issues/6004).

This is different from two problems it gets confused with. It is not the Node.js process running out of RAM, which is a separate failure covered in [Claude Code high memory usage and context overflow](/2026/07/fix-claude-code-high-memory-usage-and-context-overflow/). And it is not the post-compaction bug where your MCP tools vanish, covered in [Claude Code drops MCP tools after auto-compaction](/2026/06/fix-claude-code-drops-mcp-tools-after-auto-compaction/). Thrashing is specifically the compaction loop.

## Why a single item can defeat compaction

Claude Code manages a finite context window with a layered cascade, described well in [this teardown of the compaction system](https://finisky.github.io/en/claude-code-context-compaction/). The layers, cheapest first:

- **Layer 0, persist to disk.** When a tool returns a result over roughly 50K characters, the full payload is written to a file and only a short preview (around 2KB) plus the file path stays in context. The aggregate of all `tool_result` blocks in one message is also capped, around 200K characters.
- **Microcompact.** Old tool results are stripped out on the fly without a model call. Cheap, surgical, runs often.
- **Session memory compact.** Uses pre-extracted notes to rebuild a compact history with no summarization call.
- **Full compact.** A forked agent summarizes the whole conversation. This is the expensive one and the one you see announced in the status line.

Auto-compact fires when usage approaches a computed threshold, roughly `context_window - max_output_tokens - buffer`. For a 200K window with a large output reservation and a ~13K buffer, that lands around 167K tokens of input before compaction kicks in.

The cascade assumes the thing filling the window is *history*: many turns, many tool results, all individually small and collectively evictable. Thrashing happens when that assumption breaks and a *single live item* is both huge and un-evictable:

1. **A whole-file read of a large file** that the model keeps needing. Compaction can drop old turns, but if the current task still references a 4,000-line file that sits in context as one message, summarization cannot shrink it without losing the content the model is actively using.
2. **An MCP tool that returns a giant payload every turn.** Each call re-adds the same 80K-character blob. Microcompact evicts the previous one, the new call puts an equally large one back, and net usage never drops.
3. **An agent loop that re-reads the same files.** If the model reads the same 600 to 800 line test files on every iteration, as documented in the loop reports above, the reads pile back in faster than compaction clears them.
4. **A bloated `settings.local.json`.** The original [issue #6461](https://github.com/anthropics/claude-code/issues/6461) traced its loop to an accumulated `settings.local.json` in the `.claude` folder. Large accumulated actions inflated per-turn overhead until compaction could not win.

In every case the math is the same. Compaction frees N tokens, the next turn adds back roughly N tokens of the same oversized item, and you are over the threshold again.

## The minimal repro

You can reproduce category 1 deliberately. Point Claude Code at a repo with one very large generated file and ask it to keep working with that file in view:

```bash
# Claude Code 2.1.x
# Generate a large file that a task will keep referencing.
seq 1 200000 | awk '{print "const line_" $1 " = " $1 ";"}' > big.generated.js

# In Claude Code, force it into context as one read, then keep asking
# questions that require the whole file:
#   > Read big.generated.js in full and summarize every declaration.
#   > Now cross-check line 90000 against line 190000.
#   > Now do it again for a different pair.
```

That single `Read` is one enormous message. Once it lands you are near the threshold, and each follow-up that keeps the file "in play" prevents compaction from evicting it. You will see the auto-compact line fire, briefly recover, and fire again.

## The fix, in order of what to try first

**1. Evict the stuck item with `/clear`, then reload a slice.** This is the fastest reliable recovery. `/clear` drops the entire conversation including the oversized message. Then bring back only what the task needs:

```text
# Claude Code 2.1.x
/clear
> Read big.generated.js lines 89000-91000 and 189000-191000 only.
```

Reading a slice instead of the whole file keeps the message small enough that compaction is not needed at all.

**2. Read large files in ranges, not whole.** When you drive Claude Code, ask for ranges explicitly, or let it grep first and read around the hits. As a rule of thumb, if a file is over ~1,500 lines, never pull it in whole. The same discipline that keeps a monorepo tractable applies here: see [how to structure a monorepo so Claude Code's context stays small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/) for the repo-side version of this.

**3. Redirect verbose command output to a file.** A build log or test run that dumps 100K characters into a single tool result is a classic trigger. Send it to disk and read a slice:

```bash
# Claude Code 2.1.x -- keep the huge output out of context
npm test > .claude/test.log 2>&1 || true
# then: > Read the last 80 lines of .claude/test.log
```

Anything over ~50K characters would be spilled to disk by Layer 0 anyway, but doing it yourself means you control which 80 lines come back instead of a truncated preview.

**4. `/compact` manually with preservation instructions, before auto-compact fires.** If you compact on your own terms you can tell the summarizer what to keep, which produces a much smaller result than the generic auto pass:

```text
# Claude Code 2.1.x
/compact Keep the current file paths, the failing test name, and the
last diff. Drop all earlier file reads and command output.
```

Community guidance converges on compacting manually once you cross about 50 percent usage rather than letting the window run to the auto threshold.

**5. Stop MCP servers that return giant payloads every call.** If a tool re-adds a large blob each turn, that is your thrashing source. Trim the surface, or disconnect the server for the duration of the task. Reducing how many tools and how much payload the model pulls in is the same lever described in [how to reduce the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/). Prefer MCP tools that return a reference or a short summary and let the agent fetch detail on demand.

**6. Prune a bloated `settings.local.json`.** If none of the above explains it, check `.claude/settings.local.json`. Per [issue #6461](https://github.com/anthropics/claude-code/issues/6461), an accumulation of remembered actions inflated the loop. Rename it, restart Claude Code, and re-approve actions as they come up:

```bash
# Claude Code 2.1.x
mv .claude/settings.local.json .claude/settings.local.json.bak
# restart Claude Code; re-grant permissions on demand
```

## Gotchas and lookalikes

**"It compacts once and recovers fine" is not thrashing.** A single auto-compact on a long session is the system working as designed. Only the repeating loop is the bug in this post.

**A high output-token reservation shrinks your effective window.** The auto-compact threshold subtracts `max_output_tokens`. If you are on a configuration that reserves a large output budget, compaction fires earlier, which makes a borderline-large item tip into thrashing. Switching to a model or setting with a smaller output reservation can push the threshold up.

**`/context` tells you which item is the culprit.** Before you start guessing, run `/context` to see the breakdown. If one file read or one tool result dominates, you have found the item to evict. This is the same diagnostic used to separate RAM pressure from window pressure in the [high memory usage](/2026/07/fix-claude-code-high-memory-usage-and-context-overflow/) post.

**The 200K per-message cap does not save you across turns.** Layer 0 caps a single message and spills big single results to disk, but it does nothing about the same large item being re-introduced turn after turn. That across-turn re-add is the exact shape of thrashing, which is why the fix is behavioral (stop re-adding it) rather than a setting.

**Restarting does not always clear it.** As noted in [issue #6461](https://github.com/anthropics/claude-code/issues/6461), a session reset alone did not fix the loop when the cause lived in `settings.local.json`. If `/clear` and a restart do not help, look on disk.

## Related

- [Fix: Claude Code high memory usage and context window overflow](/2026/07/fix-claude-code-high-memory-usage-and-context-overflow/) separates the RAM problem from the context-window problem, which thrashing is often mistaken for.
- [Fix: Claude Code drops MCP tools after auto-compaction](/2026/06/fix-claude-code-drops-mcp-tools-after-auto-compaction/) covers the other post-compaction failure mode.
- [How to structure a monorepo so Claude Code's context stays small](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/) is the repo-side prevention.
- [How to reduce the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/) trims the tool payloads that feed thrashing.

## Sources

- [Auto-Compact resetting context limit to 4-6% causing frequent compaction loop, issue #6461](https://github.com/anthropics/claude-code/issues/6461)
- [Claude Code stuck in infinite compaction loop, issue #6004](https://github.com/anthropics/claude-code/issues/6004)
- [Context compaction in Claude Code: a five-layer cascade](https://finisky.github.io/en/claude-code-context-compaction/)
