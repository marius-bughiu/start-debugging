---
title: "The Flutter & Dart tracker"
description: "Flutter and Dart in one place: jank profiling, isolates, state management, CI matrices, platform channels, and the 3.x release cycle."
tagline: "One bookmark for everything Flutter and Dart on this site."
pubDate: 2026-05-10
updatedDate: 2026-09-13
indexTags:
  - "flutter"
  - "dart"
---

This pillar collects every post on the site about **Flutter and Dart** — the 3.x release cycle, Dart isolates, platform channels, state-management migrations, jank profiling, CI workflows, and the long tail of exception fixes.

## What to read first

If you're new here, [profiling jank with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) is the highest-leverage read, and [writing a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) covers the primitive teams reach for too late - pair it with [isolate vs thread](/2026/08/what-is-the-difference-between-a-dart-isolate-and-a-thread/) on why nothing you send is shared. For state management, [Provider vs Riverpod vs Bloc](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) settles the choice first, then [provider to Riverpod](/2026/06/migrate-from-provider-to-riverpod-in-flutter/) walks the common migration; if you're already on it, [Riverpod 2.x to 3.0](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) covers the new major, [Notifier vs AsyncNotifier vs StreamNotifier](/2026/08/riverpod-notifier-vs-asyncnotifier-vs-streamnotifier-in-flutter/) picks the base class, and [ref.watch vs ref.read](/2026/09/ref-watch-vs-ref-read-in-flutter-riverpod/) is the daily call people get wrong in callbacks. For routing, [go-router vs auto_route vs Navigator 2.0](/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/) settles the stack.

For the engine and tooling story, [Flutter 3.47 making Impeller the default desktop renderer](/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) is the newest change; take [the 3.47.1 hotfix](/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/) with it. [Flutter 3.44 splitting Material and Cupertino out of the SDK](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) is still the biggest packaging change in the 3.x cycle; [moving your imports to material_ui and cupertino_ui](/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) is the migration, and [running dart fix across a whole repo](/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) applies it to every package in one pass. On the web, [a stale cached build after reload](/2026/09/fix-flutter-web-serves-a-stale-cached-build-after-reload/) is a caching-header fix.

## What's on this page

The list below auto-collects posts tagged with any of: `flutter`, `dart`. Newest first.
