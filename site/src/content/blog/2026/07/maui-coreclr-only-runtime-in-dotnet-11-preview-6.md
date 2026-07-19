---
title: "MAUI Mobile Is CoreCLR Only in .NET 11 Preview 6: The Mono Escape Hatch Is Gone"
description: ".NET 11 Preview 6 removes the separate Mono path for MAUI on Android, iOS, and Mac Catalyst. CoreCLR is now the only mobile runtime, the UseMonoRuntime escape hatch is closed, and GA is set for November 2026."
pubDate: 2026-07-19
tags:
  - "dotnet-11"
  - "maui"
  - "coreclr"
  - "mono"
  - "runtime"
---

Two months ago, [MAUI flipped its default mobile runtime to CoreCLR in .NET 11 Preview 4](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), and the release notes handed you an escape hatch: set `<UseMonoRuntime>true</UseMonoRuntime>` and your Android, iOS, and Mac Catalyst builds went back to the old runtime. That hatch is closing. In [CoreCLR Progress and the Mono Timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), David Ortinau confirms that as of .NET 11 Preview 6 (shipped July 10, 2026), CoreCLR is the only runtime surfaced for MAUI mobile apps. Microsoft is "no longer surfacing a separate Mono path for Android, iOS, or Mac Catalyst."

## From default to only

The distinction matters. In Preview 4, CoreCLR was the default and Mono was a property flip away, framed explicitly as a temporary unblock while you filed a regression. Preview 6 removes that dual-runtime posture on mobile. There is no supported Mono target for MAUI's mobile heads anymore, and the opt-out property that used to revert them is no longer part of the story. If your project or a transitive dependency was leaning on `UseMonoRuntime` to sidestep a CoreCLR regression, that plan expires now, not at GA.

Blazor WebAssembly is untouched. WebAssembly still runs on Mono because CoreCLR has no Wasm target, and none of this changes that.

```xml
<!-- Preview 4: still an option -->
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <UseMonoRuntime>true</UseMonoRuntime>
</PropertyGroup>

<!-- Preview 6: no separate Mono path for MAUI mobile -->
```

## Where the numbers landed

The honest part of the Preview 4 announcement was its admission of regressions on larger Android apps. Preview 6 reads calmer. Ortinau reports iOS and Mac Catalyst are generally faster than they were on Mono, and Android now lands within roughly 10% of Mono on both startup and app size. That is close enough that the runtime unification, sharing the same JIT, GC, and diagnostics as ASP.NET Core, stops being a trade you argue about and starts being a baseline you build on. It also keeps NativeAOT for MAUI on the table as the next step, which was never possible while mobile sat on a separate runtime.

## What to test before November

GA is November 2026, and the preview window is exactly when priorities can still shift based on your feedback. Concretely:

- Build your app on Preview 6 and confirm it loads. The platforms CoreCLR dropped earlier in the .NET 11 cycle (Android x86, API 23 and lower, the old Xamarin.Android embedding APIs) fail at build or load time, not silently in production.
- Run a Release build on a representative low-end Android device and compare cold start, warm start, and package size against .NET 10. The 10% figure is Microsoft's aggregate, not a promise about your dependency graph.
- Audit any long-untouched Xamarin.Android library. If it uses the embedding APIs, it will not load on CoreCLR, and you need a replacement queued before the GA train leaves.

The runtime you ship MAUI on in November is decided now. Preview 6 is the last comfortable moment to find out whether your app agrees. The full progress report and timeline are on the [.NET Blog](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/).
