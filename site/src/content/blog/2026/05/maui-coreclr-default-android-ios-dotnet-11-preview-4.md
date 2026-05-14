---
title: "MAUI switches to CoreCLR by default on Android, iOS, and Mac Catalyst in .NET 11 Preview 4"
description: ".NET 11 Preview 4 makes CoreCLR the default runtime for MAUI on Android, iOS, Mac Catalyst, and tvOS. Mono is still one MSBuild property away. Here is what changes, what breaks, and how to opt out."
pubDate: 2026-05-14
tags:
  - "dotnet-11"
  - "maui"
  - "coreclr"
  - "mono"
  - "runtime"
---

Microsoft [flipped the default MAUI runtime to CoreCLR in .NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-maui-moves-to-coreclr-in-dotnet-11/), released May 13, 2026. New MAUI projects targeting Android, iOS, Mac Catalyst, and tvOS now run on the same runtime that powers ASP.NET Core and console apps on the desktop. Mono is no longer the implicit choice on mobile. This is the largest single architectural change in MAUI since the Xamarin merge, and it lands quietly behind a default flag.

If you are tracking the .NET 11 mobile story, this builds on [`dotnet watch` reaching MAUI on Android and iOS in the same preview](/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/).

## Why CoreCLR on a phone matters

For about a decade, Xamarin and then MAUI ran on Mono on mobile because CoreCLR had no working AOT story for ARM mobile targets. Mono shipped its own AOT compiler, GC, JIT, profiler, and debugger. Every tooling investment Microsoft made in CoreCLR (tiered compilation, dynamic PGO, the Server GC region engine, ReadyToRun) had to be re-implemented or skipped on mobile.

Switching to CoreCLR collapses that. Mobile MAUI now gets the same JIT, GC, and diagnostic surface as a Linux container running ASP.NET Core. Microsoft's startup numbers are positive for baseline templates with ReadyToRun and PGO, but the announcement is honest about regressions in larger apps on Android and asks teams to measure in Release mode on real devices before assuming a free win.

The other reason this matters: CoreCLR on Android unlocks NativeAOT for MAUI, which the post calls "a natural next step."

## What ships off by default

CoreCLR on mobile drops some platforms Mono carried:

- Android x86 is gone.
- Android API 23 and lower is gone.
- The Android embedding APIs (the path most Xamarin.Android library authors used) are gone.
- Android arm32 is "still under review."
- Blazor WebAssembly is unaffected. WASM remains on Mono because CoreCLR has no WebAssembly target.

If your app or any transitive NuGet dependency relies on the embedding APIs or shipped binaries for x86, the upgrade will fail at build or load time, not at runtime in production.

## Opting out

One MSBuild property reverts the affected target frameworks to Mono:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <UseMonoRuntime>true</UseMonoRuntime>
</PropertyGroup>
```

Drop the `Condition` to revert all platforms. Treat this as a temporary escape hatch. Microsoft has not committed to keeping Mono shipped for MAUI mobile beyond the .NET 11 lifecycle, and the announcement frames the property as a way to unblock a release while you file a regression issue, not as a long-term configuration choice.

## What to actually do this week

Three things are worth doing now, while it is still a preview:

1. Build on .NET 11 Preview 4 and check for failures from the dropped platforms.
2. Run a Release build on a representative low-end Android device and compare cold start, warm start, and APK size against the same app built on .NET 10. Community reports include both wins and regressions, so generic numbers will not predict your app.
3. If you depend on a Xamarin.Android library that has not been touched in years, check whether it uses the embedding APIs. If it does, it will not load on CoreCLR and you need a replacement before the GA train leaves.

This is the kind of change that looks fine in benchmarks and quietly breaks production six months later when a transitive dependency turns out to be Mono-only. Better to learn that during the preview.
