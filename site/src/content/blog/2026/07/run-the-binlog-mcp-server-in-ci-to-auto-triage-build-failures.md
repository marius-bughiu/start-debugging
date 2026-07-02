---
title: "Run the Binlog MCP Server in CI to Auto-Triage Build Failures"
description: "On 2026-06-30 Microsoft showed the Binlog MCP Server running unattended in a GitHub Agentic Workflow, so an agent reads the .binlog and comments a root cause the moment a CI build breaks."
pubDate: 2026-07-02
tags:
  - "dotnet"
  - "msbuild"
  - "mcp"
  - "ai-agents"
  - "ci"
---

On 2026-06-30 the .NET team published [MCP Beyond the Chat Window: Build Diagnostics in CI](https://devblogs.microsoft.com/dotnet/mcp-build-diagnostics-workflows/), and it takes the Binlog MCP Server out of your editor and drops it into your pipeline. Two weeks ago that server was something you pointed Claude or Copilot at by hand from a local `.binlog` (I covered that setup in [The Binlog MCP Server Lets an AI Read Your MSBuild Logs](/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/)). The new demo runs it unattended in GitHub Actions: the build breaks, an agent reads the log, and a root-cause comment lands on the pull request before anyone downloads anything.

## Why CI is the better home for a binlog

The interactive story is nice, but the real pain is in CI. A build goes red, you pull a multi-megabyte binary log off the runner, open the MSBuild Structured Log Viewer, and scroll through nested targets looking for the one error that matters. Moving the parser into the pipeline deletes that whole loop. The `.binlog` never leaves the runner, and the model does the reading.

You still generate the log the same way. Add `/bl` to any MSBuild-driven command:

```bash
dotnet build /bl
dotnet test /bl
dotnet pack /bl
```

## Wiring it into a GitHub Agentic Workflow

The key difference is that the server ships as a container image, so the workflow mounts the log in read-only and lets the agent query it. The `microsoft/testfx` repo uses roughly this shape:

```yaml
mcp-servers:
  binlog-mcp:
    container: "mcr.microsoft.com/dotnet-buildtools/prereqs:azurelinux-3.0-binlog-mcp-amd64"
    mounts:
      - "/tmp/build.binlog:/data/build.binlog:ro"
    allowed: ["*"]
```

The job runs the build with a binary log, and only when the build fails does it wake the agent. Nothing runs on green, so you pay no token cost for passing builds.

## binlog_diagnose does the first pass

The tool that makes this practical is `binlog_diagnose`. Instead of the agent stringing together `binlog_errors`, `binlog_search`, and `binlog_target_reasons` on its own, `binlog_diagnose` reads the log, groups the errors, identifies the likely root cause, and suggests a fix in one call. The rest of the suite (`binlog_overview`, `binlog_compare`, `binlog_task_details`, and a growing list of others covering performance, dependency graphs, and incremental-build introspection) is still there when the agent needs to dig deeper.

In Microsoft's own evaluation, giving the agent these tools moved the diagnosis quality score from 3.25 to 3.68 versus a no-tools baseline, and it finished about 44% faster (196s vs 350s of wall time). Faster and better is the rare combination, and it comes from the agent querying structured data instead of grepping raw log text.

If you have a flaky CI build that keeps producing a log nobody wants to open, this is the version of the setup that actually saves your team time: the triage happens automatically, on the PR, while the failure is still fresh.
