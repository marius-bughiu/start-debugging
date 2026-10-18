---
title: "The Flutter & Dart tracker"
description: "Flutter and Dart in one place: jank profiling, isolates, state management, CI matrices, platform channels, and the 3.x release cycle."
tagline: "One bookmark for everything Flutter and Dart on this site."
pubDate: 2026-05-10
updatedDate: 2026-10-18
indexTags:
  - "flutter"
  - "dart"
---

This pillar collects every post on the site about **Flutter and Dart** — the 3.x release cycle, Dart isolates, platform channels, state-management migrations, jank profiling, CI workflows, and the long tail of exception fixes.

## What to read first

Start with [profiling jank with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) and [writing a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) - pair it with [isolate vs thread](/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/). For state management, [Provider vs Riverpod vs Bloc](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) settles the choice, then [provider to Riverpod](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) walks the common migration; if you're already on it, [Riverpod 2.x to 3.0](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) covers the new major and [ref.watch vs ref.read](/2026/09/ref-watch-vs-ref-read-in-flutter-riverpod/) is the callback trap. For routing, [go-router vs auto_route vs Navigator 2.0](/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/) settles the stack, and [StatefulShellRoute's currentIndex](/2026/10/how-to-keep-the-navigationbar-selected-tab-in-sync-with-the-current-route-in-go-router/) keeps the NavigationBar in sync. Leaving Hive? [Hive to drift](/2026/10/migrate-a-flutter-app-from-hive-to-drift/) is the safe import.

For the engine and tooling story, [Impeller as the default desktop renderer](/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) is the newest change. [Flutter 3.44 splitting Material and Cupertino out of the SDK](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) is the biggest packaging change; [moving your imports to material_ui and cupertino_ui](/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) is the migration, [dart fix across a whole repo](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) applies it in one pass, and [the undefined `awaitNotRequired` error](/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/) is the lockfile snag; on iOS, [CocoaPods to Swift Package Manager](/2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager/) is the matching migration. On the web, [CanvasKit vs skwasm](/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/) picks the renderer. On Android, [moving to AGP 9 with built-in Kotlin](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) is the toolchain migration, and [background location on Android 15](/2026/09/how-to-keep-flutter-location-tracking-running-in-the-background-on-android-15/) needs a `location` foreground service.

## What's on this page

The list below auto-collects posts tagged with any of: `flutter`, `dart`. Newest first.
