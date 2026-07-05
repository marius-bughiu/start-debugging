---
title: "Claude Code Skills vs Subagents vs MCP Servers: When to Build Each in 2026"
description: "Build a skill to change how Claude works, a subagent to protect your context window, and an MCP server to reach a system Claude cannot otherwise touch. They solve three different problems, not one. Here is the decision, the mechanics, and the config for each."
pubDate: 2026-07-05
template: vs
tags:
  - "comparison"
  - "claude-code"
  - "agent-skills"
  - "mcp"
  - "ai-agents"
  - "subagents"
---

If you are extending Claude Code and cannot decide between a skill, a subagent, and an MCP server, here is the one-line call: **build a skill to change how Claude does a task, a subagent to keep a noisy task out of your main context window, and an MCP server to give Claude access to a system it otherwise cannot reach.** These are not three answers to the same question. A skill changes behavior, a subagent protects context, an MCP server adds capability. Most real setups use all three, and the mistake that wastes the most time is reaching for the wrong one, for example writing an MCP server to inject a checklist that should have been a 40-line `SKILL.md`.

Everything below is pinned to Claude Code 2.x (field-tested around `v2.1.198`), the [Agent Skills](https://agentskills.io) open standard that Anthropic published in late 2025, and the MCP specification revision [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). Model routing examples use `claude-sonnet-4-6`, `claude-opus-4-7`, and Haiku for cheap subagent work.

## The three problems, stated plainly

Before the table, get the framing right, because the framing is the whole decision:

- **A skill** answers "Claude doesn't know *our* procedure." Your release runbook, your code-review rubric, the exact way your team writes migrations. The knowledge is procedural and situational, and you want it loaded only when the task calls for it.
- **A subagent** answers "this work would blow up my context window." Reading 40 files, grinding through a long log, doing an exploration whose output you will never look at again. The subagent does that in its own context and hands back only the summary.
- **An MCP server** answers "Claude literally cannot reach this system." A Postgres database, your Linear board, an internal metrics API, Stripe. No amount of skill-writing conjures a database connection. That is a genuine new capability, and capabilities come from MCP servers.

Anthropic's own guidance draws the same line for the two that people most often confuse: "MCP connects Claude to data; Skills teach Claude what to do with that data." An MCP server that returns rows and a skill that explains how to interpret those rows are complements, not substitutes.

## The feature matrix

| Feature | Skill | Subagent | MCP server |
| --- | --- | --- | --- |
| Core job | Change behavior / procedure | Isolate a task's context | Add a new capability / connection |
| Lives at | `.claude/skills/<name>/SKILL.md` | `.claude/agents/<name>.md` | `.mcp.json` / client config |
| Format | Markdown + YAML frontmatter | Markdown + YAML frontmatter | Running process (stdio or HTTP) |
| Language | None (it is instructions) | None (it is instructions) | Any (TS, Python, C#, Go...) |
| Own context window | No (loads into the main one) | Yes (separate window) | No (tools called from main) |
| Loading cost when idle | ~100 tokens (metadata only) | ~0 until delegated | Tool schemas load up front |
| Loading cost when used | Under ~5k tokens + files on demand | Full separate budget | Per-call tool results |
| Invoked by | Claude auto-detects, or `/skill-name` | Claude delegates on description match | Claude calls the tool by name |
| Runs code | Only bundled scripts you ship | Via its allowed tools | Yes, that is the point |
| Reusable across projects | `~/.claude/skills/` (personal) | `~/.claude/agents/` (user) | Global client config |
| Best for | Runbooks, rubrics, conventions, formatting | Research, review, long explorations | DBs, APIs, SaaS, live systems |

The single axis that decides most cases: **do you need new instructions, a fresh context window, or a new connection?** Everything else follows from that.

## When to build a skill

Reach for a skill when the thing you keep doing is a *procedure*, and Claude already has every tool it needs to execute it. A skill is just a folder with a `SKILL.md` at the root:

```markdown
<!-- .claude/skills/release-checklist/SKILL.md, Claude Code 2.x, Agent Skills standard -->
---
name: release-checklist
description: Runs our release checklist. Use when the user asks to cut a release, tag a version, or prepare a changelog.
---

# Release checklist

1. Confirm `main` is green in CI before anything else.
2. Bump the version in `Directory.Build.props`, not the csproj files.
3. Generate the changelog from merged PR titles since the last tag.
4. Open the release PR with the `release` label so the deploy workflow picks it up.
```

The directory name (`release-checklist`) becomes the `/release-checklist` command, and the `description` is what Claude reads to decide whether to load the skill on its own. The mechanic that makes skills cheap is **progressive disclosure**: only the metadata (name plus description, on the order of 100 tokens) sits in context at all times. The body loads only when the skill fires, and it is meant to stay under about 5k tokens. Bundled files, reference docs, and scripts in the same folder load only when Claude actually reaches for them. That is why you can have 30 skills installed and pay almost nothing until one is relevant, which is the opposite of stuffing the same content into `CLAUDE.md`, where it is billed on every single turn.

That contrast is the clearest signal you want a skill. If a section of your `CLAUDE.md` has quietly grown from a *fact* ("we use xUnit") into a *procedure* ("here is how to add an integration test, step by step"), it belongs in a skill. I go deeper on that split in [how to write a CLAUDE.md that actually changes model behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/); the short version is that facts stay in `CLAUDE.md` and procedures move to skills.

Good skill candidates:

- **A repeated multi-step task**: your deploy dance, your "add a new API endpoint" boilerplate, your incident runbook.
- **A formatting or output contract**: how commit messages, ADRs, or PR descriptions should look, ideally with an example file the skill points to.
- **Portable expertise you want everywhere**: put it in `~/.claude/skills/` and it follows you into every repo on the machine.

Skills also became portable *across tools* once Anthropic made the format an [open standard](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills), with a partner directory that includes Notion, Figma, Stripe, and others. If you have used [Copilot's SKILL.md discovery in Visual Studio 2026](/2026/04/visual-studio-2026-copilot-agent-skills/), the shape will look familiar; it is the same idea landing in more than one agent.

## When to build a subagent

Reach for a subagent when the problem is not *what* Claude should do but *how much noise* the work generates. A subagent runs in its own context window with its own system prompt and its own tool allowlist, and it returns only a summary to the main conversation. The exploration, the 40 file reads, the giant log, all of that stays in the subagent's window and never pollutes yours.

A subagent is a Markdown file with frontmatter, where the body is the system prompt:

```markdown
<!-- .claude/agents/test-runner.md, Claude Code 2.x -->
---
name: test-runner
description: Runs the test suite, reads failures, and reports a concise summary. Use after code changes to verify nothing broke.
tools: Read, Grep, Glob, Bash
model: haiku
---

You run the project's tests and report back tersely.

Run the suite, read only the failing output, and return a short list of
what failed and the likely cause. Do not paste full logs into your reply.
```

Only `name` and `description` are required. The `tools` field enforces a constraint (this agent cannot write files), and `model: haiku` routes the grunt work to a cheaper, faster model instead of burning Opus on log-reading. The subagent receives only this system prompt plus basic environment details, not Claude Code's full system prompt, which is part of why it stays lean. Files live in `.claude/agents/` for a project or `~/.claude/agents/` to reuse everywhere.

Good subagent candidates:

- **Codebase research**: "find every place we construct an `HttpClient` by hand." The answer is a paragraph; the process is dozens of file reads you never want to see.
- **Test and build verification**: run it, read the failures, report the cause, as in [a subagent that runs browser tests](/2026/05/how-to-write-a-claude-code-subagent-that-runs-browser-tests/).
- **Constrained review**: a reviewer with `tools: Read, Grep, Glob` and no write access, so it physically cannot touch your files.
- **Parallel fan-out**: several read-only workers exploring at once, which is exactly the pattern behind [Claude Code's dynamic workflows fanning a prompt across up to 1,000 subagents](/2026/05/claude-code-dynamic-workflows-opus-4-8/).

The tell for a subagent: you catch yourself thinking "I wish this search hadn't eaten half my context." That is a context problem, not a knowledge problem, and a fresh window is the fix.

## When to build an MCP server

Reach for an MCP server only when Claude needs to *touch a system it cannot currently reach*. Skills and subagents both operate with the tools Claude already has: files, shell, grep. The moment you need to query a live database, hit an internal REST API, read from Stripe, or move a card on a Linear board, you need a new tool surface, and MCP is how you expose one.

An MCP server is a real program, in any language, that you register with your client:

```jsonc
// .mcp.json (project-scoped), MCP spec 2025-11-25, Claude Code 2.x
{
  "mcpServers": {
    "metrics": {
      "command": "node",
      "args": ["./mcp-servers/metrics/dist/index.js"],
      "env": { "METRICS_API_TOKEN": "${METRICS_API_TOKEN}" }
    }
  }
}
```

That entry launches a stdio server as a subprocess; the tools it exposes then show up to Claude by name. If you have never written one, the language-specific walkthrough in [building an MCP server in TypeScript that wraps a CLI](/2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli/) is the fastest path from zero to a working tool.

Good MCP server candidates:

- **A live data source**: Postgres, Elasticsearch, an internal metrics endpoint, anything behind a network call.
- **A third-party SaaS**: Linear, GitHub, Stripe, Jira. Many now ship official servers you just register.
- **A capability with real side effects**: creating a ticket, opening a PR, running a deploy through an API rather than a shell.

The tell for an MCP server: no prompt you could write and no context window you could clear would help, because the thing you need is a *connection*. If the capability already exists as a CLI or an HTTP endpoint, MCP is how you make it a first-class tool. And if you are weighing MCP against other integration styles, [MCP vs OpenAPI plugins vs custom tool calling](/2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents/) lays out when each earns its keep.

## The gotcha that picks for you

A few hard edges override preference entirely.

**Do not build an MCP server for something that isn't a capability.** This is the most common miss. Teams write a whole stdio server whose only job is to return a block of instructions or a coding standard. That is a skill. An MCP server is justified by a *connection or a side effect*, not by "I want Claude to know this." If your server never touches anything outside the repo, it should have been a `SKILL.md`.

**Every MCP server costs context even when idle.** Unlike a skill's ~100-token metadata footprint, an MCP server's tool schemas load into context up front, and a chatty server with 30 tools can crowd out real reasoning and even trip the tool-use limit. That is a live enough problem to have its own fix: [how to reduce the number of MCP tools Claude loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/). Skills do not have this problem, which is another reason to prefer a skill whenever a skill can do the job.

**Skills cannot open a socket; subagents cannot grant new powers.** A skill is instructions, so it can only orchestrate tools that already exist. A subagent gets a fresh *context*, not fresh *capabilities*; its tool allowlist is a subset of what the session already has. Neither one can reach a database. If you find yourself trying to make a skill "connect" to something, stop, that is the MCP-shaped hole.

**They compose, and the best setups lean on that.** A single task can pull all three: an MCP server exposes your database, a skill teaches Claude your query conventions and how to read the results, and a subagent runs the whole investigation in an isolated window so a 20-query exploration returns as a two-line finding. Claude Code even lets a skill run inside a subagent, so the composition is first-class rather than a hack.

## The call, restated

Ask one question: do I need new *instructions*, a fresh *context window*, or a new *connection*?

- New instructions, and Claude already has the tools: build a **skill**. Cheapest to write, cheapest to run, portable across projects and now across agents. Start here by default.
- The task is noisy and would flood your main window: build a **subagent**. It buys you an isolated context, a constrained toolset, and optional cheap-model routing.
- Claude cannot reach the system at all: build an **MCP server**. It is the only one of the three that adds a genuinely new capability, and it is the only one you should be writing real code for.

When in doubt, try to solve it with a skill first. If the skill has nothing to orchestrate because the tool does not exist, you have found your MCP server. If the skill works but drowns your context, wrap it in a subagent. That order, cheapest and least powerful first, is the one that keeps your context lean and your setup honest.

## Sources

- Anthropic Engineering, [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- Claude by Anthropic, [Skills explained: how Skills compares to prompts, Projects, MCP, and subagents](https://claude.com/blog/skills-explained)
- Claude Code docs, [Extend Claude with skills](https://code.claude.com/docs/en/skills)
- Claude Code docs, [Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Agent Skills open standard](https://agentskills.io)
- MCP specification [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
