---
title: "Building a UiPath Activity Package for Modern Studio with ViewModels"
description: "A modern UiPath custom activity needs more than a CodeActivity: a DesignPropertiesViewModel, an embedded metadata file for the toolbox, private host-supplied references, and the right System.Activities assembly version. Here's the whole recipe."
pubDate: 2026-05-24
tags:
  - "uipath"
  - "rpa"
  - "dotnet"
  - "csharp"
  - "nuget"
---
If you last wrote a UiPath custom activity a few years ago, the muscle memory is now wrong. The classic WPF `ActivityDesigner` with its property grid is **no longer rendered** by modern Studio. You can ship an activity whose code is perfect and watch it show up in the toolbox with an empty card — no properties, nothing to bind. The fix isn't in your activity at all; it's in a separate **ViewModel** class plus an embedded **metadata file**, and a couple of `.csproj` decisions that aren't obvious until you've lost an afternoon to them.

This post walks through the minimum viable modern activity package, using a tiny `WriteMessage` activity from [super-activities](https://github.com/marius-bughiu/super-activities) (all the code below is public there) as the worked example. By the end you'll have an activity that appears in the toolbox with a real icon and a real property card, packaged as a NuGet you can publish.

## The activity is the easy part

The activity itself is ordinary CoreWF. A `CodeActivity` with an `InArgument<string>`:

```cs
public sealed class WriteMessage : CodeActivity
{
    public InArgument<string> Message { get; set; } = new();

    protected override void Execute(CodeActivityContext context)
    {
        Console.WriteLine(context.GetValue(Message));
    }
}
```

*Source: [`src/Super.Activities/WriteMessage.cs`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.Activities/WriteMessage.cs)*

Drop this into a package as-is and Studio will load it — but the design-time card is blank, because nothing tells Studio *how* to render `Message`.

## The property card comes from a ViewModel

Modern Studio renders an activity's properties from a `DesignPropertiesViewModel` (in `System.Activities.ViewModels`), not from reflection over your activity and not from a WPF designer. You write a parallel class whose properties **mirror** the activity's, wrapped in `DesignInArgument<T>` / `DesignProperty<T>`, and configure them in `InitializeModel`:

```cs
using System.Activities.DesignViewModels;

public class WriteMessageViewModel : DesignPropertiesViewModel
{
    public WriteMessageViewModel(IDesignServices services) : base(services) { }

    // Matches WriteMessage.Message (an InArgument, so DesignInArgument).
    public DesignInArgument<string> Message { get; set; } = new DesignInArgument<string>();

    protected override void InitializeModel()
    {
        base.InitializeModel();

        Message.DisplayName = "Message";
        Message.Tooltip = "The text to write.";
        Message.IsRequired = true;
        Message.IsPrincipal = true;   // shown in the compact card, not just the panel
        Message.OrderIndex = 0;
    }
}
```

*Source: [`src/Super.Activities/ViewModels/WriteMessageViewModel.cs`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.Activities/ViewModels/WriteMessageViewModel.cs)*

Two things matter here. The property **name and type must match** the activity (`Message` ↔ `InArgument<string>` ↔ `DesignInArgument<string>`), and `IsPrincipal = true` is what promotes a field to the always-visible part of the activity card. For a display-only banner (a note, a warning) there's `DesignProperty<string>` with a `TextBlockWidget` instead of an argument — useful for activities that have no inputs but want to say something.

## The toolbox needs a metadata file

A ViewModel still won't make the activity *appear*. Modern Studio discovers a package's activities from an embedded JSON resource named `ActivitiesMetadata.json`. This is the bit no compiler error will ever remind you about:

```json
{
  "AssemblyRelativePath": "Super.Activities.dll",
  "Activities": [
    {
      "FullName": "Super.Activities.WriteMessage",
      "ShortName": "WriteMessage",
      "DisplayNameKey": "Write Message",
      "DescriptionKey": "Writes a message to the console.",
      "CategoryKey": "Super",
      "IconKey": "super-activities.png",
      "ViewModelType": "Super.Activities.ViewModels.WriteMessageViewModel"
    }
  ]
}
```

*Source: [`src/Super.Activities/Resources/ActivitiesMetadata.json`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.Activities/Resources/ActivitiesMetadata.json)*

`ViewModelType` is the link between the activity and the ViewModel above — get that string wrong and the activity loads with a blank card again. `CategoryKey` is the toolbox group, and `IconKey` names an embedded image. You wire both the metadata and the icon as embedded resources in the `.csproj`:

```xml
<ItemGroup>
  <!-- Tells the modern UiPath Studio Activities panel which activities this package contributes. -->
  <None Remove="Resources\ActivitiesMetadata.json" />
  <EmbeddedResource Include="Resources\ActivitiesMetadata.json" />
  <!-- Shared brand icon used as the toolbox activity icon (referenced by IconKey). -->
  <EmbeddedResource Include="$(RepoAssetsDir)super-activities.png" Link="Resources\Icons\super-activities.png" />
</ItemGroup>
```

*Source: [`src/Super.Activities/Super.Activities.csproj`](https://github.com/marius-bughiu/super-activities/blob/main/src/Super.Activities/Super.Activities.csproj)*

## References the host supplies — keep them private

Your activity compiles against the workflow runtime (`UiPath.Workflow` / `UiPath.Workflow.Runtime`, i.e. CoreWF) and, if you touch the Studio APIs, `UiPath.Activities.Api`. But Studio and the Robot **already provide** those assemblies at runtime. If you let them flow as package dependencies, you risk version skew and duplicate-assembly headaches on install. Mark them `PrivateAssets="All"` so they're compile-only and never become NuGet dependencies:

```xml
<ItemGroup>
  <!-- Private: the host (Studio/Robot) supplies the workflow runtime, so it is not a package dependency. -->
  <PackageReference Include="UiPath.Workflow.Runtime" Version="$(UiPathWorkflowVersion)" PrivateAssets="All" />
  <!-- Modern Studio renders activity properties from a DesignPropertiesViewModel. -->
  <PackageReference Include="System.Activities.ViewModels" Version="$(SystemActivitiesViewModelsVersion)" />
</ItemGroup>
```

Note the asymmetry: `System.Activities.ViewModels` is a *real* dependency (your ViewModel inherits from it and the host doesn't always carry it), so it is **not** private. The rule of thumb: if the host guarantees it, make it private; if your code is the reason it's there, ship it.

## The pitfall that eats an afternoon: the assembly version

Here's the one that doesn't look like a versioning problem. Install the obvious `UiPath.Workflow` from nuget.org and your activity may simply refuse to load — empty Project Settings, blank cards, or a `FileNotFoundException` deep in Studio. The cause: the public nuget.org `UiPath.Workflow 6.0.3` ships `System.Activities` with **AssemblyVersion 6.0.3.0**, but the Studio you're targeting loads **6.0.0.0**, and .NET won't roll a strong-name reference *forward*. Your package references a `System.Activities` that the host doesn't have.

The fix is to pin the build that matches Studio — the one from the UiPath-Official feed, whose `System.Activities` is `6.0.0.0`:

```xml
<PropertyGroup>
  <!-- IMPORTANT: use the UiPath-Official feed build (System.Activities AssemblyVersion 6.0.0.0)
       that ships with Studio, NOT the nuget.org 6.0.3 (AssemblyVersion 6.0.3.0) which Studio
       cannot load. This version pairs with UiPath.Activities.Api 24.10.1 / Studio 24.10. -->
  <UiPathWorkflowVersion>6.0.0-20240401-07</UiPathWorkflowVersion>
  <UiPathActivitiesApiVersion>24.10.1</UiPathActivitiesApiVersion>
  <SystemActivitiesViewModelsVersion>1.0.0-20250625.2</SystemActivitiesViewModelsVersion>
</PropertyGroup>
```

*Source: [`Directory.Build.props`](https://github.com/marius-bughiu/super-activities/blob/main/Directory.Build.props)*

> While you're here: target `net6.0`, **not** `net6.0-windows`. The non-Windows TFM keeps the `System.Xaml` identity coming from the workflow package instead of clashing with the WindowsDesktop `System.Xaml` — which matters the moment you do anything with XAML round-tripping.

Add the UiPath-Official feed to your `nuget.config` so those versions resolve.

## Package it like an activity package

Finally, the NuGet metadata. Two things make Studio (and the Marketplace) recognize the package as an activity pack: the `UiPathActivities` tag, and a raster icon (PNG — SVG icons aren't supported as `PackageIcon`). A README rounds out the listing:

```xml
<PropertyGroup>
  <PackageId>M.Super.Activities</PackageId>
  <Description>Essential building-block activities for UiPath...</Description>
  <PackageTags>UiPathActivities UiPath RPA automation workflow activities</PackageTags>
</PropertyGroup>
```

That's the whole recipe: a `CodeActivity`, a `DesignPropertiesViewModel`, an embedded `ActivitiesMetadata.json` + icon, host-supplied references kept private, and the *right* `System.Activities` version. Miss any one and the symptom is the same maddening blank card — so when that happens, walk this list top to bottom.

---

*Part of a series on building UiPath activity packages, drawn from [super-activities](https://github.com/marius-bughiu/super-activities) ([M.Super.Activities](https://www.nuget.org/packages/M.Super.Activities) on NuGet):*

- *[Add Project Settings to a UiPath Package: Design-Time and Runtime](/2026/05/add-project-settings-to-a-uipath-package-design-time-and-runtime/)*
- *[Writing a UiPath Workflow Analyzer Rule with Entry-Point Detection](/2026/05/write-a-uipath-workflow-analyzer-rule-with-entry-point-detection/)*
- *[Run Code Before & After Every UiPath Activity](/2026/05/run-code-before-and-after-every-uipath-activity-with-a-tracking-participant/)*
- *[Independently Releasing Multiple NuGet Packages with MinVer + Trusted Publishing](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/)*
