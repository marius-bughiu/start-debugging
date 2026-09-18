---
title: "Raise a Flutter macOS app's minimum deployment target to macOS 12 for Xcode 27"
description: "Xcode 27 refuses to build anything below macOS 12, and Flutter 3.47 moved its own floor from 10.15 to 12.0. What the automatic migration rewrites, the three places it silently skips (custom values, Podfile post_install overrides, plugin podspecs), and a Podfile fix for teams still on Flutter 3.44."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "macos"
  - "xcode"
  - "cocoapods"
---

For most Flutter macOS apps this is a five-minute job: upgrade to Flutter 3.47 or later (3.47.4 is the current stable, Dart 3.13.3), run `flutter build macos` once, and commit the three lines the tool rewrites in `macos/Runner.xcodeproj/project.pbxproj` plus the `platform :osx` line in `macos/Podfile`. The migration only recognizes the exact stock values Flutter has ever generated (10.11, 10.13, 10.14, 10.15, 11.0), so a project someone hand-edited to `11.5` or `10.14.6`, a Podfile `post_install` block that pins pods to an old version, or a stale plugin podspec will survive it and then fail on Xcode 27 with `The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to ..., but the range of supported deployment target versions is 12.0 to 27.0.x`. Everything below was verified on a Mac with Xcode 26.6, Flutter 3.44.8 and 3.47.4, and CocoaPods 1.17.0.

## Why the floor moved

Apple raised the lowest macOS deployment target in Xcode 27 from macOS 11 to macOS 12 (iOS stays at 15, watchOS goes from 8 to 9). Xcode 27 reached general availability in mid-September 2026, so CI images and developer machines are switching over right now. Below the floor, Xcode 27 does not warn and clamp the way earlier versions did: it stops the build with a target-integrity error.

Flutter's policy is to [match the deployment range of the current Xcode](https://flutter.dev/go/match-xcode-deployment-range), so the team filed [flutter/flutter#187762](https://github.com/flutter/flutter/issues/187762) and landed [flutter/flutter#188520](https://github.com/flutter/flutter/pull/188520) (merged 2026-06-29), which ships in 3.47.0. It does three things:

- `FlutterDarwinPlatform.macos.deploymentTarget()` in `flutter_tools` now returns `12.0` instead of `10.15`. That value drives the SwiftPM generated package, the plugin templates, and the podspec for `FlutterMacOS`.
- The engine's `FlutterMacOS.framework` is built for macOS 12. In my 3.44.8 build its `LC_BUILD_VERSION` says `minos 11.0`; in the 3.47.4 build it says `minos 12.0`.
- `MacOSDeploymentTargetMigration` and `podhelper.rb` were updated to move existing projects to `12.0`.

The second point matters even if you never install Xcode 27. A Flutter 3.47 app that still claims to support macOS 11 is making a promise the engine binary cannot keep.

## What breaks

| Area | Change | Severity |
| ---- | ------ | -------- |
| `MACOSX_DEPLOYMENT_TARGET` below 12.0 in `Runner` | Build error on Xcode 27 | high, auto-migrated for stock values |
| `platform :osx` below 12.0 in `macos/Podfile` | Pods build for the old version, error on Xcode 27 | high, auto-migrated for stock values |
| Podfile `post_install` that sets `MACOSX_DEPLOYMENT_TARGET` on pods | Overrides survive the migration, error on Xcode 27 | high, manual fix |
| Plugin podspec or `Package.swift` declaring below 12.0 | Handled by `podhelper.rb` (3.47+) and the generated SwiftPM package | low for app authors, cleanup for plugin authors |
| Users on macOS 10.15 and 11 | Cannot install new builds (`LSMinimumSystemVersion` becomes 12.0) | product decision |

The last row is the only one that is not a build problem. `macos/Runner/Info.plist` sets `LSMinimumSystemVersion` to `$(MACOSX_DEPLOYMENT_TARGET)`, so the moment the build setting moves, the App Store and Sparkle-style updaters stop offering your new version to Catalina and Big Sur machines. Check your analytics before you ship, and tell support.

## Pre-flight checklist

- Flutter 3.47.0 or later on every machine and CI runner that builds the macOS target. `flutter --version` should print `3.47.x` or newer.
- A clean working tree in `macos/`, so the migration diff is reviewable on its own.
- CocoaPods 1.16 or later if you are still on CocoaPods for macOS plugins (1.17.0 was used here).
- A list of every place your repo sets a macOS version. This one-liner finds them:

```bash
# Flutter 3.47.4, run from the project root
grep -rnE "MACOSX_DEPLOYMENT_TARGET|platform :osx|osx.deployment_target|\.macOS\(" \
  macos/ --include='*.pbxproj' --include='Podfile' --include='*.xcconfig' \
  --include='*.podspec' --include='Package.swift'
```

## Migration steps

1. Upgrade the SDK with `flutter upgrade` (or pin 3.47.4 in your FVM or CI config), then run `flutter clean`. Verify with `flutter --version` that the tool reports 3.47.x or newer.
2. Run `flutter build macos --debug` once. The tool runs `MacOSDeploymentTargetMigration` before `pod install` and prints `Updating minimum macOS deployment target to 12.0.` exactly once. Verify with `git diff --stat macos/` that `project.pbxproj` and `Podfile` changed.
3. Re-run the grep from the pre-flight checklist and confirm that nothing below 12.0 is left in `Runner`, `RunnerTests`, any extra targets, `.xcconfig` files, or the Podfile. Fix anything the migration skipped by hand (details below).
4. Remove or update any Podfile `post_install` block that writes `MACOSX_DEPLOYMENT_TARGET` on pod targets, then run `flutter build macos --debug` again. Verify with `grep MACOSX_DEPLOYMENT_TARGET macos/Pods/Pods.xcodeproj/project.pbxproj | sort | uniq -c` that every entry is 12.0 or higher.
5. Check the shipped binary: `plutil -p` on the built app's `Contents/Info.plist` should show `LSMinimumSystemVersion => 12.0`, and `otool -l` on the executable should show `minos 12.0`.
6. Switch CI to an Xcode 27 image and run a release build (`flutter build macos --release`). This is the only step that proves the project builds on Xcode 27.

## What the migration actually rewrites

On a project created by Flutter 3.44.8 (which generates 10.15 everywhere), with `url_launcher` added and CocoaPods enabled, the first 3.47.4 build printed the status line and produced exactly this diff in the two files it owns:

```diff
# macos/Podfile (Flutter 3.47.4 migration)
-platform :osx, '10.15'
+platform :osx, '12.0'

# macos/Runner.xcodeproj/project.pbxproj (Debug, Release, Profile)
-				MACOSX_DEPLOYMENT_TARGET = 10.15;
+				MACOSX_DEPLOYMENT_TARGET = 12.0;
```

The build then succeeded and every `MACOSX_DEPLOYMENT_TARGET` in `Pods.xcodeproj` was 12.0, even though `url_launcher_macos` 3.2.6 still declares `s.platform = :osx, '10.15'` in its podspec. That is `podhelper.rb` at work: `flutter_additional_macos_build_settings` deletes the pod's own deployment target when its major version is below 12, so the pod inherits the Podfile's platform instead. Before 3.47 the cutoff was 10.15, so a pod declaring 10.15 kept its value, which is what makes Flutter 3.44 projects fail on Xcode 27 even after you edit the Runner target (see the last section).

With SwiftPM (the default since Flutter 3.44 for projects without the opt-out), the migration also moves the Runner target, and the tool regenerates `macos/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage/Package.swift` from the Runner's `MACOSX_DEPLOYMENT_TARGET`. In my run it went from `.macOS("10.15")` to `.macOS("12.0")` on the first 3.47.4 build. The `Package.swift` inside `url_launcher_macos` still says `.macOS("10.15")`; on Xcode 26.6 that built cleanly. I could not run Xcode 27 on this machine, so I have not verified that plugin manifests below 12.0 build cleanly there too.

## Gotcha 1: a hand-edited version is invisible to the migration

The migrator is a line-based string replace. From `macos_deployment_target_migration.dart` at the `3.47.4` tag, it looks for these literal strings and nothing else:

```dart
// flutter_tools 3.47.4, lib/src/macos/migrations/macos_deployment_target_migration.dart
const deploymentTargetOriginal1015 = 'MACOSX_DEPLOYMENT_TARGET = 10.15;';
const deploymentTargetOriginal110 = 'MACOSX_DEPLOYMENT_TARGET = 11.0;';
const podfilePlatformVersionOriginal1015 = "platform :osx, '10.15'";
const podfilePlatformVersionOriginal110 = "platform :osx, '11.0'";
// ...plus 10.11, 10.13 and 10.14 in both forms
```

So `11.5`, `10.14.6`, `11.0.1`, a value set in an `.xcconfig`, or `platform :osx, "10.15"` with double quotes are all left alone, with no message. I set the Runner target and Podfile to 11.5 and built with 3.47.4. There was no `Updating minimum macOS deployment target` line, `git status` showed no changes to either file, and the build still succeeded on Xcode 26.6, with linker warnings that are easy to scroll past:

```text
ld: warning: building for macOS-11.5, but linking with dylib
'@rpath/FlutterMacOS.framework/Versions/A/FlutterMacOS' which was built for newer version 12.0
```

The resulting app has `LSMinimumSystemVersion` 11.5 and `minos 11.5` while shipping an engine built for 12.0. On Xcode 27 the same project fails outright. The fix is to set the value by hand in Xcode (Runner project, Runner target, General, Minimum Deployments) or in the file:

```bash
# Flutter 3.47.4 project, replace any leftover value below 12.0
sed -i '' -E 's/MACOSX_DEPLOYMENT_TARGET = (10\.[0-9.]+|11\.[0-9.]+);/MACOSX_DEPLOYMENT_TARGET = 12.0;/' \
  macos/Runner.xcodeproj/project.pbxproj
sed -i '' -E "s/platform :osx, ['\"][0-9.]+['\"]/platform :osx, '12.0'/" macos/Podfile
```

Raising the Podfile platform matters as much as the Runner target. When I left the Runner at 10.14.6 and the Podfile at 11.5, even Xcode 26.6 stopped with `compiling for macOS 10.14.6, but module 'url_launcher_macos' has a minimum deployment target of macOS 11.5` in `GeneratedPluginRegistrant.swift`. Keep the two in lockstep.

## Gotcha 2: Podfile post_install overrides survive

A common copy-paste from the Xcode 14 era forces every pod to one version:

```ruby
# macos/Podfile, a pattern that breaks on Xcode 27
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_macos_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['MACOSX_DEPLOYMENT_TARGET'] = '10.14'
    end
  end
end
```

The migration touched the `platform :osx` line of that Podfile and printed its status message, so it looks done. After the build, `Pods.xcodeproj` contained 15 `MACOSX_DEPLOYMENT_TARGET = 10.14;` entries and only 3 at 12.0: the override runs after `flutter_additional_macos_build_settings` and wins. Xcode 26.6 quietly built those pods for macOS 11.0 (its own floor), which is why nobody notices. Xcode 27 errors on each of them instead.

Delete the inner loop. If a pod really does need a pinned version, pin it to `12.0` or higher, never lower than the Podfile's platform.

## Gotcha 3: the guided error only exists from 3.47

When Xcode rejects the target, Flutter 3.47 recognizes the line (the matching logic came in [flutter/flutter#188812](https://github.com/flutter/flutter/pull/188812), from [flutter/flutter#187855](https://github.com/flutter/flutter/issues/187855)) and prints a boxed message:

```text
The macOS deployment target is too low. Xcode requires at least 12.0.

To upgrade your macOS deployment target, follow these steps:
  1. Open the project in Xcode:
     open macos/Runner.xcworkspace
  2. Select the "Runner" project in the project navigator.
  3. Select the "Runner" TARGET, and in the "General" tab:
     Update "Minimum Deployments" to at least 12.0.
```

Two caveats. The message only fires when the failing line mentions `MACOSX_DEPLOYMENT_TARGET` and the supported range, and the advice only covers the Runner target, so for a pod target failure (Gotcha 2) the fix it suggests is not the fix you need. And Flutter 3.44 and earlier have no such handling: you get `Build process failed` plus the raw Xcode line, which in the test fixtures for that PR reads `error: The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to 10.11, but the range of supported deployment target versions is 12.0 to 27.0.x. (in target 'Runner' from project 'Runner')`. The `(in target '...')` suffix tells you which target to fix.

## Staying on Flutter 3.44 with Xcode 27

Sometimes you cannot take a Flutter upgrade this week, but your CI image already moved to Xcode 27. You can bump the project by hand, but 3.44's `podhelper.rb` only strips pod deployment targets below 10.15, so pods that declare 10.15 through 11.x keep their values. On a 3.44.8 project with the Runner and Podfile edited to 12.0, `Pods.xcodeproj` still had 9 entries at `10.15`. This `post_install` addition removed them all, leaving every pod at the inherited 12.0:

```ruby
# macos/Podfile, Flutter 3.44.x workaround for Xcode 27
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_macos_build_settings(target)
    target.build_configurations.each do |config|
      pod_target = config.build_settings['MACOSX_DEPLOYMENT_TARGET']
      if pod_target && Gem::Version.new(pod_target) < Gem::Version.new('12.0')
        config.build_settings.delete 'MACOSX_DEPLOYMENT_TARGET'
      end
    end
  end
end
```

Deleting rather than overwriting is the same trick Flutter 3.47 uses: the pod inherits the higher value from the project, and a pod that genuinely requires something newer than 12.0 keeps its own requirement. The engine framework in 3.44 is built for macOS 11, so this does not change what your binary can run on, it only satisfies Xcode 27. Remove the block once you are on 3.47, since it becomes redundant.

## For plugin authors

If you publish a macOS plugin, bump the podspec (`s.platform = :osx, '12.0'` or `s.osx.deployment_target = '12.0'`) and the `Package.swift` platform (`.macOS("12.0")`) in your next release, and raise your `environment: flutter:` constraint to `>=3.47.0` if you rely on anything from that release. Apps on 3.47 are already protected by `podhelper.rb`, so this is hygiene rather than an emergency, but it stops your plugin from showing up in someone's `grep` as a false positive, and the 3.47 plugin templates generate 12.0 anyway.

## Verification

- `flutter build macos --release` succeeds on an Xcode 27 runner.
- `grep -rn MACOSX_DEPLOYMENT_TARGET macos/ --include='*.pbxproj' --include='*.xcconfig'` shows nothing below 12.0, including `macos/Pods/Pods.xcodeproj/project.pbxproj`.
- `plutil -p build/macos/Build/Products/Release/<App>.app/Contents/Info.plist | grep LSMinimumSystemVersion` prints `12.0`.
- The build log has no `building for macOS-11.x, but linking with dylib ... built for newer version 12.0` warnings.
- The app launches on the oldest macOS you still test on (12.x if you have a machine or VM for it).

## Rollback plan

The source change is reversible with `git revert`, but the Flutter SDK is not: on 3.47 and later the engine is built for macOS 12, and the tool will re-run the migration on the next build whenever it sees a stock value below 12.0. Going back to supporting macOS 10.15 or 11 means staying on Flutter 3.44.x and Xcode 26, which Apple will stop accepting for App Store submissions once it requires the macOS 27 SDK. Treat this as one-way, and make the macOS 11 support decision explicitly before merging.

## Related

- The Android side of the same 3.47 upgrade: [migrating a Flutter Android project to AGP 9 with built-in Kotlin](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/).
- What else changed for desktop in that release: [Flutter 3.47 makes Impeller the default renderer on desktop](/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).
- Why your project might be on SwiftPM without you choosing it: [Flutter 3.44 defaults to SwiftPM](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- When the Podfile problem is version resolution rather than deployment targets: [fixing "CocoaPods could not find compatible versions for pod"](/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).
- The previous round of this on iOS: [fixing "Failed to build iOS app" with Xcode 16 and Flutter 3.x](/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/).

## Sources

- [flutter/flutter#187762: Increase macOS minimum supported version from 10.15 to 12 to support Xcode 27](https://github.com/flutter/flutter/issues/187762)
- [flutter/flutter#188520: the SDK, template, podhelper and migration change](https://github.com/flutter/flutter/pull/188520)
- [flutter/flutter#188812: guided message when the minimum version is too low](https://github.com/flutter/flutter/pull/188812)
- [`macos_deployment_target_migration.dart` at 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/macos/migrations/macos_deployment_target_migration.dart)
- [`podhelper.rb` at 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/bin/podhelper.rb)
- [Flutter 3.47.0 release notes](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)
- [Xcode 27 release notes](https://developer.apple.com/go/?id=xcode-27-sdk-rn)
