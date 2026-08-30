---
title: "The Flutter & Dart tracker"
description: "Flutter and Dart in one place: jank profiling, isolates, state management, CI matrices, platform channels, and the 3.x release cycle."
tagline: "One bookmark for everything Flutter and Dart on this site."
pubDate: 2026-05-10
updatedDate: 2026-08-30
indexTags:
  - "flutter"
  - "dart"
---

This pillar collects every post on the site about **Flutter and Dart** — the 3.x release cycle, Material 3 theming, Dart isolates, platform channels, state-management migrations, jank and DevTools profiling, CI workflows, and the long tail of exception fixes.

## What to read first

If you're new here, [profiling jank with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) is the highest-leverage read for shipping smooth UIs, and [writing a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) covers the primitive most teams reach for too late - pair it with [isolate vs thread](/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/), which explains why nothing you send is shared. For state management, [Provider vs Riverpod vs Bloc](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) settles the choice first, then [provider to Riverpod](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) walks the common migration; if you're already on it, [Riverpod 2.x to 3.0](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) covers the new major, and [Notifier vs AsyncNotifier vs StreamNotifier](/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/) picks the base class. For routing, [go-router vs auto_route vs Navigator 2.0](/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/) settles the stack. Upgrading an older codebase first? [The Flutter 2 to 3.x null-safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) comes before any of that.

For the engine and tooling story, [Flutter 3.47 making Impeller the default desktop renderer](/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) is the newest change, and the Skia opt-out is temporary; take [the 3.47.1 hotfix](/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/) with it, closing a plugin-registrant injection hole. [Flutter 3.44 splitting Material and Cupertino out of the SDK](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) is still the biggest packaging change in the 3.x cycle, and [targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) covers the build side.

## What's on this page

The list below auto-collects posts tagged with any of: `flutter`, `dart`. Newest first.
