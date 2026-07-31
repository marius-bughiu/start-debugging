---
title: "Fix: Gradle task assembleDebug failed with exit code 1 in a Flutter Android build"
description: "That line is a wrapper, not the error. Re-run with flutter run --verbose or ./gradlew assembleDebug --stacktrace, read the real Gradle failure, then fix that."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "dart"
---

The fix in one breath: `Gradle task assembleDebug failed with exit code 1` is not an error, it is Flutter reporting that Gradle exited non-zero. The real failure is printed above it and is almost always truncated out of the console. Re-run with `flutter run --verbose`, or drop into `android/` and run `./gradlew assembleDebug --stacktrace`, and fix whatever Gradle actually says under `* What went wrong:`. In July 2026 the single most common answer is Android Gradle Plugin 9's built-in Kotlin colliding with the legacy `kotlin-android` plugin, which shows up as `Cannot add extension with name 'kotlin'`.

```text
FAILURE: Build failed with an exception.

BUILD FAILED in 47s
Running Gradle task 'assembleDebug'...                             48.2s
Error: Gradle task assembleDebug failed with exit code 1
```

This guide is written against Flutter 3.44.7 and Dart 3.12.2, the stable channel as of 2026-07-20, with notes on Android Gradle Plugin (AGP) 8.x and 9.x, Gradle 8.13, and JDK 17 and 21. The diagnosis procedure has not changed in years; the ranked causes below have, and the top one is new as of the AGP 9 rollout.

## Why the message tells you nothing

`assembleDebug` is an Android Gradle task. The Flutter tool shells out to the Gradle wrapper in your project's `android/` directory, streams the output, and then checks the exit code. If the code is non-zero, the tool raises exactly one line: the task name and the exit code. It has no idea what went wrong, because Gradle failures are not typed, they are text.

Two things then conspire against you:

1. The Flutter tool filters Gradle's output. It hides the noisy configuration-phase chatter so a normal build looks clean, and in doing so it sometimes drops the block you need.
2. Gradle itself truncates. Without `--stacktrace`, a `Caused by:` chain three levels deep gets summarized to a single line that may not name the offending plugin.

So the first move is never to guess. It is to make the build print the truth.

## Get the real error before you change anything

Run these in order and stop at the first one that gives you a `* What went wrong:` block naming a task and a cause:

```bash
# Flutter 3.44.7, Dart 3.12.2
flutter run --verbose
```

If that is still opaque, bypass the Flutter tool entirely and talk to Gradle directly. This is the step most people skip, and it is the one that works:

```bash
# From the Flutter project root. Use gradlew.bat on Windows.
cd android
./gradlew assembleDebug --stacktrace --info
```

Gradle now prints the full failure with the module that produced it:

```text
* What went wrong:
A problem occurred configuring project ':file_picker'.
> Failed to apply plugin 'kotlin-android'.
   > Cannot add extension with name 'kotlin', as there is an extension
     already registered with that name.
```

That is a real, fixable error. `Gradle task assembleDebug failed with exit code 1` never was.

One more diagnostic worth running before you touch a single Gradle file, because it catches an entire class of cause on its own:

```bash
# Validates the Java, Gradle, and AGP versions against each other
flutter analyze --suggestions
```

The [Android Java Gradle migration guide](https://docs.flutter.dev/release/breaking-changes/android-java-gradle-migration-guide) documents this validator: it evaluates your JDK, Gradle wrapper, and AGP versions as a triple and tells you which one is out of range.

## Cause 1: AGP 9 built-in Kotlin versus the `kotlin-android` plugin

This is the dominant cause in 2026 and it is the one people misdiagnose most, because it fires during Gradle's configuration phase, before a single line of Dart or Kotlin is compiled.

AGP 9.0 ships built-in Kotlin support and registers a Gradle extension named `kotlin` automatically. Any module that still applies the legacy Kotlin Gradle Plugin (`kotlin-android`, also known as KGP) tries to register a second extension under the same name, and Gradle refuses:

```text
Cannot add extension with name 'kotlin', as there is an extension
already registered with that name.
```

The module named in `A problem occurred configuring project ':x'` tells you whether the offender is your own app or a package you depend on. If it is a plugin package such as `file_picker` or `wakelock_plus`, you cannot fix it in your own build files; you upgrade the package or you turn built-in Kotlin off.

The escape hatch, per the [built-in Kotlin migration guide for app developers](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), goes in `android/gradle.properties`:

```properties
# android/gradle.properties -- Flutter 3.44, AGP 9.x
android.newDsl=false
android.builtInKotlin=false
```

That restores the pre-AGP-9 behaviour for the whole build, and Flutter's temporary KGP shim keeps the legacy plugin working. It buys you time; it is not the destination. Flutter has [filed the removal of KGP support](https://github.com/flutter/flutter/issues/184837) and [the removal of the old AGP DSL](https://github.com/flutter/flutter/issues/184839) for a future release.

The actual migration, once every plugin you depend on supports AGP 9, is to delete the plugin and the `kotlinOptions` block from `android/app/build.gradle.kts`:

```kotlin
// android/app/build.gradle.kts -- AGP 9.0+, Flutter 3.47+
plugins {
    id("com.android.application")
    // id("kotlin-android")  <-- delete this line
}

android {
    // kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }  <-- delete this block
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}
```

Then flip the flag:

```properties
# android/gradle.properties
android.builtInKotlin=true
```

Note the version floors. Flutter 3.44 raised the minimum supported KGP to 2.0.0, and the docs state that enabling built-in Kotlin requires Flutter 3.47 or later. On 3.44 stable, the correct move is `android.builtInKotlin=false` plus a package upgrade, not a half-finished migration. If your build instead complains that the Kotlin plugin itself is too old, that is a different failure with a different fix, covered in [the Kotlin Gradle plugin version error](/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/).

## Cause 2: your JDK and your Gradle wrapper disagree

The signature is a class file major version number:

```text
Caused by: org.codehaus.groovy.control.MultipleCompilationErrorsException: startup failed:
...
Unsupported class file major version 65
```

Major version 61 is Java 17, 65 is Java 21. The number tells you which JDK is running the build; the failure tells you your Gradle wrapper is too old to understand bytecode from it. Gradle releases before 7.3 cannot run under Java 17 at all, and each Gradle release has its own ceiling for the newest JDK it accepts.

This bites hardest when you did not change anything: Android Studio updated, its bundled JDK moved from 17 to 21, and your five-year-old Gradle wrapper broke overnight.

Check which JDK Flutter is using:

```bash
flutter doctor -v
```

Then either move the wrapper up:

```bash
# From android/. Pick the version flutter analyze --suggestions recommends.
./gradlew wrapper --gradle-version=8.13
```

Or pin Flutter to a JDK the wrapper can handle:

```bash
# macOS example. /usr/libexec/java_home -V lists installed JDKs.
flutter config --jdk-dir=/opt/homebrew/Cellar/openjdk@17/17.0.13/libexec/openjdk.jdk/Contents/Home
```

Prefer moving Gradle forward. Pinning an old JDK is a decision you will pay for again at the next AGP bump.

## Cause 3: NDK version mismatch across plugins

Any package with native code declares an NDK version. If two of them disagree with what your app configured, the build stops:

```text
* What went wrong:
Execution failed for task ':app:configureCMakeDebug[arm64-v8a]'.
> [CXX1101] NDK at .../ndk/26.3.11579264 did not have a source.properties file
```

Or, more explicitly:

```text
Your project is configured with Android NDK 26.3.11579264, but the following
plugin(s) depend on a different Android NDK version:
- path_provider_android requires Android NDK 27.0.12077973
```

NDK releases are backward compatible, so the fix is to adopt the highest version any dependency asks for:

```kotlin
// android/app/build.gradle.kts -- Flutter 3.44
android {
    ndkVersion = "27.0.12077973"
}
```

If the error mentions a missing `source.properties`, the named NDK directory exists but is a partial download. Delete that directory under your Android SDK's `ndk/` folder and reinstall the version through the SDK Manager, then `flutter clean`.

## Cause 4: a plugin raises minSdkVersion above yours

Manifest merging happens inside `assembleDebug`, so an SDK-level conflict surfaces as the same generic wrapper:

```text
* What went wrong:
Execution failed for task ':app:processDebugMainManifest'.
> Manifest merger failed : uses-sdk:minSdkVersion 21 cannot be smaller than
  version 23 declared in library [:some_plugin]
```

Raise the floor rather than suppressing the merge with `tools:overrideLibrary`, which only moves the crash to runtime on the devices you excluded:

```kotlin
// android/app/build.gradle.kts
android {
    defaultConfig {
        minSdk = 23
    }
}
```

The same shape of failure with a concrete package is walked through in the write-up on [background_fetch requiring minSdkVersion 21](/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/). If instead the merger complains about duplicate support-library classes, you are looking at a different problem entirely: see [the AndroidX conflict during a Flutter Android build](/2026/05/fix-androidx-conflict-during-flutter-android-build/).

## Cause 5: an unmaintained plugin has no namespace

AGP 8.0 made the `namespace` property mandatory and stopped reading `package` from `AndroidManifest.xml`. A package that has not shipped since AGP 7 fails configuration:

```text
* What went wrong:
A problem occurred configuring project ':some_old_plugin'.
> Namespace not specified. Specify a namespace in the module's build file.
```

There is no supported way to inject a namespace into someone else's package from your app. In order of preference: upgrade the package, replace it, or fork it and add `namespace 'com.example.some_old_plugin'` to its `android/build.gradle`. Scripts that rewrite files under `~/.pub-cache` circulate widely for this error and they are a trap: the cache is regenerated, so the fix vanishes on the next machine and on CI.

## Cause 6: nothing is wrong except the state on disk

Not every exit code 1 is a configuration problem. A half-written artifact in `build/`, a Gradle daemon holding a stale classpath, or a `.dart_tool` directory from a different SDK version all produce failures that look structural and are not. Before a long debugging session, clear the cheap ones:

```bash
flutter clean
cd android && ./gradlew --stop && ./gradlew clean && cd ..
flutter pub get
flutter run
```

If it builds after that, you had a stale-state problem and there is nothing further to fix. If a `pub get` fails on the way through, the constraint solver output is its own diagnosis exercise, covered in [reading a version solving failed error in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Variants that land on this page by mistake

- **`Gradle task assembleRelease failed with exit code 1`**: the same wrapper around the release variant. Everything above applies, plus R8 and shrinking, which only run in release. If debug builds and release does not, start by setting `isMinifyEnabled = false` to confirm R8 is the culprit, then fix the missing keep rules rather than leaving shrinking off.
- **`Gradle task assembleDebug failed with exit code 1` immediately, in under two seconds**: that is not a compile failure. Gradle could not start. Check the wrapper distribution URL in `android/gradle/wrapper/gradle-wrapper.properties` and your network access to `services.gradle.org`.
- **`Execution failed for task ':app:checkDebugAarMetadata'`**: a dependency requires a higher `compileSdk` than your app declares. Raise `compileSdk` in `android/app/build.gradle.kts`; it is a compile-time ceiling, not a runtime target, so raising it does not change device behaviour.
- **The failure only happens on CI**: compare the JDK, Android SDK, and NDK versions on the runner against your machine. Cause 2 and Cause 3 account for nearly all local-passes-CI-fails reports, and both are environment-shaped rather than code-shaped.
- **The failure appeared after upgrading Flutter**: check the breaking-changes index for the release before you debug the symptom. A framework jump that also moves the templated AGP and Gradle versions can trip several of the causes above at once, the same way a [Flutter 2 to Flutter 3 upgrade](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) does.

The general lesson holds beyond this one message. Any time a Flutter build failure names a Gradle task and an exit code, the tool is a messenger. Go to `android/`, run the task yourself with `--stacktrace`, and read the block under `* What went wrong:`. The fix is always in that block, and it is never in the line Flutter printed.

## Related

- [Fix: AndroidX conflict during Flutter Android build](/2026/05/fix-androidx-conflict-during-flutter-android-build/) -- the duplicate-class variant of a configuration failure, and why AGP 8 turning Jetifier off brought it back.
- [Flutter: your project requires a newer version of the Kotlin Gradle plugin](/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/) -- the KGP version floor, which is a separate failure from the AGP 9 extension collision above.
- [Fix: background_fetch requires minSdkVersion 21](/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) -- a worked example of the manifest-merger SDK conflict in Cause 4.
- [Fix: Version solving failed in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- what to do when the `flutter pub get` in the clean-state sequence is itself the thing that fails.
- [Migrate a Flutter 2 app to Flutter 3.x: null safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) -- the wider upgrade path that tends to trip several of these Gradle causes in one go.

## Sources

- [Android Java Gradle migration guide](https://docs.flutter.dev/release/breaking-changes/android-java-gradle-migration-guide), Flutter docs
- [Migrating Flutter Android projects to built-in Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin), Flutter docs
- [Built-in Kotlin migration for app developers](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), Flutter docs
- [Flutter maintained plugins should support AGP 9.0](https://github.com/flutter/flutter/issues/181383), flutter/flutter
- [Gradle Java compatibility matrix](https://docs.gradle.org/current/userguide/compatibility.html#java), Gradle docs
- [Android Gradle Plugin release notes](https://developer.android.com/build/releases/gradle-plugin), Android Developers
