---
title: "Run Code Before & After Every UiPath Activity (TrackingParticipant + a Reflection Bridge)"
description: "There's no public hook to run code around every UiPath activity in the Robot. CoreWF's TrackingParticipant gets you the events, and a small reflection bridge into the live executor attaches it from inside a running workflow — so a single Super Initialize activity instruments the whole run."
pubDate: 2026-05-24
tags:
  - "uipath"
  - "rpa"
  - "dotnet"
  - "workflow-foundation"
  - "reflection"
---
Suppose you want to run code around **every** activity in a UiPath process — telemetry, auditing, timing — without editing a single workflow. In a normal .NET app you'd reach for middleware or an interceptor. UiPath runs on CoreWF (the open-source Windows Workflow Foundation), and CoreWF *does* have the right primitive: `TrackingParticipant`. The problem is attaching one inside the **Robot**, which never exposes a public seam to register it.

This post builds the whole mechanism from [super-activities](https://github.com/marius-bughiu/super-activities) (every file linked below): the tracking participant that turns activity state transitions into before/after callbacks, and the reflection bridge that installs it into the *live* executor from inside a running activity. The payoff is that one `Super Initialize` activity at the top of `Main` instruments the entire run — at any depth, including non-isolated invoked workflows.

> Standard disclaimer up front: the reflection part pokes at CoreWF internals. It's powerful and it's been reliable in production, but it's coupled to the runtime's private field names. Pin your runtime version and treat it as a known, contained risk — more on that at the end.

## The primitive: TrackingParticipant

CoreWF emits **tracking records** as a workflow runs. Subclass `TrackingParticipant`, override `Track`, and you receive an `ActivityStateRecord` for every activity state transition. The state string tells you *when* you are: `Executing` is "before", and the terminal states (`Closed` / `Faulted` / `Canceled`) are "after".

```cs
protected override void Track(TrackingRecord record, TimeSpan timeout)
{
    if (record is not ActivityStateRecord asr) return;

    var map = EnsureMap();
    if (!map.TryGetValue(asr.Activity.Id, out var activity)) return;

    bool isBefore = string.Equals(asr.State, ActivityStates.Executing, StringComparison.Ordinal);
    var arguments = ReadArguments(asr);

    foreach (var ext in SuperExtensions.ForActivity(activity!))
    {
        var ctx = new ExtensionExecutionContext(asr.Activity, asr.State, asr.InstanceId, activity!, ext, arguments);
        if (isBefore) ext.OnBeforeExecute(ctx);
        else          ext.OnAfterExecute(ctx);
    }
}
```

*Source: [`src/Super.Extensions/ExtensionDispatchTrackingParticipant.cs`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.Extensions/ExtensionDispatchTrackingParticipant.cs)*

One wrinkle worth calling out: the record gives you the activity's **Id**, not the `Activity` object — the definition reference is internal to the runtime. So we keep a map from Id to `Activity`, built once by walking the tree with `WorkflowInspectionServices.GetActivities`:

```cs
private static void BuildMap(Activity activity, Dictionary<string, Activity> map, HashSet<Activity> visited)
{
    if (activity is null || !visited.Add(activity)) return;
    if (!string.IsNullOrEmpty(activity.Id)) map[activity.Id] = activity;

    foreach (var child in WorkflowInspectionServices.GetActivities(activity))
        BuildMap(child, map, visited);
}
```

### Capturing arguments (when you ask for it)

By default a participant only gets state changes. If you also want each activity's **argument values**, you opt in with a `TrackingProfile` whose `ActivityStateQuery` requests them. It's cheap to express and worth gating behind a flag, since it adds overhead:

```cs
private static TrackingProfile BuildCaptureProfile()
{
    var query = new ActivityStateQuery { ActivityName = "*" };
    query.States.Add("*");
    query.Arguments.Add("*");
    query.Variables.Add("*");
    return new TrackingProfile { Queries = { query } };
}
```

## The hard part: attaching it inside the Robot

If you host CoreWF yourself, you'd just add the participant to `WorkflowApplication.Extensions` and you're done. But under the UiPath Robot you don't own the host — there's no public call to register a `TrackingParticipant` for the process you're in.

The Robot still runs on CoreWF, though, and the wiring is all *there*, just private. From an `ActivityContext` you can reach the executor, the executor's host (the `WorkflowInstance`), and that instance's tracking provider — then add your participant. The chain, for UiPath.Workflow 6.0.x, is:

```text
ActivityContext._executor            (ActivityExecutor)
  -> ActivityExecutor._host          (WorkflowInstance)
       -> WorkflowInstance._trackingProvider   (TrackingProvider)
            -> TrackingProvider.AddParticipant(participant)
```

In code, getting from the context to the host:

```cs
private static object GetHost(ActivityContext context)
{
    var executorField = typeof(ActivityContext).GetField("_executor", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("ActivityContext._executor not found.");
    var executor = executorField.GetValue(context)!;

    var hostField = GetFieldUpHierarchy(executor.GetType(), "_host")
        ?? throw new InvalidOperationException("ActivityExecutor._host not found.");
    return hostField.GetValue(executor)!;
}
```

And then attaching the participant — with the important edge case that a process may have **no** tracking provider yet (nobody configured tracking). If so, we construct one over the root activity and flip `HasTrackingParticipant` so records actually start flowing:

```cs
public static void AddTrackingParticipant(ActivityContext context, TrackingParticipant participant)
{
    var host = GetHost(context);
    var hostType = host.GetType();

    var providerField = GetFieldUpHierarchy(hostType, "_trackingProvider")!;
    var provider = providerField.GetValue(host);

    if (provider is null)
    {
        // No tracking was configured by the host: create the provider and enable tracking.
        var root = GetRootActivity(context);
        provider = Activator.CreateInstance(providerField.FieldType, root)!;
        providerField.SetValue(host, provider);

        var hasParticipant = GetPropertyUpHierarchy(hostType, "HasTrackingParticipant");
        hasParticipant?.GetSetMethod(nonPublic: true)?.Invoke(host, new object[] { true });
    }

    var addParticipant = provider.GetType().GetMethod("AddParticipant", InstanceAny)!;
    addParticipant.Invoke(provider, new object[] { participant });
}
```

*Source: [`src/Super.Extensions/LiveExecutionHook.cs`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.Extensions/LiveExecutionHook.cs)*

(The helpers walk the type hierarchy with `BindingFlags.DeclaredOnly` per level, because the fields live on base types in the CoreWF hierarchy.)

## Tying it together: one activity to start the show

Now the bridge has somewhere to be called from. `Super Initialize` is an ordinary `CodeActivity` placed first in `Main`. When it executes, it grabs the runtime, auto-registers the installed extensions, and attaches the participant to the **current** workflow via the reflection bridge:

```cs
protected override void Execute(CodeActivityContext context)
{
    var runtime = context.GetExtension<IExecutorRuntime>();
    SuperRuntime.Host = runtime;
    if (runtime?.Settings is not null)
        SuperRuntime.ProjectSettings = runtime.Settings;

    ExtensionDiscovery.RegisterDiscovered();

    // Capture argument values only if some registered extension actually wants them.
    var captureArguments = SuperExtensions.All.Any(e => e.CapturesArguments);
    SuperExtensions.AttachToCurrentWorkflow(context, captureArguments);
}
```

*Source: [`src/Super.Extensions/SuperInitialize.cs`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.Extensions/SuperInitialize.cs)*

Because the participant is attached to the live instance, everything that executes *after* it — to any depth — flows through `Track`. One activity, whole process.

### Auto-discovery, so users install and go

`ExtensionDiscovery.RegisterDiscovered()` is what lets a no-code user just drop in the package. It scans the load directory for the framework's own DLLs and instantiates any `IActivityExtension` with a parameterless constructor:

```cs
foreach (var dll in Directory.EnumerateFiles(dir, "Super.*.dll"))
{
    if (dll.EndsWith(".Design.dll", StringComparison.OrdinalIgnoreCase)) continue; // WPF design-only
    var name = AssemblyName.GetAssemblyName(dll).Name;
    if (!AppDomain.CurrentDomain.GetAssemblies().Any(a => string.Equals(a.GetName().Name, name, StringComparison.OrdinalIgnoreCase)))
        Assembly.LoadFrom(dll);
}
```

*Source: [`src/Super.Extensions/ExtensionDiscovery.cs`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.Extensions/ExtensionDiscovery.cs)*

### The telemetry delivery gotcha

One last trap, specific to short-lived runs. An extension that ships data somewhere (e.g. Application Insights) must flush before the process exits — and `TelemetryClient.Flush()` is *best-effort and asynchronous*. On a quick robot run, the process tears down before the sender transmits, and you silently lose events. The fix is to block on the async flush at the end of the run (the root activity, Id `"1"`, closing):

```cs
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
if (!_client.FlushAsync(cts.Token).GetAwaiter().GetResult())
    SuperRuntime.Log("App Insights could not transmit telemetry before the timeout.", TraceEventType.Warning);
```

*Source: [`src/Super.AppInsights.Activities/AppInsightsActivityExtension.cs`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.AppInsights.Activities/AppInsightsActivityExtension.cs)*

## On the reflection risk

Be honest with yourself about the tradeoff. The `TrackingParticipant` half is fully supported, public CoreWF. The bridge half depends on private field names (`_executor`, `_host`, `_trackingProvider`) that could change between runtime versions. Mitigations that make it production-grade: pin the exact `UiPath.Workflow` version (the [packaging post](/2026/05/build-a-uipath-activity-package-for-modern-studio-with-viewmodels/) explains why you're pinning it anyway), fail loud with precise messages when a member isn't found, and keep the reflection in one small, well-tested file so a runtime bump has exactly one place to audit. Within those guardrails, "run code around every activity, even in the Robot" goes from impossible to a single drop-in activity.

---

*Part of a series on building UiPath activity packages, drawn from [super-activities](https://github.com/marius-bughiu/super-activities) ([M.Super.Extensions](https://www.nuget.org/packages/M.Super.Extensions) on NuGet):*

- *[Building a UiPath Activity Package for Modern Studio with ViewModels](/2026/05/build-a-uipath-activity-package-for-modern-studio-with-viewmodels/)*
- *[Add Project Settings to a UiPath Package: Design-Time and Runtime](/2026/05/add-project-settings-to-a-uipath-package-design-time-and-runtime/)*
- *[Writing a UiPath Workflow Analyzer Rule with Entry-Point Detection](/2026/05/write-a-uipath-workflow-analyzer-rule-with-entry-point-detection/)*
- *[Independently Releasing Multiple NuGet Packages with MinVer + Trusted Publishing](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/)*
