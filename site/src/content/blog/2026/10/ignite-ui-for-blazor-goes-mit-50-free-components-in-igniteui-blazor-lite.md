---
title: "Ignite UI for Blazor goes MIT: 50+ free components in IgniteUI.Blazor.Lite 1.0.0"
description: "Infragistics open-sourced more than 50 Ignite UI for Blazor controls under MIT, shipped as IgniteUI.Blazor.Lite and IgniteUI.Blazor.GridLite 1.0.0 for net8.0, net9.0 and net10.0. Here is what is free, how to wire it up, and the gotchas."
pubDate: 2026-10-28
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet"
  - "nuget"
---

On October 27, 2026 the ASP.NET team [announced](https://devblogs.microsoft.com/dotnet/blazor-welcomes-infragistics/) that Infragistics is now a Blazor contributor, and the headline for most of us is the license: more than 50 Ignite UI for Blazor controls are now MIT, free for commercial use, with source on [GitHub](https://github.com/IgniteUI/igniteui-blazor). This is not a trial tier. It is a permanent subset of the commercial suite.

## What is actually free

Two packages, both at 1.0.0 on NuGet and both targeting `net8.0`, `net9.0` and `net10.0`:

- `IgniteUI.Blazor.Lite`: inputs, navigation and layout controls. Combo, Date Picker, Date Range Picker, Tree, Stepper, Tile Manager, Splitter, Dialog, Tabs, Calendar, Mask Input, Slider, Rating, Chat (preview) and roughly 40 more.
- `IgniteUI.Blazor.GridLite`: a lightweight data grid with column filtering and custom cell templates.

The full Grid, Tree Grid, Pivot Grid, Hierarchical Grid and Dock Manager stay commercial in the `IgniteUI.Blazor` package. If you need grouping, editing or Excel export, Grid Lite is not that grid.

## Wiring it into a Blazor Web App

```bash
dotnet add package IgniteUI.Blazor.Lite --version 1.0.0
```

Register the services in `Program.cs` and import the namespace in `_Imports.razor`:

```csharp
builder.Services.AddIgniteUIBlazor();
```

```razor
@using IgniteUI.Blazor.Controls
```

Then add a theme to `Components/App.razor` (or `wwwroot/index.html` for standalone WebAssembly):

```html
<link href="_content/IgniteUI.Blazor/themes/light/bootstrap.css" rel="stylesheet" />
```

Note the path: it is `_content/IgniteUI.Blazor/`, not `_content/IgniteUI.Blazor.Lite/`. I checked the 1.0.0 package and its static web assets `BasePath` is set to `_content/IgniteUI.Blazor`, so the Lite and commercial packages share the same asset URLs. Guess the "obvious" path and you get unstyled components and a 404 in the network tab. Themes ship in `bootstrap`, `fluent`, `indigo` and `material`, each in `light` and `dark`.

No `<script>` tag is needed. A JavaScript initializer loads the web components when Blazor starts.

## A Combo with real data binding

`IgbCombo` is generic over `TValue` and `TItem`, and `Value` is always a `TValue[]`, even with `SingleSelect`. That trips people up the first time:

```razor
@rendermode InteractiveServer

<IgbCombo TItem="City" TValue="int"
          Data="cities"
          ValueKey="Id"
          DisplayKey="Name"
          Label="Destination"
          SingleSelect="true"
          @bind-Value="selected" />

<p>Selected id: @(selected.FirstOrDefault())</p>

@code {
    record City(int Id, string Name);

    City[] cities = [new(1, "Bucharest"), new(2, "Cluj"), new(3, "Iasi")];
    int[] selected = [];
}
```

The `@rendermode` line matters. The components are built on JavaScript interop, so they need `InteractiveServer`, `InteractiveWebAssembly` or `InteractiveAuto`. Static SSR is not supported, and a page without a render mode just renders inert markup.

## The part that lands in .NET 11

Infragistics engineers also contributed two Blazor analyzers, merged for .NET 11 in [dotnet/aspnetcore#67176](https://github.com/dotnet/aspnetcore/pull/67176) and [#67383](https://github.com/dotnet/aspnetcore/pull/67383). The first flags `StateHasChanged()` calls that `ComponentBase` already makes redundant, such as a call right before the first `await` in `OnInitializedAsync`, and ships a code fix that removes them. The second warns when a class calls `GetAuthenticationStateAsync()` without subscribing to `AuthenticationStateChanged`, which is how you end up with a stale cached user.

There is also a `use-igniteui-blazor` skill in [dotnet/skills](https://github.com/dotnet/skills/tree/main/plugins/dotnet-blazor/skills/use-igniteui-blazor) for coding agents, plus a scaffolder still under review in [dotnet/Scaffolding#3823](https://github.com/dotnet/Scaffolding/pull/3823).

For teams that skipped component vendors because of per-seat licensing, a free MIT Combo, Date Range Picker and Tree that pass the Blazor team's trimming and accessibility bar are worth a spike this week.
