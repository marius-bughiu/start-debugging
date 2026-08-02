---
title: "Visual Studio 18.8 Ships .NET Agent Skills Built In, Then Turns Them All Off"
description: "Visual Studio 2026 18.8 puts expert-authored .NET and Azure agent skills in the tool picker under a Built-in category, disabled by default. The default is the interesting part."
pubDate: 2026-08-02
tags:
  - "visual-studio"
  - "dotnet"
  - "ai-agents"
  - "agent-skills"
  - "github-copilot"
---

Visual Studio 2026 version 18.8 quietly changed where agent expertise lives. Skills authored by the .NET and Azure teams now ship with the IDE instead of being something you go find, install, and wire up yourself. On 2026-07-28 Mark Downie rolled the change into [Visual Studio July Update, Meet the New Agent](https://devblogs.microsoft.com/visualstudio/visual-studio-july-update-meet-the-new-agent-powered-by-copilot-sdk/), and GitHub picked it up in the [Copilot changelog](https://github.blog/changelog/2026-07-30-github-copilot-in-visual-studio-july-update/) on 2026-07-30.

The skills show up in a **Built-in** category in the tool picker, and only when the matching workload is installed. If you never installed the Azure workload, you never see the Azure skills. And every one of them is off until you turn it on.

## Two .NET skills worth turning on first

`dotnet-webapi` guides creating and modifying ASP.NET Core HTTP API endpoints: correct status codes, OpenAPI metadata on the endpoint rather than bolted on afterward, and error handling that does not collapse everything into a 500.

`analyzing-dotnet-performance` is the one to reach for on an existing codebase. It scans for roughly 50 performance anti-patterns across async, memory, strings, collections, LINQ, regex, serialization, and I/O, and classifies findings by severity instead of dumping a flat list. The shape of what it hunts is the stuff that passes code review because it reads fine:

```csharp
// Materializes every matching row just to ask a yes/no question
if (db.Orders.Where(o => o.CustomerId == id).ToList().Count > 0)
{
    // ...
}

// One EXISTS query, no allocation, no blocking
if (await db.Orders.AnyAsync(o => o.CustomerId == id, ct))
{
    // ...
}
```

The Azure side ships a three-step deployment chain (`azure-prepare` generates Bicep or Terraform plus `azure.yaml` and managed identity wiring, `azure-validate` runs preflight checks, `azure-deploy` executes), plus `azure-kusto` for KQL against Azure Data Explorer and `microsoft-foundry` for model deployment and evaluation.

## Off by default is a context decision, not a timidity decision

It would have been easy to enable all of these and let the agent sort it out. Shipping them dark is the better call, and the reason is context budget. Every enabled skill is instructions competing for the same window as your actual code. A .NET web API developer who has the Azure workload installed for one deployment task does not want six Azure skills narrowing every response for the rest of the year.

This is the same discipline the `dotnet-test` plugin needs, [the one behind last week's unit-test agent](/2026/08/dotnet-skills-polyglot-unit-test-agent-assertion-gate/): load the skill for the job, not the catalog.

## You do not need Visual Studio for any of this

The .NET skills are public at [dotnet/skills](https://github.com/dotnet/skills) and the Azure ones at [microsoft/azure-skills](https://github.com/microsoft/azure-skills). The same plugins install into Copilot CLI, Claude Code, VS Code, and Cursor:

```bash
/plugin marketplace add dotnet/skills
```

What 18.8 actually buys you is discovery. Nobody was going to find `analyzing-dotnet-performance` by browsing a repo. Finding it in a picker next to the workload you already installed is a different story, which makes the off-by-default toggle the only friction left, and that one is worth keeping.
