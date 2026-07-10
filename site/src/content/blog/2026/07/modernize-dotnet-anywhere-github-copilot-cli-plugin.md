---
title: "The .NET Modernization Agent Now Runs in the Copilot CLI, Not Just Visual Studio"
description: "GitHub Copilot's modernize-dotnet agent shipped as a portable plugin on July 9, 2026. It now runs in VS Code, the Copilot CLI, and on GitHub, with an assess to plan to execute workflow whose artifacts get committed to your repo for review."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "github-copilot"
  - "ai-agents"
  - "modernization"
---

For most of the last year, GitHub Copilot's .NET modernization tooling had one home: Visual Studio. If your team lived in VS Code, on the command line, or reviewed everything through pull requests, the "upgrade my legacy app" experience was somewhere you did not work. On July 9, 2026, Microsoft [shipped the `modernize-dotnet` agent as a portable plugin](https://devblogs.microsoft.com/dotnet/modernize-dotnet-anywhere-with-ghcp/) that runs across four surfaces: Visual Studio, VS Code, the GitHub Copilot CLI, and GitHub itself.

## Why "Anywhere" Actually Matters Here

Modernization is not a one-shot command. It is assess, plan, then a long sequence of code transformations you babysit. Forcing that into a single IDE meant the developer driving the upgrade had to context-switch out of their normal environment for what is often a multi-day job. Moving the same agent to the CLI means shell-first developers can run it next to their build and test loop, and putting it on GitHub means the upgrade can happen as a reviewable, collaborative unit of work rather than one person's local session.

The workflow is the same everywhere, and that is the point. The agent follows an assess, plan, execute model and writes three artifacts into your repository:

1. An **assessment** that surfaces scope and blockers before any code changes.
2. An **upgrade plan** that sequences the work.
3. **Upgrade tasks** that apply the actual transformations.

Because those artifacts are committed to the repo, your team reviews the plan the same way you review a PR, before execution touches a line of code.

## Running It From the Copilot CLI

The CLI path installs the agent as a plugin, then drives it with natural language. The commands are short:

```bash
# Add the plugin marketplace and install the agent
/plugin marketplace add dotnet/modernize-dotnet
/plugin install modernize-dotnet@modernize-dotnet-plugins

# Select the agent, then describe the job
/agent modernize-dotnet
upgrade my solution to a new version of .NET
```

From there the agent generates the assessment, proposes the plan, and applies tasks with human-in-the-loop approval at each step. It handles the unglamorous parts of an upgrade: bumping the target framework, updating dependencies, and fixing the compile errors that a `TargetFramework` change leaves behind.

## What It Covers Today

Supported workloads include ASP.NET Core, Blazor, Azure Functions, WPF, class libraries, and console applications, plus migrations from .NET Framework to modern .NET. Web Forms is not yet in scope. If you tried the Visual Studio-only version earlier and found it awkward to fit into a team workflow, this is the release that fixes the delivery model rather than the capability.

The agent is developed in the open at [dotnet/modernize-dotnet](https://github.com/microsoft/github-copilot-appmod), and the four-surface rollout is available now. The interesting shift is not that Copilot can upgrade .NET code, it is that the upgrade is now a repo artifact you review, not a black box inside one editor.
