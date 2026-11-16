---
title: "Fix: Framework 'Pods_Runner' not found when building a Flutter app for the iOS simulator"
description: "A pod without an arm64 simulator slice (MLKit is the usual one) makes Xcode skip the Pods-Runner target. Upgrade to Flutter 3.41.4+, build twice after pod changes, then use a Rosetta simulator or a device."
pubDate: 2026-11-16
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "xcode"
  - "cocoapods"
---

If `Framework 'Pods_Runner' not found` appears only for the simulator, and a device build still works, the cause is almost always a CocoaPods dependency that excludes arm64 for the simulator. Google ML Kit is the usual one. Clearing caches will not fix it. Upgrade Flutter to 3.41.4 or later. After any change to your pods, run the simulator build twice. Then run the app on a physical device or on a universal (Rosetta) simulator runtime, because an iOS 26+ arm64-only simulator cannot run an x86_64 build. On Flutter 3.41.0 to 3.41.3, add `EXCLUDED_ARCHS[sdk=iphonesimulator*]=i386 arm64` to `ios/Flutter/Debug.xcconfig`.

Everything below was reproduced on an Apple Silicon Mac with Flutter 3.44.8 (stable), Dart 3.12.2, Xcode 27.2 (27B52), CocoaPods 1.17.0, and the iOS 26.5, 27.0, and 27.1 simulator runtimes. The Flutter 3.41.0 to 3.41.3 behaviour was reproduced by giving `Generated.xcconfig` the value those versions write and running the same `xcodebuild` command Flutter runs. No 3.41.x SDK was installed for this post. The section on the minimal repro explains how.

## The error in context

`flutter run` or `flutter build ios --simulator` fails at the link step of the `Runner` target:

```
Running Xcode build...
Xcode build done.                                           23.6s
Failed to build iOS app
Error (Xcode): Framework 'Pods_Runner' not found
/path/to/app/ios/Runner.xcodeproj
Error (Xcode): Linker command failed with exit code 1 (use -v to see invocation)
/path/to/app/ios/Runner.xcodeproj
Encountered error while building for simulator.
```

The raw `xcodebuild` log names the same thing as a linker error, `ld: framework 'Pods_Runner' not found`. The symptoms match the [Stack Overflow question](https://stackoverflow.com/questions/79891589) and [flutter/flutter#182748](https://github.com/flutter/flutter/issues/182748). The device build is fine. A brand-new `flutter create` app builds until you add the same dependencies. And `Pods_Runner.framework` never shows up in the build output, even though `Pods.xcodeproj` has a `Pods-Runner` target and `Runner` links against it. That last point matters most: the framework is not misplaced. Xcode never builds it.

A related error, `Building for 'iOS-simulator', but linking in object file (.../MLImage.framework/MLImage[arm64]...) built for 'iOS'`, has the same cause. The linker reached a vendored framework before it noticed `Pods_Runner` was missing.

## Why Xcode never builds Pods-Runner

Some binary SDKs ship a `.framework` with an arm64 slice for devices and an x86_64 slice for the simulator. They have no arm64 slice for the simulator. They tell CocoaPods about it in their podspec. [MLKitCommon 10.0.0](https://github.com/CocoaPods/Specs/blob/f6cec04c121c5489fd157d6b34e6e4f546723764/Specs/c/c/6/MLKitCommon/10.0.0/MLKitCommon.podspec.json) declares:

```json
"pod_target_xcconfig":  { "EXCLUDED_ARCHS[sdk=iphonesimulator*]": "arm64" },
"user_target_xcconfig": { "EXCLUDED_ARCHS[sdk=iphonesimulator*]": "arm64" }
```

CocoaPods copies that exclusion into the pod's own target and into the `Pods-Runner` aggregate target. So for the simulator, `Pods-Runner` builds x86_64 only:

```bash
# Xcode 27.2, CocoaPods 1.17.0
xcodebuild -showBuildSettings -project ios/Pods/Pods.xcodeproj \
  -target Pods-Runner -sdk iphonesimulator | grep -E " (EXCLUDED_ARCHS|ARCHS) ="
#     ARCHS = x86_64
#     EXCLUDED_ARCHS = arm64 i386
```

The `Runner` target gets its `EXCLUDED_ARCHS` from `ios/Flutter/Generated.xcconfig`, which Flutter writes before every build. `Debug.xcconfig` includes that file after the Pods xcconfig, so Flutter's value wins. Two things can happen from here.

- Flutter sees the excluded arm64 and writes `EXCLUDED_ARCHS[sdk=iphonesimulator*]=i386 arm64`. `Runner` and `Pods-Runner` then agree on x86_64. Xcode's dependency graph contains `Implicit dependency on target 'Pods-Runner' in project 'Pods' via file 'Pods_Runner.framework' in build phase 'Link Binary'`, and the build succeeds as an x86_64 app.
- Flutter misses it and writes only `i386`. `Runner` then builds for arm64 and x86_64, while `Pods-Runner` builds only for x86_64. In this case the dependency graph Xcode prints has no `Pods-Runner` entry at all, and neither does the excluded pod. Only the plugin targets that `OTHER_LDFLAGS` names, such as `flutter_tts`, are built. Nothing produces `Pods_Runner.framework`, and the linker fails on it.

Flutter misses it in two situations.

1. **Flutter 3.41.0 to 3.41.3.** [flutter/flutter#177065](https://github.com/flutter/flutter/pull/177065), merged on 5 November 2025, removed the automatic arm64 exclusion "to support Xcode 26 simulators". In its place came a check that only warned, and it only looked at Flutter plugin targets. A transitive pod such as `MLKitCommon` was not a plugin, so no warning appeared and nothing was excluded. That is why downgrading to 3.38.10 "fixed" it for people in the issue thread. [flutter/flutter#182913](https://github.com/flutter/flutter/pull/182913) put the exclusion back for any pod, including transitive ones, and the [Flutter changelog](https://github.com/flutter/flutter/blob/master/CHANGELOG.md) lists the fix under 3.41.4.
2. **The first build after the Pods project changes, on every version including 3.44.8.** Flutter reads the pod build settings from the existing `ios/Pods/Pods.xcodeproj` to decide what to exclude, and it does this *before* it runs `pod install`. If you just deleted `ios/Pods`, or just added the dependency, it reads either nothing or the old project. It writes `i386`, then `pod install` brings in the arm64-excluding pod, and the build fails. The next build reads the new Pods project and passes. The common recipe, `rm -rf ios/Pods ios/Podfile.lock && pod install && flutter run`, sets up exactly this failure, so it appears to fail every time you try it.

## Minimal repro with a stand-in for ML Kit

You do not need to download the ML Kit pods to see this. A local pod that vendors a device-arm64 plus simulator-x86_64 framework and repeats MLKit's two xcconfig lines behaves the same way. Create the app:

```bash
# Flutter 3.44.8, Xcode 27.2, CocoaPods 1.17.0
flutter create --platforms=ios -e podsapp
cd podsapp
flutter pub add flutter_tts:4.2.5   # any CocoaPods-based plugin, so Pods_Runner exists
```

Xcode 27 rejects deployment targets below iOS 15.0, and the Flutter 3.44.8 template still says 13.0. Raise `IPHONEOS_DEPLOYMENT_TARGET` to `15.0` in `ios/Runner.xcodeproj/project.pbxproj`, uncomment `platform :ios, '15.0'` in the `Podfile`, and set the same value for every pod target in `post_install`. Then build the fake SDK:

```bash
# Xcode 27.2: a static framework with arm64 for devices and x86_64 for the simulator only
cd ios && mkdir -p LegacySimKit/Frameworks/LegacySimKit.framework/Headers && cd LegacySimKit
cat > LegacySimKit.m <<'EOF'
#import <Foundation/Foundation.h>
@interface LegacySimKit : NSObject
+ (NSString *)hello;
@end
@implementation LegacySimKit
+ (NSString *)hello { return @"hello from an x86_64-only pod"; }
@end
EOF
xcrun clang -c -target x86_64-apple-ios15.0-simulator \
  -isysroot "$(xcrun --sdk iphonesimulator --show-sdk-path)" LegacySimKit.m -o sim.o
xcrun clang -c -target arm64-apple-ios15.0 \
  -isysroot "$(xcrun --sdk iphoneos --show-sdk-path)" LegacySimKit.m -o dev.o
libtool -static -o sim.a sim.o && libtool -static -o dev.a dev.o
lipo -create sim.a dev.a -output Frameworks/LegacySimKit.framework/LegacySimKit
lipo -info Frameworks/LegacySimKit.framework/LegacySimKit
# Architectures in the fat file: ... are: x86_64 arm64
```

The framework also needs a minimal `Info.plist` with `CFBundlePackageType` set to `FMWK`. The podspec copies MLKit's settings:

```ruby
# ios/LegacySimKit/LegacySimKit.podspec, CocoaPods 1.17.0
Pod::Spec.new do |s|
  s.name                 = 'LegacySimKit'
  s.version              = '1.0.0'
  s.summary              = 'Stand-in for a vendor SDK with no arm64 simulator slice.'
  s.homepage             = 'https://example.com'
  s.license              = { :type => 'MIT', :text => 'MIT' }
  s.author               = 'repro'
  s.source               = { :path => '.' }
  s.platform             = :ios, '15.0'
  s.vendored_frameworks  = 'Frameworks/LegacySimKit.framework'
  s.pod_target_xcconfig  = { 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'arm64' }
  s.user_target_xcconfig = { 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'arm64' }
end
```

Add `pod 'LegacySimKit', :path => 'LegacySimKit'` to the `Runner` target in the `Podfile`, directly under `flutter_install_all_ios_pods`. Here is what happened on Flutter 3.44.8:

```bash
# Flutter 3.44.8, Xcode 27.2
flutter clean && rm -rf ios/Pods ios/Podfile.lock
flutter build ios --simulator --debug
# Error (Xcode): Framework 'Pods_Runner' not found
grep 'sdk=iphonesimulator' ios/Flutter/Generated.xcconfig
# EXCLUDED_ARCHS[sdk=iphonesimulator*]=i386

flutter build ios --simulator --debug      # same command, second time
# The following target(s) do not support arm64 architecture, which is a
# requirement for Apple Silicon iOS 26+ simulators:
#   - LegacySimKit
# ✓ Built build/ios/iphonesimulator/Runner.app
grep 'sdk=iphonesimulator' ios/Flutter/Generated.xcconfig
# EXCLUDED_ARCHS[sdk=iphonesimulator*]=i386 arm64
```

To reproduce 3.41.0 to 3.41.3 without installing that SDK, change the line in `Generated.xcconfig` back to `=i386` and run the command Flutter itself runs (`flutter build ios -v` prints it): `xcodebuild -configuration Debug -workspace Runner.xcworkspace -scheme Runner -sdk iphonesimulator -destination "generic/platform=iOS Simulator"`. It fails with `ld: framework 'Pods_Runner' not found` on every run, because those versions never add `arm64`. With `i386 arm64` in place, the same command prints `** BUILD SUCCEEDED **`. `lipo -info` then reports both `Runner.debug.dylib` and `Pods_Runner.framework/Pods_Runner` as `x86_64`.

## Fix, step by step

### 1. Find the pod that excludes arm64

Flutter 3.41.4 and later print the list for you (see the `do not support arm64` warning above). On older versions, or to double-check, search the per-target xcconfigs CocoaPods generates:

```bash
# CocoaPods 1.17.0: which pod targets exclude arm64 for the simulator?
grep -l 'EXCLUDED_ARCHS\[sdk=iphonesimulator\*\] = arm64' \
  ios/Pods/Target\ Support\ Files/*/*.debug.xcconfig
# ios/Pods/Target Support Files/LegacySimKit/LegacySimKit.debug.xcconfig
# ios/Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig
```

Ignore the `Pods-Runner` and `Pods-RunnerTests` entries, which inherit the exclusion. Each remaining entry is a real dependency. To find the Flutter plugin that pulls it in, search `ios/Podfile.lock` for its name. For ML Kit you will see pods such as `MLKitCommon`, `MLKitVision`, and `MLImage` under the `google_mlkit_*` plugins, which are the ones the people in #182748 hit.

### 2. Upgrade Flutter to 3.41.4 or later

```bash
# any Flutter channel
flutter upgrade
flutter --version   # needs to report 3.41.4 or newer
```

If you cannot upgrade yet, for example because a CI pipeline pins 3.41.2, add the exclusion yourself after the `Generated.xcconfig` include. That way your value overrides Flutter's:

```
// ios/Flutter/Debug.xcconfig, workaround for Flutter 3.41.0-3.41.3
#include? "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig"
#include "Generated.xcconfig"

EXCLUDED_ARCHS[sdk=iphonesimulator*]=i386 arm64
```

With `Generated.xcconfig` deliberately set to the buggy `i386`, this made the same `xcodebuild` invocation succeed with an x86_64 `Runner`. It also avoids the first-build failure from cause 2 on every version, because it does not depend on what Flutter read from the Pods project. Take it out again once the dependency ships an arm64 simulator slice. Otherwise it will keep forcing x86_64 builds without telling you.

### 3. After any pod change, prepare the config before the real build

Whenever you delete `ios/Pods`, add or remove a plugin, or bump one that changes its pods, let Flutter regenerate the config twice. The first pass runs `pod install`, and the second reads the new Pods project:

```bash
# Flutter 3.44.8
flutter build ios --simulator --debug --config-only   # runs pod install, writes =i386
flutter build ios --simulator --debug --config-only   # writes =i386 arm64
flutter run
```

`flutter clean` alone does not trigger this, because it leaves `ios/Pods` in place. In the repro, a build right after `flutter clean` passed on the first try.

### 4. Pick a simulator that can run x86_64, or use a device

Getting a successful build is only half of the fix. The app it produces is x86_64, and Apple's iOS 26 and newer simulator runtimes are arm64-only by default. On this machine, `xcrun simctl list runtimes --json` reported `"supportedArchitectures": ["arm64"]` for the iOS 26.5, 27.0, and 27.1 runtimes. Running the 3.44.8 build on an iOS 27.1 iPhone simulator failed with:

```
Uncategorized (Xcode): Unable to find a destination matching the provided destination specifier:
		{ id:2D582560-A397-4573-A51A-CCBFE401F504 }
	Destinations compatible with the "Runner" scheme:
	Destinations incompatible with the "Runner" scheme:
		{ platform:iOS Simulator, arch:arm64, ..., OS:27.1, name:iPhone Duo, error:iPhone Duo's iOS Simulator platform doesn't match Runner.app's supported platforms. ... }
```

Flutter 3.44.8 has a friendlier message for this case ("Please use a simulator that supports x86_64..."). Its trigger looks for a `platform:iOS Simulator, arch:x86_64,` destination in the error text, and Xcode 27.2 lists only arm64 entries, so the message never appeared. You get the generic destination error instead. The [destination-specifier post](/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/) covers that error from the other side, where the stray `EXCLUDED_ARCHS` line is in your own `Podfile`.

You have four ways to actually run the app:

- **Physical device.** Device builds use the pod's arm64 device slice and never hit this problem. Everyone in #182748 confirmed that devices work.
- **A universal simulator runtime.** `xcodebuild -downloadPlatform iOS -architectureVariant universal` downloads the variant that also runs x86_64 apps under Rosetta. Xcode 27.2's `xcodebuild -help` still lists the flag. You then need a simulator created on that runtime, not one of your existing arm64-only ones. The universal runtime was not downloaded for this post, and one reporter in #182748 said it did not help them, so check the runtime with `xcrun simctl list runtimes --json` before you depend on it.
- **An older runtime.** Per the Flutter team's [analysis in #182748](https://github.com/flutter/flutter/issues/182748), x86 support depends on the simulator runtime, not the Xcode version, and iOS 18.x runtimes still run x86_64 even with Xcode 26.
- **Replace or isolate the dependency.** As of November 2026, [googlesamples/mlkit#810](https://github.com/googlesamples/mlkit/issues/810), the request for arm64 simulator support, is still open. If simulator testing matters more than that feature, switch to a package that ships an arm64 simulator slice. Another option is to keep the ML Kit-backed plugin out of the build flavor you use on the simulator.

`flutter build ios --simulator` still works without any of these. It never launches the app, so a CI job that only checks the simulator build compiles is fine once steps 2 and 3 are in place.

## Gotchas and lookalike errors

- **Building `Runner.xcodeproj` instead of `Runner.xcworkspace`** leaves the Pods project out of the build, but it fails earlier and differently. In the repro, `xcodebuild -project Runner.xcodeproj` stopped at `GeneratedPluginRegistrant.m` with `error: Module 'flutter_tts' not found`, before linking. Flutter always passes `-workspace Runner.xcworkspace`, so this only bites in Xcode or in custom scripts.
- **`use_frameworks! :linkage => :static` did not help** the Stack Overflow asker. It changes how pods are linked, not the `EXCLUDED_ARCHS` value the pod declares, so there is no reason to expect it to fix the architecture mismatch.
- **Regenerating `ios/` with `flutter create --platforms ios .` does not help either.** The cause is in your dependencies, not in the project files. That is why a fresh project fails "the same way" once you add the same dependencies.
- **`Framework 'LegacySimKit' not found` (any pod name) instead of `Pods_Runner`.** This is the same bug with a pod that builds from source rather than vendoring a binary. The linker flags list the pod framework before `Pods_Runner.framework`, so the linker reports whichever missing framework it reaches first.
- **`CocoaPods could not find compatible versions`** comes from dependency resolution, not from architectures. See [the CocoaPods version-conflict fix](/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).
- **Migrating to Swift Package Manager** only helps if every plugin that pulls in the arm64-excluding SDK can move. As long as one CocoaPods-only plugin depends on it, `Pods_Runner` stays, and so does this problem. The [CocoaPods to SwiftPM migration guide](/2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager/) shows how to check which of your plugins can move.

## Related

- [Fix: Unable to find a destination matching the provided destination specifier in a Flutter iOS build](/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/) covers what you hit next if you build x86_64 and pick an arm64-only simulator.
- [Fix: Failed to build iOS app with Xcode 16 and Flutter 3.x](/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) is the general checklist for reading what Xcode actually failed on.
- [Fix: CocoaPods could not find compatible versions for pod](/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) handles the resolution errors that `pod install` raises before any linking happens.
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) is useful if some jobs are still pinned to 3.41.0 to 3.41.3.
- [Migrate a Flutter iOS app from CocoaPods to Swift Package Manager](/2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager/) covers the long-term way out of Pods-Runner for plugins that support SwiftPM.

## Sources

- [Stack Overflow 79891589: Flutter iOS build fails with "Framework 'Pods_Runner' not found"](https://stackoverflow.com/questions/79891589)
- [flutter/flutter#182748: Framework 'Pods_Runner' not found when targeting simulator with dependency that does not support arm64 simulators](https://github.com/flutter/flutter/issues/182748)
- [flutter/flutter#177065: Remove arm64 exclusion to support Xcode 26 simulators](https://github.com/flutter/flutter/pull/177065)
- [flutter/flutter#182913: Exclude arm64 if any dependencies do and print warning when using Xcode 26](https://github.com/flutter/flutter/pull/182913)
- [Flutter CHANGELOG, 3.41.4 hotfix entry](https://github.com/flutter/flutter/blob/master/CHANGELOG.md)
- [MLKitCommon 10.0.0 podspec](https://github.com/CocoaPods/Specs/blob/f6cec04c121c5489fd157d6b34e6e4f546723764/Specs/c/c/6/MLKitCommon/10.0.0/MLKitCommon.podspec.json)
- [googlesamples/mlkit#810: Support for simulators on Apple Silicon / arm64](https://github.com/googlesamples/mlkit/issues/810)
