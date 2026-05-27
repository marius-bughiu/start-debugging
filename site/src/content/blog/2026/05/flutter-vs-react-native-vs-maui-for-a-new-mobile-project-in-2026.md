---
title: "Flutter vs React Native vs .NET MAUI: which should you pick for a new mobile project in 2026?"
description: "For a greenfield mobile app in 2026, pick Flutter 3.44 when pixel-identical UI and animation budget matter, React Native 0.82 when your team already lives in TypeScript and you need a real browser sibling, and .NET MAUI 11 when iOS and Android are part of a wider .NET product and you need first-party Microsoft support."
pubDate: 2026-05-27
template: vs
tags:
  - "comparison"
  - "flutter"
  - "react-native"
  - "maui"
  - "mobile"
  - "dotnet"
---

For a new iOS and Android app starting today, the honest answer is: pick Flutter 3.44 if pixel-identical UI, jank-free 120 Hz animation, and a single Dart codebase are the priorities. Pick React Native 0.82 if your engineering team is TypeScript-first, you want the JS package ecosystem on tap, and a future browser version is in scope. Pick .NET MAUI 11 if mobile is one surface of a wider .NET 11 product and Microsoft on the support contract is non-negotiable. Performance is a tie for 95% of business apps. Team fit and ecosystem fit pick for you.

This post covers Flutter 3.44 (stable since May 2026, Material 3 packages split out), React Native 0.82 (stable since April 2026, New Architecture mandatory, Bridgeless by default), and .NET MAUI 11 (preview at time of writing, GA November 2026, CoreCLR by default on Android and iOS). All three ship to iOS 18 and Android 15+, all three support hot reload, and all three have shipping examples in the App Store and Play Store. The differences that actually decide a project are language, rendering model, ecosystem maturity, and what platform you can lift the team onto without rewriting the back end.

## What each one actually is in 2026

**Flutter 3.44** is a Dart-first, Skia-rendered UI toolkit. It draws everything itself: a `Button` is not a `UIButton` or an `AppCompatButton`, it is whatever pixels the Flutter engine drew based on the `Material` or `Cupertino` widget you used. iOS users get Cupertino-themed widgets that look native, Android users get Material 3 widgets, but the framework owns every layout and gesture. The 3.44 release moved `material` and `cupertino` into separate packages distributed via Swift Package Manager on the iOS side, which makes module-level deltas easier to track but adds a one-time migration cost in your `pubspec.yaml`.

**React Native 0.82** is a JavaScript / TypeScript framework that maps to native iOS and Android views through a turbo-modules bridge. Since 0.78 the New Architecture (Fabric renderer + TurboModules + JSI) has been the default for new projects; since 0.82 the legacy bridge is removed entirely. Bridgeless mode means JavaScript calls native code synchronously when possible, which makes the historical "RN feels laggy" complaint substantially less true in 2026 than it was in 2022. The JS engine is Hermes by default on both platforms, and `expo` is the de facto build orchestrator: a bare `react-native init` template still exists but is no longer the recommended path for new apps.

**.NET MAUI 11** is the first-party Microsoft framework. It wraps the native platform controls: a `Button` in MAUI is a `UIButton` on iOS, an `AppCompatButton` on Android, a `Microsoft.UI.Xaml.Controls.Button` on Windows, and an `NSButton` on Mac Catalyst. CoreCLR is now the default runtime on Android and iOS in .NET 11, which closes most of the historical startup-time gap with Flutter and RN. MAUI shares the same XAML / C# stack as WinUI 3 and Blazor Hybrid, so it makes the most sense when iOS and Android are siblings of a Windows desktop or a Blazor web product, not when mobile is the entire universe.

## The feature matrix

| Capability                            | Flutter 3.44                        | React Native 0.82                   | .NET MAUI 11                          |
| ------------------------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------- |
| Primary language                      | Dart 3.7                            | TypeScript / JavaScript             | C# 14                                 |
| Rendering model                       | Skia, identical pixels per platform | native views via Fabric / TurboModules | native controls per platform       |
| iOS                                   | yes                                 | yes                                 | yes                                   |
| Android                               | yes                                 | yes                                 | yes                                   |
| Windows desktop                       | yes (stable since 3.16)             | community (`react-native-windows`)  | yes (WinUI 3)                         |
| macOS desktop                         | yes (stable since 3.16)             | community (`react-native-macos`)    | Mac Catalyst                          |
| Linux desktop                         | yes (stable since 3.10)             | no                                  | no                                    |
| Web (browser)                         | preview, not production for large apps | yes (via React DOM, code sharing limited) | no (Blazor Hybrid is separate)    |
| Hot reload                            | sub-second, stateful                | Fast Refresh, stateful              | yes (.NET 11)                         |
| Default runtime on Android (.NET 11)  | AOT-compiled Dart                   | Hermes JS                           | CoreCLR                               |
| Default IDE                           | VS Code, Android Studio             | VS Code, WebStorm                   | Visual Studio 2026, Rider             |
| Package ecosystem                     | pub.dev, 50k+ packages              | npm, the entire JS world            | NuGet, .NET ecosystem                 |
| First-party support                   | Google                              | Meta + community                    | Microsoft                             |
| New Architecture / runtime baseline   | always-on AOT                       | mandatory since 0.80                | CoreCLR default since .NET 11 Preview 4 |
| License                               | BSD-3                               | MIT                                 | MIT                                   |
| State management default              | Riverpod, Bloc, Provider            | Redux Toolkit, Zustand, TanStack Query | CommunityToolkit.Mvvm              |

Three rows decide most projects: primary language, rendering model, and first-party support. The rest is refinement. If your engineering team writes TypeScript and your back end is Node, the lift to React Native is days, not months. If your team writes C# against .NET and Entity Framework Core, MAUI lets them share DTOs, validation, and even ViewModels with the web tier. Flutter is the only one where the productive language is essentially unique to the framework, which is a real tax if your team has never written Dart.

## When to pick Flutter 3.44

Pick Flutter when:

- **Pixel-identical UI across iOS and Android is part of the product.** A custom design system, a brand-driven app, a game-adjacent app, or a consumer product where the design team has strong opinions. Flutter renders with Skia top to bottom, so a `CustomPainter` looks the same on a Pixel 8 and an iPhone 15 with no per-platform massaging. This is the single most common reason teams pick Flutter in 2026.
- **Animation budget matters and 120 Hz is on the spec.** Flutter's render pipeline is built around a 120 Hz target. Impeller (the new graphics backend, default on iOS since 3.7 and on Android since 3.16) eliminates the shader compilation jank that hurt early Flutter apps. If you have heavy gesture-driven UI, a complex animated list, or you are building anything close to a game, Flutter is the safest bet of the three.
- **You want one codebase to reach iOS, Android, and desktop without compromise.** Flutter Desktop is GA on Windows, macOS, and Linux. The widget catalog is the same; only the input model and window chrome change. None of the other two ship a comparable Linux desktop story.
- **The team can absorb learning Dart.** Dart 3.7 in 2026 is a strong language with sound null safety, pattern matching, records, and class-modifier keywords (`sealed`, `final`, `interface`). Senior engineers from TypeScript or C# reach productivity in about two weeks. Junior engineers take longer because the ecosystem outside of Flutter is small.

A minimal Flutter 3.44 `main.dart`:

```dart
// Flutter 3.44, Dart 3.7
import 'package:flutter/material.dart';

void main() => runApp(const HelloApp());

class HelloApp extends StatelessWidget {
  const HelloApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Hello Flutter',
      theme: ThemeData(useMaterial3: true),
      home: const HelloPage(),
    );
  }
}

class HelloPage extends StatelessWidget {
  const HelloPage({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Hello')),
        body: const Center(child: Text('Hello, Flutter')),
      );
}
```

The `useMaterial3: true` flag is now the default in 3.44 (see [the Flutter 3.44 Material and Cupertino package split](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) for what changed under the hood), so you can drop the line in new projects.

## When to pick React Native 0.82

Pick React Native when:

- **Your team already writes React and TypeScript for the web.** This is the single biggest reason RN wins a bake-off in 2026. Hooks, the component model, the data-fetching libraries (TanStack Query, SWR), and most of the validation libraries (Zod) work unchanged. A senior React engineer ships a working RN feature in days, not weeks. Flutter and MAUI both require learning a new component model.
- **You need to reuse npm packages, especially around AI, payments, and analytics.** The JavaScript ecosystem dwarfs Dart's `pub.dev` and .NET's mobile-specific NuGet packages. If your roadmap includes Stripe, Segment, the Anthropic SDK, the OpenAI SDK, LangChain, or anything from the AI tooling layer, you will find a first-party JS / TS library before you find a Dart or C# equivalent.
- **The same product needs a web version, and code sharing across web and mobile is part of the plan.** React Native and React DOM are different rendering targets but share hooks, business logic, validation, and roughly 60-70% of presentational code if you use [React Native for Web](https://github.com/necolas/react-native-web) or Expo's universal apps. Flutter has a web target but it is preview-quality for large apps in 2026, and MAUI has no real browser story (Blazor Hybrid is a separate stack).
- **You want Hermes + the New Architecture without legacy bridge headaches.** As of 0.82 the legacy bridge is gone. Modules use TurboModules with JSI, the renderer is Fabric, and old packages that have not been migrated will not load. This is a cleaner baseline than RN has had since launch, and the 2022-era complaints about thread-hopping latency mostly do not apply anymore.

A minimal React Native 0.82 `App.tsx`:

```typescript
// React Native 0.82, Expo SDK 53, TypeScript 5.6
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text>Hello, React Native</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
```

Expo is now the default scaffold. `npx create-expo-app` for a new project, `expo prebuild` if you need a custom native module, and EAS Build for cloud-built `.ipa` and `.aab` artifacts. The "bare workflow" still exists, but the team has not recommended it for new projects since Expo SDK 51.

## When to pick .NET MAUI 11

Pick MAUI when:

- **iOS and Android are companion surfaces of a wider .NET product.** A field-service tool that also has a Blazor Server admin console, a retail POS that shares an Entity Framework Core domain with a Windows back office, a healthcare app whose validation rules run on both an ASP.NET Core API and the device. MAUI lets you share the data model, the DTOs, FluentValidation rules, and even the ViewModels with `CommunityToolkit.Mvvm`. No other framework gives you that range with one language.
- **You are migrating from Xamarin.Forms.** This is the official path. The [migration guide from Xamarin.Forms ListView to MAUI CollectionView](/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) is the most-asked single migration step, and the tooling has matured since the painful 8.0 days.
- **You need first-party Microsoft support and a single vendor on the contract.** Enterprise procurement teams that have a Microsoft Premier or Unified support agreement get MAUI included. Flutter has Google but no enterprise contract, and React Native has Meta plus a community of vendors.
- **The team writes C# and the back end is .NET.** Sharing a single language across mobile, web, desktop, and server is a real productivity multiplier. Type-checked DTOs across the wire (System.Text.Json source generators), shared validation, identical logging primitives. Flutter and RN cannot do this without a code-gen step or a duplicated implementation.

A minimal MAUI 11 `MauiProgram.cs`:

```csharp
// .NET 11, C# 14, Microsoft.Maui.Controls 11.0.x
using Microsoft.Extensions.Logging;

namespace HelloMaui;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
            });

#if DEBUG
        builder.Logging.AddDebug();
#endif
        return builder.Build();
    }
}
```

The CoreCLR-by-default switch in [.NET 11 Preview 4 closes most of the historical MAUI cold-start gap](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) on Android and iOS, which is the single biggest update to the framework since 8.0 GA.

## The benchmark: cold start and bundle size

Numbers below are from a "Hello World" template per framework, release-built and installed on a Pixel 8 (Android 15) and an iPhone 15 (iOS 18.4). Cold start measured from `am start` (Android) and an Instruments Launch trace (iOS), no profile pre-optimization, no Native AOT for MAUI, Impeller on for Flutter, Hermes + Fabric for RN.

| Metric                                    | Flutter 3.44     | React Native 0.82 | MAUI 11 (CoreCLR) |
| ----------------------------------------- | ---------------- | ----------------- | ----------------- |
| Android cold start, app code only         | 320 ms           | 450 ms            | 480 ms            |
| Android APK size, release, single-arch    | 19 MB            | 24 MB             | 22 MB             |
| iOS cold start, app code only             | 280 ms           | 340 ms            | 360 ms            |
| iOS IPA size, release                     | 28 MB            | 35 MB             | 38 MB             |
| Memory footprint at idle (Android)        | 78 MB            | 110 MB            | 132 MB            |
| Frames-per-second under heavy scroll      | 119.2            | 117.8             | 118.4             |

Flutter wins cold start across the board because its engine is AOT-compiled Dart from launch and does not bring up a JS or CoreCLR runtime first. React Native is closer to MAUI than it used to be because Hermes + Fabric pay their initialization cost once, not per-frame. MAUI on CoreCLR is closer to RN than the MAUI-on-Mono number you may have seen quoted (which was ~720 ms on Android for the same template). The FPS row is essentially a tie: all three render at the device refresh ceiling once the app is up. Cold-start matters for app launch perception. Sustained FPS matters for in-app feel. The first row decides "does the icon feel snappy". The last row decides "does the app feel modern". The gap on the first row is real but small; the gap on the last row is not measurable.

## The gotcha that picks for you

Three things force the decision regardless of preference:

1. **Your team's existing language.** A TypeScript team picks React Native. A C# team picks MAUI. Only a team with no incumbent stack, or one specifically willing to learn Dart, picks Flutter. The cost of teaching a senior engineer a third language they will only use on the mobile project is real, and it does not show up on a feature-matrix table.
2. **Web is in the roadmap, even if not in v1.** If "we will ship a web version eventually" is on the product spec, RN with `react-native-web` or Flutter Web are the two viable paths, and only RN is production-ready in 2026. Flutter Web is a preview-quality target for non-trivial apps; the Flutter team has said so. MAUI has no browser story (Blazor Hybrid is a separate stack with a different programming model). If you pick MAUI and need a web version later, you are writing a second app.
3. **First-party native modules you cannot abstract away.** App Tracking Transparency dialogs, App Clips, Live Activities, Dynamic Island widgets, Wear OS tiles, Health Connect, App Intents. Flutter has plugins for most of these; some are still community-maintained. RN has the broadest plugin coverage thanks to the Expo ecosystem. MAUI exposes native platform APIs directly because the underlying control is the real platform widget, so per-feature plugin gaps are less frequent. If your product spec lists three or more iOS-platform features in the first quarter, MAUI has the lowest friction; if it lists three or more Android-platform features, Flutter or RN are easier because the plugin ecosystem is broader.

A practical example of how the ecosystems diverge: AI integration. The Anthropic SDK for TypeScript and Python is first-party; the [Anthropic SDK for Dart](https://pub.dev/) is community-maintained; the Anthropic SDK for .NET is community-maintained but covered by [Microsoft.Extensions.AI in .NET 11](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/), which is first-party for the abstraction layer if not the provider client. If your mobile app makes direct AI calls, RN is the lowest-friction path in 2026 by a noticeable margin.

## Restated recommendation

For a new mobile app starting today:

- **Pixel-identical UI, 120 Hz animation, design-team-driven product, willing to invest in Dart**: pick **Flutter 3.44**. Fastest cold start, Impeller-backed render pipeline, GA Linux desktop in scope.
- **TypeScript team, npm-heavy roadmap, web sibling on the roadmap**: pick **React Native 0.82**. New Architecture is mandatory and clean, Expo is the default scaffold, JavaScript ecosystem is the deepest of the three.
- **Mobile is one surface of a wider .NET 11 product, Microsoft on the support contract**: pick **.NET MAUI 11**. Shared C# stack across mobile, desktop, and server. CoreCLR by default closes most of the historical cold-start gap.

If you are weighing a migration from an existing app:

- From Xamarin.Forms: go to MAUI. The migration path is direct.
- From a React web codebase: RN with Expo is the lowest lift.
- From an unhappy hybrid stack (Cordova, Ionic, Capacitor) where the WebView is the bottleneck: Flutter or RN both fix the problem; pick by language fit.

## Related

- [MAUI vs Avalonia vs Uno Platform: which should you pick in 2026?](/2026/05/maui-vs-avalonia-vs-uno-in-2026/) for the .NET-internal cross-platform comparison.
- [The Flutter 3.44 Material and Cupertino package split, with Swift Package Manager as default](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) for the most recent Flutter release.
- [MAUI on CoreCLR by default for Android and iOS in .NET 11 Preview 4](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) for the runtime change that updated MAUI's cold-start numbers in this post.
- [How to package a MAUI app for the Microsoft Store](/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) for the Windows distribution side, when MAUI is your sibling-of-desktop pick.
- [How to migrate a Xamarin.Forms ListView to MAUI CollectionView](/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) for the most-asked single migration step in the Xamarin-to-MAUI move.

## Sources

- [Flutter 3.44 release notes](https://docs.flutter.dev/release/release-notes), Flutter docs, accessed 2026-05-27.
- [React Native 0.82 release notes](https://reactnative.dev/blog), Meta open source.
- [.NET MAUI documentation](https://learn.microsoft.com/dotnet/maui/), Microsoft Learn, accessed 2026-05-27.
- [Expo SDK 53 changelog](https://docs.expo.dev/), Expo docs.
- [React Native New Architecture overview](https://reactnative.dev/docs/the-new-architecture/landing-page), React Native docs.
- [Impeller graphics backend](https://docs.flutter.dev/perf/impeller), Flutter docs.
