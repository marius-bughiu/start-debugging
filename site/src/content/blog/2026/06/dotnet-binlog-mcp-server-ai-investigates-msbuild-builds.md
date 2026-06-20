---
title: "The Binlog MCP Server Lets an AI Read Your MSBuild Logs"
description: "Microsoft shipped Microsoft.AITools.BinlogMcp on 2026-06-17, an MCP server that exposes 15 tools so Claude or Copilot can diagnose build failures and slow targets straight from a .binlog file."
pubDate: 2026-06-20
tags:
  - "dotnet"
  - "msbuild"
  - "mcp"
  - "ai-agents"
---

On 2026-06-17 Microsoft shipped the [Binlog MCP Server](https://devblogs.microsoft.com/dotnet/msbuild-binlog-mcp-server/), an MCP server that parses MSBuild binary logs and hands an AI assistant 15 specialized tools to investigate them. The pitch is simple: instead of opening a multi-megabyte `.binlog` in the MSBuild Structured Log Viewer and hunting through nested targets by hand, you ask "why did my build fail?" and the model goes and reads the log for you.

## Why a binlog is the right surface

A binary log is the highest-fidelity record MSBuild produces. It captures every target, task, property evaluation, and item, plus the source files that were embedded at build time. That detail is exactly what makes it painful to read manually, and exactly what a model is good at querying. By putting the parser behind the Model Context Protocol, the same log works in any MCP client: Claude Code, Copilot in VS Code, or Visual Studio.

Generate one the usual way:

```bash
dotnet build /bl:build-a.binlog
```

## Wiring it into an MCP client

The server is published as the `Microsoft.AITools.BinlogMcp` dotnet tool. In VS Code you point `mcp.json` at it over stdio:

```json
{
  "servers": {
    "binlog-mcp": {
      "type": "stdio",
      "command": "dotnet",
      "args": ["tool", "run", "Microsoft.AITools.BinlogMcp"]
    }
  }
}
```

If you want the model to open a specific log on startup, pass it after the `--` separator:

```json
{
  "args": ["tool", "run", "Microsoft.AITools.BinlogMcp", "--", "--binlog", "msbuild.binlog"]
}
```

Visual Studio and VS Code can also pull it in through the `dotnet-msbuild` plugin from the `dotnet/skills` marketplace, which auto-discovers the server so you skip the JSON entirely.

## The 15 tools, grouped by what you actually ask

The tools split into four jobs. For diagnosing a red build there is `binlog_overview` (status, duration, error and project counts), `binlog_errors`, `binlog_warnings` filterable by code, and `binlog_search`, which runs full-text queries in the StructuredLog DSL. The standout is `binlog_explain_property`: it traces where a property value actually came from, so a question like "why is `TargetFramework` set to net8.0 here?" gets an evaluation chain instead of a guess.

For slow builds, `binlog_expensive_projects`, `binlog_expensive_targets`, and `binlog_expensive_tasks` rank by wall-clock time. And `binlog_compare` diffs two logs, which is the one I expect to earn its keep:

> Compare `build-a.binlog` and `build-b.binlog`. What MSBuild properties and package versions changed?

That single prompt replaces the tedious side-by-side scan you do when a build works on your machine and fails in CI.

This is part of a broader pattern of Microsoft wrapping .NET diagnostics in MCP so agents can drive them. The server lives in [`dotnet/skills`](https://github.com/dotnet/skills); file issues there. If you have a flaky CI build sitting in a log nobody wants to open, this is the lowest-effort way to point a model at it.
