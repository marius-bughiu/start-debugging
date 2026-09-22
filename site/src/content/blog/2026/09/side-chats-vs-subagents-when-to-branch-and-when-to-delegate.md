---
title: "Side Chats vs Subagents: When to Branch a Conversation and When to Delegate"
description: "A side chat branches off what the agent already knows; a subagent goes and finds out something new. Claude Code's /btw has no tools at all, Cursor's /btw opens a full agent, and a plain subagent sees none of your conversation. A decision guide for Claude Code 2.1.278 and Cursor 3.11+."
pubDate: 2026-09-22
template: vs
tags:
  - "comparison"
  - "ai-agents"
  - "claude-code"
  - "cursor"
  - "subagents"
---

**Short answer:** branch (side chat) when the tangent can be answered from what the agent has already read, and delegate (subagent) when answering it needs new tool calls you do not want in your main context. In Claude Code 2.1.278, `/btw` sees your whole conversation but has **no tools** and never enters the history, a forked subagent (`/subtask`) sees the whole conversation **and** has tools, and a named subagent starts cold from a prompt. In Cursor 3.11 and later, a side chat (`/side` or `/btw`) is a full, durable agent seeded with the parent history as hidden context, while a subagent starts clean. The same `/btw` command therefore means "cheap recall" in one tool and "second agent" in the other, and that difference drives most of the mistakes.

## Two questions that decide it

Every tangent you have mid-task can be sorted with two questions:

1. **Does the answer already exist in the conversation?** "What was the name of that config file?", "why did you pick the retry decorator over Polly?", "which of the three failing tests did you already fix?" These are recall questions. The agent read the files, ran the commands, and made the decisions. You just need it to repeat or reason over what is already there.
2. **Should the work behind the answer come back into the main thread?** "Find every caller of `LegacyAuth.Validate`" needs forty grep hits and a dozen file reads. You want the conclusion in your main context, not the forty hits.

Recall questions belong in a side chat. Discovery work belongs in a subagent. The subtlety is in the middle: questions that need a *little* new information on top of a lot of existing context. That is where the fork exists, and where Claude Code and Cursor diverge.

## What each primitive actually sees and can do

Here is the matrix, taken from the current [Claude Code interactive-mode docs](https://code.claude.com/docs/en/interactive-mode#side-questions-with-%2Fbtw), the [Claude Code subagents docs](https://code.claude.com/docs/en/sub-agents), the [Cursor side chats help page](https://cursor.com/help/ai-features/side-chats), and the [Cursor subagents reference](https://cursor.com/docs/subagents):

| | Sees main conversation | Tools | Follow-ups | Enters main history | Returns result by |
|---|---|---|---|---|---|
| Claude Code `/btw` | Yes, all of it (except the reply still streaming) | None | No, each `/btw` is one answer (newest 20 exchanges replayed) | Never | You reading the overlay |
| Claude Code fork (`/subtask`) | Yes, full copy, same system prompt and tools | Same pool as the main session | Yes, via the fork panel | Final result only | Message in the main conversation |
| Claude Code named subagent | No, only the delegation prompt | Filtered by its definition | Resumable | Final result only | Tool result to the main agent |
| Cursor side chat (`/side`, `/btw`) | Yes, as hidden reference context | Full agent, defaults to read/search/answer | Yes, durable thread | No | You @-mentioning it in the main thread |
| Cursor subagent | No, clean context plus the parent's prompt | Inherits parent tools, `readonly` optional | Resumable by agent ID | Final result only | Tool result to the main agent |

Read the "Tools" column twice. The command you type in both products is `/btw`, and in Claude Code it produces something that cannot open a file, while in Cursor it produces an agent that can.

## Claude Code: `/btw` is recall, not research

Claude Code's side question is deliberately small. The docs are explicit that it "answers only from what is already in context" and "can't read files, run commands, or search". That is a feature, not a limitation: because it reuses the main conversation's prefix, a side question costs little beyond the answer itself while the prompt cache is warm, and it runs even while the main turn is still in progress, without interrupting it.

```text
# Claude Code 2.1.278, interactive session, main agent mid-refactor
/btw which file did you say registers the JWT bearer handler?
/btw you skipped OrderServiceTests earlier, was that on purpose?
/btw summarize the three options you rejected for the cache key, one line each
```

All three are pure recall. None of them adds a token to the main history, so the main agent's context stays exactly as it was. Since v2.1.212 a bare `/btw` reopens the overlay on your latest exchange, and since v2.1.257 `Shift+Left` / `Shift+Right` (or `[` / `]`) step through earlier answers. `c` copies the answer as raw Markdown, and `x` clears the replayed history.

The failure mode is asking it a discovery question:

```text
/btw does anything else in the repo call LegacyAuth.Validate?
```

If the main agent never searched for that, `/btw` cannot find out. It will either tell you it does not know, or reason from the files it happens to have seen, which reads confidently and can be wrong. Before 2.1.269 it could also write out imaginary tool calls with imaginary output; the [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) for that release says the side question is now told not to, and any that slip through are flagged as not executed. Treat that flag as your cue that you asked the wrong primitive.

### The escape hatch: press `f`

When a side question turns out to need tools, you do not have to retype it. In the overlay, `f` starts a forked subagent that inherits the parent conversation *plus* this question and answer, and continues with full tool access. You stay in your session and the fork shows up in the panel below the prompt. It works in local sessions only.

That makes the practical Claude Code workflow "ask with `/btw` first, promote with `f` if it needs tools". Asking costs almost nothing, and promotion keeps the context you already paid for.

## Claude Code: fork versus named subagent

Once you delegate, Claude Code gives you two shapes, which the [subtask vs fork vs background agent comparison](/2026/08/subtask-vs-fork-vs-background-agent-in-claude-code/) covers in depth. For this decision, the short version:

- A **fork** (`/subtask <task>` on v2.1.212+, `/fork` on v2.1.161 to v2.1.211) inherits the system prompt, tools, model and full history. Because the prefix is identical, its first request reads the parent's prompt cache, per the [prompt caching docs](https://code.claude.com/docs/en/prompt-caching#subagents-and-the-cache). Use it when re-explaining the situation would take longer than the task.
- A **named subagent** starts from a fresh context with its own system prompt, so its first request does not read the parent cache, and it runs on a five-minute cache TTL even on a subscription. Use it when the task is self-contained and you *want* it free of your conversation's assumptions, like a reviewer that should not inherit your reasoning.

```markdown
<!-- .claude/agents/caller-audit.md, Claude Code 2.1.278 -->
---
name: caller-audit
description: Finds every call site of a symbol and reports file:line plus a one-line reason per hit. Use when asked who calls something.
tools: Grep, Glob, Read
model: haiku
---

Search the repository for every call site of the symbol you are given.
Return only a table of file:line and a one-line description of each call.
Do not propose changes.
```

```text
# Named subagent: cold start, cheap model, only the table comes back
Use the caller-audit subagent to find every caller of LegacyAuth.Validate

# Fork: needs to know which refactor we are doing and why
/subtask draft migration notes for the three LegacyAuth callers we changed today
```

The first task needs no history, so paying for a fork would only add tokens. The second is meaningless without the history, so a cold subagent would need a long delegation prompt to reach the same place.

## Cursor: the side chat is a second agent

Cursor made the opposite design choice. Since [Cursor 3.11 (July 10, 2026)](https://cursor.com/changelog/side-chat), a side chat is a "durable, full agent conversation" attached to its parent. The parent history is copied in as hidden reference context, so it knows what you have been doing without rendering that transcript in the side panel. You can follow up as many times as you like, close it to archive it, and come back later. The [Cursor 3.11 news post](/2026/07/cursor-3-11-side-chats-parallel-agent-threads/) covers the launch; the part that matters here is what it implies for the decision.

```text
# Cursor 3.11+, in the main agent chat
/side does anything else in the repo call LegacyAuth.Validate?

# ...side chat searches, answers, you ask a follow-up in the side chat...
which of those callers are behind a feature flag?

# back in the main thread, pull the finding in
@<side chat> update the two unflagged callers the same way
```

Because it has tools, a Cursor side chat *can* answer discovery questions, which means Cursor collapses the Claude Code `/btw` and fork cases into one primitive. What you get back is different, though: nothing enters the main thread until you @-mention the side chat, and then Cursor pulls that side chat's context in. That is closer to "merge a branch" than to "receive a summary".

The other ways in are useful when the tangent is about something on screen: select text or a diff and pick **Ask in Side Chat**, or press `Shift+Cmd+S` (`Shift+Ctrl+S` on Windows and Linux) to seed a side chat with the current selection.

### When a Cursor subagent is still the better call

A Cursor [subagent](https://cursor.com/docs/subagents) starts with a clean context and receives only what the parent puts in its prompt. It returns one final message. That makes it the right tool when:

- The work is **noisy** and you only want the conclusion. The built-in `explore`, `bash` and `browser` subagents exist precisely because search results, command output and DOM snapshots bloat context.
- You want **parallelism the main agent orchestrates**, several subagents at once, optionally each in its own worktree or cloud VM.
- You want **enforced restrictions**. A side chat only defaults to read-and-answer behaviour; a subagent with `readonly: true` actually runs with restricted write permissions.

```markdown
<!-- .cursor/agents/caller-audit.md, Cursor 3.11+ -->
---
name: caller-audit
description: Finds every call site of a symbol and reports file:line. Use when asked who calls something.
model: inherit
readonly: true
---

Search the repository for every call site of the symbol you are given.
Return a table of file:line and a one-line description per call. Do not edit files.
```

```text
/caller-audit LegacyAuth.Validate
```

The side chat is for *you* to think out loud next to the agent. The subagent is for the *agent* to hand off a well-defined job.

## The decision, in four checks

Run these in order and stop at the first match:

1. **Is the answer already in the conversation?** Side chat. In Claude Code, `/btw`. In Cursor, `/side`, though for pure recall it is heavier than you need, so just asking in the main thread is often fine if you do not mind the extra turn.
2. **Does it need tools *and* the conversation's context, and will you keep poking at it yourself?** In Cursor, a side chat. In Claude Code, `/btw` then `f`, or `/subtask` directly.
3. **Does it need tools but not the conversation, and do you only want the conclusion?** Subagent, a named one with a narrow tool list or `readonly: true`.
4. **Is it several independent jobs?** Parallel subagents, in isolated worktrees if they edit files.

A useful sanity check: if you catch yourself pasting context into a subagent's prompt to explain what "the refactor" is, you wanted a fork or a side chat. If you catch yourself scrolling past forty grep results in a side chat to find one line, you wanted a subagent.

## Gotchas worth knowing before you rely on either

**What you learn in a Claude Code side question stays in the overlay.** The main agent has no idea you asked. If `/btw` surfaces something the main agent needs, such as "you forgot the tests in `Billing/`", you must say it in the main prompt or promote it with `f`. The fork's result, unlike the side question, does arrive as a message in the main conversation.

**Cursor side chats do not nest and do not run in the cloud.** A side chat cannot start its own side chats, and side chats are local-only for now, so a Cloud Agent session has no `/side`. Cloud work goes through `/in-cloud` cloud subagents instead.

**A Cursor side chat is not a fork either.** Forking in Cursor copies the transcript (the whole chat, or up to a chosen message) into a new chat that stands alone. A side chat only seeds the model with hidden context and stays attached to its parent, even if you navigate away.

**Shared workspace, no write lock.** A Cursor side chat is a full agent in the same workspace as the parent. The help page describes read, search and answer as its default focus, not a guarantee. Do not ask a side chat to edit files the main agent is in the middle of changing. The same goes for Claude Code forks and subagents without worktree isolation: Claude Code can pass `isolation: "worktree"` when it spawns a fork, and Cursor subagents get their own worktree when you ask for isolation.

**Compaction boundaries.** Before Claude Code 2.1.268, side questions could be sent the conversation from *before* a compaction, so an answer could cite state that the main agent had already summarized away. Upgrade if your version is older.

**Cost scales differently.** A `/btw` on a warm cache is close to free. A fork's first request reads the parent cache. A named Claude Code subagent builds its own cache from scratch. Cursor's own docs warn that five parallel subagents use roughly five times the tokens of one agent. None of the vendors publish per-primitive benchmarks, so if cost matters, measure it on your own sessions rather than trusting a rule of thumb, including this one.

**Depth limits apply to delegation, not branching.** Claude Code allows subagents three layers below the main conversation, and a fork cannot spawn further forks. Cursor allows one level of nested subagents since 2.5. If you are hitting those limits, the [post on nested subagent depth](/2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens/) explains why the extra depth rarely pays for itself.

The mental model that holds up in both tools: a side chat is a branch of *your* attention, and a subagent is a delegation of *the agent's* work. Pick the one that matches who is doing the thinking.

### Read next

- [Subtask vs Fork vs Background Agent in Claude Code](/2026/08/subtask-vs-fork-vs-background-agent-in-claude-code/) for the full breakdown of Claude Code's delegation primitives.
- [Cursor subagents vs Claude Code subagents](/2026/07/cursor-subagents-vs-claude-code-subagents/) if you are choosing between the two tools' delegation models.
- [Skills vs subagents vs MCP servers in Claude Code](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/) for when a subagent is the wrong abstraction altogether.
- [Caching multi-turn Claude conversations across API calls](/2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls/) for why a shared prefix makes side questions and forks cheap.

### Sources

- [Claude Code docs: Side questions with /btw](https://code.claude.com/docs/en/interactive-mode#side-questions-with-%2Fbtw)
- [Claude Code docs: Create custom subagents and Fork the current conversation](https://code.claude.com/docs/en/sub-agents)
- [Claude Code docs: Subagents and the prompt cache](https://code.claude.com/docs/en/prompt-caching#subagents-and-the-cache)
- [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) (2.1.212, 2.1.257, 2.1.268, 2.1.269, 2.1.278)
- [Cursor help: Side chats](https://cursor.com/help/ai-features/side-chats)
- [Cursor changelog: Side Chats and Conversation Search (3.11)](https://cursor.com/changelog/side-chat)
- [Cursor docs: Subagents](https://cursor.com/docs/subagents)
