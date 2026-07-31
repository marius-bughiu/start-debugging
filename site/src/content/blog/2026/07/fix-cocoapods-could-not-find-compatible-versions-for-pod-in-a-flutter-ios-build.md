---
title: "Fix: CocoaPods could not find compatible versions for pod during a Flutter iOS build"
description: "Read the second line of the error, not the first. It names the cause: a stale Podfile.lock snapshot, a deployment target that is too low, or two plugins pinning the same transitive pod."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "cocoapods"
---

The fix depends entirely on the line directly under the error, and there are only four possibilities. If it says `In snapshot (Podfile.lock)`, delete `ios/Podfile.lock` and run `pod install`. If it says the specs `required a higher minimum deployment target`, raise `platform :ios` in your `Podfile`. If it lists two plugins each resolving to a different exact version of the same pod, that is a real conflict and you fix it in `pubspec.yaml`, not in the `Podfile`. Only the fourth case, a genuinely stale spec repo, is fixed by `pod repo update`. Running `pod repo update` first, which is what almost everyone does, wastes two minutes on the three cases where it cannot help.

This post is written against Flutter 3.44.7 (stable, July 2026), CocoaPods 1.17.0 (released 6 July 2026), Dart 3.12, and Xcode 16.x on macOS Sequoia.

## The error in context

The most common shape, hit right after a `flutter pub upgrade` that bumped a Firebase plugin:

```text
[!] CocoaPods could not find compatible versions for pod "Firebase/CoreOnly":
  In snapshot (Podfile.lock):
    Firebase/CoreOnly (= 10.28.0)

  In Podfile:
    firebase_core (from `.symlinks/plugins/firebase_core/ios`) was resolved to 3.4.0, which depends on
      Firebase/CoreOnly (= 11.0.0)

You have either:
 * out-of-date source repos which you can update with `pod repo update` or with `pod install --repo-update`.
 * changed the constraints of dependency `Firebase/CoreOnly` inside your development pod `firebase_core`.
   You should run `pod update Firebase/CoreOnly` to apply changes you've made.

Error running pod install
Error launching application on iPhone 16 Pro.
```

The second shape, which looks like the same error but is not:

```text
[!] CocoaPods could not find compatible versions for pod "sqflite_darwin":
  In Podfile:
    sqflite_darwin (from `.symlinks/plugins/sqflite_darwin/darwin`)

Specs satisfying the `sqflite_darwin (from `.symlinks/plugins/sqflite_darwin/darwin`)` dependency were
found, but they required a higher minimum deployment target.
```

Both start with the same headline string, which is why search results for this error are a mess of contradictory advice. They have nothing in common past the first line.

## Why CocoaPods reports this instead of just picking a version

CocoaPods resolves dependencies with Molinillo, a backtracking SAT-style resolver. It is handed a set of constraints and asked to find one version of each pod that satisfies all of them simultaneously. When it exhausts the search space without a solution, it does not guess. It prints the constraints that were still in conflict when it gave up, plus a boilerplate list of things that sometimes cause conflicts.

That boilerplate is generic. It is printed whether or not it applies. The diagnostic content is the indented block above it, which names each constraint and where it came from. Four things put an unsatisfiable constraint into that set:

1. **`Podfile.lock` pins an old exact version.** The lockfile participates in resolution as a constraint labelled `In snapshot (Podfile.lock)`. A plugin upgrade on the Dart side changed what the podspec requires, and the lock still insists on the old number. Most common cause by a wide margin.
2. **Every candidate version needs a higher deployment target than your `Podfile` declares.** Molinillo filters out specs whose `deployment_target` exceeds your platform line, then reports an empty candidate set. This is the `required a higher minimum deployment target` variant.
3. **Two plugins pin incompatible exact versions of a shared transitive pod.** A genuine diamond. No `Podfile` edit resolves it, because the constraint originates in two podspecs that Flutter generated from your `pubspec.yaml`.
4. **The spec repo predates the version being asked for.** Only relevant if you use a git-backed specs repo. The CDN source that Flutter's default `Podfile` uses does not need `pod repo update`.

## Minimal repro

Case 1 reproduces in three commands on any project with a plugin that has a pinned native dependency:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter create podconflict && cd podconflict
flutter pub add firebase_core:3.1.0 && (cd ios && pod install)
flutter pub add firebase_core:3.4.0 && (cd ios && pod install)   # boom
```

The first `pod install` writes `Firebase/CoreOnly (= 11.0.0)` into `ios/Podfile.lock`. The second `flutter pub add` swaps the plugin for one whose podspec requires a different exact version, and the lockfile constraint is now unsatisfiable against the new podspec.

Case 2 reproduces by lowering the platform line below what a plugin needs:

```ruby
# ios/Podfile -- Flutter 3.44.7, CocoaPods 1.17.0
platform :ios, '12.0'
```

with a plugin whose podspec declares:

```ruby
# .symlinks/plugins/sqflite_darwin/darwin/sqflite_darwin.podspec
s.platform = :ios, '13.0'
```

## The fix, ranked

### 1. If the error says `In snapshot (Podfile.lock)`, drop the lock

The lockfile is a cache of a previous resolution, not a source of truth. Flutter regenerates the entire pod graph from `pubspec.lock` on every build, so an `ios/Podfile.lock` that disagrees with it is stale by definition, not authoritative.

```bash
# Flutter 3.44.7, CocoaPods 1.17.0 -- run from the repo root
flutter pub get
cd ios
rm Podfile.lock
pod install
```

Note the ordering. `flutter pub get` has to run first, because it is what rewrites `ios/.symlinks/plugins/` to point at the resolved plugin versions in the pub cache. Running `pod install` before it resolves the podspecs of whatever plugin versions were there last time, which produces the same error with different numbers and sends you in a circle.

If the plugin is one you control or one where you want a targeted change rather than a full re-resolve:

```bash
# CocoaPods 1.17.0 -- surgical alternative, keeps other pins intact
cd ios && pod update Firebase/CoreOnly
```

Prefer deleting the lock in a Flutter app. `pod update <pod>` is the right call in a hand-written iOS project where the lockfile encodes deliberate pins; in a Flutter app the pins came from `pubspec.lock`, and that is where you want them to keep coming from.

### 2. If the error says `higher minimum deployment target`, raise the platform in two places

Both the `Podfile` and the Xcode project need it. Editing only the `Podfile` fixes pod resolution and then fails later at link time, because the `Runner` target's own build setting still declares the old floor.

```ruby
# ios/Podfile -- Flutter 3.44.7
platform :ios, '15.0'
```

```ruby
# ios/Podfile -- force every pod target to inherit the same floor
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
    end
  end
end
```

Then set it on the app target too. Open `ios/Runner.xcworkspace`, select the `Runner` target, `Build Settings`, and set `iOS Deployment Target` to the same value for both Debug and Release. The workspace setting wins over the `Podfile` for `Runner` itself; the `Podfile` line only governs pod targets.

Do not pick the number by trial and error. Read it off the podspec that failed:

```bash
# Flutter 3.44.7 -- print the floor the failing plugin actually declares
grep -r "s.platform\|deployment_target" ios/.symlinks/plugins/sqflite_darwin/darwin/*.podspec
```

Raising the floor drops support for older devices, so raise it to exactly what the podspec needs, not to the newest iOS you have installed.

### 3. If two plugins pin the same pod to different exact versions, fix `pubspec.yaml`

This is the case where every `Podfile` edit and every cache wipe fails, because the conflict is upstream of CocoaPods. The tell is two `was resolved to` lines naming two different plugins:

```text
[!] CocoaPods could not find compatible versions for pod "GTMSessionFetcher/Core":
  In Podfile:
    firebase_auth (from `.symlinks/plugins/firebase_auth/ios`) was resolved to 5.1.0, which depends on
      GTMSessionFetcher/Core (~> 3.3)
    google_sign_in_ios (from `.symlinks/plugins/google_sign_in_ios/darwin`) was resolved to 5.7.6, which depends on
      GTMSessionFetcher/Core (< 3.0, >= 1.1)
```

`~> 3.3` and `< 3.0` have no overlap. Find the plugin versions whose podspecs agree, and pin them in `pubspec.yaml`:

```yaml
# pubspec.yaml -- Flutter 3.44.7, Dart 3.12
dependencies:
  firebase_auth: ^5.1.0
  google_sign_in: ^6.2.2   # 6.2.2 ships google_sign_in_ios 5.7.7+, which allows GTMSessionFetcher 3.x
```

Then re-resolve both layers:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter pub get
cd ios && rm Podfile.lock && pod install
```

You can force a version of a transitive pod from the `Podfile` instead:

```ruby
# ios/Podfile -- last resort, use only to unblock while waiting on a plugin release
pod 'GTMSessionFetcher/Core', '3.4.1'
```

Treat that as a temporary patch with a deadline attached. It overrides a constraint the plugin author wrote deliberately, and it will build cleanly right up until it crashes on a missing selector at runtime.

If `flutter pub get` itself fails before you ever reach CocoaPods, you have a Dart-side resolution problem rather than a native one, and the constraints to read are different: see [why "Version solving failed" is a proof and not a bug](/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

### 4. Only then, update the spec repo

```bash
# CocoaPods 1.17.0
cd ios && pod install --repo-update
```

This helps in exactly one situation: you use a git-backed specs repo (`source 'https://github.com/CocoaPods/Specs.git'` in your `Podfile`) and your local clone predates the version being requested. Flutter's generated `Podfile` uses the CDN source by default, which queries versions over HTTP per pod and is never stale in that sense. If you have not changed the `source` line, `--repo-update` is a no-op that costs you a full specs clone.

## Gotchas and lookalikes

**`flutter clean` does not touch `Podfile.lock`.** It clears `build/` and `.dart_tool/`. `ios/Podfile.lock` and `ios/Pods/` survive it untouched, which is why "I already ran flutter clean" is the most common false lead on this error. The nuclear option that actually clears iOS state:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter clean
cd ios && pod deintegrate && rm -rf Pods Podfile.lock .symlinks
cd .. && flutter pub get
cd ios && pod install
```

**`arch -x86_64 pod install` is obsolete.** That workaround dates to 2021, when the `ffi` gem had no arm64 binary. CocoaPods 1.17.0 on Ruby 3.x runs natively on Apple Silicon. Prefixing `arch -x86_64` today forces a Rosetta Ruby that may not have your gems installed and produces an unrelated failure.

**A plugin that moved to SwiftPM will not appear in the pod graph at all.** Since [Flutter 3.44 made Swift Package Manager the default](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/), plugins shipping a `Package.swift` are resolved by SwiftPM and CocoaPods never sees them. That is usually what makes this error disappear on upgrade. It also means a conflict you are reading about in a 2024 StackOverflow answer may no longer reproduce, and that pinning a pod in your `Podfile` to fix a plugin that has since migrated will silently do nothing. Check which resolver owns a plugin before you patch around it:

```bash
# Flutter 3.44.7 -- if this file exists, the plugin is on SwiftPM, not CocoaPods
ls ios/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage/Package.swift
```

**`Error running pod install` with no constraint block underneath is a different error.** If there is no indented `In Podfile:` section, CocoaPods failed before resolution, usually on a Ruby or Xcode toolchain problem rather than a version conflict. That belongs to [the Xcode 16 iOS build checklist](/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/), not here.

**CI reproducibility.** Committing `ios/Podfile.lock` is the right default, but it makes case 1 fire on CI the first time a teammate bumps a plugin without re-running `pod install` locally. Either enforce that both lockfiles move in the same commit, or pin the toolchain so the failure is at least deterministic: see [targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/). The Android side of the same class of problem is covered in [assembleDebug failing with exit code 1](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

## The deadline worth knowing about

The CocoaPods Trunk specs repo goes permanently read-only on 2 December 2026, with a rehearsal outage from 1 to 7 November 2026. Existing pods keep resolving and the CDN keeps serving, so builds do not break, but no pod will ever publish a new version again. Practically: after that date, case 3 above becomes unfixable by waiting. If two plugins pin incompatible versions of a shared pod and neither ships a corrected podspec before December, no upstream release will arrive to rescue you, and the only exits are a `Podfile` override or moving the plugin to SwiftPM. Both worth budgeting for now rather than in Q1.

## Sources

- [CocoaPods Trunk read-only plan](https://blog.cocoapods.org/CocoaPods-Specs-Repo/) (CocoaPods blog)
- [Swift Package Manager for Flutter app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers) (docs.flutter.dev)
- [Flutter release notes](https://docs.flutter.dev/release/release-notes) (docs.flutter.dev)
- [CocoaPods releases](https://github.com/CocoaPods/CocoaPods/releases) (CocoaPods/CocoaPods)
- [flutter/flutter#168660: could not find compatible versions for pod Firebase/CoreOnly](https://github.com/flutter/flutter/issues/168660) (flutter/flutter)
- [flutter/flutter#148116: could not find compatible versions for pod GTMSessionFetcher/Core](https://github.com/flutter/flutter/issues/148116) (flutter/flutter)
