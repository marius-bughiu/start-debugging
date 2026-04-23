---
title: "GitHub Copilot Modernization: The Assessment Report Is the Actual Product"
description: "GitHub Copilot Modernization is pitched as an Assess, Plan, Execute loop for migrating legacy .NET apps. The assessment phase is where the value lives: an inventory report, categorized blockers, and file-level remediation guidance you can diff like code."
pubDate: 2026-04-14
tags:
  - "dotnet"
  - "copilot"
  - "github-copilot"
  - "ai-agents"
  - "modernization"
  - "dotnet-10"
---

Microsoft's April 7 post ["Your Migration's Source of Truth: The Modernization Assessment"](https://devblogs.microsoft.com/dotnet/your-migrations-source-of-truth-the-modernization-assessment/) describes [GitHub Copilot Modernization](https://devblogs.microsoft.com/dotnet/your-migrations-source-of-truth-the-modernization-assessment/) as an "Assess, Plan, Execute" loop for pulling legacy .NET Framework and Java workloads forward. If you only remember one thing from the post, make it this: the assessment is not a glossy dashboard, it is a report written to `.github/modernize/assessment/` that you commit alongside your code.

## Why put the report in the repo

Migrations die when the plan lives in a Word doc that nobody updates. By writing the assessment into the repo, every change becomes reviewable through a pull request, and the branch history shows how the "list of blockers" shrank over time. It also means the assessment can be regenerated on CI and diffed, so you notice when someone reintroduces a deprecated API.

The report itself breaks findings into three buckets:

1. Mandatory: blockers that must be resolved before the migration compiles or runs.
2. Potential: behavior changes that usually require a code update, for example APIs removed between .NET Framework and .NET 10.
3. Optional: ergonomic improvements like switching to `System.Text.Json` or `HttpClientFactory`.

Each finding is tied to a file and line range, so a reviewer can open the report, click through to the code, and understand the remediation without re-running the tool.

## Running an assessment

You can kick off an assessment from the VS Code extension, but the interesting surface is the CLI, because it is the one that fits into CI:

```bash
# Run a recommended assessment against a single repo
modernize assess --path ./src/LegacyApi --target dotnet10

# Multi-repo batch mode for a portfolio
modernize assess --multi-repo ./repos --target dotnet10 --coverage deep
```

The `--target` flag is where the scenario presets live: `dotnet10` triggers the .NET Framework to .NET 10 upgrade path, while `java-openjdk21` covers the Java equivalent. The `--coverage` flag trades runtime for depth, and deep coverage is the one that actually inspects transitive NuGet references.

## Treating the assessment like code

Because the report is a set of Markdown and JSON files, you can lint it. Here is a small script that fails CI when the assessment gains new Mandatory issues:

```csharp
using System.Text.Json;

var report = JsonSerializer.Deserialize<AssessmentReport>(
    File.ReadAllText(".github/modernize/assessment/summary.json"));

var mandatory = report.Issues.Count(i => i.Severity == "Mandatory");
Console.WriteLine($"Mandatory issues: {mandatory}");

if (mandatory > report.Baseline.Mandatory)
{
    Console.Error.WriteLine("New Mandatory blockers introduced since baseline.");
    Environment.Exit(1);
}

record AssessmentReport(Baseline Baseline, Issue[] Issues);
record Baseline(int Mandatory);
record Issue(string Severity, string File, int Line, string Rule);
```

That turns a one-off assessment into a ratchet: once a blocker is resolved, it cannot silently come back.

## Where it fits next to ASP.NET Core 2.3

The same April 7 batch of posts included the [ASP.NET Core 2.3 end of support notice](https://devblogs.microsoft.com/dotnet/aspnet-core-2-3-end-of-support/), which sets April 13, 2027 as the hard date. Copilot Modernization is Microsoft's answer for shops that still have ASP.NET Core 2.3 packages riding on .NET Framework: run the assessment, commit it, and work down the Mandatory list before the clock runs out.

The tool is not magic. It will not rewrite a `HttpContext` extension for you or decide whether to containerize via App Service or AKS. What it does is give you a repo-native, diffable inventory of the work, which is the first honest conversation most long-lived .NET codebases have had in years.
