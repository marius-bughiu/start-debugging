---
title: "Fix: Unable to find a destination matching the provided destination specifier in a Flutter iOS build"
description: "iOS 26 simulator runtimes are arm64-only, so a leftover EXCLUDED_ARCHS arm64 line builds an Intel-only Runner no simulator can execute. Drop the exclusion."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "xcode"
  - "cocoapods"
---

Delete the `EXCLUDED_ARCHS[sdk=iphonesimulator*] = arm64` line from your `ios/Podfile`, then run `flutter clean` followed by a fresh `pod install`. That line is a leftover from the 2020 Apple Silicon era, and on Xcode 26 it is fatal: iOS 26 simulator runtimes ship arm64-only by default, so excluding arm64 leaves `Runner` with no architecture the simulator can run, and `xcodebuild` reports it as a missing destination rather than an architecture mismatch. If the exclusion comes from a plugin you do not control, install the universal runtime instead with `xcodebuild -downloadPlatform iOS -architectureVariant universal`.

## The error, in full

Flutter surfaces the raw `xcodebuild` failure, which names your simulator's UDID and then lists destinations that look perfectly valid:

```
Uncategorized (Xcode): Unable to find a destination matching the provided destination specifier:
                { id:6B4F9D28-C76C-4146-9527-E844395B4434 }

        Available destinations for the "Runner" scheme:
                { platform:macOS, arch:arm64, variant:Designed for [iPad,iPhone], id:00006020-000221002EE8C01E, name:My Mac }
                { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }
                { platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device }
```

Running the same scheme from Xcode's UI gives the diagnosis Flutter's output buries:

```
iPhone 17 cannot run Runner.
Domain: IDEFoundationErrorDomain
Code: 3
Recovery Suggestion: Runner's architectures (Intel 64-bit) include none that iPhone 17 can execute (arm64).
```

That second message is the real error. The simulator exists, it is booted, and its UDID is correct. What is missing is an architecture in common between the product you just built and the device you asked to run it on.

## Why an iOS 26 simulator has no matching destination

`xcodebuild -destination` does not resolve to "a device with this UDID". It resolves to "a device with this UDID that can execute this scheme's product". Architecture is part of the match, so an architecture mismatch surfaces as a missing destination.

Before iOS 26, that distinction rarely mattered. Simulator runtimes shipped as universal binaries containing both `x86_64` and `arm64` slices, so an Intel-only build still found a slice to run under Rosetta on Apple Silicon. Xcode 26 ended that. When you install a runtime, Apple resolves the architecture variant to `arm64` on Apple Silicon and downloads only that slice, printing `Automatically resolved architecture variant for platform iOS as 'arm64'` on the way.

So an iOS 26 simulator can execute exactly one architecture, and any build setting that strips `arm64` from the simulator build produces a product with zero usable slices.

That setting almost always comes from a Podfile. In 2020, every Apple Silicon workaround guide told you to add an arm64 exclusion so Intel-only pods would link, and the advice was copied into thousands of projects. Flutter's own CocoaPods helper preserves it: `packages/flutter_tools/bin/podhelper.rb` writes the simulator exclusion with `$(inherited)` in front, which keeps your project-level value rather than replacing it.

```ruby
# Flutter 3.44.2, packages/flutter_tools/bin/podhelper.rb
build_configuration.build_settings['VALID_ARCHS[sdk=iphonesimulator*]'] = '$(ARCHS_STANDARD)'
build_configuration.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = '$(inherited) i386'
build_configuration.build_settings['EXCLUDED_ARCHS[sdk=iphoneos*]'] = '$(inherited) armv7'
```

The stock exclusion is `i386` alone, which is harmless. It is the inherited `arm64` that kills the build.

There is a second source. If any pod target excludes `arm64`, Flutter propagates the exclusion to the app itself. `packages/flutter_tools/lib/src/ios/xcode_build_settings.dart` decides this while generating `Generated.xcconfig`:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/ios/xcode_build_settings.dart
var excludedSimulatorArchs = 'i386';
if (!(await project.ios.pluginsSupportArmSimulator(printWarnings: printWarnings))) {
  excludedSimulatorArchs += ' arm64';
}
xcodeBuildSettings.add(
  'EXCLUDED_ARCHS[sdk=${XcodeSdk.IPhoneSimulator.platformName}*]=$excludedSimulatorArchs',
);
```

`pluginsSupportArmSimulator` runs `xcodebuild -showBuildSettings` across `Pods/Pods.xcodeproj` and returns false if any target's `EXCLUDED_ARCHS` mentions `arm64`. One badly configured transitive dependency is enough to make the whole app Intel-only.

## Minimal repro: the Podfile line that breaks the simulator build

Add the classic workaround to a stock Flutter app and run it on an iOS 26 simulator:

```ruby
# ios/Podfile, Flutter 3.44.2, CocoaPods 1.16.2, Xcode 26.0.1
post_install do |installer|
  installer.pods_project.build_configurations.each do |config|
    config.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = 'arm64'
  end
end
```

```bash
# Flutter 3.44.2 (stable, 11 June 2026), Dart 3.12.2
flutter run -d 6B4F9D28-C76C-4146-9527-E844395B4434
```

Flutter builds the `-destination` argument from the device you selected, in `packages/flutter_tools/lib/src/ios/mac.dart`:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/ios/mac.dart
buildCommands.add('-destination');
if (deviceID != null) {
  buildCommands.add('id=$deviceID');
} else if (environmentType == EnvironmentType.physical) {
  buildCommands.add(XcodeSdk.IPhoneOS.genericPlatform);
} else {
  buildCommands.add(XcodeSdk.IPhoneSimulator.genericPlatform);
}
```

`genericPlatform` expands to `generic/platform=iOS Simulator`. Either form fails the same way once the product is Intel-only, which is why `flutter build ios --simulator` reproduces it with no device selected at all.

## How do I remove the arm64 exclusion?

Work outward from your own project to your dependencies.

First, delete the exclusion from `ios/Podfile`. Remove the whole `EXCLUDED_ARCHS[sdk=iphonesimulator*]` assignment rather than setting it to an empty string, so Flutter's own `i386` default applies cleanly.

Second, check the Xcode project itself, since the same line is often pasted into build settings rather than the Podfile:

```bash
# Xcode 26.0.1
cd ios
xcodebuild -showBuildSettings -project Runner.xcodeproj -scheme Runner \
  -sdk iphonesimulator | grep -i EXCLUDED_ARCHS
```

Anything mentioning `arm64` on the simulator SDK has to go. Clear it in Xcode under Build Settings, Excluded Architectures, for both Debug and Release.

Third, rebuild the pods from scratch. Stale `Pods` and `DerivedData` keep the old settings alive and make it look like the fix did nothing:

```bash
# Flutter 3.44.2, CocoaPods 1.16.2
flutter clean
rm -rf ios/Pods ios/Podfile.lock ~/Library/Developer/Xcode/DerivedData
flutter pub get
cd ios && pod install
```

Fourth, confirm the exclusion is gone from the file Flutter generates. `ios/Flutter/Generated.xcconfig` should show `EXCLUDED_ARCHS[sdk=iphonesimulator*]=i386` with no `arm64`. If `arm64` survives a clean `pod install`, a dependency is the source, not you.

## What if a plugin still excludes arm64?

On Xcode 26 and later, Flutter 3.41.0 (11 February 2026) and newer name the offending targets during the build, from `packages/flutter_tools/lib/src/xcode_project.dart`:

```
The following target(s) do not support arm64 architecture, which is a requirement for Apple Silicon iOS 26+ simulators:
  - SomePlugin (Flutter plugin)
  - SomeVendorSDK (transitive dependency of Flutter plugin SomePlugin)

Please contact plugin maintainers to request arm64 support to continue to be able to use the plugin on a simulator.
```

That warning shipped in [PR #177065](https://github.com/flutter/flutter/pull/177065), merged on 5 November 2025. Comparing the merge commit against release tags puts it outside 3.38.10 and inside 3.41.0, so anyone still on the 3.38 line gets the failure with no explanation attached.

If the target is a vendor binary framework with no arm64 simulator slice, you cannot remove the exclusion. Install a universal runtime instead, so an Intel-only product still has something to run on:

```bash
# Xcode 26.0.1
xcrun simctl delete unavailable
xcodebuild -downloadPlatform iOS -architectureVariant universal
```

Delete the existing arm64-only iOS 26 runtime first, through Xcode's Settings, Components pane. Otherwise the download resolves to the runtime you already have and exits without fetching the universal variant. Verify afterwards:

```bash
# Xcode 26.0.1
xcrun simctl list runtimes --json | grep -i x86_64
```

This is the workaround Flutter itself recommends. Since 3.41.4 (4 March 2026), the tool prints the suggestion after a failed simulator build, gated on Xcode 26 or later and on the selected runtime genuinely lacking an `x86_64` slice:

```
The selected simulator is incompatible with the current build settings.
Please use a simulator that supports x86_64, such as a simulator prior to iOS 26 or download the universal variant of the iOS 26 simulator using "xcodebuild -downloadPlatform iOS -architectureVariant universal".
```

Treat it as a stopgap. A universal runtime is a larger download, it runs your app under Rosetta, and it does nothing for the next teammate who installs the runtime the default way. Removing the exclusion is the durable fix.

## What if the error says the platform is not installed?

A different failure mode prints the same headline with an `Ineligible destinations` block underneath:

```
Unable to find a destination matching the provided destination specifier:
                { id:1234D567-890C-1DA2-34E5-F6789A0123C4 }

        Ineligible destinations for the "Runner" scheme:
                { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device, error:iOS 17.0 is not installed. To use with Xcode, first download and install the platform }
```

This is not an architecture problem. Your deployment target or scheme references a runtime that is not on the machine, which is common right after an Xcode upgrade because Xcode 26 does not carry older runtimes forward. Flutter parses the `is not installed` phrase out of that message and prints installation instructions pointing at Xcode's Components pane. Install the missing runtime, or raise the deployment target to one you actually have.

## What if the destination is a stale simulator UDID?

If the UDID in the error no longer exists, `xcodebuild` adds a distinct line:

```
The requested device could not be found because no available devices matched the request.
```

Flutter explicitly excludes this case from its architecture diagnosis, so that sentence means you are chasing a phantom device, not an arch mismatch. It usually follows an iOS or Xcode update that regenerated the simulator set while an IDE config, a `launch.json`, or a shell alias kept pinning the old identifier:

```bash
# Xcode 26.0.1, Flutter 3.44.2
xcrun simctl list devices available
xcrun simctl delete unavailable
flutter devices
```

Then pass a UDID that `flutter devices` actually reports, or drop `-d` entirely and let Flutter pick.

## What breaks this on CI when it works locally?

On a build server the same message usually means the iOS platform is not installed at all. In [issue #163011](https://github.com/flutter/flutter/issues/163011) the destination list contained only macOS entries, which is what a macOS image with an incomplete Xcode component set looks like. `flutter build ipa` passes `generic/platform=iOS`, and with no iOS platform present there is nothing to match.

Check the image before blaming the project:

```bash
# Xcode 26.0.1 on a CI runner
xcodebuild -showsdks
xcrun simctl list runtimes
```

If iOS is missing, add `xcodebuild -downloadPlatform iOS` as a pre-build step, and pin the Xcode version so an image refresh does not silently change the answer. That is the same discipline that keeps [a CI pipeline building against several Flutter versions](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) predictable.

## Gotchas and lookalike variants

`ONLY_ACTIVE_ARCH` is not a substitute. Flutter already passes `ONLY_ACTIVE_ARCH` and `ARCHS` explicitly when it knows the active architecture, and setting it by hand does not add back a slice that `EXCLUDED_ARCHS` removed.

Watch for the legacy `VALID_ARCHS[sdk=iphonesimulator*] = x86_64` form too. It predates `EXCLUDED_ARCHS` and produces an identical Intel-only product. Flutter's podhelper resets it to `$(ARCHS_STANDARD)` for pod targets, but not for your app target.

A physical-device build failing with the same string is a different problem. There the destination is `generic/platform=iOS`, and the usual cause is code signing, closer to [a provisioning profile that does not include the selected device](/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/).

Finally, if the build gets past the destination check and then dies at launch, you are somewhere else entirely. A debug build that starts and immediately crashes in the Dart VM is [the mprotect permission denied failure](/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/), and a build that never links is more likely [a CocoaPods version resolution conflict](/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).

## Which Flutter version reports the real cause

The underlying incompatibility is Apple's, so upgrading Flutter does not make an Intel-only product run on an arm64-only runtime. What upgrading buys you is a diagnosis instead of a riddle. Flutter 3.41.0 adds the warning naming every target that excludes arm64, and 3.41.4 adds the post-failure hint about the universal runtime. Both are in the current stable, 3.47.1, released 19 August 2026.

If you are on 3.38 or earlier and cannot upgrade, run the `-showBuildSettings` grep above by hand. That is precisely the check Flutter now performs for you. For a wider iOS build-failure sweep after an Xcode upgrade, the triage order in [the Xcode 16 build failure walkthrough](/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) still applies.

## Related

- [Fix: mprotect failed: 13 (Permission denied) in a Flutter iOS debug build](/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)
- [Fix: CocoaPods could not find compatible versions for pod in a Flutter iOS build](/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/)
- [Fix: Failed to build iOS app with Xcode 16 and Flutter 3.x](/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)
- [Flutter 3.44 makes Swift Package Manager the default](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)

## Sources

- [flutter/flutter issue #176188, flutter run not working on iOS 26 simulator](https://github.com/flutter/flutter/issues/176188)
- [flutter/flutter PR #177065, Remove arm64 exclusion to support Xcode 26 simulators](https://github.com/flutter/flutter/pull/177065)
- [flutter/flutter issue #163011, destination specifier failure with a generic iOS platform](https://github.com/flutter/flutter/issues/163011)
- [Apple Developer Forums, installing iOS 26 simulator runtimes and architecture variants](https://developer.apple.com/forums/thread/801106)
- [Apple, Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [Apple, Installing additional simulator runtimes](https://developer.apple.com/documentation/xcode/installing-additional-simulator-runtimes)
