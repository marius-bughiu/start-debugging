---
title: ".NET MAUI vs platform UI on .NET 11 GA: the Barista Notes startup and size numbers"
description: "David Ortinau had agents rebuild a 31,000-line .NET MAUI app as .NET for iOS and .NET for Android, then measured both on .NET 11 GA. Platform UI started 50% faster on Android and 35% faster on iOS, but cost more to maintain."
pubDate: 2026-11-21
tags:
  - "maui"
  - "dotnet-11"
  - "performance"
  - "ai-agents"
---

On November 20, 2026, David Ortinau, the .NET MAUI product manager, published [AI is Changing the Cross-Platform Decision Matrix](https://devblogs.microsoft.com/dotnet/ai-cross-platform-decision-matrix/) on the .NET Blog. It is unusual for a framework team post: it measures what you give up by staying on .NET MAUI's shared UI, using a real app and numbers rerun on .NET 11 GA two days before publication.

## The experiment

The app is Barista Notes, a .NET MAUI app with a dozen-plus screens, more than 20 NuGet dependencies, and about 31,000 lines of hand-written C# using MauiReactor instead of XAML. In late September, a GitHub Copilot session with 13 agent identities rebuilt the iOS and Android front ends as .NET for iOS (UIKit) and .NET for Android (Android Views), both in C#, over a shared class library. The rewrite took 58 hours of aggregate model time and produced 699 passing tests. Shared code dropped from 99.2% to 40.4%.

The runtime numbers were rerun on November 18 with SDK `11.0.100`, .NET MAUI Controls `11.0.0`, and EF Core plus Microsoft.Extensions aligned to `11.0.0`, on an iPhone 15 Pro and a Pixel 5. Startup is the median of 30 launches; navigation is the median of 10 fresh-process samples.

## What platform UI bought

With full composite ReadyToRun on both sides:

| Measure | MAUI iOS | .NET for iOS | MAUI Android | .NET for Android |
|---|---|---|---|---|
| Startup median | 569 ms | 367 ms | 1,233 ms | 615 ms |
| Signed package | 58.87 MiB | 49.09 MiB | 45.64 MiB | 31.74 MiB |
| New Drink to History | 660.5 ms | 115.0 ms | 826.8 ms | 381.0 ms |

That is 50% faster startup on Android and 35% on iOS, plus 30% and 17% smaller packages. The defaults tell a more mixed story: .NET MAUI Android Release builds use partial composite ReadyToRun, which gave 1,192 ms startup with a 28.84 MiB APK, smaller than the platform UI build. Ortinau also notes that the MAUI package carries MauiReactor, toolkits, and popups, so the size gap is not all framework.

The Android startup figure comes from `am start -W`, which you can run against your own app (replace the package and activity names):

```bash
adb shell am force-stop com.example.myapp
adb shell am start -W -n com.example.myapp/com.example.myapp.MainActivity | grep TotalTime
```

## What it cost to keep

The second phase added the same feature, a Mapsui bean-origin map, to both versions using `gpt-6.1-sol` at High effort. The platform UI side used 121.2 model minutes versus 87.6, 17.3M input tokens versus 10.0M, and drew 19 defect or feedback items versus 13. The coordinator agent spent 616 minutes verifying, more than both implementations combined (209). Agents make the second UI cheap to write. They do not make it cheap to own.

## A middle path that already exists

Ortinau still recommends a single shared UI for most teams, but suggests measuring platform UI per screen or per platform. .NET MAUI native embedding supports that in both directions: keep MAUI pages and drop to platform views where startup matters, or host MAUI content inside a .NET for Android activity:

```csharp
// Android Activity in a .NET for Android app, MAUI built with UseMauiEmbeddedApp<App>()
var mauiApp = MauiProgram.CreateMauiApp();
var mauiContext = new MauiContext(mauiApp.Services, this);

var settings = new SettingsView();               // a MAUI ContentView
Android.Views.View native = settings.ToPlatformEmbedded(mauiContext);
SetContentView(native);
```

If your last MAUI startup comparison predates .NET 11, it measured Mono. As covered in [MAUI going CoreCLR-only in .NET 11 Preview 6](/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/), that runtime is gone, so rerun your own numbers on `11.0.100`. The [Android](https://github.com/davidortinau/BaristaNotes/blob/main/docs/native-runtime-comparison-net11-ga.md) and [iOS](https://github.com/davidortinau/BaristaNotes/blob/main/docs/native-runtime-comparison-ios-net11-ga.md) reports in the [BaristaNotes repo](https://github.com/davidortinau/BaristaNotes) document the full method.
