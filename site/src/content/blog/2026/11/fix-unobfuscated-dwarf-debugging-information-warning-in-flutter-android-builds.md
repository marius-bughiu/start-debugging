---
title: "Fix: The generated ELF library contains unobfuscated DWARF debugging information (Flutter --obfuscate --split-debug-info)"
description: "Since Flutter 3.44, Android builds leave stripping to AGP, so gen_snapshot warns about an intermediate file. The shipped libapp.so is still stripped. Ignore it; don't add --strip."
pubDate: 2026-11-17
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "dart"
---

If `flutter build appbundle --obfuscate --split-debug-info=<dir>` (or `flutter build apk` with the same flags) prints `Warning: The generated ELF library contains unobfuscated DWARF debugging information` after upgrading to Flutter 3.44, nothing is wrong with your app and there is nothing to fix in your Gradle files. Since 3.44 the Flutter tool no longer passes `--strip` to the Dart AOT compiler on Android. It leaves stripping to the Android Gradle Plugin, so the compiler warns about an intermediate `app.so` that AGP strips a few seconds later. The `libapp.so` that ships in the AAB or APK has no DWARF and no symbol table. Do **not** follow the warning's advice with `--extra-gen-snapshot-options=--strip`: for app bundles it makes the build fail. Everything below was reproduced with Flutter 3.44.8 (Dart 3.12.2), AGP 9.0.1, Gradle 9.1.0, NDK 28.2.13676358, on macOS 27.0.

## The error in context

This is the report from a [Stack Overflow question from August 2026](https://stackoverflow.com/questions/79989952), posted after moving from Flutter 3.41.9 to 3.44.8 and following the AGP 9 migration steps. The same text is in [flutter/flutter#190267](https://github.com/flutter/flutter/issues/190267), opened in July 2026 against 3.44.8:

```text
Running Gradle task 'bundleRelease'...
Warning: The generated ELF library contains unobfuscated DWARF debugging information.
         To avoid this, use --strip to remove it.
Warning: The generated ELF library contains unobfuscated DWARF debugging information.
         To avoid this, use --strip to remove it.
Warning: The generated ELF library contains unobfuscated DWARF debugging information.
         To avoid this, use --strip to remove it.
✓ Built build/app/outputs/bundle/release/app-release.aab (41.3MB)
```

It prints once per target ABI (`android-arm`, `android-arm64`, `android-x64` by default), which is why it usually shows up three times. The build still succeeds.

Two details in the Stack Overflow question send people in the wrong direction. First, `--strip` is not a `flutter build` option at all: the message comes from `gen_snapshot`, the Dart AOT compiler that Flutter runs underneath, and `--strip` is one of its flags. Second, the asker saw it only for `appbundle`, not for `apk`. That is a build cache effect, covered below. Both commands warn on a clean build.

## Why this happens

The warning is printed by `gen_snapshot` when two conditions are true at once: it was asked to obfuscate (`--obfuscate`), and it was not asked to strip (`--strip`). In that combination the ELF file it writes contains DWARF sections and a `.symtab` whose function names are the real Dart names, not the obfuscated ones, which defeats the point of obfuscation if that file were to ship. Both message variants are in the 3.44.8 engine's `gen_snapshot` binary for Android:

```text
Warning: Generating %s without DWARF debugging information.
Warning: The generated %s contains unobfuscated DWARF debugging information.
```

Before Flutter 3.44, the tool always added `--strip` to `gen_snapshot` on Android, so the second message never appeared. The first one (the `--strip` variant) is on the tool's list of warnings it silences, `kIgnoredWarnings` in `packages/flutter_tools/lib/src/base/build.dart`. The new one is not on that list, so it reaches your terminal.

What changed is [flutter/flutter#181275](https://github.com/flutter/flutter/pull/181275), "Don't strip symbols from `libapp.so` on android by default", merged in January 2026 and first released in 3.44.0. It is a reland of [#162464](https://github.com/flutter/flutter/pull/162464), which was reverted in [#171044](https://github.com/flutter/flutter/pull/171044) before 3.35 branched, so no stable release shipped the first attempt. The motivation is [flutter/flutter#170664](https://github.com/flutter/flutter/issues/170664): when an ANR or native crash lands inside Dart code, Play Console shows raw addresses in `libapp.so` because the native symbols were thrown away at compile time. The fix was to follow what iOS already does with dSYMs: keep the symbols in the compiler output, let AGP strip the library, and let AGP put the symbol table into the bundle metadata that Play Console uses to symbolicate. The relevant code in 3.44.8 is short:

```dart
// Flutter 3.44.8, packages/flutter_tools/lib/src/base/build.dart
} else if (targetingAndroidPlatform) {
  stripAfterBuild = false;
  // When building for Android, we let AGP handle stripping of debug symbols.
} else {
  stripAfterBuild = false;
  if (shouldStrip) {
    genSnapshotArgs.add('--strip');
  }
}
```

So the warning describes `build/app/intermediates/flutter/release/<abi>/app.so`, a file that never leaves your machine. Nobody updated the ignore list for the new message. As of the `master` branch on 2026-11-17, `kIgnoredWarnings` is unchanged, so newer releases still print it.

## Minimal repro

A fresh project is enough. The class below is only there so there is a recognizable app-level name to search for in the binaries; `@pragma('vm:never-inline')` stops the AOT compiler from inlining the method into `main`, which would otherwise make the name disappear for reasons that have nothing to do with obfuscation.

```dart
// Flutter 3.44.8, Dart 3.12.2 - lib/main.dart
import 'package:flutter/material.dart';

class SecretPaymentProcessor {
  @pragma('vm:never-inline')
  String chargeCustomerCard(int cents) => 'charged $cents';
}

void main() {
  runApp(MaterialApp(
    home: Scaffold(
      body: Center(
        child: Text(SecretPaymentProcessor().chargeCustomerCard(42)),
      ),
    ),
  ));
}
```

```bash
# Flutter 3.44.8, AGP 9.0.1, Gradle 9.1.0
flutter create --platforms=android dwarfapp
cd dwarfapp
# replace lib/main.dart with the code above
flutter build appbundle --obfuscate --split-debug-info=out
```

That prints the warning three times and builds the AAB. Here is the matrix from clean builds (`flutter clean` before each one):

| Command | Warning | Build result |
| --- | --- | --- |
| `flutter build appbundle --obfuscate --split-debug-info=out` | 3 times | Succeeds |
| `flutter build apk --obfuscate --split-debug-info=out` | 3 times | Succeeds |
| `flutter build appbundle --split-debug-info=out` (no `--obfuscate`) | None | Succeeds |
| `flutter build appbundle --obfuscate --split-debug-info=out --extra-gen-snapshot-options=--strip` | None | **Fails** |
| `flutter build apk --obfuscate --split-debug-info=out --extra-gen-snapshot-options=--strip` | None | Succeeds |

The "APK does not warn" observation is caching. Running `flutter build apk` right after an `appbundle` build reuses the AOT snapshots that were already compiled for the same flags and finishes in a few seconds without running `gen_snapshot` at all, so there is nothing to warn about. After `flutter clean` the APK build warns exactly like the bundle build.

## Checking what actually ships

The warning is about a file. It is worth looking at each file instead of trusting either the warning or this post. The NDK's LLVM tools are enough (adjust the NDK path to yours):

```bash
# NDK 28.2.13676358 on macOS; Flutter 3.44.8 build output
NDK_BIN=$ANDROID_SDK/ndk/28.2.13676358/toolchains/llvm/prebuilt/darwin-x86_64/bin

# 1. The intermediate file gen_snapshot warned about
$NDK_BIN/llvm-readelf -S -W build/app/intermediates/flutter/release/arm64-v8a/app.so \
  | grep -E '\.debug|\.symtab'
$NDK_BIN/llvm-readelf -s -W build/app/intermediates/flutter/release/arm64-v8a/app.so \
  | grep SecretPayment
```

The intermediate `app.so` (3,666,368 bytes for arm64 here) has `.debug_abbrev`, `.debug_info`, `.debug_line`, `.symtab` and `.strtab`. The symbol table has entries like `SecretPaymentProcessor.chargeCustomerCard` and framework names such as `ScaffoldState.handleStatusBarTap`, all in clear text, and the DWARF line table contains the absolute path of your `lib/main.dart` on the build machine. That is exactly what the warning says.

Now the copies that leave the build:

```bash
# 2. The library inside the app bundle (what devices get)
unzip -o build/app/outputs/bundle/release/app-release.aab \
  'base/lib/arm64-v8a/libapp.so' -d aab
$NDK_BIN/llvm-readelf -S -W aab/base/lib/arm64-v8a/libapp.so | grep -cE '\.debug|\.symtab'
strings aab/base/lib/arm64-v8a/libapp.so | grep -c SecretPayment

# 3. The symbol file AGP put in the bundle metadata (what Play Console gets)
unzip -l build/app/outputs/bundle/release/app-release.aab | grep debugsymbols
```

The shipped `base/lib/arm64-v8a/libapp.so` is 2,425,744 bytes, has no `.debug_*` and no `.symtab` section, and contains no `SecretPayment` string. It is the output of AGP's `stripReleaseDebugSymbols` task, which (per the build log in the Flutter PR below) runs the NDK's `llvm-strip --strip-unneeded` over every `.so`. The `libapp.so` inside a release APK checks out the same way. Obfuscation is intact in what users download.

The bundle also contains `BUNDLE-METADATA/com.android.tools.build.debugsymbols/<abi>/libapp.so.sym` (2,801,904 bytes for arm64), next to `libflutter.so.sym`. That file keeps `.symtab` with the clear names, and that is the whole point of the 3.44 change: Play Console reads it to symbolicate native crashes and ANRs in Dart code. Google Play does not deliver bundle metadata to devices. If you upload the AAB, the real names reach Google's servers, the same way your `out/app.android-arm64.symbols` file (which also contains `SecretPaymentProcessor.chargeCustomerCard`) has always held them for `flutter symbolize`.

## Fix, in detail

There is no Gradle or Flutter setting that removes the warning while keeping the 3.44 behavior. In order of recommendation:

1. **Ignore the warning.** It refers to an intermediate file that AGP strips before packaging. Keep passing `--obfuscate --split-debug-info=<dir>`, keep archiving that directory per release, because it is what [`flutter symbolize`](https://docs.flutter.dev/deployment/obfuscate) needs to read obfuscated Dart stack traces. If your CI fails on warnings by grepping logs, add this exact message to the allowlist rather than changing the build.
2. **Verify once, then move on.** Run the `llvm-readelf` checks above against your own release AAB or APK. If the shipped `libapp.so` has no `.symtab`, you are done. This is a better check than the absence of a warning, because the warning never looked at the shipped file in the first place.
3. **Only for APK-only pipelines, if you must silence it:** `flutter build apk --obfuscate --split-debug-info=out --extra-gen-snapshot-options=--strip` builds, writes the same three `.symbols` files, and prints no warning. The intermediate `app.so` then has no `.debug_*` or `.symtab` sections. The cost is that you opt back out of the native symbols that 3.44 started keeping. For an APK that matters little, because APKs carry no bundle metadata anyway, but it is a flag you have to remember to remove if you switch to app bundles.

Do not use the `--strip` option for `flutter build appbundle`. It fails with:

```text
Release app bundle failed to strip debug symbols from native libraries.
Please run flutter doctor and ensure that the Android toolchain does not
report any issues.

Otherwise, file an issue at https://github.com/flutter/flutter/issues.
```

The message suggests a toolchain problem, but the cause is a check in `packages/flutter_tools/lib/src/android/gradle.dart`, `_isAabStrippedOfDebugSymbols`. After a release bundle build, the tool runs `apkanalyzer files list` on the AAB and requires both `libflutter.so.sym` (or `.dbg`) and `libapp.so.sym` (or `.dbg`) to be present. It treats them as proof that AGP stripped the native libraries and moved the symbols aside. When `gen_snapshot` has already stripped `app.so`, AGP finds nothing to extract, writes no `libapp.so.sym`, and the check fails. That is the second half of what the reporter of [#190267](https://github.com/flutter/flutter/issues/190267) ran into, and why a triager could reproduce the failure but not the warning on a different machine. The same check also explains why the tool needs `cmdline-tools` (for `apkanalyzer`) installed to build any release bundle.

## Gotchas and variants

- **The warning appears without `--obfuscate`?** It should not. Without obfuscation the DWARF names are not "unobfuscated" by definition, so `gen_snapshot` stays quiet. In the matrix above, `--split-debug-info` alone produced no warning.
- **Three warnings, but you build one ABI.** `flutter build appbundle` targets `android-arm`, `android-arm64` and `android-x64` unless you pass `--target-platform`. One warning per `gen_snapshot` run.
- **"It used to work on 3.41."** Correct. 3.41.x still passed `--strip` on Android. The change is in the tool, not in anything the AGP 9 migration made you edit, so reverting `settings.gradle.kts` or `gradle.properties` (including `android.builtInKotlin` and `android.newDsl`) has no effect on the warning. If you are mid-migration for other reasons, the separate [AGP 9 migration guide for Flutter](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) covers those flags.
- **Does this weaken obfuscation in production?** Not for the shipped binary, as shown above. What changed is that real symbol names now also go to Play Console inside the bundle metadata. Teams with strict rules about what leaves their build machines should know that, and should treat the `--split-debug-info` directory as equally sensitive, as they always should have.
- **`--extra-gen-snapshot-options=--no-strip`.** This value is consumed by the Flutter tool itself (it turns off the tool's own stripping on desktop and iOS) and is not passed to `gen_snapshot`. On Android in 3.44 it changes nothing, because the tool no longer strips there.
- **Release build crashes at startup instead.** A different problem: see [the "Could not create Dart VM instance" fix](/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/) for release builds that compile fine but die on launch.

## Related

- [Migrate a Flutter Android project to AGP 9 with built-in Kotlin](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) for the migration that usually comes alongside the 3.44 upgrade.
- [What a Flutter flavor is and how it differs from a build mode](/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/), which also inspects `libapp.so` from a release APK to prove what the AOT compiler folded in.
- [Fix: ClassNotFoundException for MainActivity when a Flutter Android app launches](/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/) for an R8 and namespace problem that only shows up in release builds.
- [Fix: flutter doctor --android-licenses fails with cmdline-tools 23](/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/), relevant because the bundle symbol check above depends on `apkanalyzer` from cmdline-tools.

## Sources

- [Stack Overflow: flutter build appbundle warning "unobfuscated DWARF debugging information"](https://stackoverflow.com/questions/79989952)
- [flutter/flutter#190267: Obfuscate not working properly](https://github.com/flutter/flutter/issues/190267)
- [flutter/flutter#181275: [Reland] Don't strip symbols from libapp.so on android by default](https://github.com/flutter/flutter/pull/181275)
- [flutter/flutter#170664: Generate symbol files for AOT snapshots even without split-debug-info](https://github.com/flutter/flutter/issues/170664)
- [Flutter docs: Obfuscate Dart code](https://docs.flutter.dev/deployment/obfuscate)
- [Android docs: Include native symbols in your app bundle](https://developer.android.com/build/include-native-symbols)
- [`build.dart` in flutter_tools (master)](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/lib/src/base/build.dart) and [`gradle.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/lib/src/android/gradle.dart)
