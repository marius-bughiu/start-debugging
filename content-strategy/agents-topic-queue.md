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
- How to run parallel conversations in Cursor with Side Chats without interrupting the agent → slug: 2026/07/cursor-3-11-side-chats-parallel-agent-threads
- How to observe an agent's prompts, thinking, and subagents with Cursor cloud agent hooks → slug: 2026/07/observe-cursor-cloud-agent-prompts-thinking-subagents-with-hooks
- How to build a Cursor automation with the `/automate` skill and GitHub triggers → slug: 2026/07/build-a-cursor-automation-with-automate-skill-and-github-triggers
- How to distribute a team MCP server config across Cursor cloud agents and the IDE → slug: 2026/07/distribute-team-mcp-config-across-cursor-cloud-agents-and-ide
- How to set per-session AI credit spend limits in the Copilot CLI and SDK → slug: 2026/07/set-ai-credit-session-limits-in-github-copilot-cli-and-sdk
- How to package reusable domain expertise as an Agent Skill in .NET with Microsoft Agent Framework → slug: 2026/07/package-domain-expertise-as-an-agent-skill-microsoft-agent-framework
- How to lock down a coding agent's network egress with a strict host allowlist → slug: 2026/07/how-to-lock-down-a-coding-agents-network-egress-with-a-strict-host-allowlist
- How to stream nested subagent output from a headless Claude Code run with `--forward-subagent-text` → slug: 2026/07/stream-nested-subagent-output-from-a-headless-claude-code-run
- How to run a background coding agent that auto-commits and opens a draft PR when it finishes → slug: 2026/07/run-a-background-coding-agent-that-auto-commits-and-opens-a-draft-pr
- How to define an agent orchestration in YAML with Microsoft Agent Framework Declarative Workflows 1.0 → slug: 2026/07/agent-framework-declarative-workflows-1-0-yaml-orchestration
- How to route models per request with Cursor Router and enforce Intelligence/Balance/Cost across a team → slug: 2026/07/cursor-router-makes-auto-a-per-request-model-decision
- How to route MCP traffic through a gateway using the `Mcp-Method` and `Mcp-Name` headers → slug: 2026/08/route-mcp-traffic-through-a-gateway-with-mcp-method-and-mcp-name-headers
- How to package skills and an MCP server together as one Agent Plugin (`plugin.json`, `skills/`, `mcp.json`) → slug: 2026/08/package-skills-and-an-mcp-server-as-one-agent-plugin
- How to centrally control which MCP servers a team can run with `allowedMcpServers` and `deniedMcpServers` → slug: 2026/08/centrally-control-which-mcp-servers-a-team-can-run
- How to set the reasoning level for a GitHub Copilot cloud agent per task → slug: 2026/08/how-to-set-the-reasoning-level-for-a-github-copilot-cloud-agent-per-task
- How to serve agent skills from an MCP server in .NET with `UseMcpSkills` instead of shipping them in the app → slug: 2026/08/serve-agent-skills-from-an-mcp-server-in-dotnet-with-usemcpskills
- How to run a Microsoft Agent Framework agent on the GitHub Copilot harness as its execution engine (skipped: same intent as 2026/08/agent-framework-github-copilot-provider-copilot-cli-as-aiagent, which covers CopilotClient.AsAIAgent, the deny-by-default permission handler, SessionConfig.McpServers and Squad)
- How to cut Cursor cloud agent startup time with prebuilt Builds → slug: 2026/08/how-to-cut-cursor-cloud-agent-startup-time-with-builds
- How to give a Microsoft Agent Framework agent persistent memory with Azure Cosmos DB
- How to expose one Microsoft Agent Framework agent over Telegram, A2A, and MCP client channels with per-channel behaviour
- How to keep Cursor agent tool execution inside your own network with self-hosted machines
- How to run shared agentic work with GitHub Copilot in Slack
- How to trigger a GitHub Copilot automation from an issue or pull request comment
- How to give a Cursor cloud agent a long-lived objective with `/goal`
- How to pin skills to a Cursor Custom Mode so an agent stays on one task

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
- Fix: all MCP servers fail to load after one malformed-JSON syntax error in the config → slug: 2026/07/fix-all-mcp-servers-fail-to-load-after-malformed-json-in-config
- Fix: Claude Code misreads an MCP server's stderr startup message as an error → slug: 2026/07/fix-claude-code-misreads-mcp-server-stderr-as-error
- Fix: "Autocompact thrashing" when a large file or tool output immediately refills the context window → slug: 2026/07/fix-claude-code-autocompact-thrashing-on-large-file-or-tool-output
- Fix: MCP server protocol incompatibility on Node.js versions below 18 → slug: 2026/07/fix-mcp-server-fetch-is-not-defined-on-node-below-18
- Fix: Windows paths with `\u` segments mangled into CJK characters in an agent config file → slug: 2026/07/fix-windows-path-in-mcp-json-turns-into-tab-newline-or-cjk-character
- Fix: `.mcp.json` servers never start because the workspace is marked untrusted → slug: 2026/07/fix-mcp-json-servers-never-start-because-the-workspace-is-untrusted
- Fix: a long MCP tool call gets auto-backgrounded after two minutes mid-task → slug: 2026/07/fix-long-mcp-tool-call-auto-backgrounded-after-two-minutes
- Fix: a `Write(src)` permission rule never matches - directory rules need `src/**` → slug: 2026/08/fix-write-rule-is-not-matched-by-file-permission-checks
- Fix: MCP client and server negotiate different protocol versions (2025-11-25 vs 2026-07-28) → slug: 2026/08/fix-mcp-unsupported-protocol-version-2025-11-25-vs-2026-07-28
- Fix: `MCP9004`/`MCP9005`/`MCP9006` deprecation warnings after upgrading the MCP C# SDK to v2.0 → slug: 2026/08/fix-mcp9004-mcp9005-mcp9006-warnings-after-mcp-csharp-sdk-2-0
- Fix: an MCP server never starts because an enterprise allowlist blocks its command or URL → slug: 2026/08/fix-mcp-server-blocked-by-enterprise-allowlist
- Fix: a remote MCP server returns `401 invalid_token` because the token's `aud` doesn't match the canonical server URL
- Fix: an MCP client drops the `Authorization` header across a 308 cross-origin redirect and gets a 401
- Fix: Cursor Agent won't initialise - "extension host didn't finish starting within 60 seconds"
- Fix: a coding agent loops forever re-running a check it can't satisfy with the tools it has
- Fix: a `PreToolUse` hook returns `allow` but a later deny rule still blocks the tool call
- Fix: Copilot can't see a file because a content exclusion rule removed it from the index
- Fix: Claude Code ignores `AGENTS.md` - import it from `CLAUDE.md` or symlink it

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
- Agent Framework orchestration: sequential vs concurrent vs group chat vs handoff vs magentic → slug: 2026/07/agent-framework-orchestration-patterns-compared
- Cursor cloud agents vs GitHub Copilot coding agent for background PRs → slug: 2026/07/cursor-cloud-agents-vs-github-copilot-coding-agent-for-background-prs
- Auto permission mode vs manual approval in a coding agent: what each actually allows through → slug: 2026/08/auto-mode-vs-manual-approval-what-each-permission-mode-allows
- Declarative YAML workflows vs code-first orchestration in Microsoft Agent Framework → slug: 2026/08/agent-framework-declarative-yaml-vs-code-first-orchestration
- Subtask vs fork vs background agent in Claude Code: which delegation to reach for → slug: 2026/08/subtask-vs-fork-vs-background-agent-in-claude-code
- Stateful vs stateless MCP servers: what actually breaks when the session goes away → slug: 2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away
- Agent Plugins 1.0 vs vendor-specific plugin formats: what the shared standard covers and what it doesn't → slug: 2026/08/agent-plugins-1-0-vs-vendor-specific-plugin-formats
- Copilot memory vs repository custom instructions vs `AGENTS.md`: which one the model actually reads → slug: 2026/09/copilot-memory-vs-repository-custom-instructions-vs-agents-md
- Copilot code review vs Cursor Bugbot vs a Claude Code review action: which catches what
- Cursor sandbox providers compared: AWS Lambda vs Modal vs Cloudflare vs Vercel for agent tool execution
- Local Ollama models vs cloud models in GitHub Copilot: what you give up

## Migration / upgrade

- Migrate a Semantic Kernel app to Microsoft Agent Framework 1.0 → slug: 2026/07/migrate-a-semantic-kernel-app-to-microsoft-agent-framework-1-0
- Migrate from OpenAI SDK to Microsoft.Extensions.AI in a .NET app → slug: 2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai
- Migrate a LangChain agent to the MCP tool-calling pattern → slug: 2026/07/migrate-a-langchain-agent-to-the-mcp-tool-calling-pattern
- Migrate a custom tool-calling loop to an MCP server → slug: 2026/07/migrate-a-custom-tool-calling-loop-to-an-mcp-server
- Migrate from Copilot chat prompts to a Copilot Agent Skill in your repo → slug: 2026/07/migrate-copilot-prompt-files-to-agent-skills
- Migrate an MCP server from SSE to streamable HTTP transport → slug: 2026/07/migrate-an-mcp-server-from-sse-to-streamable-http
- Migrate a custom multi-agent orchestrator to handoff orchestration in Agent Framework → slug: 2026/08/migrate-a-custom-multi-agent-orchestrator-to-handoff-orchestration
- Migrate a custom TypeScript agent loop to the Cursor SDK → slug: 2026/08/migrate-a-custom-typescript-agent-loop-to-the-cursor-sdk
- Migrate a Cursor rules file to the new plugins, skills, and subagents model → slug: 2026/08/migrate-cursor-rules-to-skills-subagents-and-plugins
- Migrate off the archived MCP reference servers (GitHub, Postgres, Slack) to their maintained replacements → slug: 2026/08/migrate-off-archived-mcp-reference-servers
- Migrate an agent from chunking-and-RAG to a 1M-token context window → slug: 2026/08/migrate-from-rag-chunking-to-a-1m-token-context-window
- Migrate a Claude Code setup to the "Manual" default permission mode without breaking headless runs → slug: 2026/08/migrate-to-manual-permission-mode-without-breaking-headless-runs
- Migrate an MCP server from session-based transport to the stateless 2026-07-28 spec (skipped: same intent as 2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away, which covers the six migration buckets, the handle pattern and the feature matrix)
- Migrate off deprecated MCP sampling and elicitation to `InputRequiredResult` multi round-trip requests (skipped: answered by 2026/08/fix-mcp9004-mcp9005-mcp9006-warnings-after-mcp-csharp-sdk-2-0 for C# and 2026/08/stateful-vs-stateless-mcp-servers-what-breaks-when-the-session-goes-away for TypeScript)
- Migrate an MCP C# SDK 1.x server to v2.0 without breaking v1 clients → slug: 2026/09/migrate-mcp-csharp-sdk-1-x-to-2-0-without-breaking-old-clients
- Migrate a vendor-specific agent plugin to the cross-vendor Agent Plugins 1.0 layout (skipped: same intent as 2026/08/agent-plugins-1-0-vs-vendor-specific-plugin-formats, which covers the component matrix, the reverse-domain escape hatch and the recommendation to make the 1.0.0 layout the source of truth, plus 2026/08/package-skills-and-an-mcp-server-as-one-agent-plugin for the dual-layout directory and the `${PLUGIN_ROOT}` vs `${CLAUDE_PLUGIN_ROOT}` gotcha)
- Migrate a stdio MCP server to a remote OAuth-protected HTTP server with dynamic client registration
- Migrate duplicated per-tool rule files (`.cursorrules`, `CLAUDE.md`, `copilot-instructions.md`) to a single `AGENTS.md` source of truth
- Migrate a Cursor cloud agent workflow off GitHub to Cursor Origin repos

## Patterns

- Patterns: scheduling Claude Code via cron for autonomous daily workflows (skipped: same intent as 2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues, which already compares Routines vs GitHub Actions cron vs /loop)
- Patterns: sub-agent orchestration in Claude Code, when to spawn and when not to (skipped: answered by 2026/08/subtask-vs-fork-vs-background-agent-in-claude-code and 2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each)
- Patterns: writing an eval harness for a coding agent (skipped: answered by 2026/05/how-to-set-up-an-llm-as-judge-eval-harness-for-a-coding-agent and 2026/06/llm-as-judge-vs-rule-based-evals-for-a-coding-agent)
- Patterns: MCP server design for a large internal API surface → slug: 2026/08/mcp-server-design-for-a-large-internal-api-surface
- Patterns: keeping a CLAUDE.md readable as the repo grows (skipped: same intent as 2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour, which covers the 200-line ceiling and `.claude/rules/`, plus 2026/05/how-to-structure-a-monorepo-so-claude-codes-context-stays-small on splitting the file as the repo grows)
- Patterns: prompt-cache-first API design for multi-turn agents (skipped: answered by 2026/05/how-to-cache-multi-turn-claude-conversations-across-api-calls, which covers breakpoint placement, TTL refresh and prefix invalidation across turns)
- Patterns: safe file-write tools for an agent (preview, confirm, apply) → slug: 2026/08/safe-file-write-tools-for-an-agent-preview-confirm-apply
- Patterns: information-flow control to block prompt injection in agents → slug: 2026/09/information-flow-control-to-block-prompt-injection-in-agents
- Patterns: storing agent chat history - cost, privacy, and portability tradeoffs → slug: 2026/09/where-to-store-agent-chat-history-cost-privacy-portability
- Patterns: nested subagent hierarchies - when delegation depth helps and when it just burns tokens → slug: 2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens
- Patterns: human-in-the-loop tool gating for autonomous coding agents (auto-review and permission gates)
- Patterns: parallel side-chats vs subagents - when to branch a conversation and when to delegate
- Patterns: hooks as observability for cloud coding agents (prompts, thinking, subagents, compaction)
- Patterns: cost control for autonomous agents with per-session credit and spend limits
- Patterns: keeping API keys out of agent context with a credential gateway
- Patterns: running coding agents in disposable VMs and containers instead of on your laptop
- Patterns: measuring an agent's fixed token overhead - system prompt and tool schemas before the first user token
- Patterns: stateless tool design - passing state handles as tool arguments instead of relying on the transport
- Patterns: self-healing end-to-end tests when a coding agent renames selectors

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
- What are declarative agent workflows and when is YAML better than code
- What is a Multi Round-Trip Request in MCP and why it replaced server-initiated sampling
- What is the MCP Tasks extension and when do you need poll-based long-running tools
- What is Agent Plugins 1.0 and which agents can install the same plugin

---

## Consumed

<!-- entries move here with `→ slug: YYYY/MM/<slug>` annotations once a post is written -->
