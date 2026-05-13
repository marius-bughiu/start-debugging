---
title: "dotnet watch finally reaches MAUI on Android and iOS in .NET 11 Preview 4"
description: ".NET 11 Preview 4 turns on dotnet watch for Android devices, Android emulators, and the iOS Simulator. Edit, save, and the running app updates without a manual rebuild. One csproj gotcha applies to iOS."
pubDate: 2026-05-13
tags:
  - "dotnet-11"
  - "maui"
  - "dotnet-watch"
  - "hot-reload"
  - "mobile"
---

Microsoft [shipped .NET 11 Preview 4 on May 12, 2026](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/), and for MAUI developers the headline is small in the changelog but huge in day-to-day work: `dotnet watch` now drives Hot Reload on Android devices, Android emulators, and the iOS Simulator. Until this preview, the MAUI mobile loop was "edit, rebuild, redeploy" for anything outside of XAML. Preview 4 closes that gap.

## The actual workflow

Open a MAUI app, pick a target framework and a device, and run:

```bash
dotnet watch --framework net11.0-android
```

For iOS it is the same shape, with the iOS Simulator target:

```bash
dotnet watch --framework net11.0-ios
```

`dotnet watch` deploys the app once, then files change events get translated into Hot Reload deltas and pushed to the running process. C# method bodies, XAML, and CSS all flow through. Adding a new `PackageReference` or `ProjectReference` mid-session also works in .NET 11: Roslyn validates the change, the `ReferenceCopyLocalPathsOutputGroup` target copies the new assemblies to the output directory, and the in-process delta applier loads them via the `AssemblyResolving` event. No restart.

## The iOS gotcha you have to know about

There is one known issue worth pinning to your wall. Per the [MAUI Preview 4 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/dotnetmaui.md), `dotnet watch` does not work for iOS projects unless `MtouchLink` is disabled. Drop this into the iOS `PropertyGroup` of your `.csproj`:

```xml
<PropertyGroup Condition="$(TargetFramework.Contains('-ios'))">
  <MtouchLink>None</MtouchLink>
</PropertyGroup>
```

That disables the managed linker for iOS debug builds, which is fine for inner-loop development but you do not want it in your release configuration. Keep the condition scoped to the iOS TFM and Debug configuration, or move it to a `Debug|iPhoneSimulator` condition if you have separate platform configurations.

The other fixes Preview 4 landed for the iOS path are worth calling out: console input conflicts with the simulator are resolved, the WebSocket exception that used to kill the Hot Reload session is gone, and the deadlock that froze the app on rapid edits has been ironed out. These are the bugs that made earlier previews unusable on iOS even when watch technically launched.

## Why this matters more than it sounds

The MAUI feedback loop has been the single most-cited reason Xamarin veterans and Flutter-adjacent devs have stayed away. A 30 second rebuild after every C# edit kills exploratory UI work. `dotnet watch` for desktop targets (Windows, Mac Catalyst) has been around for a while, but mobile is where MAUI lives or dies. Preview 4 finally puts MAUI's mobile inner loop in the same league as Flutter's `flutter run` hot reload.

If you already track .NET 11 previews on a side branch, this is the one to actually use on a real project. If you have been waiting, [download Preview 4](https://dotnet.microsoft.com/download/dotnet/11.0) and update your iOS `.csproj` before you `dotnet watch` for the first time.
