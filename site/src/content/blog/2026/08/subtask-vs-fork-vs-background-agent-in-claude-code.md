---
title: "Subtask vs Fork vs Background Agent in Claude Code: Which Delegation to Reach For"
description: "A named subagent starts cold, a fork inherits your whole conversation and shares your prompt cache, and a background agent is a second Claude Code session entirely. The trap is the naming: /fork stopped being the in-session fork at v2.1.212 and /subtask took over."
pubDate: 2026-08-06
template: vs
tags:
  - "comparison"
  - "claude-code"
  - "ai-agents"
  - "subagents"
  - "context-window"
---

Claude Code gives you three different ways to hand work to another agent, and they are easy to confuse because two of them were called the same thing until recently. Here is the call: **spawn a named subagent when the work is self-contained and you want its noise out of your context, run `/subtask` when the work needs everything you have already discussed, and dispatch a background session with `claude --bg` when the work should outlive the terminal you are sitting in.** The one that trips people up is `/fork`. On Claude Code v2.1.161 through v2.1.211 it started an in-session fork. As of [v2.1.212](https://code.claude.com/docs/en/sub-agents#fork-the-current-conversation) it copies your whole session into a separate background session instead, and `/subtask` is the command that forks in place.

Everything below is pinned to the Claude Code 2.1.x line. Behavioural claims come from the [subagents reference](https://code.claude.com/docs/en/sub-agents), the [agent view reference](https://code.claude.com/docs/en/agent-view), and the [prompt caching reference](https://code.claude.com/docs/en/prompt-caching), with the fork internals cross-checked against a local **Claude Code 2.1.123 on Windows 11** install.

## Three primitives, three different things being isolated

The useful framing is not "which one is more powerful" but "what does each one cut you off from". Every delegation decision is a trade between context you keep and context you spend.

| | Named subagent | Fork (`/subtask`) | Background session (`/fork`, `--bg`) |
| --- | --- | --- | --- |
| Starting context | Fresh, only the prompt you pass | Your full conversation history | A copy of your full session |
| System prompt and tools | From the subagent's definition file, filtered for background runs | Identical to the main session | Same as a normal session |
| Model | The definition's `model` field | Same as the main session | The dispatch model, set with `--model` |
| Prompt cache | Its own, cold on the first call | Reads the parent's cache | Its own |
| Lives in | Your session | Your session | A supervisor process, no terminal needed |
| Result arrives as | A tool result in your conversation | A message in your main conversation | You attach to it and read it |
| Survives closing the terminal | No | No | Yes |
| Counts toward the 200-subagent session cap | Yes | Yes | No |

The row that decides most real cases is the first one. A named subagent starts cold, so you pay to re-explain the situation. A fork starts warm, so you do not. A background session starts warm too, but it is a genuinely separate Claude, with its own quota consumption and its own worktree.

## The rename that breaks muscle memory

If you learned this feature before August 2026, your fingers know `/fork` as the in-session fork. That is no longer what it does.

The current behaviour, quoting the subagents reference: run a forked subagent with `/subtask`, which requires v2.1.212 or later. When agent view is turned off, `/subtask` is not available and `/fork` starts the forked subagent instead. Otherwise `/fork` copies the whole session into a new background session.

So the same keystroke gives you one of two very different things depending on a setting you may not remember changing:

```bash
# Claude Code v2.1.212+, agent view ON (the default)
/subtask draft unit tests for the parser changes so far   # in-session fork, inherits context
/fork open a draft pull request with the work so far      # NEW background session, detaches
```

```bash
# Same version, agent view OFF via CLAUDE_CODE_DISABLE_AGENT_VIEW=1
/fork draft unit tests for the parser changes so far      # in-session fork (the old meaning)
```

On v2.1.161 through v2.1.211, `/fork` is the in-session fork and `/subtask` does not exist. Check `claude --version` before trusting any write-up about this, including this one.

## Named subagents: cold start, filtered tools

A named subagent is a markdown file with YAML frontmatter, in `.claude/agents/` for the project or `~/.claude/agents/` for you personally:

```markdown
<!-- .claude/agents/test-runner.md, Claude Code 2.1.x -->
---
name: test-runner
description: Runs the test suite and reports only failures. Use after code changes.
tools: Read, Grep, Glob, Bash
model: haiku
---

Run the full test suite. Report only failing tests with their error messages.
Do not attempt fixes.
```

The frontmatter fields the `--agents` flag and file-based definitions both accept are `description`, `prompt`, `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `skills`, `initialPrompt`, `memory`, `effort`, `background`, `isolation`, and `color`.

Two things about named subagents surprise people. The first is that **as of v2.1.198 they run in the background by default**. Claude only runs one in the foreground when it needs the result before it can continue. The second follows from the first: background subagents get a *smaller* built-in tool set than foreground ones. A background subagent keeps every MCP tool but only these built-ins: `Read`, `Grep`, `Glob`, `Bash`, `PowerShell`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`, `Skill`, `ToolSearch`, `EnterWorktree`, `ExitWorktree`, `Monitor`, `TaskStop`, `SendMessage`, and `Artifact`.

Everything else is stripped, whether inherited or explicitly listed in `tools`. That means **the same definition file can resolve to different tools depending on where it runs**, and the removal is silent unless it leaves the `tools` list resolving to nothing. If a subagent mysteriously cannot do something it could do last month, this is the first thing to check.

Model routing is the other reason to reach for a named subagent. Pointing exploration at Haiku with `model: haiku` is the cheapest structural win available, and you cannot do it with a fork, because a fork always runs the parent's model.

## Forks: same context, and they read your cache

A fork drops the input isolation that makes subagents cheap to reason about. It sees the same system prompt, the same tools, the same model, and the same message history as the main session. What it keeps is the *output* isolation: its tool calls stay out of your conversation and only the final result comes back.

That inheritance has a direct cost consequence. Because a fork's system prompt and tool definitions are byte-identical to the parent's, its first request reads the parent's prompt cache instead of building a new one. A named subagent does the opposite: it starts its own conversation with its own system prompt, gets no cache hits on its first call, and uses the five-minute TTL even on a subscription where the main conversation gets the one-hour TTL.

Cached reads bill at roughly 10% of the standard input rate, so on a session carrying tens of thousands of tokens of history, the difference between forking and re-briefing a cold subagent is most of an order of magnitude on that first request. If you find yourself pasting a long recap into a subagent prompt, you wanted a fork.

You can start one yourself without any configuration:

```text
/subtask draft unit tests for the parser changes so far
```

Claude Code names the fork from the first words of the task, shows it in a panel below the prompt, and runs it in the background while you keep working. In that panel, `Enter` opens the fork's transcript so you can send it follow-ups, `x` stops a running fork or dismisses a finished one, and `Esc` returns focus to the prompt.

Letting *Claude* spawn forks on its own is a separate, experimental switch:

```bash
# Enable fork mode explicitly, regardless of the staged rollout
export CLAUDE_CODE_FORK_SUBAGENT=1

# Disable it everywhere, including any server-side rollout
export CLAUDE_CODE_FORK_SUBAGENT=0
```

The variable is honoured in interactive mode, in headless runs, and through the Agent SDK. Turning it on changes two things: Claude can request the `fork` subagent type explicitly, and **every** subagent starts running in the background, fork or not, because fork mode removes the `run_in_background` parameter from the Agent tool. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` takes precedence and forces subagents back to synchronous.

That selection mechanism has changed. The fork agent definition compiled into the local 2.1.123 binary still describes itself as an implicit fork that is "Not selectable via subagent_type; triggered by omitting subagent_type when the fork experiment is active", alongside `model: "inherit"`, `permissionMode: "bubble"`, `maxTurns: 200`, and a wildcard tool list. The current documentation describes the opposite: Claude spawns a fork by requesting the `fork` type explicitly, and omitting the type gets you the general-purpose subagent. If you are reading older reverse-engineering write-ups that say "omit `subagent_type` to fork", they were right for their version and are wrong for current ones.

Forks also skip both of the tool filters described above and receive the main conversation's exact tool pool. That is usually what you want and occasionally alarming: a fork can reach anything you can reach.

## Background sessions: a second Claude, not a second context

The third option is not a subagent at all. It is a full Claude Code conversation that keeps running with no terminal attached, hosted by a per-user supervisor process.

```bash
# Dispatch from the shell, Claude Code 2.1.x
claude --bg "investigate the flaky SettingsChangeDetector test"

# Name it, and run it under a specific subagent definition
claude --bg --name "flaky-test-fix" --agent code-reviewer "address review comments on PR 1234"

# Watch everything from one place
claude agents
claude agents --json --all
```

From inside a session, `/background` (alias `/bg`) moves the current conversation into a background session, and `/fork` copies it into a new one while the original keeps running. Backgrounding starts a fresh process that resumes from the saved conversation, and in-flight work moves with it: running background shell commands, backgrounded subagents, dynamic workflows, and `/loop` scheduled tasks all carry over.

Three properties matter for the decision:

- **File isolation is automatic.** Before editing files, a background session moves itself into an isolated git worktree under `.claude/worktrees/`, so parallel sessions read the same checkout but each writes to its own. Set `"worktree": { "bgIsolation": "none" }` to turn that off.
- **Quota is not shared.** Background sessions consume subscription usage exactly like interactive ones. Ten agents in parallel burn quota roughly ten times as fast as one. This is the cost nobody budgets for.
- **They are local.** Sessions run on your machine and survive sleep, but stop if the machine shuts down. The supervisor also stops idle sessions after about an hour unless you pin them with `Ctrl+T`.

The deletion behaviour deserves a warning of its own: worktrees Claude created are deleted along with the session in agent view. Commit before you delete a session that edited files.

## The decision, in three questions

Work down this list and stop at the first yes:

1. **Does the task need the conversation you have already had?** If re-explaining it would take more than a paragraph, use `/subtask`. You get the context for free and you read the parent's cache instead of rebuilding one.
2. **Should the work keep going after you close the terminal, or touch files you do not want touched in your checkout?** Use `claude --bg`, or `/fork` from inside the session. You get worktree isolation and process durability, and you pay separate quota.
3. **Otherwise, use a named subagent.** Self-contained work, verbose output you will never re-read, a cheaper model, or a restricted tool set. This is the default answer and should stay the default answer.

A fourth case that is none of the above: for a quick question about something already in your conversation, `/btw` sees your full context, has no tool access, and discards the answer instead of adding it to history. It is strictly cheaper than forking when you just want to ask something.

## Limits that bite in long sessions

Three separate caps govern subagent use, each with its own variable, and they are easy to conflate:

- **Depth.** A subagent can spawn subagents up to three layers below the main conversation by default. At the limit, Claude Code withholds the `Agent` tool from every subagent except a fork, and a fork at the limit keeps `Agent` in its inherited tool list but the tool returns an error instead of spawning. Change it with `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; set `1` to turn nesting off. The default has moved around, so check yours: v2.1.172 through v2.1.216 allowed five layers with no way to change it, v2.1.217 and v2.1.218 defaulted to one, and v2.1.219 settled on three.
- **Session total.** Claude can spawn at most 200 subagents per session, raised with `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` (v2.1.212 or later). Nested subagents, forks, and background subagents all count. A `/subtask` you start yourself spends the same budget but is not blocked by the cap. A session created with `/fork` does not count at all, since it has its own budget.
- **A fork cannot spawn further forks.** Full stop, at any depth.

One more subtlety worth knowing before you trust a progress report: a background subagent's results reach Claude as a completion notification in a later turn. Claude waits for that notification before reporting results, and if you ask about progress first, it will tell you the subagent is still running. Before v2.1.211 it sometimes reported results for a subagent that had not finished, which made for some confidently wrong summaries.

Finally, subagent output is scanned before Claude reads it. The scan never removes or rewords anything, but it escapes text imitating Claude Code's own output such as a `<system-reminder>` tag, and prepends a marker line when a report imitates such a tag or mentions settings like `bypassPermissions`. It is a labelling mechanism, not a sandbox, and no substitute for restricting what a subagent can reach.

## Related

- [Claude Code Skills vs Subagents vs MCP Servers: When to Build Each in 2026](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/) covers the layer above this one: whether you need a subagent at all, or a skill, or a new capability entirely.
- [Claude Code 2.1.219 Reopens Nested Subagents, Three Layers Deep](/2026/07/claude-code-2-1-219-nested-subagents-three-layers-deep/) has the history behind the depth limit that keeps changing.
- If you want the background-session pattern end to end, [running a background coding agent that auto-commits and opens a draft PR](/2026/07/run-a-background-coding-agent-that-auto-commits-and-opens-a-draft-pr/) wires up the whole loop.
- The cache maths behind forking is the same maths in [prompt caching on Claude Sonnet 4.6 vs Opus 4.7](/2026/06/prompt-caching-on-claude-sonnet-4-6-vs-claude-opus-4-7-when-it-pays-off/).
- Permission prompts from background subagents surface in your main session, which interacts with the modes described in [what each permission mode actually allows through](/2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows/).

## Sources

- [Create custom subagents](https://code.claude.com/docs/en/sub-agents), Claude Code documentation, including the fork, tool filtering, and limits sections.
- [Background agents and agent view](https://code.claude.com/docs/en/agent-view), Claude Code documentation.
- [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching), specifically the subagents and cache section.
- [Environment variables](https://code.claude.com/docs/en/env-vars) for `CLAUDE_CODE_FORK_SUBAGENT`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, and the subagent limits.
</content>
</invoke>
