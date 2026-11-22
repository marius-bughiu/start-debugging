---
title: "The coding agents tracker"
description: "Claude Code, Cursor, Copilot, MCP, Microsoft Agent Framework - every post on building and working with AI coding agents, in one place."
tagline: "One bookmark for coding agents, LLMs, and MCP."
pubDate: 2026-04-23
updatedDate: 2026-11-22
indexTags:
  - "ai-agents"
  - "llm"
  - "mcp"
  - "claude-code"
  - "cursor"
  - "github-copilot"
  - "agent-skills"
  - "microsoft-agent-framework"
---

Posts on **AI coding agents, LLMs, and the Model Context Protocol**: Claude Code, Cursor, Copilot, Microsoft Agent Framework, MCP and skills.

## What to read first

[Claude Code vs Cursor vs Copilot Agent Mode](/2026/06/claude-code-vs-cursor-vs-copilot-agent-mode-where-each-wins/) settles where each wins, and [an AI agent vs an AI workflow](/2026/10/what-is-the-difference-between-an-ai-agent-and-an-ai-workflow/) decides who owns control flow. For .NET, start with [Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/), then [Agent Framework vs Semantic Kernel](/2026/06/microsoft-agent-framework-vs-semantic-kernel-for-a-greenfield-net-agent/) for the fork. For MCP, [what the protocol is](/2026/09/what-is-the-model-context-protocol-and-why-every-ide-is-shipping-it/) explains it, [ACP vs MCP](/2026/11/acp-vs-mcp-what-the-agent-client-protocol-does-that-mcp-does-not/) separates it from the editor-side protocol, and [a custom server in C#](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) builds one. [MCP C# SDK 2.0](/2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005/) is stateless by default; [migrating 1.x to 2.x](/2026/09/migrate-mcp-csharp-sdk-1-x-to-2-0-without-breaking-old-clients/) keeps older clients connected. A 401 after OAuth is usually [the token audience mismatch](/2026/09/fix-mcp-401-invalid-token-audience-does-not-match-server-url/).

For Claude Code, [a CLAUDE.md that changes behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) leads, and [subtask vs fork vs background agent](/2026/08/subtask-vs-fork-vs-background-agent-in-claude-code/) decides what gets its own context; for multi-day jobs, [a coordinator agent plus workers](/2026/11/coordinator-agent-plus-worker-agents-for-multi-day-projects/) splits the work, and [Copilot local sandboxing](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/) fences each agent. Before widening an allowlist, read [the 2.1.251 permission-check bypasses](/2026/08/claude-code-2-1-251-four-ways-around-the-permission-check/), make guard hooks [fail closed with `onFailure: "block"`](/2026/10/how-to-make-a-claude-code-hook-fail-closed-with-onfailure-block/), and keep unattended runs moving with [`denyInsteadOfPrompting`](/2026/11/how-to-keep-headless-claude-code-runs-from-stalling-on-permission-prompts/) or [sandboxed Bash auto-allow](/2026/11/how-to-let-sandboxed-bash-run-without-permission-prompts-in-claude-code/). [What an agent skill is](/2026/10/what-is-an-agent-skill-and-how-is-it-different-from-a-system-prompt/) explains why skills beat a longer prompt, and [tool calling](/2026/10/what-is-tool-calling-and-why-json-schemas-matter-more-than-prompts/) why a schema beats either. On the Claude API, [prompt-cache diagnostics](/2026/11/how-to-find-out-why-a-claude-prompt-cache-missed-with-diagnostics/) name what broke the cache, and [`ant apply`](/2026/11/how-to-manage-claude-managed-agents-skills-and-memory-stores-as-code-with-ant-apply/) keeps managed agents and skills in git.

## What's on this page

The list below auto-collects posts tagged with any of: `ai-agents`, `llm`, `mcp`, `claude-code`, `cursor`, `github-copilot`, `agent-skills`, `microsoft-agent-framework`. Newest first.

Companion: [the security tracker](/pillars/security-tracker/) for locking agents down.
