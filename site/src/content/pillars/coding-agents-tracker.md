---
title: "The coding agents tracker"
description: "Claude Code, Cursor, Copilot, MCP, Microsoft Agent Framework - every post on building and working with AI coding agents, in one place."
tagline: "One bookmark for coding agents, LLMs, and MCP."
pubDate: 2026-04-23
updatedDate: 2026-10-25
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

Everything on the site about **AI coding agents, LLMs, and the Model Context Protocol**: Claude Code, Cursor, Copilot, Microsoft Agent Framework, MCP and skills.

## What to read first

[Claude Code vs Cursor vs Copilot Agent Mode](/2026/06/claude-code-vs-cursor-vs-copilot-agent-mode-where-each-wins/) settles where each wins, and [an AI agent vs an AI workflow](/2026/10/what-is-the-difference-between-an-ai-agent-and-an-ai-workflow/) decides who owns control flow. For .NET, start with [Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/), then [Agent Framework vs Semantic Kernel](/2026/06/microsoft-agent-framework-vs-semantic-kernel-for-a-greenfield-net-agent/) for the fork. For MCP, [what the protocol is](/2026/09/what-is-the-model-context-protocol-and-why-every-ide-is-shipping-it/) explains it, and [a custom server in C#](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) builds one. [MCP C# SDK 2.0](/2026/07/mcp-csharp-sdk-2-0-stateless-by-default-and-mcp9005/) is stateless by default; [migrating 1.x to 2.x](/2026/09/migrate-mcp-csharp-sdk-1-x-to-2-0-without-breaking-old-clients/) keeps older clients connected. A 401 after OAuth is usually [the token audience mismatch](/2026/09/fix-mcp-401-invalid-token-audience-does-not-match-server-url/).

For Claude Code, [a CLAUDE.md that changes behaviour](/2026/04/how-to-write-a-claude-md-that-actually-changes-model-behaviour/) leads, and [subtask vs fork vs background agent](/2026/08/subtask-vs-fork-vs-background-agent-in-claude-code/) decides what gets its own context; for long jobs, [a Cursor Projects coordinator](/2026/10/split-a-long-running-task-across-agents-with-a-cursor-projects-coordinator/) splits the work, and [Copilot local sandboxing](/2026/10/how-to-turn-on-copilot-local-sandboxing-and-restrict-what-an-agent-can-touch/) fences each agent. Before widening an allowlist, read [the 2.1.251 permission-check bypasses](/2026/08/claude-code-2-1-251-four-ways-around-the-permission-check/), and make guard hooks [fail closed with `onFailure: "block"`](/2026/10/how-to-make-a-claude-code-hook-fail-closed-with-onfailure-block/). [What an agent skill is](/2026/10/what-is-an-agent-skill-and-how-is-it-different-from-a-system-prompt/) explains why skills beat a longer prompt, and [tool calling](/2026/10/what-is-tool-calling-and-why-json-schemas-matter-more-than-prompts/) why a schema beats either. [Copilot Memory vs custom instructions vs AGENTS.md](/2026/09/copilot-memory-vs-repository-custom-instructions-vs-agents-md/) says which the model reads, and [one AGENTS.md for every tool](/2026/09/migrate-cursorrules-claude-md-copilot-instructions-to-one-agents-md/) ends the drift.

## What's on this page

The list below auto-collects posts tagged with any of: `ai-agents`, `llm`, `mcp`, `claude-code`, `cursor`, `github-copilot`, `agent-skills`, `microsoft-agent-framework`. Newest first.

Companion: [the security tracker](/pillars/security-tracker/) for locking agents down.
