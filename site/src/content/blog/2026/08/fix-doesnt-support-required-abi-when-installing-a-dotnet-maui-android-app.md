---
title: "Fix: Doesn't support required ABI when installing a .NET MAUI Android app"
description: "The APK has no native library for the device's CPU. Since .NET 9 the default Android RuntimeIdentifiers are 64-bit only, so the fix is to set RuntimeIdentifiers explicitly. Covers ADB0020, XA0036, NETSDK1083, the ABI to RID mapping, the Play Console wording, and why the four-RID snippet everyone copies breaks on .NET 11."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "maui"
  - "dotnet"
  - "android"
  - "dotnet-11"
  - "coreclr"
---

The app bundle contains no native library for the CPU of the machine you are installing on. Android refuses the install rather than running the wrong binary. Since .NET 9, a `net9.0-android` or later project builds `arm64-v8a` and `x86_64` only, where the same project on .NET 8 built four ABIs, so the usual trigger is an upgrade rather than anything you changed. Fix it by setting `$(RuntimeIdentifiers)` on the Android target framework. The correct set of RIDs depends on which .NET version you are on, because .NET 11 removed Android x86 entirely, which means the four-RID snippet in most search results now fails to build.

## The error in context

The same root cause surfaces with three different wordings, depending on who is doing the installing.

Deploying from Visual Studio or from `dotnet build -t:Run` gives you a .NET for Android build error:

```
error ADB0020: The package does not support the CPU architecture of this device.
```

Installing the APK yourself with the Android SDK's `adb` reports the underlying failure:

```
adb: failed to install com.company.app-Signed.apk:
Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]
```

ADB0020 is .NET for Android's translation of exactly that, plus the older `INSTALL_FAILED_CPU_ABI_INCOMPATIBLE`. And the Google Play Console says it in device-catalog terms, which is where the "required ABI" phrasing comes from:

```
Doesn't support required ABI: arm64-v8a, x86_64
```

On a user's phone, the same condition shows up as "Your device isn't compatible with this version" in the Play Store, or a bare "App not installed" from a sideloaded APK.

## Which ABI does the device actually want?

Ask it. Every Android device and emulator publishes its supported ABIs in priority order:

```bash
adb shell getprop ro.product.cpu.abilist
```

A modern phone answers `arm64-v8a,armeabi-v7a`. A 64-bit-only device answers `arm64-v8a`. An emulator image on an Apple Silicon Mac answers `arm64-v8a`, and a Google x86_64 image answers `x86_64,arm64-v8a` only if it has ARM translation, which is not something to rely on.

Then ask the package what it ships. The native libraries live under `lib/<abi>/` in an APK:

```bash
unzip -l bin/Release/net11.0-android/com.company.app-Signed.apk | grep 'lib/'
```

```text
lib/arm64-v8a/libmonodroid.so
lib/arm64-v8a/libSystem.Native.so
lib/x86_64/libmonodroid.so
lib/x86_64/libSystem.Native.so
```

For an app bundle the prefix is `base/lib/` instead:

```bash
unzip -l bin/Release/net11.0-android/com.company.app-Signed.aab | grep 'base/lib/'
```

The intersection of those two lists is empty. That is the whole bug. The listing above installs on an Apple Silicon emulator and a modern phone, and fails on any device whose `abilist` is `armeabi-v7a` alone.

## What changed in .NET 9

.NET 8 and earlier built all four Android ABIs by default. .NET 9 narrowed the default `$(RuntimeIdentifiers)` for Android to the 64-bit pair:

```text
net8.0-android    armeabi-v7a  arm64-v8a  x86  x86_64
net9.0-android                 arm64-v8a       x86_64
net10.0-android                arm64-v8a       x86_64
net11.0-android                arm64-v8a       x86_64
```

The reasoning is that .NET follows the mobile platform vendors, and Google has required a 64-bit build for Play submissions since 2019. Nothing warns you at build time, because from the build's point of view nothing is wrong. You find out when a tester on an older handset cannot install, or when the Play Console device catalog silently drops several thousand device models off your supported list.

If your app is a hobby project or targets recent hardware, the new default is the right one and you should leave it alone. Two 64-bit ABIs instead of four cuts a MAUI APK roughly in half.

## The fix

Set `$(RuntimeIdentifiers)` explicitly, conditioned on the Android target framework so it does not leak into your iOS or Windows builds:

```xml
<!-- .NET 9 and .NET 10 -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x86;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

A single-target project can use the simpler condition on the TFM string:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net10.0-android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

That second set is the one to reach for by default. It restores 32-bit ARM, which is the only 32-bit ABI with real hardware behind it, and skips 32-bit x86, which in practice means old emulator images and a handful of Intel Atom tablets.

Rebuild after changing this. The per-ABI native libraries are staged in `obj/`, and an incremental build will happily reuse a layout that predates the property.

## ABI names are not runtime identifiers

This is the most common failed first attempt. `$(AndroidSupportedAbis)` took ABI names, so people paste ABI names into the property that replaced it:

```xml
<!-- wrong -->
<RuntimeIdentifiers>armeabi-v7a;arm64-v8a;x86;x86_64</RuntimeIdentifiers>
```

```text
error NETSDK1083: The specified RuntimeIdentifier 'armeabi-v7a' is not recognized.
```

The two vocabularies map one to one:

| Android ABI | .NET runtime identifier |
| --- | --- |
| `armeabi-v7a` | `android-arm` |
| `arm64-v8a` | `android-arm64` |
| `x86` | `android-x86` |
| `x86_64` | `android-x64` |

Note that `x86_64` maps to `android-x64` and not to `android-x86_64`, and that `android-x86` is the 32-bit one. Getting those two backwards produces a build that succeeds and an APK that installs on nothing you own.

## The ADB0020 page recommends a property that no longer works

Following the official ADB0020 page leads you into a second error. It suggests:

```xml
<AndroidSupportedAbis>armeabi-v7a;x86;x86_64;arm64-v8a</AndroidSupportedAbis>
```

That advice predates .NET 6. Add it to a modern project and the build tells you so:

```text
warning XA0036: The 'AndroidSupportedAbis' MSBuild property is no longer supported. Edit the project
file in a text editor, remove any uses of 'AndroidSupportedAbis', and use the 'RuntimeIdentifiers'
MSBuild property instead.
```

Because XA0036 is a warning rather than an error, the build succeeds, the property is ignored, and the APK still ships two ABIs. If you inherited a project migrated from Xamarin.Forms, check for a leftover `AndroidSupportedAbis` in a `Directory.Build.props` or a build-server argument before you conclude that `RuntimeIdentifiers` is not taking effect.

## .NET 11 changes the answer again

Do not paste the four-RID snippet into a `net11.0-android` project. [MAUI moved to CoreCLR on Android, iOS, and Mac Catalyst in .NET 11 Preview 4](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), and CoreCLR did not carry over every architecture Mono supported. Android x86 is gone, and asking for it fails the build rather than being quietly dropped:

```text
error NETSDK1082: There was no runtime pack for Microsoft.Android.Runtime available for the specified
RuntimeIdentifier 'android-x86'.
```

32-bit ARM had a longer wait. It was listed as under review when CoreCLR became the default, and support landed for Preview 7. Since [Preview 6 removed the Mono path for mobile entirely](/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/), there is no `$(UseMonoRuntime)` escape hatch to fall back on. For a .NET 11 project the working set is:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

If you are on a Preview 6 or earlier SDK, drop `android-arm` too and accept 64-bit only until you can update. .NET 11 reaches GA in November 2026.

The practical consequence for emulators: a 32-bit x86 system image can never run a .NET 11 MAUI app. If your CI still boots one, move it to `x86_64`, or to `arm64-v8a` on Apple Silicon runners.

## Keep the inner loop fast

Building four ABIs to debug on one device is wasted time. `$(RuntimeIdentifier)`, singular, overrides the plural form and builds exactly one:

```bash
dotnet build -f net11.0-android -t:Run -p:RuntimeIdentifier=android-arm64
```

Wire it to the Debug configuration and leave the full set for Release:

```xml
<PropertyGroup Condition="'$(Configuration)' == 'Debug' and $(TargetFramework.Contains('-android'))">
  <RuntimeIdentifier>android-arm64</RuntimeIdentifier>
</PropertyGroup>
```

One warning about passing the plural property on a command line: MSBuild splits `-p:` values on semicolons, so `-p:RuntimeIdentifiers=android-arm64;android-x64` gives you a shell or MSBuild parse error rather than two RIDs. Escape the separator as `%3B`:

```bash
dotnet publish -f net11.0-android -c Release -p:RuntimeIdentifiers=android-arm64%3Bandroid-x64
```

## What Google Play actually requires

Play has required a 64-bit binary alongside any 32-bit one since August 2019. It has never required the 32-bit one. So the .NET 9 default is compliant, and adding `android-arm` back is a reach decision, not a compliance fix.

Check the real number before you spend APK size on it. In the Play Console, the release's device catalog shows how many supported devices a bundle reaches, and the difference between a two-ABI and a three-ABI build is the population of `armeabi-v7a`-only handsets still in use in your markets. For many apps in 2026 that number is small enough to ignore, and for apps shipping into regions with long device replacement cycles it is not.

If you do ship an app bundle, Play splits it per ABI anyway, so each user downloads one architecture. The extra ABI costs you build time and bundle upload size, not install size.

## Related

- Native libraries are also why [Google Play rejects a Flutter or .NET MAUI app for missing 16 KB memory page size support](/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/), a check that runs against the same `lib/<abi>/` entries you listed above.
- The runtime switch behind the .NET 11 architecture changes is covered in [MAUI switches to CoreCLR by default on Android, iOS, and Mac Catalyst](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/).
- A leftover `AndroidSupportedAbis` usually arrives with the rest of the legacy build properties handled in [migrating from Xamarin.Forms to MAUI 11](/2026/05/migrate-from-xamarin-forms-to-maui-11/).
- If the build fails before it ever produces a package to install, start with [Gradle build failed to produce an APK file in MAUI Android](/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).

## Sources

- [.NET for Android error ADB0020](https://learn.microsoft.com/en-us/dotnet/android/messages/adb0020), for the mapping from `INSTALL_FAILED_NO_MATCHING_ABIS` to the build error.
- [.NET for Android warning XA0036](https://learn.microsoft.com/en-us/dotnet/android/messages/xa0036), for the `AndroidSupportedAbis` deprecation text.
- [Xamarin.Android project migration](https://learn.microsoft.com/en-us/dotnet/maui/migration/android-projects), which documents the ABI to `RuntimeIdentifiers` replacement.
- [.NET RID catalog](https://learn.microsoft.com/en-us/dotnet/core/rid-catalog) for the Android runtime identifier names.
- [CoreCLR progress and the Mono timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), for the removal of the Mono path in Preview 6 and the arm32 status.
- [dotnet/maui#27697](https://github.com/dotnet/maui/issues/27697), the report that surfaced the .NET 9 default change as a Play Store compatibility regression.
- [Support 64-bit architectures](https://developer.android.com/google-play/64-bit) in the Google Play developer documentation.
