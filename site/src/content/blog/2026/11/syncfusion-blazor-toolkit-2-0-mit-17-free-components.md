---
title: "Syncfusion Blazor Toolkit 2.0.1: 17 MIT Components, No License Key, No Data Grid"
description: "On October 29, 2026 Microsoft announced Syncfusion as a Blazor contributor. The headline is Syncfusion.Blazor.Toolkit 2.0.1: 17 MIT-licensed components for net8.0, net9.0 and net10.0, free for commercial use with no license key. Here is what is in it, how to wire it up, and where the commercial line is drawn."
pubDate: 2026-11-03
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet"
  - "nuget"
---

Two days after Infragistics [open-sourced Ignite UI for Blazor Lite](/2026/10/ignite-ui-for-blazor-goes-mit-50-free-components-in-igniteui-blazor-lite/), the ASP.NET team [announced](https://devblogs.microsoft.com/dotnet/blazor-welcomes-syncfusion/) a second vendor on October 29, 2026: Syncfusion. The practical part for app developers is the [Syncfusion Toolkit for Blazor](https://github.com/syncfusion/blazor-toolkit), an MIT-licensed component set that is free for commercial use and, unlike Syncfusion's Community License, has no revenue cap, no eligibility check and no license key.

## What ships in Syncfusion.Blazor.Toolkit

The NuGet package is [`Syncfusion.Blazor.Toolkit`](https://www.nuget.org/packages/Syncfusion.Blazor.Toolkit), currently at 2.0.1 (published October 19, 2026), targeting `net8.0`, `net9.0` and `net10.0`. Its only dependencies are `Microsoft.AspNetCore.Components.Web` and `Microsoft.Extensions.Localization`. The README lists Blazor Server, WebAssembly and Auto as supported for all three frameworks. There is no `net11.0` target yet, so .NET 11 apps will consume the `net10.0` build when .NET 11 goes GA on November 10.

The 17 components:

- **Data viz**: Chart
- **Buttons**: Button, ButtonGroup, Checkbox, Radio Button, Toggle Switch
- **Calendars**: Calendar, DatePicker, DateTime Picker, TimePicker
- **Inputs**: File Upload, Numeric TextBox, TextArea, TextBox
- **Layout**: Dialog, Tooltip
- **Notification**: Spinner

What stays commercial: DataGrid, Scheduler, Gantt, Rich Text Editor, Diagram, Maps, Tree Grid and AI AssistView. The README is blunt about the roadmap: no Data Grid is planned. If you need a free grid, Infragistics' `IgniteUI.Blazor.GridLite` or the built-in QuickGrid are the options.

## Wiring it up

Either start from the templates:

```bash
dotnet new install Syncfusion.Blazor.Toolkit.Templates
dotnet new blazortoolkitweb -o MyApp
```

Or add it to an existing Blazor Web App:

```bash
dotnet add package Syncfusion.Blazor.Toolkit --version 2.0.1
```

```csharp
using Syncfusion.Blazor.Toolkit;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

builder.Services.AddSyncfusionBlazorToolkit();
```

```razor
@* _Imports.razor *@
@using Syncfusion.Blazor.Toolkit
```

Note the namespace: everything lives in `Syncfusion.Blazor.Toolkit`, not the `Syncfusion.Blazor.*` namespaces of the commercial suite. The 2.0 release moved namespaces and themes, and the repo ships `docs/API-COMPATIBILITY.md` for anyone coming from 1.x.

Theme CSS is the one place the docs disagree. The README says styles are delivered at render time by `SfThemeRoot` and a separate link is not needed in the common case, while the Syncfusion product page still tells you to add one in `App.razor`:

```html
<link href="_content/Syncfusion.Blazor.Toolkit/styles/fluent.min.css" rel="stylesheet" />
```

If components render unstyled, add that link first.

Component tags keep the familiar `Sf` prefix, so a chart looks like the commercial API:

```razor
<SfChart Height="330px" Title="Online vs Retail">
    <ChartPrimaryXAxis ValueType="Syncfusion.Blazor.Toolkit.ValueType.Category" />
    <ChartPrimaryYAxis Title="Sales in Units" />
    <ChartSeries DataSource="@sales" XName="Month" YName="Online"
                 Type="ChartSeriesType.SplineArea" Name="Online" />
    <ChartLegendSettings Visible="true" />
    <ChartTooltipSettings Enable="true" />
</SfChart>

@code {
    private record MonthlySales(string Month, double Online);

    private List<MonthlySales> sales = new()
    {
        new("Jan", 35), new("Feb", 28), new("Mar", 34)
    };
}
```

`ChartSeries` sits directly inside `SfChart`, with no collection wrapper. The axis `ValueType` is fully qualified in the README sample too, because the toolkit's `ValueType` enum shares its name with `System.ValueType`.

## Beyond the components

Syncfusion's contributions also landed in the framework: merged `dotnet/aspnetcore` PRs for preserving prerendered state on interactive Not Found pages (#68032), validation of forms bound to inherited models (#67075) and clearer QuickGrid diagnostics (#67413), plus two Blazor Identity scaffolding fixes in `dotnet/Scaffolding`. A toolkit setup scaffolder and a `dotnet/skills` entry for AI coding assistants are still in review.

Support is best-effort through GitHub issues, with paid tickets available separately. For forms, date input and charts in a commercial app without a license key, the toolkit is now a credible default. The [release notes](https://github.com/syncfusion/blazor-toolkit/releases) are worth watching for a `net11.0` target.
