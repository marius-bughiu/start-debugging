---
title: "Fix: Unable to load asset in Flutter after adding an image to pubspec.yaml"
description: "The asset key is missing from the compiled bundle, not from your disk. Fix the pubspec indentation, add the trailing slash, match the key exactly, then full restart."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pubspec"
  - "assets"
---

The file is on disk, the path looks right, and Flutter still says it cannot load it. That is because the message is not about your disk: the key you passed is not in the compiled asset bundle. In order of frequency, the reason is an `assets:` block that is not indented under `flutter:`, a directory entry missing its trailing `/`, a file in a subdirectory that was never declared, a key that differs in case from the file name, or a hot reload where a full restart was needed. Fix `pubspec.yaml`, stop the app, and run it again.

```text
======== Exception caught by image resource service ================================================
The following assertion was thrown resolving an image codec:
Unable to load asset: "assets/images/logo.png".
The asset does not exist or has empty data.

When the exception was thrown, this was the stack:
#0      PlatformAssetBundle.load (package:flutter/src/services/asset_bundle.dart:271:7)
<asynchronous suspension>
#1      AssetBundleImageProvider._loadAsync (package:flutter/src/painting/image_provider.dart:951:14)
```

This guide is written against Flutter 3.44.7 and Dart 3.12.2, the stable channel as of 2026-07-20. The behaviour described here has been stable since Flutter 3.16 changed the asset manifest format, and the pubspec rules have not changed in years.

## What the error actually means

`Image.asset('assets/images/logo.png')` does not open a file. It hands a string key to the framework, which asks the engine for the bytes registered under that key in the app's asset bundle. `PlatformAssetBundle.load` throws the moment the engine returns null or a zero-length buffer:

```dart
// flutter/lib/src/services/asset_bundle.dart, Flutter 3.44.7
throw FlutterError.fromParts(<DiagnosticsNode>[
  _errorSummaryWithKey(key),
  ErrorDescription('The asset does not exist or has empty data.'),
]);
```

That bundle is built once, by the `flutter` tool, from the `flutter: assets:` section of `pubspec.yaml`. Everything listed there is copied into `build/flutter_assets/` and indexed in a manifest called `AssetManifest.bin`, which the engine loads at startup. Nothing else on your filesystem exists as far as the running app is concerned.

So two independent things have to line up, and the error cannot tell you which one is wrong:

1. The pubspec declaration has to put the file into the bundle.
2. The key in your Dart code has to match the bundle key byte for byte.

Every cause below is one of those two failing.

## The minimal repro

```
my_app/
  pubspec.yaml
  assets/
    images/
      logo.png
  lib/
    main.dart
```

```yaml
# pubspec.yaml, Flutter 3.44.7
name: my_app

flutter:
  uses-material-design: true
  assets:
    - assets/images/logo.png
```

```dart
// lib/main.dart, Flutter 3.44.7, Dart 3.12.2
import 'package:flutter/material.dart';

void main() => runApp(
      const MaterialApp(
        home: Scaffold(
          body: Center(child: Image.asset('assets/images/logo.png')),
        ),
      ),
    );
```

That works. Break any single line of it in the ways below and you get the error, with no other diagnostic.

## Cause 1: the assets block is not nested under flutter

This is the most common failure and the most frustrating, because nothing complains. `flutter pub get` succeeds, the build succeeds, and the app runs with an empty bundle.

```yaml
# Wrong. Valid YAML, silently ignored.
flutter:
  uses-material-design: true
assets:
  - assets/images/logo.png
```

`assets:` at the top level is a key the Flutter tool does not read. It is not an error, it is just someone else's configuration as far as the parser is concerned. The correct form indents `assets:` exactly two spaces under `flutter:`, with the list items two spaces further in:

```yaml
# Right.
flutter:
  uses-material-design: true
  assets:
    - assets/images/logo.png
```

A related version of this: a second `flutter:` key later in the file. YAML mappings cannot have duplicate keys, and depending on the parser one silently wins. If your pubspec has grown organically, search it for every occurrence of `flutter:` at column zero before you debug anything else.

## Cause 2: a directory entry without a trailing slash, or a subdirectory that was never declared

Directory entries are opt-in per directory, and they are not recursive. From the Flutter documentation on adding assets: "Only files located directly in the directory are included. Resolution-aware asset image variants are the only exception. To add files located in subdirectories, create an entry per directory."

So this declares nothing useful if your images live in `assets/images/icons/`:

```yaml
flutter:
  assets:
    - assets/images/
```

and this is what you need:

```yaml
flutter:
  assets:
    - assets/images/
    - assets/images/icons/
    - assets/images/illustrations/
```

The trailing slash is what makes the entry a directory. `- assets/images` without it is read as a single file named `images`, and because no such file exists the build fails at tool level with a message that is actually helpful:

```text
Error: unable to find directory entry in pubspec.yaml: /path/to/my_app/assets/images/
```

That is worth knowing in reverse: if your build succeeded and you still get `Unable to load asset` at runtime, the entry matched something. The problem is then a key mismatch, not a missing declaration.

The one exception to the non-recursive rule is resolution-aware variants. If you declare `assets/images/logo.png`, then `assets/images/2.0x/logo.png` and `assets/images/3.0x/logo.png` are bundled automatically and `AssetImage` picks the right one for the device pixel ratio. You never declare the variant directories yourself.

## Cause 3: the key in code does not match the key in the bundle

Bundle keys are exact strings. Three ways they drift from what you typed:

**Case.** Your development machine almost certainly has a case-insensitive filesystem (APFS on macOS by default, NTFS on Windows). `Image.asset('assets/images/Logo.png')` resolves a file called `logo.png` locally and fails on an Android device, on iOS, on web, and on any Linux CI runner. If a build works on your laptop and fails everywhere else, check case first. This is the single most likely explanation for a same-code, different-machine split.

**Leading `./` or a stray space.** `'./assets/images/logo.png'` is a different string from `'assets/images/logo.png'`, and the bundle only contains the second. Trailing whitespace inside a quoted YAML value has the same effect.

**The `packages/` prefix.** An asset that ships inside a package you depend on is keyed `packages/<package_name>/<path>`, with the package's `lib/` directory implied and never written out. To load `lib/assets/bg.png` from a package called `fancy_backgrounds`:

```dart
// Flutter 3.44.7. Either form works; they produce the same key.
Image.asset('packages/fancy_backgrounds/assets/bg.png');
Image.asset('assets/bg.png', package: 'fancy_backgrounds');
```

If you wrote the package, it also has to declare those files in its own `pubspec.yaml`. Assets in a dependency are not bundled just because the file exists in `.pub-cache`.

## Cause 4: you hot reloaded when you needed to restart

Hot reload swaps Dart code into a running isolate. The asset bundle and its manifest are produced by the tool when the app is launched. Editing `pubspec.yaml` to add a new entry changes the manifest, and a running app keeps the manifest it started with.

Stop the session and start it again. Not `r`, not `R`:

```bash
# Flutter 3.44.7
# Ctrl-C to end the current run, then:
flutter run
```

Changing the *bytes* of an asset that is already declared is re-bundled on reload and does not need this. Changing the *set* of declared assets does.

## Cause 5: stale output on disk

Rarely the cause, cheap to rule out, and the first thing every answer online tells you to do, which is why it gets blamed for far more failures than it produces. It is a real cause on iOS, where a partially updated `.app` bundle can outlive a rebuild:

```bash
# Flutter 3.44.7
flutter clean
flutter pub get
flutter run
```

If `flutter pub get` is itself what fails on the way through, that is a dependency resolution problem rather than an asset problem, and the constraint solver output is its own exercise: see [reading a version solving failed error in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Stop guessing: print the keys that are actually in the bundle

Every section above is a hypothesis. You can replace all of them with one measurement. `AssetManifest` is the supported API for reading the manifest at runtime, added when `AssetManifest.json` was replaced by `AssetManifest.bin`:

```dart
// Flutter 3.44.7, Dart 3.12.2
import 'package:flutter/services.dart';

Future<void> dumpAssetKeys() async {
  final manifest = await AssetManifest.loadFromAssetBundle(rootBundle);
  for (final key in manifest.listAssets()..sort()) {
    debugPrint(key);
  }
}
```

Call it from `main` behind a `kDebugMode` check and read the console. Whatever is printed is what the engine can serve. If your path is absent, the problem is Cause 1 or 2. If a near-miss of your path is present, it is Cause 3, and the diff between the two strings is your fix.

Do not parse `AssetManifest.bin` yourself. Flutter documents it as an implementation detail whose format can change without an announcement, and `AssetManifest.json` is no longer generated at all, so code that still calls `rootBundle.loadString('AssetManifest.json')` throws this exact error with `AssetManifest.json` as the key.

You can also inspect the bundle without running anything:

```bash
# Flutter 3.44.7. Writes the bundle the engine would load.
flutter build bundle
ls build/flutter_assets/assets/images/

# Or check what shipped inside a built APK:
unzip -l build/app/outputs/flutter-apk/app-debug.apk | grep flutter_assets
```

## Variants that land on this page

- **`Unable to load asset: "fonts/Inter-Regular.ttf"`**. Fonts are declared under `flutter: fonts:`, not `assets:`, and the family name in your `TextStyle` has to match the `family:` value rather than the file name. The failure mode and the fix logic are identical.
- **`Unable to load asset` from `SvgPicture.asset`**. `flutter_svg` loads through the same `AssetBundle`, so the error is the framework's, not the package's. Everything above applies unchanged.
- **The asset exists but "has empty data"**. Read that phrase literally. The usual culprit is Git LFS: a repository where images are LFS-tracked, checked out on a CI runner without `lfs: true`, leaves a 130-byte text pointer where the PNG should be. The build succeeds, the bundle contains the key, and the decode fails. Check the file size before you check anything else. A `.gitignore` or `.dockerignore` rule that excludes `assets/` produces the same local-passes-CI-fails shape, which is worth ruling out when you are [running builds across several Flutter versions in one pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).
- **Only broken on Flutter web, only after deploying**. If the app is hosted under a subpath, `build/web/index.html` needs `<base href="/my-app/">` and the build needs `flutter build web --base-href /my-app/`. Without it the engine requests `/assets/...` from the domain root and gets a 404, which surfaces as this error. The same trap applies to a [WebAssembly build with `flutter build web --wasm`](/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/).
- **Only broken in `flutter test`**. Assets declared in `pubspec.yaml` do work in widget tests: the tool builds `build/unit_test_assets/`, exports its path as `UNIT_TEST_ASSETS`, and `mockFlutterAssets()` serves keys from it. Two things still break. Assets bundled conditionally per flavor are not in that directory, and a golden test that renders `Image.asset` needs the load to complete, so wrap the pump in `tester.runAsync` or call `precacheImage` before comparing.
- **Only broken in release, not debug**. Not an asset problem. Check whether the code path that builds the key is being reached at all, and whether a `const` string is being assembled from something that differs between build modes.
- **The Android build never got far enough to bundle anything**. If the failure is at build time rather than runtime, you are looking at [a Gradle task that failed with exit code 1](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/), and no amount of pubspec editing will help.

The through-line: this error is a lookup miss in a data structure your build produced. Treat it that way. Print `listAssets()`, compare the string you passed against the strings that exist, and the fix is always one of the two sides of that comparison.

## Related

- [Fix: Version solving failed in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- when the `flutter pub get` in the clean-rebuild sequence is itself what fails.
- [Fix: Gradle task assembleDebug failed with exit code 1 in a Flutter Android build](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) -- the build-time counterpart, where the bundle never gets produced.
- [How to build a Flutter web app with WebAssembly](/2026/07/how-to-build-a-flutter-web-app-with-webassembly-using-flutter-build-web-wasm/) -- covers the base href and hosting-path setup that breaks web asset URLs.
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) -- the checkout and caching details behind most local-passes-CI-fails asset reports.
- [Fix: Cannot provide both a color and a decoration in a Flutter Container](/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/) -- the other error that shows up the first time you put an image behind a styled box.

## Sources

- [Adding assets and images](https://docs.flutter.dev/ui/assets/assets-and-images), Flutter docs
- [Removal of AssetManifest.json](https://docs.flutter.dev/release/breaking-changes/asset-manifest-dot-json), Flutter docs
- [`AssetManifest` class](https://api.flutter.dev/flutter/services/AssetManifest-class.html), Flutter API reference
- [`asset_bundle.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/services/asset_bundle.dart), flutter/flutter
- [`_binding_io.dart` and `mockFlutterAssets`](https://github.com/flutter/flutter/blob/stable/packages/flutter_test/lib/src/_binding_io.dart), flutter/flutter
- [Conditionally bundling assets based on flavor makes tests fail](https://github.com/flutter/flutter/issues/150296), flutter/flutter
