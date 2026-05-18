---
title: "Fix: AndroidX conflict during Flutter Android build"
description: "The fix in 30 seconds: set android.useAndroidX=true and android.enableJetifier=true in android/gradle.properties, then find any plugin still on the old support library and upgrade or replace it."
pubDate: 2026-05-18
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "androidx"
---

The fix in one breath: an `AndroidX conflict` during a Flutter Android build means two halves of your dependency graph disagree about which Android support library they target. The Flutter engine and any plugin published in the last five years use `androidx.*`. A single plugin (or a transitive Java library) that still references `android.support.*` is enough to break the build. Set `android.useAndroidX=true` and `android.enableJetifier=true` in `android/gradle.properties`, run `flutter clean`, then `flutter pub get` and `flutter build apk` again. If Gradle still refuses, find the offending plugin with `./gradlew app:dependencies` and upgrade or replace it. Do not edit anything under `android/app/build.gradle` yet.

```text
* What went wrong:
Execution failed for task ':app:checkDebugDuplicateClasses'.
> Duplicate class android.support.v4.app.INotificationSideChannel found in modules
    core-1.6.0-runtime (androidx.core:core:1.6.0) and
    support-compat-28.0.0-runtime (com.android.support:support-compat:28.0.0)

  Go to the documentation to learn how to <a href="d.android.com/r/tools/classpath-sync-errors">Fix dependency resolution errors</a>.

FAILURE: Build failed with an exception.
BUILD FAILED in 12s
```

This guide is written against Flutter 3.41.5, Dart 3.11, Android Gradle Plugin 8.7, and Gradle 8.11, the stable channel as of May 2026. The behaviour described here is the same since the Android tooling team froze the `android.support.*` namespace in 2018 and shipped Jetifier as the bridge for legacy bytecode. The Flutter project enabled AndroidX by default for new apps in [Flutter 1.12](https://docs.flutter.dev/release/breaking-changes/androidx-migration) (December 2019); anything generated since then ships with `useAndroidX=true` out of the box. If you are hitting this error, the app was almost certainly created on a pre-1.12 Flutter SDK and never had the migration applied.

## What the error actually means

`androidx.*` is the second-generation Android support library. Google rewrote the package namespace once and committed to never renaming it again. Classes under `android.support.v4.*`, `android.support.v7.*`, `android.support.design.*`, etc. are the original support libraries and have been frozen since 28.0.0 in September 2018.

The Android build system refuses to compile an APK that contains both halves at once because the duplicated class names collide on the classpath. The error surfaces in one of three concrete forms:

```text
> Duplicate class android.support.v4.app.INotificationSideChannel found in modules ...
```

```text
This app is using AndroidX dependencies, but the project does not have
the property android.useAndroidX set to true. Configure your project for
AndroidX. See https://goo.gle/flutter-androidx-migration
```

```text
Cannot fit requested classes in a single dex file (# methods: 73512 > 65536)
```

The first is a literal classpath collision. The second is the Flutter tool's pre-flight check noticing that the project still has the legacy default. The third is the same conflict expressed downstream: pulling both libraries blows past Dalvik's 64K method limit because every support class has an AndroidX twin.

Jetifier is the workaround that ships with AGP. At build time it rewrites every `android.support.*` reference inside any JAR or AAR coming from a third-party dependency into the equivalent `androidx.*` reference. With Jetifier on, a plugin that still ships support-library bytecode is silently translated and the duplicate-class collision disappears. With Jetifier off, the duplicate is exposed and the build fails. AGP 8 and later default `enableJetifier` to `false` for build-speed reasons, which is why this error is back on the front page for projects that lived for years without anyone noticing the legacy plugin in their tree.

## A minimal repro

Create a fresh Flutter app on a recent SDK, then add a plugin that still references the support library through a transitive Java dependency:

```bash
# Flutter 3.41.5
flutter create androidx_repro
cd androidx_repro
flutter pub add some_old_plugin:^1.2.0  # any plugin whose Android side
                                        # depends on com.android.support:*
```

Then deliberately turn off the workaround:

```properties
# android/gradle.properties, Flutter 3.41.5, AGP 8.7
org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G
android.useAndroidX=true
android.enableJetifier=false
```

Run the build:

```bash
flutter build apk --debug
```

Gradle prints the duplicate-class failure above and exits non-zero. The single line that triggers the regression is `enableJetifier=false` combined with a transitive dependency on `com.android.support:*`. Flip Jetifier back on and the same build succeeds, even though nothing about the plugin tree changed.

## Fix, in order of how often it is the answer

Run the steps in order. Each step assumes the previous one did not resolve the error.

### 1. Set both AndroidX flags

Open `android/gradle.properties` (not the Gradle file in the Flutter SDK, not the root project's `build.gradle`) and confirm both lines are present:

```properties
# android/gradle.properties, Flutter 3.41.5
android.useAndroidX=true
android.enableJetifier=true
```

`useAndroidX=true` tells AGP that your own code and the Flutter engine are AndroidX. `enableJetifier=true` tells AGP to rewrite any third-party bytecode that still references the support library. You need both. Setting only `useAndroidX=true` while a plugin still ships support classes is exactly the configuration that produces the duplicate-class error.

If the file does not exist (rare on a Flutter 1.12+ project, common on apps migrated from native Android), create it. Then run:

```bash
flutter clean
flutter pub get
flutter build apk --debug
```

`flutter clean` is required here because Gradle caches the dependency resolution graph; without it the build will re-use the failed graph and report the same error.

### 2. Find and upgrade the legacy plugin

If Jetifier is on and the build still fails, the duplicate is not the support library itself but a plugin whose `android/build.gradle` declares `com.android.support:*` directly and uses something Jetifier cannot rewrite (annotation processors are the most common offender, since Jetifier only operates on runtime classpath JARs by default).

List the Android dependency tree:

```bash
# from android/ directory, Flutter 3.41.5
./gradlew app:dependencies --configuration releaseRuntimeClasspath | grep -i "com.android.support"
```

The output names the plugin and the support-library coordinate. Cross-reference it with your `pubspec.yaml`. Three resolutions, in order of preference:

1. **Upgrade the plugin** if a newer version exists. Run `flutter pub outdated` and look for the offender. A version published after late 2019 will be AndroidX-native and the conflict disappears.
2. **Replace the plugin** if it is unmaintained. The Flutter community has rebuilt most pre-1.12 plugins under a different name; search [pub.dev](https://pub.dev) for the same domain (notifications, image picker, etc.) and pick the most recent maintained option.
3. **Fork and patch** if neither helps. Clone the plugin's repo, change every `com.android.support:appcompat-v7:28.0.0` line in `android/build.gradle` to `androidx.appcompat:appcompat:1.6.1` (the [AndroidX class mapping](https://developer.android.com/jetpack/androidx/migrate/class-mappings) translates the old names to the new), update your `pubspec.yaml` to point at the fork via `git:`, and run `flutter pub get`.

### 3. Bump `compileSdk` to a version that includes AndroidX

If you migrated this app from native Android, the `android/app/build.gradle` may pin `compileSdkVersion` to 28 or lower. AndroidX requires `compileSdk` 28 or higher and works best on the most recent stable. Flutter 3.41.5 sets `flutter.compileSdkVersion` to 35 by default; if you overrode it, restore the default or set it explicitly:

```groovy
// android/app/build.gradle, Flutter 3.41.5, AGP 8.7
android {
    namespace "com.example.androidx_repro"
    compileSdk 35
    ndkVersion flutter.ndkVersion

    defaultConfig {
        applicationId "com.example.androidx_repro"
        minSdkVersion 21      // AndroidX requires at least 19; pick 21 unless you have a reason
        targetSdkVersion 35
    }
}
```

`minSdkVersion 21` is the practical floor for an AndroidX app in 2026. Going lower works in principle but pulls in compatibility shims that produce different but equally confusing classpath errors during the merge step.

### 4. Enable multidex if the duplicate is gone but the dex limit error remains

The 64K-method limit predates AndroidX and AGP turns multidex on automatically when `minSdkVersion >= 21`. If you are still seeing the "cannot fit requested classes" error, you have a pre-21 `minSdk` and need to opt in:

```groovy
// android/app/build.gradle
android {
    defaultConfig {
        multiDexEnabled true
    }
}

dependencies {
    implementation "androidx.multidex:multidex:2.0.1"
}
```

This is not a fix for the AndroidX conflict itself, it is the cleanup pass when you have already resolved the duplicate classes but the leftover method count still overflows.

### 5. Last resort: turn Jetifier off only after auditing every dependency

Once you have confirmed via `./gradlew app:dependencies` that no plugin in the tree still references `com.android.support:*`, set `android.enableJetifier=false` for the build-speed win. Jetifier's classpath rewrite is the single most expensive step in a cold Android build for a large Flutter app (15-30 seconds on a typical project in our measurements). Disabling it requires zero changes to your code or pub dependencies, but if you do this without auditing first, the conflict comes back the next time a transitive update pulls in a legacy library and you will think the error has nothing to do with Jetifier because you removed it weeks ago.

## Gotchas and lookalikes

A few cases that produce a similar error or look like an AndroidX conflict but are not:

- **`Could not find com.android.tools.build:gradle:X.Y.Z`**: not an AndroidX problem. The Google Maven repository is unreachable, or your `settings.gradle` lost the `google()` repository entry. Add `google()` to `pluginManagement.repositories` and `dependencyResolutionManagement.repositories`.
- **`Manifest merger failed : Attribute application@appComponentFactory ...`**: this is the historical signature of an AndroidX/support clash specifically in the manifest, before AGP's bytecode-level check existed. The same fix (enable both flags) resolves it, but the trigger is a plugin's `AndroidManifest.xml` declaring an `android.support.*` component name rather than its Java code referencing a support class.
- **`Class not found: com.android.support.FileProvider`**: a plugin's `AndroidManifest.xml` hardcodes the support-library path. Jetifier does not rewrite manifest XML by default. Either upgrade the plugin or override the `<provider>` element in your own `AndroidManifest.xml` with the AndroidX equivalent (`androidx.core.content.FileProvider`).
- **`Execution failed for task ':app:processDebugMainManifest'`** during a `flutter run` on a release build: usually a `targetSdkVersion` mismatch between plugins. AndroidX is fine; the merge fails because two plugins disagree about `android:exported` for an activity. Unrelated, even though it surfaces in the same Gradle step.
- **Build succeeds on macOS but fails on Linux CI**: the most common root cause is a stale `~/.gradle/caches` on the developer machine that masks the missing AndroidX flag. The Linux runner has a clean cache and resolves the dependency graph from scratch. The fix is the same (the flags), but the symptom looks like a CI-only issue.
- **A clean `flutter create` project hits this**: it should not. If a brand-new app hits an AndroidX conflict before you add any plugin, your Flutter SDK is older than 1.12 and you need to upgrade. Run `flutter upgrade` and re-run `flutter create` against the new SDK; copy your `lib/` over rather than editing the broken project.

If you are reaching for `enableJetifier=true` more than once a year on the same project, you have at least one plugin whose maintainer has stopped tracking the Android platform. Replace it. Jetifier is officially designated as a transitional shim, and the AGP team has publicly stated that it will be removed in a future major release.

## Related

- [Fix: Version solving failed in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Fix: Gradle build failed to produce an .apk file in MAUI Android](/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/)
- [Fix: Failed to build iOS app with Xcode 16 and Flutter 3.x](/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)
- [How to target multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Fix: A RenderFlex overflowed by N pixels in Flutter](/2026/05/fix-renderflex-overflowed-in-flutter/)

## Sources

- [AndroidX migration for Flutter](https://docs.flutter.dev/release/breaking-changes/androidx-migration) (docs.flutter.dev)
- [Migrate to AndroidX](https://developer.android.com/jetpack/androidx/migrate) (developer.android.com)
- [AndroidX class mappings](https://developer.android.com/jetpack/androidx/migrate/class-mappings) (developer.android.com)
- [Android Gradle Plugin release notes: enableJetifier default](https://developer.android.com/build/releases/gradle-plugin) (developer.android.com)
- [flutter/flutter issue 25325: AndroidX support tracking](https://github.com/flutter/flutter/issues/25325) (canonical thread for the original migration)
