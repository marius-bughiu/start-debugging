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
- How to expose your own functions to a Cursor SDK agent with `local.customTools` instead of a separate MCP server → slug: 2026/06/expose-functions-to-cursor-sdk-agent-with-local-customtools
- How to persist Cursor SDK agent state across restarts with a custom `LocalAgentStore` (SQLite vs JSONL) → slug: 2026/06/persist-cursor-sdk-agent-state-across-restarts-sqlite-vs-jsonl
- How to gate which Cursor SDK tool calls run automatically with auto-review and `permissions.json` → slug: 2026/06/gate-cursor-sdk-tool-calls-with-auto-review-and-permissions-json
- How to nest subagents in the Cursor SDK so a reviewer can delegate to a test-writer → slug: 2026/06/nest-subagents-in-the-cursor-sdk-reviewer-delegates-to-test-writer
- How to automate a repository task with GitHub Agentic Workflows without a personal access token → slug: 2026/06/github-agentic-workflows-without-a-personal-access-token
- How to trigger a GitHub Copilot coding agent task from the Agent Tasks REST API → slug: 2026/06/trigger-github-copilot-coding-agent-task-from-rest-api
- How to auto-fix a failing GitHub Action with "Fix with Copilot" → slug: 2026/06/how-to-auto-fix-a-failing-github-action-with-fix-with-copilot
- How to deploy a Microsoft Agent Framework agent to Foundry Hosted Agents → slug: 2026/06/deploy-a-microsoft-agent-framework-agent-to-foundry-hosted-agents
- How to add policy enforcement and audit logging to a Microsoft Agent Framework agent with the Governance Toolkit → slug: 2026/06/policy-enforcement-and-audit-logging-for-a-microsoft-agent-framework-agent
- How to run a pre-push code review locally with Cursor Bugbot's `/review` → slug: 2026/06/how-to-run-bugbot-review-locally-before-pushing-in-cursor
- How to run parallel conversations in Cursor with Side Chats without interrupting the agent
- How to observe an agent's prompts, thinking, and subagents with Cursor cloud agent hooks → slug: 2026/07/observe-cursor-cloud-agent-prompts-thinking-subagents-with-hooks
- How to build a Cursor automation with the `/automate` skill and GitHub triggers → slug: 2026/07/build-a-cursor-automation-with-automate-skill-and-github-triggers
- How to distribute a team MCP server config across Cursor cloud agents and the IDE → slug: 2026/07/distribute-team-mcp-config-across-cursor-cloud-agents-and-ide
- How to set per-session AI credit spend limits in the Copilot CLI and SDK
- How to package reusable domain expertise as an Agent Skill in .NET with Microsoft Agent Framework

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
- Fix: `MCP error -32000: Client Closed` in Claude Code when a server dies on launch → slug: 2026/06/fix-mcp-error-32000-connection-closed-in-claude-code
- Fix: Claude Code drops MCP tools after auto-compaction (reconnect with `/mcp`) → slug: 2026/06/fix-claude-code-drops-mcp-tools-after-auto-compaction
- Fix: Claude Code high memory usage and context overflow (`/heapdump` and `/compact`) → slug: 2026/07/fix-claude-code-high-memory-usage-and-context-overflow
- Fix: all MCP servers fail to load after one malformed-JSON syntax error in the config
- Fix: Claude Code misreads an MCP server's stderr startup message as an error
- Fix: "Autocompact thrashing" when a large file or tool output immediately refills the context window
- Fix: MCP server protocol incompatibility on Node.js versions below 18

## Vs / comparison

- Claude Code vs Cursor vs Aider for a .NET 11 repo in 2026 → slug: 2026/06/claude-code-vs-cursor-vs-aider-for-a-dotnet-11-repo
- Claude Code vs Cursor vs Copilot agent mode: where each wins → slug: 2026/06/claude-code-vs-cursor-vs-copilot-agent-mode-where-each-wins
- MCP vs OpenAPI plugins vs custom tool calling for AI agents → slug: 2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents
- Microsoft Agent Framework vs LangChain vs LlamaIndex in 2026 → slug: 2026/06/microsoft-agent-framework-vs-langchain-vs-llamaindex-in-2026
- Microsoft Agent Framework vs Semantic Kernel for a greenfield .NET agent → slug: 2026/06/microsoft-agent-framework-vs-semantic-kernel-for-a-greenfield-net-agent
- Anthropic SDK vs Microsoft.Extensions.AI for calling Claude from .NET → slug: 2026/06/anthropic-sdk-vs-microsoft-extensions-ai-for-calling-claude-from-dotnet
- Prompt caching on Claude Sonnet 4.6 vs Claude Opus 4.7: when it pays off → slug: 2026/06/prompt-caching-on-claude-sonnet-4-6-vs-claude-opus-4-7-when-it-pays-off
- Claude subagents vs OpenAI Assistants for parallelisable work → slug: 2026/06/claude-subagents-vs-openai-assistants-for-parallel-work
- LLM-as-judge vs rule-based evals for a coding agent → slug: 2026/06/llm-as-judge-vs-rule-based-evals-for-a-coding-agent
- Hangfire vs Quartz.NET vs IHostedService for scheduled LLM jobs → slug: 2026/06/hangfire-vs-quartz-net-vs-ihostedservice-for-scheduled-llm-jobs
- MCP stdio vs HTTP vs SSE transport: which to choose → slug: 2026/07/mcp-stdio-vs-http-vs-sse-transport-which-to-choose
- A2A protocol vs MCP: agent-to-agent vs agent-to-tool → slug: 2026/07/a2a-protocol-vs-mcp-agent-to-agent-vs-agent-to-tool
- CodeAct vs a traditional tool-calling loop for agents → slug: 2026/07/codeact-vs-tool-calling-loop-for-agents
- Claude Code skills vs subagents vs MCP servers: when to build each → slug: 2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each
- Cursor subagents vs Claude Code subagents for multi-agent workflows → slug: 2026/07/cursor-subagents-vs-claude-code-subagents
- Agent Framework orchestration: sequential vs concurrent vs group chat vs handoff vs magentic
- Cursor cloud agents vs GitHub Copilot coding agent for background PRs

## Migration / upgrade

- Migrate a Semantic Kernel app to Microsoft Agent Framework 1.0 → slug: 2026/07/migrate-a-semantic-kernel-app-to-microsoft-agent-framework-1-0
- Migrate from OpenAI SDK to Microsoft.Extensions.AI in a .NET app → slug: 2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai
- Migrate a LangChain agent to the MCP tool-calling pattern → slug: 2026/07/migrate-a-langchain-agent-to-the-mcp-tool-calling-pattern
- Migrate a custom tool-calling loop to an MCP server → slug: 2026/07/migrate-a-custom-tool-calling-loop-to-an-mcp-server
- Migrate from Copilot chat prompts to a Copilot Agent Skill in your repo
- Migrate an MCP server from SSE to streamable HTTP transport
- Migrate a custom multi-agent orchestrator to handoff orchestration in Agent Framework
- Migrate a custom TypeScript agent loop to the Cursor SDK
- Migrate a Cursor rules file to the new plugins, skills, and subagents model

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
- Patterns: nested subagent hierarchies - when delegation depth helps and when it just burns tokens
- Patterns: human-in-the-loop tool gating for autonomous coding agents (auto-review and permission gates)
- Patterns: parallel side-chats vs subagents - when to branch a conversation and when to delegate
- Patterns: hooks as observability for cloud coding agents (prompts, thinking, subagents, compaction)
- Patterns: cost control for autonomous agents with per-session credit and spend limits

## What is / concept

- What is the Model Context Protocol and why every IDE is shipping it
- What is an "agent skill" and how is it different from a system prompt
- What is prompt caching and when does it save real money
- What is a coding agent "subagent" and when does it beat one big prompt
- What is the difference between an AI agent and an AI workflow
- What is tool calling and why JSON schemas matter more than prompts
- What is a context window and how do agents stretch it in 2026
- What is CodeAct and how does it cut an agent's model turns
- What is the Agent Harness in Microsoft Agent Framework
- What is GitHub Agentic Workflows and how does it differ from GitHub Actions
- What is the GitHub Copilot SDK and what can you build with it
- What is magentic orchestration in Microsoft Agent Framework
- What is Claude Tag and how does it bring Claude into Slack

---

## Consumed

<!-- entries move here with `→ slug: YYYY/MM/<slug>` annotations once a post is written -->
