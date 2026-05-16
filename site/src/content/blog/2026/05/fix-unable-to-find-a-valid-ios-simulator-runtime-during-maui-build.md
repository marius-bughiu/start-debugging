---
title: "Fix: Unable to find a valid iOS Simulator runtime during MAUI build"
description: "Xcode 15+ ships without bundled iOS simulator runtimes. MAUI fails the build when SupportedOSPlatformVersion has no matching runtime installed. Install one with xcodebuild -downloadPlatform iOS or via Xcode Settings, then verify with xcrun simctl list runtimes."
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "ios"
  - "xcode"
  - "simulator"
---

The fix: starting with Xcode 15 the iOS Simulator runtime is no longer bundled with Xcode itself, and starting with Xcode 26 the previous Xcode's runtime is not migrated automatically either. The MAUI iOS toolchain reads `SupportedOSPlatformVersion` from your csproj, asks Xcode for a simulator at that version or higher, and bails out with `Unable to find a valid iOS Simulator runtime` when nothing matches. Run `xcrun simctl list runtimes` to confirm what is actually installed, then either download one in Xcode through Settings, Platforms, the plus button, or do it headless with `xcodebuild -downloadPlatform iOS`. If `SupportedOSPlatformVersion` in your csproj is higher than every installed runtime, drop it back to a version you have or install the matching one.

```text
/usr/local/share/dotnet/packs/Microsoft.iOS.Sdk/18.2.9270/targets/Xamarin.Shared.Sdk.targets(1245,3):
error : Unable to find a valid iOS Simulator runtime. Please install one from Xcode > Settings > Platforms.

xcodebuild: error: Unable to find a destination matching the provided destination specifier:
        { platform:iOS Simulator, OS:18.2, name:iPhone 16 Pro }

Could not find the simulator runtime 'com.apple.CoreSimulator.SimRuntime.iOS-18-2'.
```

This guide is written against .NET 11 preview 4, MAUI 11 preview 4, Xcode 26.0, and `Microsoft.iOS.Sdk` 18.2.9270. The behaviour appeared the moment Apple unbundled Simulator runtimes from the Xcode installer in Xcode 15, and it became a much more visible problem in Xcode 26 because Apple stopped silently importing the prior Xcode's runtime cache during first-launch. If you upgraded recently and your build pipeline started failing for what looks like no reason, this is almost certainly the cause.

## Why Xcode 15 broke MAUI iOS builds

For most of the Xcode history, the installer carried the iOS Simulator runtime in the same `.xip` you downloaded from the developer portal, which is part of why Xcode used to weigh in at 7+ GB. With Xcode 15 Apple split the runtimes out into a separate download model: the Xcode app ships with the toolchain (compilers, SDKs, headers) and the iOS Simulator app itself, but every concrete runtime image (`iOS 17.4`, `iOS 18.2`, and so on) is a separate download that you opt into. The installer trims to roughly 3 GB, and you pull only the platforms you need.

That is great for disk usage and terrible for first-time builds. A MAUI project targeting `net11.0-ios` resolves the target SDK from `Microsoft.iOS.Sdk`, hands `xcodebuild` a destination string that includes a runtime version, and then `xcrun simctl create` or `xcrun simctl boot` tries to find a matching runtime in `~/Library/Developer/CoreSimulator/Profiles/Runtimes` and `/Library/Developer/CoreSimulator/Profiles/Runtimes`. With nothing installed, none of those calls succeed and you get the error above.

Xcode 26 added a new wrinkle. Apple now treats the runtimes as independent of the Xcode bundle entirely, and the new `CoreSimulator` framework keeps a per-Xcode compatibility matrix. If you had Xcode 16 with iOS 18.2 simulator installed, then upgraded to Xcode 26 and your csproj targets `iOS 19.0`, the 18.2 runtime is still on disk but it is not what MAUI is asking for. The error wording is unchanged, which is why it confuses people on upgrade.

## What MAUI actually asks for

When you run `dotnet build -t:Run -f net11.0-ios -p:_DeviceName=":v2:runtime=com.apple.CoreSimulator.SimRuntime.iOS-19-0,devicetype=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"`, the MAUI iOS targets in `Microsoft.iOS.Sdk` do a few things:

1. They resolve `SupportedOSPlatformVersion` and `_MtouchTargetiOSVersion` from your project.
2. They invoke `xcrun simctl list runtimes -j` to discover what is installed locally.
3. They pick the first runtime whose version is greater than or equal to your target, and matches the platform (`iOS-Simulator`).
4. If nothing matches, the MSBuild task throws the `Unable to find a valid iOS Simulator runtime` error before ever calling `xcrun simctl boot`.

This is implemented in the `_DetectSimulator` task in `Xamarin.Shared.Sdk.targets`. The takeaway: the error means your installed runtime list is empty for the platform, or every installed runtime has a lower version than your csproj target.

## Verify what is actually installed

Before changing anything in your csproj, list the runtimes:

```bash
# macOS, any shell
xcrun simctl list runtimes --json | jq '.runtimes[] | {name, version, identifier, isAvailable}'
```

A healthy machine prints something like:

```json
{
  "name": "iOS 19.0",
  "version": "19.0",
  "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  "isAvailable": true
}
```

A broken machine after an Xcode upgrade prints either an empty `runtimes` array, or runtimes flagged with `"isAvailable": false` and a `availabilityError` string explaining that the runtime is "incompatible with this version of Xcode". A runtime flagged unavailable is on disk but Xcode will refuse to use it, so MAUI treats it as missing.

You can also see the same information from inside Xcode at **Settings, Platforms**. The list shows installed runtimes with a checkmark and lets you install or remove each one.

## Install the runtime from the command line

If you are headless or on CI, do not click through the Xcode UI. Xcode 15 introduced a `-downloadPlatform` flag to `xcodebuild`:

```bash
# Xcode 15+, downloads the latest iOS simulator runtime
# compatible with this Xcode version
xcodebuild -downloadPlatform iOS

# Xcode 16+, pin to a specific build of the runtime
xcodebuild -downloadPlatform iOS -buildVersion 18.2
```

The command runs in the foreground, prints a progress percentage, and writes the runtime to `~/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS <version>.simruntime`. It is roughly 8 GB per runtime, so plan accordingly on CI. Apple documents this in [Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components).

For older Xcode versions (Xcode 15 only), the older form is `xcodebuild -downloadAllPlatforms`, which downloads every compatible platform runtime. It is much heavier than `-downloadPlatform iOS` and you almost never want it on CI.

If you need a runtime that is not part of the current Xcode's compatibility set, for example you want iOS 17.4 to repro a customer bug on Xcode 26, install it from a downloaded `.dmg` or `.simruntime`:

```bash
# Manually install a simruntime image from disk
xcrun simctl runtime add "/path/to/iOS 17.4.simruntime"
```

The `xcrun simctl runtime` subcommand exists in Xcode 16+ and is the supported way to register a runtime that was downloaded separately. You can list registered runtime images with `xcrun simctl runtime list`.

## Align SupportedOSPlatformVersion with what you have

If you installed `iOS 18.2` but your csproj targets `iOS 19.0`, the error will repeat. Open the iOS-specific section of your csproj and either lower the target or accept that you need a newer runtime:

```xml
<!-- .NET 11, MAUI 11, Microsoft.iOS.Sdk 18.2.9270 -->
<PropertyGroup Condition="$(TargetFramework.Contains('-ios'))">
  <SupportedOSPlatformVersion>15.0</SupportedOSPlatformVersion>
</PropertyGroup>
```

`SupportedOSPlatformVersion` is the **minimum** iOS version your app supports at runtime. The simulator runtime you boot must be greater than or equal to this number. The actual simulator that MAUI launches by default is the highest-version installed runtime, not the minimum, so if you have iOS 19.0 installed your app still boots on iOS 19.0 even though the project's floor is 15.0.

Do not raise `SupportedOSPlatformVersion` to silence the error, that is the wrong knob. The right move is to install the runtime, then leave the project's minimum where it actually needs to be for your audience.

## Pin a specific simulator from dotnet build

When you have multiple runtimes installed and want a specific one, pass `_DeviceName` to MAUI's iOS Run target. This is the same string `xcrun simctl` uses internally:

```bash
# .NET 11 preview 4, MAUI 11 preview 4
dotnet build -t:Run -f net11.0-ios \
  -p:_DeviceName=":v2:runtime=com.apple.CoreSimulator.SimRuntime.iOS-18-2,devicetype=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"
```

The `:v2:` prefix is required, MAUI parses it as the new-format device selector. The runtime identifier matches what `xcrun simctl list runtimes` prints under `identifier`. The device type identifier matches `xcrun simctl list devicetypes`.

If you omit `_DeviceName`, MAUI picks the latest installed iPhone simulator at the highest installed runtime, which is fine for local dev and surprisingly fragile on CI when a new Xcode point release lands.

## Fixing CI specifically

On a fresh GitHub Actions `macos-15` or `macos-26` runner, Xcode is preinstalled but the iOS simulator runtime that matches your `SupportedOSPlatformVersion` may not be. Apple's hosted images include one or two runtimes baked in; build agents from other providers vary. The safe pattern is to install explicitly before running `dotnet build`:

```yaml
# .github/workflows/maui-ios.yml
- name: Select Xcode
  run: sudo xcode-select -s /Applications/Xcode_26.0.app

- name: Install iOS 18.2 simulator runtime
  run: xcodebuild -downloadPlatform iOS -buildVersion 18.2

- name: Verify runtime is registered
  run: xcrun simctl list runtimes

- name: Build MAUI iOS
  run: dotnet build src/App/App.csproj -c Release -f net11.0-ios
```

Two things bite people here. First, the runner caches between jobs only if you opt in, so each job re-downloads 8 GB unless you wire up [`actions/cache`](https://github.com/actions/cache) keyed on the runtime version. Second, `xcodebuild -downloadPlatform` does not error if the runtime is already installed, but it does refetch metadata. On a warm cache the command finishes in seconds.

If your CI is running an older Xcode (Xcode 14 or earlier), `-downloadPlatform` does not exist. Either upgrade Xcode, or fall back to a third-party tool like `xcodes` (`brew install xcodes`) and `sudo xcodes runtimes install "iOS 18.2"`. The community-maintained `xcodes` was the only good answer before Xcode 15 and is still useful when you need older runtimes that Apple no longer hosts on the developer portal.

## CoreSimulator service stuck after upgrade

Sometimes the runtime is installed, `xcrun simctl list runtimes` shows it as available, and MAUI still fails. The cause is usually a stale `CoreSimulatorService` that cached the pre-upgrade Xcode's runtime list. Kill it:

```bash
sudo killall -9 com.apple.CoreSimulator.CoreSimulatorService
```

The service relaunches on the next `xcrun simctl` call and re-reads the runtime directory. This is documented in several `dotnet/macios` issues, including [dotnet/macios#22243](https://github.com/dotnet/macios/issues/22243), and shows up most after `softwareupdate -ai` runs that update CoreSimulator without rebooting.

If killing the service does not help, also clear `~/Library/Developer/CoreSimulator/Caches` and reboot. `CoreSimulator` keeps a derived data cache that occasionally points to a deleted runtime path.

## When the wrong Xcode is selected

The other common false positive: `xcode-select -p` points to a different Xcode than the one you installed the runtime into. Runtimes are technically registered against the active Xcode through `CoreSimulator`, and switching Xcodes can leave the new active Xcode without visible runtimes even though the files exist:

```bash
# Show the active Xcode
xcode-select -p
# /Applications/Xcode_26.0.app/Contents/Developer

# Switch to a specific Xcode
sudo xcode-select -s /Applications/Xcode_26.0.app
```

MAUI also respects `DEVELOPER_DIR`. If a CI step exports it, that overrides `xcode-select`. Mismatch between `xcode-select` and `DEVELOPER_DIR` is one of those bugs that only shows up the second time the pipeline runs, when a cached env var conflicts with a fresh runner's default. The [MAUI troubleshooting guide](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0) documents the Xcode selection precedence: `DEVELOPER_DIR`, then deprecated plist files, then `xcode-select -p`, then `/Applications/Xcode.app`.

## Gotchas after the fix

A few things still trip people after the runtime is installed:

1. **Apple Silicon vs Intel simulator slices**. The iOS 17.0+ simulator runtimes only ship the arm64 slice. If you are running an Intel Mac under Rosetta, you cannot boot them. Use an older runtime or upgrade the build agent.
2. **Mac Catalyst confusion**. `net11.0-maccatalyst` does not need a simulator runtime, it runs natively on macOS. If a Mac Catalyst build fails with this error, you almost certainly have a stray `net11.0-ios` target in the same project and your IDE picked it.
3. **`-buildVersion` mismatches**. `xcodebuild -downloadPlatform iOS -buildVersion 18.2` accepts marketing versions like `18.2`, not internal build numbers like `22C150`. Passing a build number silently downloads the latest instead.
4. **App Store Connect uploads still work without a simulator**. Device builds (`-p:RuntimeIdentifier=ios-arm64`) do not need the simulator runtime at all. If your CI only ships to TestFlight, you can skip the install entirely and only set up signing.

If you also fight Android-side build errors in the same project, the same pattern (toolchain expects a component the installer no longer bundles) shows up there too: see the writeup on [the MAUI Android Gradle APK failure](/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/). For signing-side iOS errors that look similar but are unrelated to simulators, the [provisioning profile device mismatch fix](/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) covers that path. If you want to step back from cross-platform mobile entirely on this project, the post on [running MAUI on Windows and macOS only](/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) walks through the desktop-only target frameworks. For background on the broader MAUI 11 release wave, [the .NET 11 preview 4 MAUI CoreCLR default](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) post explains what changed under the hood.

The shortest fix is almost always `xcodebuild -downloadPlatform iOS` followed by a `dotnet build`. The longer fix is to write that one line into your CI script so the next agent that joins the team does not waste an afternoon on it.

## Source links

- [Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [Troubleshoot known issues - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0)
- [dotnet/macios#22243 - Can't find simulator when a particular iOS SDK version doesn't contain a simulator](https://github.com/dotnet/macios/issues/22243)
- [dotnet/maui#23352 - iOS build failed with iossimulator-x64 RuntimeIdentifier](https://github.com/dotnet/maui/issues/23352)
- [Build with a specific version of Xcode](https://learn.microsoft.com/en-us/dotnet/ios/cli)
