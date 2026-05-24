---
title: "Add Project Settings to a UiPath Package: Design-Time and Runtime"
description: "How to add a custom category to UiPath's Project Settings from your activity package, register fields at design time via IRegisterWorkflowDesignApi, and read those values back at runtime through IExecutorRuntime — with the App Insights instrumentation key as the example."
pubDate: 2026-05-24
tags:
  - "uipath"
  - "rpa"
  - "dotnet"
  - "csharp"
---
Sooner or later your UiPath activity package needs configuration that doesn't belong on any single activity: an API endpoint, a feature toggle, an Application Insights instrumentation key. You don't want users hardcoding a secret into a workflow argument, and you don't want a config file they have to remember to deploy. The right home is **Project Settings** — the same dialog where Studio keeps its own per-project options, with separate debug and runtime values built in.

The catch is that wiring this up touches **two different APIs that never reference each other**: a design-time API to *register* the settings so they appear in Studio, and a runtime API to *read* them while the robot runs. The only thing binding the two halves together is a set of string keys you control. This post shows both halves, using the App Insights settings from [super-activities](https://github.com/marius-bughiu/super-activities) (public, linked per snippet) as the example.

## One source of truth: the keys

Because the design side and the runtime side are independent, start with the keys both will use. A single static class keeps them honest:

```cs
public static class AppInsightsSettingKeys
{
    public const string Category = "Super.AppInsights";

    // UiPath project settings already track separate debug and runtime values per key, so this is a
    // single setting; the runtime reader returns the value for the current execution mode.
    public const string InstrumentationKey = "Super.AppInsights.InstrumentationKey";

    public const string CaptureArguments = "Super.AppInsights.CaptureArguments";
}
```

*Source: [`src/Super.AppInsights.Activities/AppInsightsSettingKeys.cs`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.AppInsights.Activities/AppInsightsSettingKeys.cs)*

Worth internalizing the comment: you don't register "debug key" and "runtime key" as two settings. You register **one** key, and UiPath stores a debug value and a runtime value for it; the runtime reader hands you whichever matches the current execution mode. That's a nicer model than it first appears.

## Design time: register a category and fields

Studio discovers any public class implementing `IRegisterWorkflowDesignApi` and calls `Initialize`. From there you reach the settings service and add a category plus its fields. Each field is a `SingleValueEditorDescription<T>` — the `T` drives the editor Studio renders (a text box for `string`, a checkbox for `bool`):

```cs
public sealed class AppInsightsDesignRegistration : IRegisterWorkflowDesignApi
{
    public void Initialize(IWorkflowDesignApi api) => Register(api.Settings);

    internal static void Register(IActivitiesSettingsService settings)
    {
        var category = new SettingsCategory
        {
            Key = AppInsightsSettingKeys.Category,
            Header = "App Insights",
            Description = "Application Insights telemetry for activities.",
        };
        settings.AddCategory(category);

        settings.AddSetting(category, new SingleValueEditorDescription<string>
        {
            Key = AppInsightsSettingKeys.InstrumentationKey,
            Label = "Instrumentation Key",
            Description = "Application Insights instrumentation key (or full connection string).",
            DefaultValue = string.Empty,
        });

        settings.AddSetting(category, new SingleValueEditorDescription<bool>
        {
            Key = AppInsightsSettingKeys.CaptureArguments,
            Label = "Capture arguments",
            Description = "Include each activity's argument values in the telemetry events (more overhead).",
            DefaultValue = false,
        });
    }
}
```

*Source: [`src/Super.AppInsights.Activities/AppInsightsDesignRegistration.cs`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.AppInsights.Activities/AppInsightsDesignRegistration.cs)*

Install the package, open **Project Settings**, and there's an "App Insights" category with an Instrumentation Key text field and a Capture arguments checkbox — each already offering separate debug/runtime values. `IActivitiesSettingsService` lives in `UiPath.Studio.Activities.Api.Settings`, which you reference (privately — the host supplies it) as covered in the [activity-package post](/2026/05/build-a-uipath-activity-package-for-modern-studio-with-viewmodels/).

## Runtime: read the values back

At runtime there is no `IWorkflowDesignApi` — Studio's design surface isn't running. Instead the **Robot host** provides an `IExecutorRuntime`, from which you get an `IActivitiesSettingsReader`. The reader is a typed key/value lookup: `TryGetValue<T>` returns the value for the current execution mode (debug vs. unattended), already resolved.

Here's a settings object that hydrates itself from the reader, keyed by the same constants the design side used:

```cs
public static AppInsightsSettings FromProjectSettings(IActivitiesSettingsReader reader)
{
    ArgumentNullException.ThrowIfNull(reader);

    return new AppInsightsSettings
    {
        InstrumentationKey = reader.TryGetValue(AppInsightsSettingKeys.InstrumentationKey, out string value) ? value : null,
        CaptureArguments = ReadBool(reader, AppInsightsSettingKeys.CaptureArguments),
    };
}

private static bool ReadBool(IActivitiesSettingsReader reader, string key)
{
    if (reader.TryGetValue(key, out bool b))
    {
        return b;
    }
    return reader.TryGetValue(key, out string s) && bool.TryParse(s, out var parsed) && parsed;
}
```

*Source: [`src/Super.AppInsights.Activities/AppInsightsSettings.cs`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.AppInsights.Activities/AppInsightsSettings.cs)*

The `ReadBool` fallback is a small piece of defensive code worth keeping: depending on how a value was stored, a boolean setting may come back typed as `bool` *or* as the string `"true"`. Trying the typed read first and falling back to a parse covers both without surprising the user.

## Getting the reader in the first place

The remaining question is where `IActivitiesSettingsReader` comes from. The `IExecutorRuntime` is available through the activity context via `GetExtension`. In super-activities, a single bootstrap activity grabs it once and stashes it in ambient state so every extension can read settings without threading the context around:

```cs
protected override void Execute(CodeActivityContext context)
{
    var runtime = context.GetExtension<IExecutorRuntime>();
    SuperRuntime.Host = runtime;
    if (runtime?.Settings is not null)
    {
        SuperRuntime.ProjectSettings = runtime.Settings;   // IActivitiesSettingsReader
    }
    // ...
}
```

*Source: [`src/Super.Extensions/SuperInitialize.cs`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.Extensions/SuperInitialize.cs)*

`runtime.Settings` *is* the `IActivitiesSettingsReader`. If you're reading settings from inside a normal activity, `context.GetExtension<IActivitiesSettingsReader>()` works directly too — the bootstrap approach just centralizes it for a framework where many components need the same values. (That bootstrap activity does more than this; the [before/after-activity post](/2026/05/run-code-before-and-after-every-uipath-activity-with-a-tracking-participant/) covers the rest.)

## The whole loop

Put together, the flow is: **shared keys → design-time registration → user fills in Project Settings → runtime reader returns the value for the current mode.** Design and runtime never talk to each other directly; the keys are the contract. Keep them in one class, register with the typed editor descriptions, read with `TryGetValue<T>` plus a sensible fallback, and your package gets first-class, secret-free configuration that lives exactly where UiPath users expect to find it.

---

*Part of a series on building UiPath activity packages, drawn from [super-activities](https://github.com/marius-bughiu/super-activities) ([M.Super.AppInsights.Activities](https://www.nuget.org/packages/M.Super.AppInsights.Activities) on NuGet):*

- *[Building a UiPath Activity Package for Modern Studio with ViewModels](/2026/05/build-a-uipath-activity-package-for-modern-studio-with-viewmodels/)*
- *[Writing a UiPath Workflow Analyzer Rule with Entry-Point Detection](/2026/05/write-a-uipath-workflow-analyzer-rule-with-entry-point-detection/)*
- *[Run Code Before & After Every UiPath Activity](/2026/05/run-code-before-and-after-every-uipath-activity-with-a-tracking-participant/)*
- *[Independently Releasing Multiple NuGet Packages with MinVer + Trusted Publishing](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/)*
