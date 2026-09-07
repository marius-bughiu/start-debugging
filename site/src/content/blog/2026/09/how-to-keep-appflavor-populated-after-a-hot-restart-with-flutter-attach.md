---
title: "How to keep appFlavor populated after a hot restart when using flutter attach"
description: "flutter attach has no --flavor option, so the resident compiler it spawns never defines FLUTTER_APP_FLAVOR and the appFlavor const collapses to null on the first hot restart. Three fixes: default-flavor in pubspec.yaml, flutter run --use-application-binary, and a platform channel that reads the flavor natively. Verified on Flutter 3.47.2 / Dart 3.13.2."
pubDate: 2026-09-07
template: how-to
tags:
  - "flutter"
  - "dart"
  - "how-to"
  - "flavors"
  - "tooling"
---

`appFlavor` is a compile-time constant, not a runtime lookup, and `flutter attach` has no `--flavor` option. So when you attach to an app that was built and launched outside `flutter run`, the frontend compiler the tool spawns is started without `-DFLUTTER_APP_FLAVOR=...`, and the first hot restart replaces your correct `dev` with `null`. The quickest fix is `default-flavor` in `pubspec.yaml`, which `FlutterCommand.getBuildInfo()` reads for every command including `attach`. If you need the flavor to vary per invocation, use `flutter run --use-application-binary=<path> --flavor dev` instead of attaching, or stop reading `appFlavor` at all and read the flavor from the platform. Everything below was checked against Flutter 3.47.2 with Dart 3.13.2 on the stable channel.

## appFlavor is eleven lines of const, and that is the whole story

People assume `appFlavor` asks the engine something. It does not. Here is the entire declaration, from `packages/flutter/lib/src/services/flavor.dart` on the stable branch:

```dart
// Flutter 3.47.2, packages/flutter/lib/src/services/flavor.dart
/// The flavor this app was built with.
///
/// This is equivalent to the value argued to the `--flavor` option at build time.
/// This will be `null` if the `--flavor` option was not provided.
const String? appFlavor = String.fromEnvironment('FLUTTER_APP_FLAVOR') != ''
    ? String.fromEnvironment('FLUTTER_APP_FLAVOR')
    : null;
```

`String.fromEnvironment` is resolved by the CFE when it compiles the kernel, from the `-D` flags handed to the compiler process. It has nothing to do with `Platform.environment`, nothing to do with the running VM, and nothing to do with the APK you installed. Whatever value the compiler had at the moment it produced the kernel is baked in.

That matters because a Flutter debug session has two compilers in its life. The first one runs when you build the app: `flutter build apk --flavor dev --debug` resolves `--flavor` in `FlutterCommand.getBuildInfo()` and appends `FLUTTER_APP_FLAVOR=dev` to the dart defines, which end up as `-DFLUTTER_APP_FLAVOR=dev` on the frontend server command line. The second one runs for the whole rest of the session: the resident compiler that `flutter run` or `flutter attach` keeps alive to service hot reload and hot restart. In `packages/flutter_tools/lib/src/compile.dart` the defines are splatted onto that process exactly once, when it starts:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/compile.dart (abridged)
final List<String> command = <String>[
  engineDartPath,
  ...
  '--sdk-root', sdkRoot,
  '--target=$targetModel',
  '--no-print-incremental-dependencies',
  for (final Object dartDefine in dartDefines) '-D$dartDefine',
  ...buildModeOptions(buildMode, dartDefines),
  if (trackWidgetCreation) '--track-creation-locations',
  ...
];
```

There is no channel to change `dartDefines` after that. Every hot reload and every hot restart for the rest of the session is served by that one process with that one define set. If `FLUTTER_APP_FLAVOR` was not on the command line when it started, no amount of restarting will bring it back.

## What attach registers, and what it does not

`AttachCommand`'s constructor is a list of `uses*` calls. Here is the relevant part, verbatim from stable:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/commands/attach.dart
addBuildModeFlags(verboseHelp: verboseHelp, defaultToRelease: false, excludeRelease: true);
usesTargetOption();
usesPortOptions(verboseHelp: verboseHelp);
usesIpv6Flag(verboseHelp: verboseHelp);
usesFilesystemOptions(hide: !verboseHelp);
usesFuchsiaOptions(hide: !verboseHelp);
usesDartDefineOption();
usesDeviceUserOption();
```

`usesFlavorOption()` is absent. `RunCommand` calls it on line 40 of `run.dart`; `AttachCommand` never does. And `getBuildInfo()`, which `attach` does call, resolves the flavor like this:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/runner/flutter_command.dart
final String? defaultFlavor = project.manifest.defaultFlavor;
final String? cliFlavor = getValue(BuildInfoOptions.flavor);
final String? flavor = cliFlavor ?? defaultFlavor;

_ensureReservedDartDefineIsUnset(kAppFlavor, dartDefines);
if (flavor != null) {
  dartDefines.add('$kAppFlavor=$flavor');
}
```

With no `--flavor` option registered, `cliFlavor` is `null`. If `defaultFlavor` is also null, `flavor` is null, the `if` never runs, and the resident compiler is spawned without the define. The app on the device is a `dev` build; the compiler serving it thinks flavors do not exist.

## The repro, in four steps

This is [flutter/flutter#192261](https://github.com/flutter/flutter/issues/192261), filed on 2026-09-03 and confirmed by a triager against 3.47.2 stable. It reproduces on both `platform-android` and `platform-ios`.

1. Give an app product flavors and read the constant somewhere visible:

   ```dart
   // Flutter 3.47.2 / Dart 3.13.2
   import 'package:flutter/material.dart';
   import 'package:flutter/services.dart';

   void main() => runApp(const FlavorApp());

   class FlavorApp extends StatelessWidget {
     const FlavorApp({super.key});

     @override
     Widget build(BuildContext context) {
       return MaterialApp(
         home: Scaffold(
           body: Center(
             child: Text('appFlavor = $appFlavor',
                 style: const TextStyle(fontSize: 28)),
           ),
         ),
       );
     }
   }
   ```

2. Build and launch it with the flavor, but outside `flutter run`:

   ```bash
   flutter build apk --flavor dev --debug
   adb install -r build/app/outputs/flutter-apk/app-dev-debug.apk
   adb shell monkey -p com.example.flavors.dev 1
   ```

3. Attach: `flutter attach --debug`. The screen still reads `appFlavor = dev`, because nothing has been recompiled yet.

4. Press `R` for a hot restart. The screen now reads `appFlavor = null`.

Step 3 is what makes this confusing to diagnose. The value is correct right up until the first restart, so the bug looks like it belongs to whatever code you just edited rather than to the tool.

## Fix 1: default-flavor in pubspec.yaml

`default-flavor` was added to the pubspec schema in [flutter/flutter#147968](https://github.com/flutter/flutter/pull/147968), and [#169298](https://github.com/flutter/flutter/pull/169298) moved its resolution into `FlutterCommand.getBuildInfo()` so it applies to every command that builds a `BuildInfo`, not just `run` and `build`. `attach` is one of those commands. That is why this works.

1. Add the field under the `flutter:` key in `pubspec.yaml`:

   ```yaml
   # pubspec.yaml, Flutter 3.47.2
   name: flavors_example
   environment:
     sdk: ^3.13.0

   flutter:
     uses-material-design: true
     default-flavor: dev
   ```

2. Restart the attach session. `flutter attach --debug` now resolves `flavor` to `dev` from the manifest, appends `FLUTTER_APP_FLAVOR=dev` to the defines, and hot restart keeps returning `dev`.

3. Keep using `--flavor` explicitly where the option exists. `usesFlavorOption()`'s own help text says it "Overrides the value of the `default-flavor` entry in the flutter pubspec", so `flutter run --flavor staging` still wins over `default-flavor: dev`.

The limitation is exactly what you would expect from a value stored in a checked-in file: it is one flavor, for everybody, for every attach. If your CI attaches to a `staging` build on one machine and a `dev` build on another, `default-flavor` cannot follow them. There is an open proposal, [#191376](https://github.com/flutter/flutter/pull/191376), to allow platform-specific `default-flavor` values, but that still does not make the value per-invocation.

## Why --dart-define=FLUTTER_APP_FLAVOR is refused

The obvious workaround is to set the define by hand, and `attach` does register `usesDartDefineOption()`, so the flag parses. It still fails:

```bash
flutter attach --debug --dart-define=FLUTTER_APP_FLAVOR=dev
# FLUTTER_APP_FLAVOR is used by the framework and cannot be set using
# --dart-define or --dart-define-from-file
```

That guard is deliberate, and it also covers the process environment:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/runner/flutter_command.dart
void _ensureReservedDartDefineIsUnset(String define, List<String> dartDefines) {
  if (_platform.environment[define] != null) {
    throwToolExit('$define is used by the framework and cannot be set in the environment.');
  }
  if (dartDefines.any((String d) => d == define || d.startsWith('$define='))) {
    throwToolExit(
      '$define is used by the framework and cannot be '
      'set using --${FlutterOptions.kDartDefinesOption} or --${FlutterOptions.kDartDefineFromFileOption}',
    );
  }
}
```

`FLUTTER_APP_FLAVOR` joins `FLUTTER_BUILD_NAME`, `FLUTTER_BUILD_NUMBER` and `FLUTTER_ENABLED_FEATURE_FLAGS` on that reserved list. Setting the variable in your shell before running the tool does not sneak past it either: the first branch checks `_platform.environment` and exits with a different message. If you used to do this on web builds, that is [#172165](https://github.com/flutter/flutter/issues/172165), closed as invalid: the pre-3.32 behaviour was the accident, not the current refusal.

## Fix 2: run the prebuilt binary instead of attaching

Most people reach for `flutter attach` because the app was built by something other than `flutter run`: a Gradle task, an Xcode scheme, an instrumentation harness. If all you need is "install this artifact and give me a hot-restart loop", `flutter run` will do that directly, and unlike `attach` it accepts `--flavor`:

```bash
# Flutter 3.47.2. run registers both --use-application-binary and --flavor.
flutter run \
  --use-application-binary=build/app/outputs/flutter-apk/app-dev-debug.apk \
  --flavor dev
```

`RunCommand` calls `usesFlavorOption()` and reads `--use-application-binary` into `prebuiltApplicationBinaryPath`, so you get a real `HotRunner` over a binary you built yourself, with `FLUTTER_APP_FLAVOR=dev` on the resident compiler. On iOS, point it at the `.app` bundle produced by `flutter build ios --flavor dev --debug` or by your Xcode scheme. This is the closest thing to a correct fix that does not require touching your Dart code, and it is the one I reach for first in CI.

It does not help if you genuinely cannot control the launch, for example when a native host app embeds Flutter as a module and starts the engine itself. That is what Fix 3 is for.

## Fix 3: read the flavor from the platform, not from the kernel

If the flavor has to survive an arbitrary attach, stop asking a compile-time constant for a value that the compiler does not know. The flavor is already present natively, in `BuildConfig.FLAVOR` on Android and in whatever build setting drives your Xcode scheme, and a platform channel reads it after the isolate restarts rather than before it compiles. The technique is the same one covered in [adding platform-specific code without writing a plugin](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

Android first. AGP 8.0 stopped generating `BuildConfig` unless you ask, and the Flutter app template does not ask, so enable it:

```kotlin
// android/app/build.gradle.kts, AGP 8.13, Flutter 3.47.2
android {
    namespace = "com.example.flavors"

    buildFeatures {
        buildConfig = true
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
        }
        create("staging") {
            dimension = "env"
            applicationIdSuffix = ".staging"
        }
    }
}
```

Then answer a channel call in `MainActivity`:

```kotlin
// android/app/src/main/kotlin/com/example/flavors/MainActivity.kt
package com.example.flavors

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "com.example.flavors/flavor",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "getFlavor" -> result.success(BuildConfig.FLAVOR)
                else -> result.notImplemented()
            }
        }
    }
}
```

On iOS, add a user-defined build setting per xcconfig (`APP_FLAVOR = dev` in `Debug-dev.xcconfig`), surface it in `Info.plist` as a `FLUTTER_APP_FLAVOR` string set to `$(APP_FLAVOR)`, and read it out of the bundle:

```swift
// ios/Runner/AppDelegate.swift, Xcode 26.4, Flutter 3.47.2
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let controller = window?.rootViewController as! FlutterViewController
    let channel = FlutterMethodChannel(
      name: "com.example.flavors/flavor",
      binaryMessenger: controller.binaryMessenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "getFlavor" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result(Bundle.main.object(forInfoDictionaryKey: "FLUTTER_APP_FLAVOR") as? String)
    }
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
```

And on the Dart side, resolve once and fall back to `appFlavor` on platforms that have no native handler:

```dart
// Flutter 3.47.2 / Dart 3.13.2
import 'package:flutter/services.dart';

const _channel = MethodChannel('com.example.flavors/flavor');

/// Survives hot restart under `flutter attach`, because it is a call, not a const.
Future<String?> resolveFlavor() async {
  try {
    return await _channel.invokeMethod<String>('getFlavor') ?? appFlavor;
  } on MissingPluginException {
    return appFlavor; // desktop, web, unit tests
  }
}
```

The cost is that `resolveFlavor()` is asynchronous and `appFlavor` is not, so anything that branched on the flavor synchronously in `main()` now has to await it before `runApp`, or read it from a provider. That is a real refactor, which is why I would only take it when Fix 1 and Fix 2 are both unavailable.

## Things that look like this bug but are not

**The 3.32.1 hotfix.** If you search this symptom you will land on [#165803](https://github.com/flutter/flutter/issues/165803) and [#169160](https://github.com/flutter/flutter/issues/169160), where `appFlavor` went null after a hot restart under plain `flutter run --flavor` and during `flutter test --flavor`. That was a different cause: `KernelSnapshot` in `build_system/targets/common.dart` skipped adding the flavor when a define was already present from the xcodebuild leg of the build. [PR #169602](https://github.com/flutter/flutter/pull/169602) changed it to remove any existing entry and re-add its own last, and the changelog entry landed in **Flutter 3.32.1**. If you are on 3.32.1 or newer and still see null under `flutter run`, that is a new bug, not this one.

**Hot reload, not just hot restart.** The define set is fixed when the resident compiler starts, so it governs every incremental compile, not only full restarts. A hot reload that recompiles a library which reads `appFlavor` can re-evaluate the constant to null in that library while other libraries keep the old value. Do not assume `r` is safe because `R` is not.

**Flavors that only exist in Gradle.** `appFlavor` reports the value passed to `--flavor`, which must match a product flavor name. If you renamed a flavor in `build.gradle.kts` but kept building with the old name, the build fails before this ever matters. Wiring up the flavor dimensions themselves is out of scope here; if `assembleDevDebug` is what is failing, that is closer to [the assembleDebug exit code 1 checklist](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

**IDE "Attach" actions.** IntelliJ hit the same wall from the other side in flutter-intellij#5237, where the Attach action passed `--flavor` and died with `Could not find an option named 'flavor'`. The IDE fix was to drop the flag, which is why attaching from Android Studio or VS Code shows this behaviour too. `default-flavor` is currently the only thing that fixes the IDE path, since you do not control its command line.

The upstream proposal in #192261 is one line: call `usesFlavorOption()` in `AttachCommand`'s constructor. `getBuildInfo()` already turns the option into the define, so nothing else needs plumbing. Until that lands, treat `appFlavor` under `attach` as "correct exactly once", and pick whichever of the three fixes above matches how much of the launch you control.

## Related

- [How to add platform-specific code in Flutter without plugins](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) walks through the `MethodChannel` setup Fix 3 depends on.
- [Fix: Gradle task assembleDebug failed with exit code 1 in a Flutter Android build](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) covers the flavor and NDK misconfigurations that break the build before `appFlavor` is even in play.
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) is worth reading alongside Fix 2, because `--use-application-binary` is mostly a CI move.
- [Debugging Flutter iOS from Windows: a real device workflow](/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) is the other place `flutter attach` earns its keep, and the same constant-versus-runtime distinction applies there.
- [Fix: Firebase Auth sign-in does not persist in a Flutter Android release build](/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/) is a good companion if your flavors also mean different Firebase projects.

## Sources

- [flutter/flutter#192261](https://github.com/flutter/flutter/issues/192261), the open issue tracking the missing `--flavor` on `attach`, with a triager confirmation on 3.47.2.
- [`appFlavor` constant](https://api.flutter.dev/flutter/services/appFlavor-constant.html) in the Flutter API docs, and its source at `packages/flutter/lib/src/services/flavor.dart`.
- [Flutter pubspec options](https://docs.flutter.dev/tools/pubspec) for the `default-flavor` field, and [Set up Flutter flavors for Android](https://docs.flutter.dev/deployment/flavors) for the flavor setup itself.
- [flutter/flutter#147968](https://github.com/flutter/flutter/pull/147968) added `default-flavor`; [#169298](https://github.com/flutter/flutter/pull/169298) and its roll-forward [#169602](https://github.com/flutter/flutter/pull/169602) moved flavor resolution into `getBuildInfo()`.
- [The Flutter CHANGELOG](https://github.com/flutter/flutter/blob/main/CHANGELOG.md) for the 3.32.1 hotfix entry covering `appFlavor` under `flutter test` and hot restart.
- [Android Gradle Plugin 8.0 release notes](https://developer.android.com/build/releases/past-releases/agp-8-0-0-release-notes) for the `buildFeatures.buildConfig` default change that Fix 3 has to work around.
