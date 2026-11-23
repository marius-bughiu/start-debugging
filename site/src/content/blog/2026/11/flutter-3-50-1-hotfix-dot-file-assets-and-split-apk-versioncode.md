---
title: "Flutter 3.50.1 Brings Back Your .env Asset and Unique Split APK versionCodes"
description: "Flutter 3.50.1 is the first stable hotfix for 3.50. It restores Android assets whose names start with a dot, gives --split-per-abi APKs distinct versionCodes again, and fixes an applicationIdSuffix Gradle failure and a web build that deleted index.html."
pubDate: 2026-11-23
tags:
  - "flutter"
  - "dart"
  - "android"
  - "flutter-web"
---

Flutter 3.50.1, the first stable hotfix for the 3.50 line, was tagged on November 19, 2026. It still ships with Dart 3.14.0, and its [CHANGELOG entry](https://github.com/flutter/flutter/blob/stable/CHANGELOG.md) lists eleven fixes. Most of them are tool crashes you would notice immediately. Two of them are worse: Android builds on 3.50.0 could succeed and still produce something broken.

## Assets starting with a dot vanished from the APK

On Flutter 3.50.0, Android builds silently dropped assets whose file names start with a dot (such as `.env`) and assets inside folders starting with an underscore. The build did not fail. The asset was simply missing from the APK or AAB, and the app failed at runtime. The report in [flutter/flutter#196444](https://github.com/flutter/flutter/issues/196444) uses the very common `flutter_dotenv` setup:

```yaml
# pubspec.yaml
flutter:
  assets:
    - .env
```

```dart
import 'package:flutter/widgets.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // 3.50.0 on Android: FileNotFoundError, ".env" not found
  await dotenv.load(fileName: '.env');
  runApp(const MyApp());
}
```

The same file renamed to `env` loaded fine, which is what pointed to the leading dot. If you renamed assets as a workaround on 3.50.0, you can rename them back after upgrading.

## Every split APK got the same versionCode

The second silent regression, [flutter/flutter#196559](https://github.com/flutter/flutter/issues/196559), hits older projects that declare `android:versionCode` only in `AndroidManifest.xml`. Before 3.50, `flutter build apk --split-per-abi` offset that value per ABI. A refactor in 3.50.0 stopped doing it for manifest-only version codes, so every split APK got the same number, and Google Play rejects multiple APKs with the same versionCode. The build only printed a warning.

3.50.1 restores the per-ABI offset. The workaround from the issue is still the cleaner setup, because it keeps the version in one place:

```kotlin
// android/app/build.gradle.kts
android {
    defaultConfig {
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }
}
```

Then remove `android:versionCode` from `AndroidManifest.xml`.

## The rest of the hotfix

- **Gradle and `buildType` settings**: apps with plugins and custom or app-only build type settings, for example `applicationIdSuffix = ".profile"` on the `profile` build type, failed Gradle configuration with "Library projects cannot set applicationIdSuffix" ([#196412](https://github.com/flutter/flutter/issues/196412)).
- **Gradle configuration cache**: Gradle could not store the cache entry for Flutter Android builds, so it never reused it ([#195006](https://github.com/flutter/flutter/pull/195006)).
- **Web content hash**: running `flutter build web` without `--web-content-hash` after a build that used it deleted `build/web/index.html` ([#196452](https://github.com/flutter/flutter/issues/196452)). If you adopted the flag introduced in 3.50 (covered in [Flutter 3.50 opens WebAssembly to Safari and Firefox](/2026/11/flutter-3-50-wasm-on-safari-and-firefox-and-web-content-hash/)), this one is worth the upgrade alone.
- **Wasm text rendering**: dynamic text under `--wasm` with cross-origin isolation enabled could freeze or crash the app ([#193695](https://github.com/flutter/flutter/issues/193695)).
- **`flutter run -d chrome`**: large web apps hit a `TimeoutException` connecting to the debug service ([dart-lang/webdev#2883](https://github.com/dart-lang/webdev/issues/2883)).
- **Tool crashes**: unhandled `RPCError` in `flutter screenshot --type=skia` with Impeller and in `flutter run`/`flutter attach` when the device temp directory is full or inaccessible, plus a `Cross-device link` `FileSystemException` in `flutter test` on external macOS volumes.
- **Linux**: content shifted on drivers without `glBlitFramebuffer`.

## Upgrading

```bash
flutter channel stable
flutter upgrade
flutter --version   # Flutter 3.50.1, Dart 3.14.0
```

The standalone Dart SDK also moved to [3.14.1 on November 17](https://github.com/dart-lang/sdk/blob/stable/CHANGELOG.md), fixing an AOT compiler crash when a `final` local assigned in a pattern `switch` is captured by a closure. That fix is not part of Flutter 3.50.1, which still pins Dart 3.14.0.

If you ship Android builds with dot-file assets or split APKs, check the artifacts you produced on 3.50.0 before they reach Play: those two bugs did not fail the build, so CI would not have caught them.
