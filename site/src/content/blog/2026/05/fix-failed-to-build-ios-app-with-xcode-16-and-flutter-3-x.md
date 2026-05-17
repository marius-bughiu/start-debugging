---
title: "Fix: Failed to build iOS app with Xcode 16 and Flutter 3.x"
description: "The fix in 60 seconds: upgrade Flutter to 3.24.4 or later, raise the Podfile platform to iOS 13, wipe Pods plus DerivedData, then pod install. The error rarely lives in your Dart code."
pubDate: 2026-05-17
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "xcode"
  - "cocoapods"
---

The fix in one breath: `Failed to build iOS app` after upgrading to Xcode 16 is almost never your Dart code. It is one of four things, in this order of frequency: a Flutter SDK older than 3.24.4 that does not know about Xcode 16's new module verifier, a `Podfile` that still pins `platform :ios, '11.0'` (Xcode 16 dropped iOS 11 simulator support), a stale `ios/Pods` and `~/Library/Developer/Xcode/DerivedData/ModuleCache.noindex` cache from the previous Xcode, or a plugin that has not shipped a Swift 6 / Xcode 16 compatible release yet. Upgrade Flutter, raise the Podfile to iOS 13, nuke both caches, `pod install`, rebuild. Stop reaching for `flutter clean` as step one; it does not touch the iOS caches that are actually broken.

```text
Launching lib/main.dart on iPhone 16 Pro in debug mode...
Running Xcode build...
Xcode build done.                                           38.4s
Failed to build iOS app
Error (Xcode): Swift Compiler Error (Xcode): No such module 'Flutter'
/Users/me/MyApp/ios/Runner/AppDelegate.swift:2:8

Could not build the application for the simulator.
Error launching application on iPhone 16 Pro.
```

This guide is written against Flutter 3.41.5 (stable channel, May 2026), the Xcode 16.x line (16.0 through 16.4 at time of writing), CocoaPods 1.16.2, and macOS Sequoia 15.3 on Apple Silicon. The same fixes apply to Flutter 3.24.4 and later; if you are on Flutter 3.19 or older, see the upgrade step first because no amount of pod-fiddling will save you on that branch. The relevant Flutter changes that made Xcode 16 work cleanly landed in [flutter/flutter#155438](https://github.com/flutter/flutter/issues/155438) and the follow-up modulemap fixes in [flutter/flutter#157461](https://github.com/flutter/flutter/issues/157461).

## What `Failed to build iOS app` actually tells you

`Failed to build iOS app` is the Flutter tool's umbrella message. It only means "xcodebuild returned a non-zero exit code". The real diagnostic is the line directly above or below it, prefixed with `Error (Xcode):`. There are roughly six distinct underlying errors that all surface under this same umbrella:

1. `No such module 'Flutter'` -- the Swift compiler cannot find the Flutter framework module. Almost always a Podfile or pod-install problem after the Xcode 16 upgrade.
2. `no such file or directory: '.../ModuleCache.noindex/Session.modulevalidation'` -- Xcode 16's new module verifier cannot read a cache file written by Xcode 15. See [issue #157461](https://github.com/flutter/flutter/issues/157461).
3. `Using bridging headers with module interfaces is unsupported` -- a plugin's `module.modulemap` plus bridging header pattern that worked in Xcode 15 is now a hard error.
4. `type 'UIApplication' does not conform to protocol 'Launcher'` -- a Swift 6 strict-conformance error in an out-of-date plugin (commonly `url_launcher_ios` before 6.3.0).
5. `Undefined symbol: _swift_FORCE_LOAD$_swiftCompatibility56` -- Swift runtime ABI mismatch, almost always a CocoaPods cache from a previous Xcode SDK.
6. `The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 11.0, but the range of supported deployment target versions is 12.0 to 18.4` -- your `Podfile` still pins iOS 11, which Xcode 16 dropped.

Each of these is a different bug with a different root cause. The first job is identifying which one the tool actually hit. Scroll up in the terminal until you find the `error:` line that has a file path and a line number. That is the truth; `Failed to build iOS app` is the symptom.

## Reading the actual error from `flutter build`

Run with verbose logging so the underlying `xcodebuild` output is not summarised away:

```bash
# Flutter 3.41.5
flutter build ios --verbose 2>&1 | tee build.log
```

Then search the log for the first `error:` (lowercase, that is the Xcode prefix), not `Error (Xcode)` (which is Flutter's reformat):

```bash
grep -n "error:" build.log | head -20
```

The first match is the one to fix. Subsequent errors are usually cascades from the first. If you do not have the verbose output, you are guessing.

## A minimal repro that demonstrates one of the common forms

The most common shape in 2026 is the `Podfile` platform pin combined with a stale `Pods` directory. Create a fresh Flutter project and pin the iOS deployment target to 11.0:

```ruby
# ios/Podfile, Flutter 3.41.5, CocoaPods 1.16.2
platform :ios, '11.0'

# CocoaPods analytics sends network stats synchronously affecting flutter build latency.
ENV['COCOAPODS_DISABLE_STATS'] = 'true'

project 'Runner', {
  'Debug' => :debug,
  'Profile' => :release,
  'Release' => :release,
}

# ... rest of the default Podfile ...
```

Run `flutter build ios --no-codesign` under Xcode 16 and the build fails with:

```text
[!] Automatically assigning platform `iOS` with version `11.0` on target `Runner`
    because no platform was specified. Please specify a platform for this target
    in your Podfile.
...
error: The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 11.0,
       but the range of supported deployment target versions is 12.0 to 18.4.
       (in target 'firebase_core' from project 'Pods')
Failed to build iOS app
```

Same Podfile under Xcode 15.4 builds without complaint. The bug is the new deployment target floor in Xcode 16, not your code.

## Fix, in order of how often it is the answer

Apply these in order. Each step assumes the previous one did not work.

### 1. Upgrade Flutter to 3.24.4 or later

Flutter 3.24.4 (October 2024) is the first stable release that ships the Xcode 16 fixes for `xcode_backend.sh` and the Generated.xcconfig template. Any release on the 3.41.x line in 2026 is current. Check what you have and upgrade:

```bash
flutter --version
flutter upgrade
```

If `flutter upgrade` refuses because your channel is on `master` or you have local engine modifications, switch back to `stable`:

```bash
flutter channel stable
flutter upgrade
```

This single step resolves the majority of `No such module 'Flutter'` reports filed against Xcode 16 in 2024 and 2025. The Flutter team closed [issue #155438](https://github.com/flutter/flutter/issues/155438) as fixed in 3.24.4 for exactly this reason.

### 2. Raise the Podfile platform to iOS 13

Xcode 16 still supports iOS 12 as a deployment target, but most modern plugins (Firebase, Google Maps, anything that touches SwiftUI) now require iOS 13. Setting iOS 13 as your floor is the safe default in 2026:

```ruby
# ios/Podfile, Flutter 3.41.5
platform :ios, '13.0'
```

You also need to mirror this in the runner project. Open `ios/Runner.xcworkspace`, select the `Runner` target, go to `Build Settings`, and set `iOS Deployment Target` to `13.0` for both debug and release. The build settings in the workspace win over `Podfile` for the Runner target itself; the `Podfile` line only affects pod targets.

If you have a `post_install` block in the Podfile, force every pod to inherit the same minimum (this is the snippet from the modern Flutter template):

```ruby
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
    end
  end
end
```

### 3. Wipe Pods, the lockfile, and the module cache

This is the step that fixes the `ModuleCache.noindex` error and most of the `Undefined symbol: _swift_FORCE_LOAD$_swiftCompatibility56` reports. The Swift ABI cache from your previous Xcode is incompatible with Xcode 16's `swiftc`, and `flutter clean` does not touch it. From the project root:

```bash
# Flutter 3.41.5, CocoaPods 1.16.2
flutter clean
cd ios
rm -rf Pods Podfile.lock .symlinks
rm -rf ~/Library/Developer/Xcode/DerivedData
pod cache clean --all
pod install --repo-update
cd ..
flutter pub get
```

`pod install --repo-update` (note: not `pod install` alone) refreshes the CocoaPods specs repo so you pick up any plugin podspecs published since you last built. Skip this and you will install yesterday's `firebase_core.podspec` that still pins iOS 11.

### 4. Update plugins, especially the ones in the error

If the error is `type 'UIApplication' does not conform to protocol 'Launcher'`, the plugin is out of date. The two most common offenders are `url_launcher_ios` and `webview_flutter_wkwebview`. Bump to the latest minor:

```bash
flutter pub upgrade --major-versions
```

If you cannot do a blanket upgrade because some dependency pins, upgrade just the plugin named in the error:

```bash
flutter pub upgrade --major-versions url_launcher_ios
```

Then redo step 3 (Pods are cached by version; a `pubspec.yaml` change does not re-run `pod install` automatically). For a deeper guide on reading the `pubspec` resolver's complaints if `pub upgrade` itself fails, see [why "Version solving failed" is a proof not a bug](/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

### 5. Force a single Swift version across pods

A subset of build failures come from pods that did not declare a `SWIFT_VERSION`, which under Xcode 16 defaults to Swift 6 strict mode and then explodes on perfectly legal Swift 5 code. The fix is to clamp every pod to Swift 5 in the same `post_install` block:

```ruby
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
      config.build_settings['SWIFT_VERSION'] = '5.0'
    end
  end
end
```

This is a workaround, not a fix. The correct long-term solution is to file an issue against the plugin so it declares its own Swift version, but the clamp will unblock you today.

### 6. Delete and regenerate `ios/Runner.xcodeproj` settings only as a last resort

If you have hand-edited the `project.pbxproj` (added native targets, custom build phases, App Clip extensions) and none of the above worked, the Runner target may have stale build settings that pre-date Xcode 16. Back up `ios/Runner.xcodeproj`, then diff it against a freshly generated one:

```bash
# Flutter 3.41.5
flutter create --platforms=ios --project-name=runner /tmp/scratch
diff -r ios/Runner.xcodeproj /tmp/scratch/ios/Runner.xcodeproj
```

Port the relevant build settings (`IPHONEOS_DEPLOYMENT_TARGET`, `SWIFT_VERSION`, `ENABLE_USER_SCRIPT_SANDBOXING`, `STRING_CATALOG_GENERATE_SYMBOLS`) from the scratch project into yours, one at a time, rebuilding between each. This is tedious but it is also the only reliable way to recover a project that has accumulated five years of Xcode upgrade detritus.

## Gotchas and lookalikes

A handful of cases that look like this error but are not:

- **`Sandbox: rsync deny file-write-create`**: Xcode 16 enabled `ENABLE_USER_SCRIPT_SANDBOXING=YES` by default for new projects. Flutter's `xcode_backend.sh` writes outside the sandbox. Set `ENABLE_USER_SCRIPT_SANDBOXING=NO` in the Runner target Build Settings. The Flutter installer template since 3.24.4 sets this, but projects created earlier do not.
- **`Provisioning profile doesn't include the currently selected device`**: not a Flutter build failure at all. The native binary built fine; the install step failed. See [Provisioning profile doesn't include the currently selected device](/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) -- the MAUI write covers the same Apple-side root cause.
- **`Unable to find a valid iOS Simulator runtime`**: Xcode 15 stopped bundling Simulator runtimes; Xcode 16 still does not bundle them. Run `xcodebuild -downloadPlatform iOS`. The detailed write-up is at [Unable to find a valid iOS Simulator runtime during MAUI build](/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/) and applies identically to Flutter.
- **`Xcode 26 update -- Clang dependency scanning failure: module 'Flutter' not found`**: this is the Xcode 26 (developer preview) variant tracked in [flutter/flutter#185210](https://github.com/flutter/flutter/issues/185210). Do not ship release builds against Xcode 26 yet; stay on the 16.x line until Flutter publishes a compatibility note.
- **CI fails but local builds pass**: your CI is on an older Xcode image. GitHub Actions `macos-14` ships Xcode 15.4; you need `macos-15` (or explicitly `macos-15-large`) for Xcode 16. Pin the runner image and select the Xcode version with `sudo xcode-select -s /Applications/Xcode_16.app`. If you are juggling multiple Flutter versions in CI as well, the [matrix pattern for Flutter on subosito/flutter-action](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) shows how to keep the build green across versions.
- **`No such module 'Flutter'` only in a watchOS target or App Clip**: the Flutter framework is not embedded in companion targets by default. You have to add a Run Script phase that copies `Flutter.framework` into the embedded binaries, or use [add-to-app](https://docs.flutter.dev/add-to-app/ios/project-setup) project setup. This is documented in [flutter/flutter#164597](https://github.com/flutter/flutter/issues/164597) for the Apple Watch case.
- **`flutter clean` deleted the `ios/Flutter/Generated.xcconfig` and now nothing builds**: this is expected. Run `flutter pub get` to regenerate it. If `flutter pub get` succeeds but the file is not regenerated, your `pubspec.yaml` does not declare iOS as a platform; add `flutter:` `plugin:` `platforms:` `ios:` or run `flutter create --platforms=ios .`.

If you have iterated through steps 1-5 twice and still see the same error, the next move is to bisect plugins. Comment every direct dependency in `pubspec.yaml` except `flutter` and `cupertino_icons`, run the wipe-and-build cycle, and confirm the empty project builds. Then uncomment dependencies in groups of three. The first group that reintroduces the failure contains the offending plugin. This is slow but it is deterministic and it gives you a filing-ready bug report.

## Related

- [Fix: Version solving failed in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Fix: Provisioning profile doesn't include the currently selected device (MAUI iOS)](/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/)
- [Fix: Unable to find a valid iOS Simulator runtime during MAUI build](/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/)
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Debugging Flutter iOS from Windows: a real-device workflow](/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/)

## Sources

- [flutter/flutter#155438: After updating to xCode 16, Failed to build iOS app in Flutter 3.19.5](https://github.com/flutter/flutter/issues/155438)
- [flutter/flutter#157461: Xcode 16 and iOS 18 project not compiling: ModuleCache.noindex error](https://github.com/flutter/flutter/issues/157461)
- [flutter/flutter#155873: No such module 'Flutter' after updating to Xcode 16](https://github.com/flutter/flutter/issues/155873)
- [flutter/flutter#164597: Flutter 3.29.0 + Xcode 16 build failure with Apple Watch target](https://github.com/flutter/flutter/issues/164597)
- [flutter/flutter#185210: Xcode 26 update -- Clang dependency scanning failure](https://github.com/flutter/flutter/issues/185210)
- [Flutter add-to-app iOS project setup](https://docs.flutter.dev/add-to-app/ios/project-setup) (docs.flutter.dev)
- [CocoaPods 1.16.x changelog](https://github.com/CocoaPods/CocoaPods/releases) (CocoaPods/CocoaPods)
