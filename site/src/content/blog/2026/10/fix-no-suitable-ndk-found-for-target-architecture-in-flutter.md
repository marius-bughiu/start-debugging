---
title: "Fix: Bad state: No suitable NDK found for target architecture arm64 in a Flutter build"
description: "The android_libcpp_shared build hook (0.2.0 and older) cannot find your NDK, or your minSdk is above the NDK's newest API. Upgrade to 0.2.1+, or install an NDK that covers your minSdk."
pubDate: 2026-10-07
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "ndk"
  - "native-assets"
---

This error does not come from Gradle or from Flutter. It is thrown by the Dart build hook of the `android_libcpp_shared` package (versions 0.1.0 to 0.2.0), which some FFI packages such as `croppy` pull in transitively. There are two causes. Either the hook's own NDK search misses the NDK that Gradle is happily using, or every NDK it finds stops at an API level below your app's `minSdk`. For the first, upgrade the package to 0.2.1 or later (with `dependency_overrides` if it is transitive). For the second, install an NDK whose sysroot covers your `minSdk`: NDK r28c and r29 stop at API 35, so `minSdk = 36` needs r30.

Everything below was reproduced on macOS with Flutter 3.44.8 (Dart 3.12.2), the Flutter template's Gradle 9.1.0, OpenJDK 17, and NDK r28c (`28.2.13676358`) in an Android SDK at `/opt/homebrew/share/android-commandlinetools`. I read the hook source of `android_libcpp_shared` 0.1.0 through 0.3.1 straight from the pub.dev archives.

## The error in context

This is the output of `flutter build apk --debug --target-platform android-arm64` on a freshly created app with `android_libcpp_shared: 0.2.0` added and nothing else changed (the long `--packages` paths are shortened):

```text
Unhandled exception:
Bad state: No suitable NDK found for target architecture arm64.
#0      main.<anonymous closure> (file:///Users/marius/.pub-cache/hosted/pub.dev/android_libcpp_shared-0.2.0/hook/build.dart:31:7)
<asynchronous suspension>
#1      build (package:hooks/src/api/build_and_link.dart:250:5)
<asynchronous suspension>
#2      main (file:///Users/marius/.pub-cache/hosted/pub.dev/android_libcpp_shared-0.2.0/hook/build.dart:12:3)
<asynchronous suspension>

  Building assets for package:android_libcpp_shared failed.
  build.dart returned with exit code: 255.
  To reproduce run:
  (cd .../android_libcpp_shared-0.2.0/; .../dart-sdk/bin/dart --packages=.../package_config.json .../hooks_runner/android_libcpp_shared/cbb4418675/hook.dill --config=.../input.json )
  stdout:
  INFO: Searching for android NDK...

Target dart_build failed: Error: Building native assets failed. See the logs for more details.

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileFlutterBuildDebug'.
```

The architecture at the end changes with your target: `arm64`, `arm`, or `x64`. A release build without `--target-platform` builds all three, so whichever ABI the hook runner tries first is the one you see.

The detail that confuses everyone: Gradle had already resolved NDK `28.2.13676358` on this machine. Flutter's own Gradle plugin forces that NDK download on every Android build, so the NDK was installed, valid, and in use. The hook just did not look where it was.

## Why a build hook is looking for an NDK at all

In current Flutter stable releases, packages can ship a `hook/build.dart` that runs during `flutter build` to compile or bundle native code (the "native assets" or "build hooks" feature, built on `package:hooks` and `package:code_assets`). Flutter runs these hooks in the `dart_build` target, before Gradle compiles anything, and hands each hook a JSON config with the target OS, the architecture, the C compiler Flutter found, and `targetNdkApi`.

`android_libcpp_shared` exists to bundle `libc++_shared.so`, the shared C++ runtime that FFI libraries compiled with `-stl=c++_shared` need at load time. To do that it has to find an NDK on disk, and in 0.2.0 and earlier it ran its own search instead of trusting the one Flutter passed in. Two things inside that search can return nothing, and both end in the same `StateError`.

### Cause 1: the hook searches a narrower set of places than Gradle

In 0.2.0 `NDKLocator.locate()` collects candidates from exactly four sources:

1. `ndk-build` on `PATH`, but it resolves the parent of the NDK directory instead of the directory itself, so this source never matched (the 0.2.1 changelog calls this out as a fix).
2. The `ANDROID_NDK`, `ANDROID_NDK_HOME`, `ANDROID_NDK_LATEST_HOME` and `ANDROID_NDK_ROOT` environment variables.
3. A hardcoded glob per OS: `$HOME/Library/Android/sdk/ndk/*/` on macOS, `$HOME/Android/Sdk/ndk/*/` on Linux, `$HOME/AppData/Local/Android/Sdk/ndk/*/` on Windows.
4. `ndk/*/` under `ANDROID_HOME`, `ANDROID_SDK_ROOT` or `ANDROID_SDK_HOME`.

What it does not read is `sdk.dir` in `android/local.properties`, which is where Gradle actually gets the SDK from, or the `android-sdk` value you set with `flutter config --android-sdk`. Flutter itself honours both. So any SDK outside the default Android Studio location, without an exported `ANDROID_HOME`, is invisible to the hook: Homebrew's `android-commandlinetools`, a custom drive on Windows and a CI image that only writes `local.properties`. On Windows there is a second trap: the glob expands `$HOME` with `Platform.environment['HOME']!`, and `HOME` is not set in a normal `cmd.exe` session.

### Cause 2: your minSdk is higher than the newest API in any NDK it found

Even when an NDK is found, the hook only accepts it if its sysroot has an API-level directory at or above your app's minimum SDK:

```dart
// android_libcpp_shared 0.2.0, lib/src/locate_ndk.dart
NDKApiLevel? highestMatching(int minApiLevel) {
  final suitableApiLevels =
      _apiLevels.where((api) => api.level >= minApiLevel).toList()
        ..sort((a, b) => b.level.compareTo(a.level));
  return suitableApiLevels.isNotEmpty ? suitableApiLevels.first : null;
}
```

`minApiLevel` is `targetNdkApi` from the hook config, and Flutter fills that from your app's merged `minSdk`: `FlutterPlugin.kt` reads `variant.mergedFlavor.minSdkVersion` and passes it to `flutter assemble` as `-dMinSdkVersion`. The API directories come from `toolchains/llvm/prebuilt/<host>/sysroot/usr/lib/aarch64-linux-android/`. I listed them for the three current NDKs:

| NDK | Revision | Sysroot API levels |
|-----|----------|--------------------|
| r28c | `28.2.13676358` (Flutter 3.44's default `ndkVersion`) | 21 to 35 |
| r29 | `29.0.14206865` | 21 to 35 |
| r30 | `30.0.16248370` | 21 to 37 |

So `minSdk = 36` with Flutter's default NDK fails, no matter how the NDK is discovered. This check survives in 0.2.1 and 0.3.x too, only with a better message. It is also slightly odd, because `libc++_shared.so` lives one level up, in `sysroot/usr/lib/<triple>/`, and is not per-API at all. But that is the rule the package enforces, so you have to satisfy it.

## Minimal repro

Both causes reproduce with a template app. For cause 1 you need an SDK outside the default location and no `ANDROID_HOME`; for cause 2 any machine works.

```bash
# Flutter 3.44.8, android_libcpp_shared 0.2.0, NDK r28c
flutter create --platforms=android -e ndkapp
cd ndkapp
flutter pub add android_libcpp_shared:0.2.0
flutter build apk --debug --target-platform android-arm64
```

To check the hook's view of your machine without a full Gradle build, call its locator from a throwaway console package. This is what I used to separate the two causes:

```dart
// Dart 3.12.2, android_libcpp_shared 0.2.0
// bin/repro.dart  -  dart run bin/repro.dart 36
import 'package:android_libcpp_shared/src/locate_ndk.dart';

Future<void> main(List<String> args) async {
  final minSdk = int.parse(args.first);
  final ndks = await NDKLocator.locate();
  print('NDKs found: ${ndks.length}');
  for (final ndk in ndks) {
    final target = ndk.hostArchitectures.first.findTarget(LibArch.arm64);
    print('${ndk.path.toFilePath()} '
        'match(minSdk=$minSdk): ${target?.highestMatching(minSdk)}');
  }
}
```

On my machine, without `ANDROID_HOME` it prints `NDKs found: 0` (cause 1). With `ANDROID_HOME` set and argument `24` it prints `android-35`; with `36` it prints `null` (cause 2).

## The fix, step by step

### 1. Find out who depends on android_libcpp_shared

You probably never added it yourself:

```bash
# Flutter 3.44.8
flutter pub deps --style=compact | grep android_libcpp_shared
flutter pub deps --style=tree | grep -B5 android_libcpp_shared
```

At the time of writing, the packages on pub.dev that depend on it are `croppy` (1.5.3 pins exactly `0.1.0`), `flutter_piper_tts` (`^0.1.1`), `mecab_for_dart` and `than_audiotag` (`^0.2.1`), and `liblsl` (`^0.3.0`). If yours resolves 0.2.0 or older, step 2 fixes cause 1.

### 2. Upgrade to 0.2.1 or later

0.2.1 (published 2026-08-12) rewrote discovery. It adds the NDK that the Flutter tool is building with, derived from the C compiler path in the hook config, to the candidates, plus `sdk.dir` and `ndk.dir` from `local.properties`, `flutter config --android-sdk`, a longer list of well-known directories, and the fixed `PATH` lookup. It also reads `USERPROFILE` on Windows.

If the dependency is direct, bump it. If it is transitive and pinned, override it:

```yaml
# pubspec.yaml, Flutter 3.44.8
dependency_overrides:
  android_libcpp_shared: ^0.2.1
```

Which line to pick depends on your Flutter version. 0.2.x depends on `code_assets ^1.0.0` and `hooks ^2.0.2`. 0.3.0 and 0.3.1 move to `code_assets ^2.0.0`. Flutter 3.44.8's `flutter_tools` itself pins `code_assets 1.0.0`, so on 3.44 I recommend `^0.2.1`, which is what I verified. With 0.2.1 and no `ANDROID_HOME`, the same template app builds and the APK contains `lib/arm64-v8a/libc++_shared.so`.

Overrides apply to the whole graph, so check that the package pinning the old version still works against the new one. For `croppy`, which only uses `android_libcpp_shared` for its hook side effect, there is no API to break.

### 3. If you cannot upgrade: give the old hook a path it does search

On 0.2.0 or older, export one of the variables it reads before you build:

```bash
# macOS / Linux, android_libcpp_shared 0.2.0
export ANDROID_HOME="$HOME/path/to/your/android/sdk"
flutter clean
flutter build apk
```

```powershell
# Windows PowerShell, android_libcpp_shared 0.2.0
$env:ANDROID_HOME = "D:\Android\Sdk"
$env:HOME = $env:USERPROFILE
flutter clean
flutter build apk
```

That variable has to be in the environment of whatever launches the build. In my tests with `flutter build` and Gradle 9.1.0, a warm Gradle daemon picked up the new value on the next build, in both directions. The place it goes wrong is Android Studio started from the Dock, Start menu, or a launcher: GUI apps do not read `~/.zshrc`, so `flutter run` from the IDE fails while the same command in your terminal works. Start the IDE from a shell that has the variable, or use step 2.

Do not skip `flutter clean` while testing this. Flutter caches hook results under `.dart_tool/`, and in my repro a build without `ANDROID_HOME` kept passing because it reused the successful hook output from the previous build. You would think your fix works until a clean CI runner proves otherwise.

### 4. If your minSdk is above 35: install an NDK that covers it

For cause 2 the only correct fix is an NDK whose sysroot reaches your `minSdk`. Set it explicitly so Gradle downloads it on every machine and CI runner:

```kotlin
// android/app/build.gradle.kts, Flutter 3.44.8, AGP 9.0.1
android {
    ndkVersion = "30.0.16248370" // NDK r30: sysroot API levels 21 to 37
    defaultConfig {
        minSdk = 36
    }
}
```

0.2.1 and later sort every NDK they find by version and take the newest one that passes the API check, so having r30 installed alongside r28c is enough. Before changing anything, check your installed NDKs yourself:

```bash
# any NDK r23 or later; the host folder is darwin-x86_64 even on Apple silicon
ls "$ANDROID_HOME"/ndk/*/toolchains/llvm/prebuilt/*/sysroot/usr/lib/aarch64-linux-android/
```

The highest number in that listing is the highest `minSdk` that NDK can satisfy for this hook.

## The libcpp_shared_path override and the multi-ABI trap

0.2.1 also added an escape hatch: a user define that points straight at the library. The resulting error message in 0.2.1 and later even suggests it:

```yaml
# pubspec.yaml, android_libcpp_shared 0.2.1
hooks:
  user_defines:
    android_libcpp_shared:
      libcpp_shared_path: /path/to/ndk/toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so
```

When the value is a file, it skips NDK discovery and the API check completely, so it does turn a `minSdk = 36` build green. But it is one path for every architecture. I built a release APK with this override and inspected it:

```text
lib/arm64-v8a/libc++_shared.so:   ELF 64-bit LSB shared object, ARM aarch64
lib/armeabi-v7a/libc++_shared.so: ELF 64-bit LSB shared object, ARM aarch64
lib/x86_64/libc++_shared.so:      ELF 64-bit LSB shared object, ARM aarch64
```

The 32-bit ARM and x86_64 slots now contain an arm64 library. The build succeeds, the app ships, and it fails to load the library on any device or emulator that is not arm64. Only use a file path when you build a single ABI (`--target-platform android-arm64`). If you point the user define, or the `ANDROID_LIBCPP_SHARED_PATH` environment variable, at an NDK root directory instead, the hook resolves each architecture correctly, but that path goes back through the API check, so it does not get around cause 2.

## What the newer versions print instead

If you are on 0.2.1 or later and still fail, you will not see the "No suitable NDK" wording. The hook now throws a longer `StateError` that lists every NDK it considered. My `minSdk = 36` repro on 0.2.1 produced:

```text
Could not find libc++_shared.so for target architecture arm64 (minimum NDK API level 36).
NDK installations considered:
  - 1 NDK installation(s) found, but none support arm64 at API level 36
```

"Found, but none support ... at API level" is cause 2, and step 4 applies. "No Android NDK installation was found" is cause 1 on a machine where even the extended search fails, which usually means the NDK was never downloaded: run one Gradle build of any Android project first, or install it with `sdkmanager "ndk;28.2.13676358"`.

## Lookalikes

- `NDK at .../ndk/<version> did not have a source.properties file` is a half-extracted NDK, and the fix is deleting that directory. That and other NDK version mismatches are covered in [the assembleDebug exit code 1 walkthrough](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- `An error occurred while preparing SDK package NDK (Side by side): Not in GZIP format` means the NDK download itself is corrupt. See [how to clear the SDK Manager's download cache](/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- `No toolchains found in the NDK toolchains folder for ABI with prefix: mips64el-linux-android` is an old Android Gradle Plugin talking to a new NDK. It has nothing to do with build hooks.
- `Building native assets failed` with a different exception above it is another package's hook. Read the `Building assets for package:<name> failed` line to see which one.

## Related

- [Google Play rejecting a Flutter app for 16 KB page size](/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) is the other place where the NDK version you pin decides whether a release ships.
- [The Gradle journal cache lock timeout](/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/) covers how Gradle daemons outlive the build that started them.
- [Resolving AndroidX conflicts in a Flutter Android build](/2026/05/fix-androidx-conflict-during-flutter-android-build/) walks through the `android/app/build.gradle` settings, including `ndkVersion`.

## Sources

- [android_libcpp_shared on pub.dev](https://pub.dev/packages/android_libcpp_shared), including the [changelog](https://pub.dev/packages/android_libcpp_shared/changelog) for 0.2.1 and 0.3.x.
- [NexusDynamic/android_libcpp_shared on GitHub](https://github.com/NexusDynamic/android_libcpp_shared), the hook and `locate_ndk.dart` source.
- [Flutter docs: hooks and native assets](https://docs.flutter.dev/platform-integration/bind-native-code).
- [package:hooks](https://pub.dev/packages/hooks) and [package:code_assets](https://pub.dev/packages/code_assets), the build hook protocol.
- [Android NDK revision history](https://developer.android.com/ndk/downloads/revision_history) for r28c, r29 and r30.
- Flutter 3.44.8 `flutter_tools` source: `lib/src/android/gradle_utils.dart` (default `ndkVersion`), `lib/src/android/android_sdk.dart` (`getNdkBinaryPath`), and `gradle/src/main/kotlin/FlutterPlugin.kt` (`-dMinSdkVersion`).
