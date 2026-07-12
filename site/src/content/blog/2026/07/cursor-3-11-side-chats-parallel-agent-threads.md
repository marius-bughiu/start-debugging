---
title: "Cursor 3.11 Side Chats: Branch a Question Without Derailing the Main Agent"
description: "Cursor 3.11 (July 10, 2026) adds side chats, durable parallel agent threads you spawn with /side or /btw and pull back into the main conversation with an at-mention. Plus Cmd+K transcript search and new cloud agent hooks."
pubDate: 2026-07-12
tags:
  - "cursor"
  - "ai-agents"
  - "llm"
  - "productivity"
---

Cursor 3.11 shipped on July 10, 2026, and the headline feature solves a specific annoyance: you are deep in an agent task, a tangent occurs to you ("wait, does this repo even use `IAsyncEnumerable` anywhere?"), and asking it derails the thread you were building. Side chats give you a place to ask that question without touching the main conversation.

## A side chat is a full agent, not a scratchpad

The important detail is that a side chat is not a lightweight popup. It is a durable, full agent conversation that runs alongside your main chat. You can follow up on it, close it, and revisit it later, and it keeps its own context the whole time. That makes it different from clearing your prompt and retyping: the tangent becomes its own persistent thread you can return to.

You open one three ways: the `/side` command, the `/btw` shortcut, or the plus button at the top of the chat panel.

```text
# In the middle of a refactor, spin off a question without losing your place:
/btw where do we register the JWT bearer handler?

# Or explicitly:
/side compare our current retry policy to Polly's default
```

Side chats lean toward reading, searching, and answering while your main agent keeps its own state intact. The main task does not lose its plan because you went looking for an answer.

## Pulling the answer back with an at-mention

The part that makes this more than a second tab is the return path. Once a side chat has figured something out, you at-mention it from the main thread to pull that context back in:

```text
# Back in the main chat, fold the side chat's findings into the real work:
@side-chat: retry-policy apply that Polly comparison to OrderService
```

So the workflow is: branch off, investigate in isolation, then graft the conclusion back into the primary agent without having re-explained anything. The isolation keeps the main context clean while you explore; the at-mention means the exploration was not wasted.

## The rest of 3.11

Two more changes are worth knowing. Conversation search now runs off a local index: `Cmd+K` searches across thousands of past agent transcripts, and `Cmd+F` jumps between matches inside a single conversation. The repo and project pickers were rebuilt to scope by location (This Computer, Cloud, Remote Machines) and to let you create a project or connect GitHub/GitLab without leaving the picker.

For anyone scripting agent behavior, 3.11 also adds cloud agent hooks like `beforeSubmitPrompt` and `afterAgentResponse`, which let you observe and gate an agent's reasoning and its subagents' behavior:

```json
{
  "hooks": {
    "beforeSubmitPrompt": "./scripts/inject-guardrails.sh",
    "afterAgentResponse": "./scripts/lint-agent-output.sh"
  }
}
```

If you already run parallel workers, side chats sit one layer below that: not another agent doing work, but a place to think out loud without the main agent hearing it until you decide it should. For how the heavier multi-worker story compares across tools, see [Cursor subagents vs Claude Code subagents](/2026/07/cursor-subagents-vs-claude-code-subagents/). Full notes are on the [Cursor changelog](https://cursor.com/changelog).
