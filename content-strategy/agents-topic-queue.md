# Agents topic queue

Source of high-intent topics for `content-strategy/agents-prompt.md` (the AI coding agents / LLMs / MCP / automation lane). When a topic is picked up, the agents lane appends `→ slug: YYYY/MM/<slug>` to that line so it is not re-picked.

**Target depth**: 1500-2500 words per post.
**Target intent**: solve a real search query (error fix, comparison, migration, how-to) in the coding-agents / LLM / MCP space.
**Refill rule**: never let this file drop below **30 unconsumed items**. Weekly top-up task (`start-debugging-agents-refill`) pulls from Anthropic News, OpenAI Blog, Cursor/Aider/Copilot changelogs, and the relevant subreddits.

**Language-agnostic**: items do NOT have to tie to .NET. Claude Code, Cursor, Aider, MCP servers in TypeScript or Python are all fair game.

---

## How-to

- How to build a custom MCP server in TypeScript that wraps a CLI → slug: 2026/04/how-to-build-an-mcp-server-in-typescript-that-wraps-a-cli
- How to build a custom MCP server in Python with the official SDK → slug: 2026/04/how-to-build-a-custom-mcp-server-in-python-with-the-official-sdk
- How to build a custom MCP server in C# on .NET 11 → slug: 2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11
- How to schedule a recurring Claude Code task that triages GitHub issues → slug: 2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues
- How to write a CLAUDE.md that actually changes model behaviour → slug: 2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour
- How to add prompt caching to an Anthropic SDK app and measure the hit rate → slug: 2026/04/how-to-add-prompt-caching-to-an-anthropic-sdk-app-and-measure-the-hit-rate
- How to call the Claude API from a .NET 11 minimal API with streaming → slug: 2026/04/how-to-call-the-claude-api-from-a-net-11-minimal-api-with-streaming
- How to run Claude Code in a GitHub Action for autonomous PR review → slug: 2026/05/how-to-run-claude-code-in-a-github-action-for-autonomous-pr-review
- How to migrate a Semantic Kernel plugin to an MCP server → slug: 2026/05/migrate-a-semantic-kernel-plugin-to-an-mcp-server
- How to add tool calling to a Microsoft.Extensions.AI chat client → slug: 2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client
- How to expose an EF Core database to an AI agent via MCP → slug: 2026/05/how-to-expose-an-ef-core-database-to-an-ai-agent-via-mcp
- How to run a Semantic Kernel plugin from a BackgroundService → slug: 2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice
- How to give a Copilot Agent Skill access to your repo conventions → slug: 2026/05/how-to-give-a-copilot-agent-skill-access-to-your-repo-conventions
- How to write a Claude Code subagent that runs browser tests → slug: 2026/05/how-to-write-a-claude-code-subagent-that-runs-browser-tests
- How to pipe Cursor's context to an Aider session for multi-agent refactors → slug: 2026/05/how-to-pipe-cursors-context-to-an-aider-session-for-multi-agent-refactors
- How to set up an eval harness for a coding agent with LLM-as-judge → slug: 2026/05/how-to-set-up-an-llm-as-judge-eval-harness-for-a-coding-agent
- How to cache multi-turn Claude conversations across API calls → slug: 2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls
- How to structure a monorepo so Claude Code's context stays small → slug: 2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small
- How to add retrieval-augmented generation to a Claude Code session → slug: 2026/05/how-to-add-retrieval-augmented-generation-to-a-claude-code-session
- How to author a Microsoft Agent Framework skill in .NET (file vs inline C# vs class) → slug: 2026/05/microsoft-agent-framework-function-tools-inline-method-class
- How to reduce the number of MCP tools Claude loads to avoid the tool-use limit → slug: 2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads
- How to let Aider edit files outside the git repository → slug: 2026/05/how-to-let-aider-edit-files-outside-the-git-repository
- How to assign a Jira ticket to a Cursor cloud agent and get a PR back → slug: 2026/05/how-to-assign-a-jira-ticket-to-a-cursor-cloud-agent-and-get-a-pr-back

## Fix / error

- Fix: `MCP server stdio hang` when launched from Claude Code → slug: 2026/05/fix-mcp-server-stdio-hang-when-launched-from-claude-code
- Fix: `Tool call arguments did not match schema` in Anthropic tool use → slug: 2026/05/fix-tool-call-arguments-did-not-match-schema-in-anthropic-tool-use
- Fix: `Context window exceeded` during an Aider refactor → slug: 2026/05/fix-context-window-exceeded-during-an-aider-refactor
- Fix: `rate_limit_error` on Claude Sonnet 4.6 in a long agent loop → slug: 2026/05/fix-rate-limit-error-on-claude-sonnet-4-6-in-a-long-agent-loop
- Fix: Claude Code reports "MCP server disconnected" inside WSL → slug: 2026/05/fix-claude-code-reports-mcp-server-disconnected-inside-wsl
- Fix: Cursor's "Apply" button does nothing on a large diff → slug: 2026/05/fix-cursor-apply-button-does-nothing-on-large-diff
- Fix: GitHub Copilot ignores repository custom instructions in VS Code → slug: 2026/05/fix-github-copilot-ignores-repository-custom-instructions-in-vs-code
- Fix: `ECONNREFUSED` when a local MCP server starts before the client is ready → slug: 2026/05/fix-econnrefused-when-a-local-mcp-server-starts-before-the-client-is-ready
- Fix: `Extra inputs are not permitted` on a tool call with a structured argument → slug: 2026/05/fix-extra-inputs-are-not-permitted-on-a-tool-call-with-a-structured-argument
- Fix: an HTTP MCP server URL won't connect in Claude Desktop (stdio vs HTTP transport) → slug: 2026/05/fix-http-mcp-server-url-wont-connect-in-claude-desktop
- Fix: `Claude reached its tool-use limit for this turn` mid-task → slug: 2026/05/fix-claude-reached-its-tool-use-limit-for-this-turn
- Fix: GitHub MCP server tool calls fail silently when the PAT isn't passed → slug: 2026/05/fix-github-mcp-server-tool-calls-fail-silently-without-pat
- Fix: MCP servers stop working after a Claude Desktop update on Windows (config path moved) → slug: 2026/06/fix-mcp-servers-stop-working-after-claude-desktop-update-on-windows

## Vs / comparison

- Claude Code vs Cursor vs Aider for a .NET 11 repo in 2026 → slug: 2026/06/claude-code-vs-cursor-vs-aider-for-a-dotnet-11-repo
- Claude Code vs Cursor vs Copilot agent mode: where each wins → slug: 2026/06/claude-code-vs-cursor-vs-copilot-agent-mode-where-each-wins
- MCP vs OpenAPI plugins vs custom tool calling for AI agents → slug: 2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents
- Microsoft Agent Framework vs LangChain vs LlamaIndex in 2026 → slug: 2026/06/microsoft-agent-framework-vs-langchain-vs-llamaindex-in-2026
- Microsoft Agent Framework vs Semantic Kernel for a greenfield .NET agent
- Anthropic SDK vs Microsoft.Extensions.AI for calling Claude from .NET
- Prompt caching on Claude Sonnet 4.6 vs Claude Opus 4.7: when it pays off
- Claude subagents vs OpenAI Assistants for parallelisable work
- LLM-as-judge vs rule-based evals for a coding agent
- Hangfire vs Quartz.NET vs IHostedService for scheduled LLM jobs
- MCP stdio vs HTTP vs SSE transport: which to choose
- A2A protocol vs MCP: agent-to-agent vs agent-to-tool
- CodeAct vs a traditional tool-calling loop for agents

## Migration / upgrade

- Migrate a Semantic Kernel app to Microsoft Agent Framework 1.0
- Migrate from OpenAI SDK to Microsoft.Extensions.AI in a .NET app
- Migrate a LangChain agent to the MCP tool-calling pattern
- Migrate a custom tool-calling loop to an MCP server
- Migrate from Copilot chat prompts to a Copilot Agent Skill in your repo
- Migrate an MCP server from SSE to streamable HTTP transport
- Migrate a custom multi-agent orchestrator to handoff orchestration in Agent Framework

## Patterns

- Patterns: scheduling Claude Code via cron for autonomous daily workflows
- Patterns: sub-agent orchestration in Claude Code, when to spawn and when not to
- Patterns: writing an eval harness for a coding agent
- Patterns: MCP server design for a large internal API surface
- Patterns: keeping a CLAUDE.md readable as the repo grows
- Patterns: prompt-cache-first API design for multi-turn agents
- Patterns: safe file-write tools for an agent (preview, confirm, apply)
- Patterns: information-flow control to block prompt injection in agents
- Patterns: storing agent chat history - cost, privacy, and portability tradeoffs

## What is / concept

- What is the Model Context Protocol and why every IDE is shipping it
- What is an "agent skill" and how is it different from a system prompt
- What is prompt caching and when does it save real money
- What is a coding agent "subagent" and when does it beat one big prompt
- What is the difference between an AI agent and an AI workflow
- What is tool calling and why JSON schemas matter more than prompts
- What is a context window and how do agents stretch it in 2026
- What is CodeAct and how does it cut an agent's model turns

---

## Consumed

<!-- entries move here with `→ slug: YYYY/MM/<slug>` annotations once a post is written -->
