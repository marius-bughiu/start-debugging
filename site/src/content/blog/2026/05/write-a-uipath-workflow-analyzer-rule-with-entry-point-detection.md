---
title: "Writing a UiPath Workflow Analyzer Rule with Entry-Point Detection"
description: "Ship a Workflow Analyzer rule inside your UiPath activity package: register it with IRegisterAnalyzerConfiguration, scope it to the workflow so the result lands on the right file, detect the project's entry point, and walk the activity tree — with the gotcha that InspectionResult has no File property."
pubDate: 2026-05-24
tags:
  - "uipath"
  - "rpa"
  - "dotnet"
  - "static-analysis"
---
If your activity package has a setup requirement — "you must drop *this* activity at the top of Main, or nothing works" — a README won't save your users. UiPath Studio has a built-in **Workflow Analyzer**, and you can ship your own rules inside your package so Studio flags the mistake right in the project, with the offending file called out. This is the RPA equivalent of a Roslyn analyzer, and it's underused.

In [super-activities](https://github.com/marius-bughiu/super-activities), the whole framework only activates if a `Super Initialize` activity runs at the start of the process. So the package ships a rule that errors when an entry-point workflow is missing it. Let's build that rule (the [full file is on GitHub](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.Extensions/SuperInitializeAnalyzerRule.cs)) and cover the two things that trip people up: **choosing the right scope** so the result attaches to a file, and **detecting which workflow is actually the entry point.**

## Registration: Studio finds your rule

Like the design and runtime APIs, the analyzer is discovery-based. Implement `IRegisterAnalyzerConfiguration`, and Studio calls `Initialize`, handing you a service to register rules against:

```cs
public sealed class SuperInitializeAnalyzerRule : IRegisterAnalyzerConfiguration
{
    private const string RuleId = "SUPER-001";
    private const string RuleName = "Missing Super Initialize";

    public void Initialize(IAnalyzerConfigurationService service)
    {
        var rule = new Rule<IWorkflowModel>(RuleName, RuleId, Inspect)
        {
            DefaultErrorLevel = TraceLevel.Error,
            RecommendationMessage = $"Add the '{SuperInitialize.DefaultDisplayName}' activity at the start of the project's main entry point.",
        };
        service.AddRule(rule);
    }
    // ...
}
```

A few conventions: `RuleId` is a stable identifier (users can configure or suppress by it), `RuleName` is what shows in the Analyzer settings, and `DefaultErrorLevel` decides whether a violation is an Error (blocks publish) or a Warning.

## Scope is the most important decision

The generic parameter on `Rule<T>` is not a detail — it determines what your rule inspects *and* where its result is reported. The common choices:

- `Rule<IProjectModel>` — runs once per project. Good for project-wide policy.
- `Rule<IWorkflowModel>` — runs once per `.xaml` workflow. **The result is associated with that workflow's file.**
- `Rule<IActivityModel>` — runs per activity.

We want Studio to point at the *file* that's missing the activity, so we use `Rule<IWorkflowModel>`. This choice is the answer to the single most confusing thing about the API, which we'll hit in a moment.

## Detecting the entry point

`Rule<IWorkflowModel>` runs for *every* workflow in the project, but only the **entry point** (usually `Main.xaml`) needs the activity — invoked sub-workflows inherit the setup. So the first thing the inspection does is bail out for non-entry-point workflows.

The project model exposes the entry point(s), and you match them against the current workflow's path. Be tolerant: compare both the relative path and the bare file name, case-insensitively, because the two sides aren't always formatted identically:

```cs
internal static bool IsEntryPoint(IWorkflowModel workflow)
{
    var project = workflow.Project;
    if (project is null) return false;

    bool Matches(string? candidate)
        => !string.IsNullOrEmpty(candidate)
           && (string.Equals(candidate, workflow.RelativePath, StringComparison.OrdinalIgnoreCase)
               || string.Equals(FileNameOf(candidate), FileNameOf(workflow.RelativePath), StringComparison.OrdinalIgnoreCase));

    if (Matches(project.EntryPointName)) return true;

    if (project.EntryPoints is not null)
    {
        foreach (var entry in project.EntryPoints)
            if (Matches(entry)) return true;
    }

    return false;
}
```

Modern UiPath projects can declare **multiple** entry points (`project.EntryPoints`), so checking only the legacy single `EntryPointName` isn't enough — iterate both.

## Walking the activity tree

Once we know we're on an entry point, we need to know whether the `Super Initialize` activity is present *anywhere* in it. `IWorkflowModel.Root` gives the top activity, and `IActivityModel.Children` lets you recurse. Matching on the type name (rather than a CLR type) keeps the analyzer decoupled from the runtime assembly:

```cs
internal static bool ContainsSuperInitialize(IActivityModel activity)
{
    if (IsSuperInitialize(activity.Type)) return true;

    foreach (var child in activity.Children)
        if (ContainsSuperInitialize(child)) return true;

    return false;
}

internal static bool IsSuperInitialize(string? activityType)
    => activityType is not null && activityType.Contains(nameof(SuperInitialize), StringComparison.Ordinal);
```

## The gotcha: InspectionResult has no File property

Here's the thing that sends people in circles. You've found a violation and you want the Analyzer's **File** column to point at `Main.xaml`. You go looking for a `File` (or `FilePath`) property on `InspectionResult`… and it isn't there.

It isn't there because you don't set it. **The file association comes from the rule's scope.** Because this is a `Rule<IWorkflowModel>`, Studio already knows which workflow file produced each result and fills the File column for you. Your job is just to return the verdict — and to keep the message itself file-agnostic, since the file is shown separately:

```cs
internal static InspectionResult Inspect(IWorkflowModel workflow, Rule rule)
{
    if (!IsEntryPoint(workflow))
        return new InspectionResult { HasErrors = false };

    var root = workflow.Root;
    if (root is not null && ContainsSuperInitialize(root))
        return new InspectionResult { HasErrors = false };

    // Scoped to this workflow, so Studio shows the file in the File column — keep the message file-agnostic.
    var result = new InspectionResult
    {
        HasErrors = true,
        ErrorLevel = rule.ErrorLevel,
        RecommendationMessage =
            $"Add the '{SuperInitialize.DefaultDisplayName}' activity at the start of the main entry point so the Super extensions run. " +
            "Without it, the extensions (e.g. App Insights telemetry) are never wired up.",
    };
    result.Messages?.Add($"The '{SuperInitialize.DefaultDisplayName}' activity is missing.");
    return result;
}
```

*Source: [`src/Super.Extensions/SuperInitializeAnalyzerRule.cs`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.Extensions/SuperInitializeAnalyzerRule.cs)*

If you ever *do* need the result attached to a specific file that isn't the one currently being inspected, that's a sign you picked the wrong scope — switch the `Rule<T>` parameter rather than hunting for a property to set.

## Wrapping up

A shippable Workflow Analyzer rule is four moving parts: implement `IRegisterAnalyzerConfiguration`, pick the **scope** that matches where the result should land (`IWorkflowModel` here, so the file is reported for free), detect the relevant workflow (entry-point matching across both `EntryPointName` and `EntryPoints`), and walk `IActivityModel.Children` for the condition. Get the scope right and the rest is ordinary tree-walking — your users get a red squiggle in the right place instead of a support ticket.

---

*Part of a series on building UiPath activity packages, drawn from [super-activities](https://github.com/marius-bughiu/super-activities) ([M.Super.Extensions](https://www.nuget.org/packages/M.Super.Extensions) on NuGet):*

- *[Building a UiPath Activity Package for Modern Studio with ViewModels](/2026/05/build-a-uipath-activity-package-for-modern-studio-with-viewmodels/)*
- *[Add Project Settings to a UiPath Package: Design-Time and Runtime](/2026/05/add-project-settings-to-a-uipath-package-design-time-and-runtime/)*
- *[Run Code Before & After Every UiPath Activity](/2026/05/run-code-before-and-after-every-uipath-activity-with-a-tracking-participant/)*
- *[Independently Releasing Multiple NuGet Packages with MinVer + Trusted Publishing](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/)*
