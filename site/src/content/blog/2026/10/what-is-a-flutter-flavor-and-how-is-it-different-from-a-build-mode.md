---
title: "What Is a Flutter Flavor, and How Is It Different from a Build Mode?"
description: "A build mode (debug, profile, release) decides how Flutter compiles your Dart code. A flavor (dev, staging, prod) is a native build variant you define in Gradle and Xcode that decides which app you ship. They are independent axes: 2 flavors times 3 modes is 6 builds. Verified on Flutter 3.44.8 with AGP 9.0.1, source checked against 3.47.7."
pubDate: 2026-10-10
tags:
  - "flutter"
  - "dart"
  - "flavors"
  - "android"
  - "ios"
  - "tooling"
---

Short answer: a **build mode** is how Flutter compiles and runs your Dart code. There are exactly three, `debug`, `profile` and `release`, they are built into the engine and the tool, and your code sees them through `kDebugMode`, `kProfileMode` and `kReleaseMode`. A **flavor** is something Flutter does not own at all: it is a native build variant you define yourself, as Android `productFlavors` in Gradle and as Xcode schemes plus build configurations on iOS and macOS, and it decides *which app* you are building (application ID, display name, icons, Firebase project, API base URL). Flutter just forwards `--flavor dev` to the native build and exposes the name to Dart as the `appFlavor` constant. The two are orthogonal, so a project with `dev` and `prod` flavors has six variants, from `devDebug` to `prodRelease`. Everything below was built and checked on Flutter 3.44.8 (Dart 3.12.2, Android Gradle Plugin 9.0.1, Gradle 9.1.0), and the relevant `flutter_tools` source was compared against the current stable, Flutter 3.47.7.

## Two axes, one build matrix

The confusion usually starts because both things are passed on the same command line and both end up in the output file name:

```bash
# Flutter 3.44.8 / 3.47.7
flutter build apk --release --flavor prod
# -> Running Gradle task 'assembleProdRelease'...
# -> build/app/outputs/flutter-apk/app-prod-release.apk
```

`--release` picks the mode. `--flavor prod` picks the flavor. Gradle composes them into one variant name, `prodRelease`, and runs `assembleProdRelease`. Here is the full matrix for a project with two flavors:

| | `--debug` | `--profile` | `--release` |
|---|---|---|---|
| `--flavor dev` | `app-dev-debug.apk` | `app-dev-profile.apk` | `app-dev-release.apk` |
| `--flavor prod` | `app-prod-debug.apk` | `app-prod-profile.apk` | `app-prod-release.apk` |

The columns are decided by Flutter and answer "how is the Dart code compiled, and can I hot reload it?" The rows are decided by your `build.gradle.kts` and Xcode project and answer "is this the app that talks to the staging backend and is called `Demo Dev` on the home screen?" Nothing about one axis implies anything about the other. A `prod` debug build is completely normal: it is what you run when you need to reproduce a production-only bug with breakpoints.

## What a build mode actually changes

Build modes are about the Dart compilation pipeline, and they are fixed by Flutter:

- **Debug** compiles to a kernel file and runs it on the Dart VM's JIT. Asserts are on, service extensions are on, hot reload and hot restart work, and performance is not representative.
- **Profile** compiles ahead of time to native machine code, like release, but keeps enough of the service protocol alive for DevTools tracing. It does not run on emulators or simulators.
- **Release** compiles ahead of time, strips asserts and debugging information, and is what you ship.

You can see the difference by listing the APKs. The debug APK carries the Dart program as `kernel_blob.bin` for the JIT, while the profile and release APKs carry a precompiled `libapp.so`:

```text
# Flutter 3.44.8, flutter build apk --target-platform android-arm64 --flavor dev|prod
app-dev-debug.apk     26146208  assets/flutter_assets/kernel_blob.bin
app-dev-profile.apk    2753424  lib/arm64-v8a/libapp.so
app-prod-release.apk   1508240  lib/arm64-v8a/libapp.so
```

Your Dart code learns the mode from three constants in `package:flutter/foundation.dart`. They are compile-time constants derived from flags the tool passes to the Dart compiler, which is why the compiler can tree-shake an `if (kDebugMode) { ... }` block out of a release build entirely:

```dart
// Flutter 3.44.8, packages/flutter/lib/src/foundation/constants.dart (abridged)
const bool kReleaseMode = bool.fromEnvironment('dart.vm.product');
const bool kProfileMode = bool.fromEnvironment('dart.vm.profile');
const bool kDebugMode = !kReleaseMode && !kProfileMode;
```

You cannot add a fourth mode. A "staging" mode is not a thing in Flutter; staging is a flavor.

## What a flavor actually is

A flavor is a variant of the native app. Flutter has no flavor configuration format of its own. When you pass `--flavor dev`, the tool does three things:

1. On Android, it runs the Gradle task `assemble<Flavor><Mode>`, for example `assembleDevDebug`. If your Gradle file declares no product flavor named `dev`, the build fails.
2. On iOS and macOS, it builds the Xcode scheme named after the flavor (sentence-cased, so `dev` looks for `Dev` first, then a case-insensitive match) using the build configuration `<Mode>-<scheme>`, for example `Debug-dev` or `Release-prod`.
3. On every platform, it adds `FLUTTER_APP_FLAVOR=dev` to the Dart defines, which surfaces in Dart as `appFlavor`.

Everything a flavor changes in the final binary comes from the native side: the application ID suffix, the app name string, `google-services.json` or `GoogleService-Info.plist`, launcher icons, signing config. Flutter only routes the name through.

## Defining flavors on Android with AGP 9

Here is the Android side of the demo app. It is the stock `flutter create` template for Flutter 3.44.8 with a flavor dimension added:

```kotlin
// android/app/build.gradle.kts
// Flutter 3.44.8, Android Gradle Plugin 9.0.1, Gradle 9.1.0
android {
    namespace = "com.example.flavordemo"
    compileSdk = flutter.compileSdkVersion

    defaultConfig {
        applicationId = "com.example.flavordemo"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // AGP 9 turns resValue off by default. Without this block the
    // productFlavors below fail with:
    // "Product Flavor dev contains custom resource values, but the feature is disabled."
    buildFeatures {
        resValues = true
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            resValue("string", "app_name", "Demo Dev")
        }
        create("prod") {
            dimension = "env"
            resValue("string", "app_name", "Demo")
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}
```

The `buildFeatures` block is the part most older tutorials miss. Flavor guides written before AGP 9 use `resValue` for the app name, and on a fresh Flutter 3.44 project that configuration now fails at Gradle configuration time with the error in the comment above. Then point the manifest at the string so each flavor gets its own launcher label:

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<application
    android:label="@string/app_name"
    android:name="${applicationName}"
    android:icon="@mipmap/ic_launcher">
```

`aapt2 dump badging` on the resulting APKs confirms the two axes really are independent. The mode changed nothing about identity, and the flavor changed nothing about compilation:

```text
app-dev-debug.apk     package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-dev-profile.apk   package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-dev-release.apk   package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-prod-release.apk  package: com.example.flavordemo      versionName 0.1.0      label 'Demo'
```

Because the `dev` variants have a different application ID, they install side by side with production on the same phone. That alone is the reason most teams adopt flavors.

## The errors that tell you which axis is wrong

Once a Gradle file declares product flavors, a plain `flutter build apk` stops working:

```text
# Flutter 3.44.8, no --flavor, productFlavors declared
Running Gradle task 'assembleDebug'...                             14.5s
Gradle build failed to produce an .apk file. It's likely that this file was generated
under .../flavordemo/build, but the tool couldn't find it.
```

The message is misleading. `assembleDebug` succeeded and built *every* flavor (both `app-dev-debug.apk` and `app-prod-debug.apk` were on disk afterwards), but the tool looks for `app-debug.apk`, which no longer exists. Pass `--flavor`, or set a default (see below).

The opposite mistake, passing `--flavor` to a project that has no product flavors, gets a much clearer message:

```text
# Flutter 3.44.8, --flavor dev, no productFlavors
[!]  Gradle project does not define a task suitable for the requested build.
The .../android/app/build.gradle.kts file does not define any custom product flavors.
You cannot use the --flavor option.
```

On iOS the tool validates the flavor against the Xcode schemes. Running `flutter build ios --config-only --no-codesign --flavor dev` on the same project, which has no `dev` scheme yet, printed:

```text
The Xcode project defines schemes: FlutterFramework, FlutterGeneratedPluginSwiftPackage, Runner
You must specify a --flavor option to select one of the available schemes.
```

## Proof that both end up as constants in the binary

`appFlavor` is declared in `package:flutter/services.dart`, and in Flutter 3.47.7 it is still a plain `String.fromEnvironment` lookup:

```dart
// Flutter 3.47.7, packages/flutter/lib/src/services/flavor.dart
const String? appFlavor = String.fromEnvironment('FLUTTER_APP_FLAVOR') != ''
    ? String.fromEnvironment('FLUTTER_APP_FLAVOR')
    : null;
```

So the flavor reaches Dart the same way the mode does: as a compile-time constant. To prove it, the demo's `main.dart` logs both:

```dart
// Flutter 3.44.8, lib/main.dart
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

void main() {
  debugPrint('FLAVORPROBE appFlavor=$appFlavor kDebugMode=$kDebugMode '
      'kProfileMode=$kProfileMode kReleaseMode=$kReleaseMode');
  runApp(const SizedBox());
}
```

Then `strings` on the AOT snapshot inside each APK shows the compiler folded the whole interpolation into one literal. There is no runtime lookup left to inspect:

```text
# strings lib/arm64-v8a/libapp.so | grep FLAVORPROBE
app-dev-release.apk:   FLAVORPROBE appFlavor=dev kDebugMode=false kProfileMode=false kReleaseMode=true
app-prod-release.apk:  FLAVORPROBE appFlavor=prod kDebugMode=false kProfileMode=false kReleaseMode=true
app-dev-profile.apk:   FLAVORPROBE appFlavor=dev kDebugMode=false kProfileMode=true kReleaseMode=false
```

This has two practical consequences. You cannot switch flavors at runtime, because the binary only contains one answer. And anything that recompiles Dart without the right defines, such as a hot restart from `flutter attach`, gets `appFlavor == null`, which is the problem covered in [keeping appFlavor populated after a hot restart](/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).

The tool also guards the name. Trying to fake a flavor with a define fails before the build starts:

```text
# flutter build apk --dart-define=FLUTTER_APP_FLAVOR=qa
FLUTTER_APP_FLAVOR is used by the framework and cannot be set using --dart-define or --dart-define-from-file
```

## iOS and macOS: schemes plus build configurations

On Apple platforms a flavor is two things that must agree: a scheme named after the flavor and a set of build configurations named `Debug-<flavor>`, `Profile-<flavor>` and `Release-<flavor>`. The mode-times-flavor matrix is literally spelled out in the configuration names. In Xcode, duplicate `Debug`, `Profile` and `Release` for each flavor, create a `dev` scheme, and set its Run action to `Debug-dev`, Profile to `Profile-dev`, and Archive to `Release-dev`. Each configuration can then set its own `PRODUCT_BUNDLE_IDENTIFIER` and display name.

One behaviour worth knowing in Flutter 3.47.7: `XcodeProjectInfo.buildConfigurationFor` looks for an exact `Debug-dev` match first, then for a single configuration whose name contains both the mode and the scheme (case-insensitive), and if neither exists it **falls back to the plain `Debug` configuration**. So a typo like `Debug-dve` does not fail the build; it quietly builds with your base configuration and whatever bundle identifier that configuration carries, usually production's. If a flavored iOS build looks like prod, check the configuration names before anything else.

`flutter run`, `flutter build ios`, `flutter build ipa` and `flutter build macos` accept `--flavor`. `flutter build web`, `flutter build windows` and `flutter build linux` do not have the option in 3.44.8, because there is no native variant system for Flutter to forward to.

## Flavor-specific assets and a default flavor

Two pubspec features make flavors less painful. Assets can be limited to specific flavors, which keeps dev fixtures and debug configs out of the production bundle:

```yaml
# pubspec.yaml, Flutter 3.44.8
flutter:
  default-flavor: dev
  assets:
    - path: assets/dev/
      flavors:
        - dev
```

In the demo, `assets/flutter_assets/assets/dev/config.json` was present in `app-dev-debug.apk` and `app-dev-profile.apk` and absent from `app-prod-debug.apk` and `app-prod-release.apk`. Remember that any `rootBundle.loadString('assets/dev/config.json')` in shared code will now throw in `prod`, the same "Unable to load asset" failure described in [the pubspec asset troubleshooting post](/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/).

`default-flavor` is what the tool uses when `--flavor` is omitted. In `FlutterCommand.getBuildInfo()` the logic is a one-liner, `cliFlavor ?? defaultFlavor`, unchanged in 3.47.7. With it set, plain `flutter build apk --release` in the demo produced `app-dev-release.apk` instead of failing. It is handy for `flutter run` during development, but think twice before committing `default-flavor: prod`: a CI job that forgets `--flavor` then silently ships whichever flavor the file names.

## Which axis does a setting belong to?

A quick way to decide where a piece of configuration lives:

- **It depends on how code is compiled or debugged** (verbose logging, `debugPaintSizeEnabled`, crash reporting off during development, performance overlays): use the mode, through `kDebugMode` / `kReleaseMode`. These checks tree-shake out of release builds.
- **It depends on which environment or product you are shipping** (API base URL, Firebase project, bundle ID, app name, icon, paywall product IDs): use a flavor, on the native side for anything the OS reads and through `appFlavor` for anything Dart reads.
- **It is a value, not an identity** (a feature flag, a build number, a non-secret key): `--dart-define` or `--dart-define-from-file` is often simpler than a flavor. Defines are also compile-time constants, so they compose with both axes.
- **It is a secret**: none of the above. Flavors, modes and defines all end up as readable strings in the binary, as the `strings` output above shows.

The mistake to avoid is mapping environments onto modes, for example "debug talks to staging, release talks to prod". It works until you need to profile against production, debug a release-only crash against staging, or ship a staging build to testers through TestFlight, which requires a release build. Keep the axes separate and every combination stays reachable.

Firebase is where this goes wrong most often in practice. Per-flavor `google-services.json` files live in Android source sets such as `android/app/src/dev/`, and a mismatch there produces the kind of release-only failure covered in [Firebase Auth sign-in not persisting in a release build](/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/). Flavor source sets also affect which Kotlin classes get compiled, which is one of the causes in [ClassNotFoundException for MainActivity](/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/), and flavored output names (`app-prod-release.apk`, `app-prodRelease.aab`) matter when you check native libraries for [the "Could not create Dart VM instance" release crash](/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## Related

- [How to keep appFlavor populated after a hot restart when using flutter attach](/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/)
- [Fix: ClassNotFoundException for MainActivity when a Flutter Android app launches](/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/)
- [Fix: Firebase Auth sign-in does not persist in a Flutter Android release build](/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/)
- [Fix: Could not create Dart VM instance in a Flutter release build after flutter upgrade](/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)
- [Fix: Unable to load asset in Flutter after adding an image to pubspec.yaml](/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/)

## Sources

- [Flutter docs: Flutter's build modes](https://docs.flutter.dev/testing/build-modes)
- [Flutter docs: Set up Flutter flavors for Android](https://docs.flutter.dev/deployment/flavors)
- [Flutter docs: Set up Flutter flavors for iOS and macOS](https://docs.flutter.dev/deployment/flavors-ios)
- [Android developers: Configure build variants](https://developer.android.com/build/build-variants)
- [`flavor.dart` at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter/lib/src/services/flavor.dart)
- [`flutter_command.dart` (`getBuildInfo`, `default-flavor`) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter_tools/lib/src/runner/flutter_command.dart)
- [`xcodeproj.dart` (scheme and build configuration matching) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter_tools/lib/src/ios/xcodeproj.dart)
- [`constants.dart` (`kReleaseMode`, `kProfileMode`, `kDebugMode`) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter/lib/src/foundation/constants.dart)
