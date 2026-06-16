---
title: "Migrate a Flutter 2 app to Flutter 3.x: the null safety checklist"
description: "A version-pinned guide to moving a legacy Flutter 2.x app to a current Flutter 3.x release, with the sound null safety migration as the hard gate: why you need a two-hop path through Dart 2.19, what dart migrate does, and what breaks along the way."
pubDate: 2026-06-16
updatedDate: 2026-06-16
template: migration
tags:
  - "migration"
  - "flutter"
  - "flutter-2"
  - "flutter-3"
  - "dart"
  - "null-safety"
---

If you still have a Flutter 2.x app that opted out of sound null safety, you cannot jump straight to a current Flutter 3.x release. Dart 3, which shipped in Flutter 3.10 (May 2023), removed unsound null safety entirely and deleted the `dart migrate` tool, so the upgrade is a two-hop migration: first get the codebase null-safe on Dart 2.19 (Flutter 3.7.x), then bump to the latest Flutter 3.x. Budget a day for a small app and three to five days for a large one with many transitive dependencies. The null safety pass is the gate; everything else (Gradle, iOS minimums, removed widgets) is mechanical once the analyzer is green. This guide pins Flutter 2.10 / Dart 2.16 as the starting point and a current Flutter 3.x line running Dart 3 as the target.

## Why this is a two-step trip, not one

The instinct is to download the newest stable Flutter, run `flutter pub get`, and fix whatever breaks. With an unsound Flutter 2 app that fails immediately, because the tool you need no longer exists in the SDK you are upgrading to.

Sound null safety landed as opt-in in Dart 2.12 (Flutter 2.0, March 2021). For two years a mixed mode let null-safe and legacy libraries coexist. Dart 3 ended that. From the official guide: "In Dart 3, null safety is built in; you cannot turn it off." A library that never migrated produces, at resolve time:

```
Because pkg1 doesn't support null safety, version solving failed.
The lower bound of "sdk: '>=2.9.0 <3.0.0'" must be 2.12.0 or higher to enable null safety.
```

and at runtime, on the old engine, `Library doesn't support null safety`. The `dart migrate` interactive tool that fixes this was removed in Dart 3. Dart 2.19.6 is the final SDK that ships it. So the only supported route is: migrate to null safety while you are still on a Dart 2.x SDK, then upgrade the SDK.

## Why migrate at all in 2026

- Every current package on pub.dev requires a Dart 3 SDK constraint (`sdk: '>=3.0.0 <4.0.0'`). Staying on Flutter 2 freezes you out of new versions of `http`, `provider`, `go_router`, and every Firebase plugin, including their security patches.
- Dart 3 unlocked records, patterns, sealed classes, and class modifiers. None of these compile on a Flutter 2 toolchain.
- Sound null safety is a real correctness win: the compiler proves a `String` is never `null`, so a whole class of `NoSuchMethodError: The method '...' was called on null` crashes becomes impossible to ship. If you have ever chased that one in production, this is the fix at the type-system level.
- Apple and Google store requirements (minimum SDK levels, 64-bit, current build tooling) have moved well past what a Flutter 2 build can satisfy.

## What breaks

Severity is how likely the change is to break a typical app, not how hard the fix is.

| Area | Change | Severity |
| ---- | ------ | -------- |
| Null safety | Unsound mode removed in Dart 3; every line of your code and every dependency must be null-safe | high |
| `dart migrate` tool | Removed in Dart 3; only exists up to Dart 2.19.6 | high |
| SDK constraint | `pubspec.yaml` lower bound must be `2.12.0`, then `3.0.0` | high |
| Dependencies | Any package without a null-safe release blocks the whole resolve | high |
| Removed deprecated widgets | `ThemeData.accentColor`, `textSelectionColor`, `toggleableActiveColor` removed in the 3.0 deprecation sweep | high |
| Android toolchain | Gradle, Android Gradle Plugin, and Kotlin floors all rose; old `build.gradle` fails | high |
| iOS minimum | Minimum deployment target raised to iOS 12; 32-bit armv7 dropped | medium |
| Plugin embedding | Apps still on the v1 Android embedding must move to v2 | medium |

## Pre-flight checklist

Do all of this before touching code:

- Commit a clean baseline and tag it: `git tag pre-flutter3-migration`. You will roll back to this more than once.
- Record your exact current versions: `flutter --version` and `dart --version`. Pin them somewhere so the migration is reproducible.
- Make sure CI builds the app green on the old SDK first. Migrating on top of an already-broken build wastes hours.
- Install a Dart 2.19 / Flutter 3.7.12 toolchain alongside your current one. Use `fvm` (Flutter Version Management) so you can switch per project: `fvm install 3.7.12`.
- Inventory dependencies: `flutter pub deps --no-dev` and note anything unmaintained. A single abandoned package with no null-safe release can stall the entire migration.

## Migration steps

1. **Pin to Flutter 3.7.12 (Dart 2.19) for the migration.** This is the last toolchain that has `dart migrate`. With `fvm`, run `fvm use 3.7.12` in the project, then `fvm flutter --version` to confirm `Dart 2.19.x`. Verify: `fvm flutter pub get` resolves without an SDK error.

2. **Check dependency readiness before migrating your own code.** Run `dart pub outdated --mode=null-safety`. It prints a table showing which packages already have null-safe versions and which do not. Verify: every direct dependency shows a resolvable null-safe version in the "Upgradable" or "Resolvable" column. If one does not, find a replacement or fork it now, before going further.

3. **Upgrade dependencies to their null-safe versions, bottom-up.** Dependencies migrate in order: if C depends on B depends on A, then A must be null-safe first. The tooling handles the ordering when you run `dart pub upgrade --null-safety` followed by `dart pub get`. Verify: `pubspec.lock` now lists null-safe versions and `dart pub get` exits 0.

4. **Run the interactive migration tool on your code.** From the project root, run `dart migrate`. It analyzes the whole package, proposes nullability for every type, and serves a local web UI where you review each inferred `?`, `late`, and `required`. Where it guesses wrong, nudge it with hint markers in your source: `/*?*/` forces nullable, `/*!*/` forces non-nullable, `/*late*/` marks late initialization, `/*required*/` marks a required parameter. Verify: the tool reports zero remaining analysis errors in its summary before you apply.

5. **Apply the migration and bump the SDK constraint.** Click "Apply migration". The tool rewrites your `.dart` files, strips the hint comments, and sets the lower bound in `pubspec.yaml`:

   ```yaml
   # pubspec.yaml -- after the null safety migration, still on Dart 2.19
   environment:
     sdk: '>=2.12.0 <3.0.0'
   ```

   Verify: `dart analyze` reports no errors and `flutter test` passes on Flutter 3.7.12. Commit this as a standalone checkpoint -- you now have a sound, null-safe app that still runs on the old toolchain.

6. **Switch to the current Flutter 3.x toolchain.** Now do the second hop. Run `fvm install stable` and `fvm use stable` (or your pinned target like `3.35.x`). Raise the SDK constraint to Dart 3:

   ```yaml
   # pubspec.yaml -- targeting the current Flutter 3.x / Dart 3 line
   environment:
     sdk: '>=3.0.0 <4.0.0'
     flutter: '>=3.10.0'
   ```

   Run `flutter pub get`. Verify: resolution succeeds. If it fails with "version solving failed", a dependency still lacks a Dart 3 constraint -- run `dart pub outdated` to find it. This same error shows up for plain pubspec mistakes too; see the [version solving failed fix](/2026/05/fix-version-solving-failed-in-pubspec-yaml/) for the full decision tree.

7. **Clear removed-API and deprecation errors with `dart fix`.** Flutter 3.0 deleted APIs that were deprecated in the 2.x line. Run `dart fix --dry-run` to preview, then `dart fix --apply` to auto-rewrite the mechanical ones. The common casualties are theme properties: `ThemeData.accentColor` is gone, which is exactly the [accentColor compile error](/2023/08/flutter-fix-the-getter-accentcolor-isnt-defined-for-the-class-themedata/) that trips up nearly every 2-to-3 upgrade. Verify: `flutter analyze` is clean.

8. **Fix the Android build tooling.** A Flutter 2 `android/` folder almost always has Gradle, AGP, and Kotlin versions too old for the new embedding. Update `android/gradle/wrapper/gradle-wrapper.properties`, `android/build.gradle`, and `android/app/build.gradle` to versions the current Flutter expects (the `flutter create` template for a throwaway app is the reference). Verify: `flutter build apk --debug` succeeds. If you hit an `AndroidX conflict`, the [AndroidX conflict fix](/2026/05/fix-androidx-conflict-during-flutter-android-build/) walks the resolution.

## Verification

Run this smoke test after step 7, on both platforms:

- `flutter analyze` reports zero issues.
- `flutter test` passes with the same count as your pre-migration baseline. A drop means a test file silently failed to compile.
- `flutter build apk --release` and `flutter build ios --release --no-codesign` both succeed.
- Launch on a real device, not just the simulator, and exercise the screens that previously crashed with null errors. Sound null safety should have removed the failure modes outright.
- Diff app startup time and frame timings against the tagged baseline. Dart 3's AOT compiler is generally faster, but check rather than assume.

## Rollback plan

The null safety migration is effectively one-way at the code level: once types carry `?` and `late`, reverting by hand is impractical. That is why step 4 is a standalone commit. If the Dart 3 hop (steps 5 to 7) goes wrong, you do not unwind the null safety work -- you `git reset --hard` back to the step-4 checkpoint, which is a fully working null-safe app on Flutter 3.7.12, and retry the toolchain bump. Keep the `pre-flutter3-migration` tag until the new build has been in production for a release cycle.

## Gotchas we hit

**An abandoned dependency with no null-safe release.** This is the single most common blocker. `dart pub outdated --mode=null-safety` flags it, but the fix is human: replace the package, fork and migrate it yourself, or vendor it. Decide this in the pre-flight, because discovering it mid-migration means backtracking.

**`late` used as a crutch.** The migration tool will happily mark a field `late` to avoid forcing you to provide an initializer. Every `late` is a deferred `LateInitializationError` waiting for a code path that reads before write. Audit each one the tool inserts and prefer a real nullable type or constructor initialization where the lifecycle is not airtight.

**`dynamic` hides nulls from the analyzer.** Null safety only protects statically typed code. Fields and JSON maps typed as `dynamic` still let `null` flow through and crash at the use site. Migrating is the right moment to give your `fromJson` factories real types; a mistyped field there throws `FormatException` or a null crash that the type system cannot catch. If you parse a lot of JSON, tighten those models while you are in here.

**Plugin v1 embedding.** Apps that predate the v2 Android embedding fail to build on current Flutter with a `MainActivity` or `FlutterApplication` error. Regenerate `android/app/src/main/.../MainActivity.kt` from the current template and delete the old `GeneratedPluginRegistrant` references.

**Skipping the intermediate toolchain.** It is tempting to install current Flutter and try to power through. Without `dart migrate`, you are hand-annotating thousands of types from analyzer errors, which is exactly the work the tool automates. Take the two hops.

## Related

- [Fix: version solving failed in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Flutter: the getter accentColor isn't defined for the class ThemeData](/2023/08/flutter-fix-the-getter-accentcolor-isnt-defined-for-the-class-themedata/)
- [Fix: AndroidX conflict during a Flutter Android build](/2026/05/fix-androidx-conflict-during-flutter-android-build/)
- [How to migrate a Flutter app from GetX to Riverpod](/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)
- [Provider vs Riverpod vs Bloc for Flutter state management in 2026](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/)

## Sources

- [Dart 3 migration guide](https://dart.dev/resources/dart-3-migration) -- null safety mandatory in Dart 3, `dart migrate` removed, use Dart 2.19 to migrate first.
- [Migrating to null safety](https://github.com/dart-community/migrate-to-null-safety/blob/main/docs/migrate.md) -- `dart pub outdated --mode=null-safety`, `dart migrate`, hint markers, bottom-up dependency order, Dart 2.19.6 as the final tool-bearing SDK.
- [Flutter breaking changes and migration guides](https://docs.flutter.dev/release/breaking-changes) -- the per-release list of removed and changed APIs.
</content>
</invoke>
