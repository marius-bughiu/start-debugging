---
title: "Cursor Subagents vs Claude Code Subagents for Multi-Agent Workflows"
description: "Both let one agent spawn isolated workers from a Markdown file, but Claude Code nests five levels deep with per-agent tool allowlists and worktree isolation, while Cursor keeps it to two levels with a single readonly switch and reads Claude's format for free. Pick by where your agents run, not by brand."
pubDate: 2026-07-06
template: vs
tags:
  - "comparison"
  - "ai-agents"
  - "claude-code"
  - "cursor"
  - "subagents"
  - "llm"
---

If you are wiring up multi-agent work in mid-2026 and choosing between Cursor's subagents and Claude Code's, here is the short version: **both give you the same core primitive (one agent spawns isolated workers defined in a Markdown file with YAML frontmatter), but Claude Code is the deeper orchestration engine and Cursor is the more visible IDE-native one.** Pick **Claude Code** when your agents run headless or in CI, when you need nesting past two levels, or when you want fine-grained per-agent tool and repository isolation. Pick **Cursor** when you live inside the editor and want to watch parallel workers run. And because Cursor reads Claude's `.claude/agents/` directory directly, the choice is not always exclusive: you can author a subagent once and run it in both.

Everything below is pinned to versions current as of July 6, 2026: Claude Code 2.1.x running `claude-opus-4-8`, `claude-sonnet-4-6`, and `claude-haiku-4-5`; Cursor subagents as shipped in Cursor 2.4 (January 2026) with `/multitask` parallel dispatch added in Cursor 3.2 (April 24, 2026), running Cursor's `composer-2` or an inherited frontier model. Where a claim depends on a hard limit or a version, the number is in the sentence.

## The feature matrix

| Feature | Claude Code subagents (2.1.x) | Cursor subagents (2.4 / 3.2) |
| --- | --- | --- |
| Definition file | `.claude/agents/*.md` (project), `~/.claude/agents/*.md` (user) | `.cursor/agents/*.md` (project), `~/.cursor/agents/*.md` (user), **also reads `.claude/agents/` and `.codex/agents/`** |
| Required frontmatter | `name`, `description` | none (all optional; `name` derives from filename) |
| Model field | `sonnet`, `opus`, `haiku`, `fable`, full ID, or `inherit` (default) | `"inherit"` (default) or a model ID like `"composer-2"` |
| Tool scoping | `tools` allowlist + `disallowedTools` denylist, per-agent MCP scoping | single `readonly` boolean |
| Nesting depth | up to **5 levels** below the main conversation | **2 levels** (main agent and its direct subagents) |
| Background execution | **default** since v2.1.198; force with `background: true` | opt-in with `is_background: true` |
| Repository isolation | `isolation: worktree` per agent | not a frontmatter field |
| Invocation | automatic delegation, explicit Agent tool | `/name`, natural language, automatic delegation |
| Programmatic entry | Claude Agent SDK, `--agents` JSON flag | Cursor CLI / SDK, `/multitask` |

The rest of this post is why those rows matter.

## The primitive both share

A subagent, in either tool, is a separate model instance with its own context window, its own system prompt, and its own tool access. The parent agent hands it a self-contained task; the subagent does the noisy work (reading dozens of files, running a suite, fetching docs) in its own context and returns only a summary. The verbose output never lands in the main conversation. Both products express this as a Markdown file with YAML frontmatter, and the shapes are close enough to be interchangeable at a glance.

A Claude Code subagent looks like this:

```markdown
<!-- .claude/agents/api-researcher.md -->
<!-- Claude Code 2.1.x -->
---
name: api-researcher
description: Investigates one API module in isolation. Use proactively for parallel research across independent areas.
tools: Read, Grep, Glob
model: haiku
---

You research a single module. Read only what you need, then return a
tight summary: public surface, key dependencies, and any risk you spotted.
Do not modify files.
```

The Cursor equivalent:

```markdown
<!-- .cursor/agents/api-researcher.md -->
<!-- Cursor 2.4 -->
---
name: api-researcher
description: Investigates one API module in isolation. Use for parallel research.
model: inherit
readonly: true
is_background: false
---

You research a single module. Read only what you need, then return a
tight summary: public surface, key dependencies, and any risk you spotted.
```

Read those two side by side and the philosophies fall out. Claude Code makes you name the exact tools the subagent may touch (`tools: Read, Grep, Glob`). Cursor collapses the whole question into `readonly: true`. That single line is the cleanest expression of the difference: Claude Code hands you a control surface, Cursor hands you a switch.

## Where Claude Code pulls ahead: depth and tool control

Two Claude Code capabilities have no direct Cursor analogue.

**Five levels of nesting.** As of Claude Code v2.1.172, a subagent can spawn its own subagents, and the tree can go five levels deep below the main conversation. Depth is counted as the number of subagent levels regardless of foreground or background execution; a subagent at depth five does not receive the Agent tool and cannot spawn further. The limit is fixed and not configurable. This is what lets a reviewer subagent dispatch a verifier per finding, and each verifier fan out again, with only the top-level summary returning to you. Cursor's tree is shallower by design: the main agent and its direct subagents can launch subagents, but a subagent launched by another subagent cannot launch further ones. That is two useful levels versus five. For the deep, self-similar delegation patterns covered in [when to nest subagents so a reviewer delegates to a test-writer](/2026/06/nest-subagents-in-the-cursor-sdk-reviewer-delegates-to-test-writer/), Claude Code simply has more room.

**Allowlists, denylists, and per-agent MCP scoping.** Cursor's `readonly` boolean is binary: writes on or off. Claude Code's `tools` field is a precise allowlist, `disallowedTools` is a denylist layered on top, and you can scope individual MCP servers to a single subagent. You can build a subagent that inherits every tool except `Write` and `Edit`:

```markdown
<!-- .claude/agents/no-writes.md -->
<!-- Claude Code 2.1.x -->
---
name: no-writes
description: Inherits every tool from the main conversation except file writes
disallowedTools: Write, Edit
---

Investigate and report. You keep Bash and MCP tools, but you cannot
change any files.
```

That is a materially different agent from `readonly: true`, which would also strip the Bash access this one keeps. When a subagent needs to run a build or hit an MCP server but must never touch source, the denylist expresses it exactly; the boolean cannot.

**Worktree isolation.** Set `isolation: worktree` and the subagent gets a temporary git worktree, an isolated copy of the repository branched from your default branch, cleaned up automatically if the subagent makes no changes. That is the safe way to let parallel workers edit files without stepping on each other or on your checkout. Cursor has no equivalent frontmatter field; parallel Cursor subagents that write share the working tree, so you lean on `readonly` for most workers and serialize the ones that mutate.

**Background by default.** Since v2.1.198, Claude Code runs subagents in the background by default, and Claude sets foreground only when it needs the result before continuing. That shift, which I covered when [subagents started running in the background by default](/2026/07/claude-code-2-1-198-subagents-run-in-the-background-by-default/), means a wide fan-out keeps working while you do. Cursor inverts the default: subagents run foreground unless you set `is_background: true`.

## Where Cursor pulls ahead: the IDE and the format truce

Cursor's advantages are not about the primitive, they are about where it runs.

**It is native to the editor.** Cursor's subagents surface as visible workers inside the IDE. Cursor 3.2 reframed the editor as an agent execution runtime, and `/multitask` spawns async subagents in parallel rather than serializing them in a queue. You watch the tree run in the same window where you read the diff, click into a worker, and steer. Claude Code shows a subagent panel below the prompt in the terminal, which is capable but text-first. If your mental model is "I am editing code and occasionally dispatching helpers," Cursor's surface fits that better.

**It reads Claude's format.** This is the detail most comparisons miss. Cursor's subagent loader scans `.cursor/agents/`, `.claude/agents/`, and `.codex/agents/`, with project definitions taking precedence on a name conflict. In practice that means a `.claude/agents/` directory you already wrote for Claude Code is picked up by Cursor with no porting step. The two tools are not fighting over a format; Cursor adopted Claude's. So the real move for a mixed team is to author subagents in the Claude Code superset (they carry more fields), commit them under `.claude/agents/`, and let Cursor consume the subset it understands. Fields Cursor does not recognize, such as `isolation` or `disallowedTools`, are simply ignored on the Cursor side.

**Simplicity when you do not need the knobs.** If your workers are all read-only researchers, `readonly: true` is the entire security model and there is nothing else to reason about. Claude Code's richer surface is only an advantage when you actually use it; for a team that wants three parallel code-readers and nothing fancier, Cursor's frontmatter is less to get wrong.

## The gotcha that picks for you

Two facts force the decision more than any preference.

**Do your agents run without a human watching?** If the answer is CI, a cron job, a GitHub Action, or any headless pipeline, Claude Code is the tool, because its whole subagent story is designed to run through the Claude Agent SDK and the `--agents` JSON flag with the same definitions you use interactively. Cursor's subagents are strongest inside the running IDE. You can drive Cursor headlessly, but the visible-workers advantage that justifies choosing it evaporates when nobody is looking at the screen.

**Do you need to bound cost precisely?** Both tools bill each subagent independently, so three parallel workers cost roughly three times one pass, and each summary that returns to the parent adds tokens to the orchestrator's context. Claude Code gives you more levers to contain that: route read-only workers to `claude-haiku-4-5` with `model: haiku`, keep the orchestrator on `claude-opus-4-8`, and cap effort per agent. The same discipline that keeps [a monorepo's context small for Claude Code](/2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small/) applies to fan-out: the more precisely you can scope each worker, the cheaper a wide tree gets. Cursor's `inherit`-or-`composer-2` model choice is coarser, which is fine until a careless fan-out on a frontier model surprises you on the invoice.

## The recommendation, restated

If you are choosing one and only one, choose by where the work runs. **Claude Code** is the better multi-agent engine for anything autonomous, deeply nested, or tool-restricted: five levels of nesting, allowlists plus denylists, per-agent MCP scoping, worktree isolation, and background-by-default execution add up to real orchestration control. **Cursor** is the better choice when you are interactively building in the IDE and want parallel workers you can see and steer, with a security model that is one boolean instead of a tool list.

But the framing that treats this as exclusive is usually wrong. Cursor reading `.claude/agents/` means a team can standardize on the Claude Code format, keep the definitions in version control, run them autonomously through the Agent SDK, and still have every Cursor user pick them up in the editor for free. If you are still deciding between the harnesses themselves rather than their subagent systems, the trade-offs in [how Claude Code, Cursor, and Aider compare on a real .NET 11 repo](/2026/06/claude-code-vs-cursor-vs-aider-for-a-dotnet-11-repo/) are the next thing to read, and if you are unsure whether a subagent is even the right unit of reuse, [when to build a skill, a subagent, or an MCP server](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/) draws that line.

Sources: [Create custom subagents (Claude Code docs)](https://code.claude.com/docs/en/sub-agents), [Subagents in the Agent SDK](https://code.claude.com/docs/en/agent-sdk/subagents), [Subagents (Cursor docs)](https://cursor.com/docs/subagents), [Cursor 2.4 changelog: Subagents, Skills, and Image Generation](https://cursor.com/changelog/2-4).
