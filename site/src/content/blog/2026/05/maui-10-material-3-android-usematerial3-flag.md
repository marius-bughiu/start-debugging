---
title: ".NET MAUI 10 SR6 finishes Material 3 on Android behind a single UseMaterial3 flag"
description: "MAUI 10 SR6 (10.0.60) extends Material 3 theming to Button, Entry, SearchBar, DatePicker, Slider, ProgressBar, ImageButton, Switch, and Shell on Android. Opt in with one MSBuild property. No custom renderers, no styles.xml edits."
pubDate: 2026-05-27
tags:
  - "dotnet"
  - "maui"
  - "android"
  - "material-3"
  - "dotnet-10"
---

Microsoft shipped the [last big chunk of Material 3 support for .NET MAUI on Android](https://devblogs.microsoft.com/dotnet/dotnet-maui-material-3/) in the .NET MAUI 10 SR6 release (10.0.60), announced May 26, 2026. The interesting part is not that Material 3 is here. It is that the opt-in is exactly one MSBuild property and that the team kept handler customization out of the picture entirely.

If you have been following the .NET 11 mobile story, MAUI itself is also [switching its default runtime to CoreCLR on Android and iOS in .NET 11 Preview 4](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/). Material 3, however, is a .NET MAUI 10 feature and ships on the supported service-release cadence today.

## How the rollout was sliced

Material 3 did not land all at once. The feature was staged across three .NET MAUI 10 service releases:

- **SR3 (10.0.30)**: baseline Material 3 styles for a handful of controls.
- **SR4 (10.0.40)**: `CheckBox` picked up the new theming.
- **SR6 (10.0.60)**: the big batch. `Button`, `Entry`, `SearchBar`, `DatePicker`, `Slider`, `ProgressBar`, `ImageButton`, `Switch`, and full `Shell` theming.

The full supported set in SR6 covers `Entry`, `Editor`, `SearchBar`, `RadioButton`, `ProgressBar`, `Slider`, `Picker`, `TimePicker`, `DatePicker`, `CheckBox`, `Switch`, `ImageButton`, `Button`, `Label`, `ActivityIndicator`, `Image`, and `Shell`.

## The opt-in is one property

The whole opt-in is a single property in your `.csproj`:

```xml
<PropertyGroup>
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>
```

That is the entire surface area. Rebuild, deploy to an Android device or emulator, and the supported controls start picking up Material 3 styling automatically. No handler customization, no custom renderers, no `Resources/values/styles.xml` surgery, no `MainActivity` changes.

If you want to scope the flag to Android only, use the standard MSBuild condition:

```xml
<PropertyGroup Condition="$(TargetFramework.Contains('-android'))">
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>
```

## Explicit styles still win

The team kept the precedence rule the way you would want it. Anything you set explicitly in XAML or C# overrides Material 3 defaults:

```xml
<Button Text="Save"
        BackgroundColor="#0F62FE"
        TextColor="White" />
```

That button keeps its IBM blue. Material 3 only fills in where you did not already paint. Custom handlers and renderers are unaffected, which matters if you have a design system that already overrides specific controls; flipping the flag will not silently restyle the things you intentionally customized.

## Why this matters

The Android visual gap has been one of the longest-running complaints about MAUI. Out-of-the-box controls looked dated, fixing it required dropping into Android theme XML, and any per-control workaround tended to drift from whatever Google shipped in the next Material release. A single MSBuild flag that tracks Material 3 across SR releases is a meaningful reduction in maintenance surface for any team that does not have a design system already nailed down.

The pragmatic move on an existing MAUI 10 app: bump to 10.0.60, set `UseMaterial3` to `true`, run the app on an Android emulator, and walk through every screen. Anywhere you previously hand-styled to compensate for the old defaults is now a candidate for deletion.
