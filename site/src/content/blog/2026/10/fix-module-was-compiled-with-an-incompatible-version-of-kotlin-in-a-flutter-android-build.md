---
title: "Fix: Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is X, expected version is Y (Flutter Android)"
description: "A dependency was built with a Kotlin at least two minor versions newer than your build's compiler. Raise the org.jetbrains.kotlin.android version in settings.gradle.kts to X minus one or later, or pin the dependency back."
pubDate: 2026-10-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "kotlin"
  - "gradle"
---

Short answer: some library on your Android classpath (very often a newer `kotlin-stdlib` pulled in transitively) was compiled with a Kotlin version at least two minor releases ahead of the compiler your build actually runs. The compiler only reads metadata one minor version ahead. Raise the `org.jetbrains.kotlin.android` version in `android/settings.gradle.kts` to at least "X minus one minor" (for metadata 2.4.0, KGP 2.3.x or newer), then rebuild. Everything below was reproduced on Flutter 3.44.8, AGP 9.0.1, Gradle 9.1.0 and Kotlin 2.4.21 artifacts.

## The error in context

On a `flutter build apk` or `flutter run`, the `compileDebugKotlin` (or `compileReleaseKotlin`) task fails with one line per Kotlin module file in the offending jar:

```text
> Task :app:compileDebugKotlin FAILED
e: file:///Users/me/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.4.21/.../kotlin-stdlib-2.4.21.jar!/META-INF/kotlin-stdlib.kotlin_module Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is 2.4.0, expected version is 2.2.0.
e: file:///.../MainActivity.kt:6:19 Unresolved reference 'listOf'.

FAILURE: Build failed with an exception.
* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction
   > Compilation error. See log for more details
```

When the failing code lives in a plugin instead of your app, the same mismatch is reported per class and the wording is newer and more helpful:

```text
> Task :shared_preferences_android:compileDebugKotlin FAILED
e: Incompatible classes were found in dependencies. Remove them from the classpath or use '-Xskip-metadata-version-check' to suppress errors
e: .../shared_preferences_android-2.5.1/android/src/main/kotlin/io/flutter/plugins/sharedpreferences/LegacySharedPreferencesPlugin.kt:47:5 Class 'kotlin.Unit' was compiled with an incompatible version of Kotlin. The actual metadata version is 2.4.0, but the compiler version 2.2.0 can read versions up to 2.3.0.
```

The trailing "Unresolved reference" errors (`listOf`, `startsWith`, `it`) are noise. Once the compiler refuses to load the standard library, every stdlib symbol becomes unresolved. Fix the first error and they all disappear.

## Why the compiler refuses newer metadata

Every Kotlin/JVM class file carries a `@kotlin.Metadata` annotation, and every jar has a `META-INF/*.kotlin_module` file, both stamped with the metadata version of the compiler that produced them. Kotlin's [evolution principles](https://kotlinlang.org/docs/kotlin-evolution-principles.html) promise backward compatibility (a newer compiler reads all older binaries) but only best-effort forward compatibility with the next language release, "but not later ones". The compiler enforces that rule up front: a 2.2 compiler accepts metadata up to 2.3.0 and rejects 2.4.0. That is exactly what the newer message spells out: "the compiler version 2.2.0 can read versions up to 2.3.0".

So the two numbers in the error mean:

- **"binary version of its metadata is X"**: the Kotlin version that compiled the library jar named in the path.
- **"expected version is Y"**: the Kotlin compiler your Gradle build is running, which comes from the Kotlin Gradle Plugin (KGP) on the build classpath. It is not the Kotlin installed in Android Studio, and it is not necessarily the version you typed.

In Flutter apps the trigger is almost always one of these, in order of frequency:

1. **A plugin or AndroidX/Google library update** pulls in a newer `kotlin-stdlib` transitively. Gradle's conflict resolution picks the highest requested stdlib, so one modern dependency upgrades it for the whole module.
2. **Your project's KGP is old**, typically because the app was created years ago and `settings.gradle.kts` (or `ext.kotlin_version` in a pre-3.16 `android/build.gradle`) was never bumped.
3. **A plugin compiled against a newer Kotlin ships a prebuilt AAR or jar** with Kotlin classes in it (common with SDK-wrapping plugins such as maps, payments and analytics).

## Minimal repro

Start from a fresh Flutter 3.44.8 project, lower the KGP, and add one dependency built with Kotlin 2.4:

```kotlin
// android/settings.gradle.kts -- Flutter 3.44.8, AGP 9.0.1, Gradle 9.1.0
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false // template ships 2.3.20
}
```

```kotlin
// android/app/build.gradle.kts -- Flutter 3.44.8
dependencies {
    // Stands in for any library compiled with Kotlin 2.4.x
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.4.21")
}
```

```kotlin
// android/app/src/main/kotlin/com/example/kapp/MainActivity.kt -- Kotlin source that touches stdlib
package com.example.kapp

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    val doubled = listOf(1, 2, 3).map { it * 2 }
}
```

Two details from the repro are worth knowing before you start changing versions.

**The version you declared may not be the version that runs.** I declared KGP 2.0.21, yet the error says "expected version is 2.2.0", and the Flutter Gradle Plugin warned "Flutter support for your project's Kotlin version (2.2.10) will soon be dropped". AGP 9.0.1 declares a runtime dependency on `kotlin-gradle-plugin:2.2.10`, and Gradle resolves the build classpath to the highest version requested. Declaring a KGP *below* the one AGP brings has no effect at all. Read the "expected version" from the error, not from your settings file.

**The error only fires when Kotlin code touches the newer classes.** With the stock one-line `class MainActivity : FlutterActivity()` the same classpath built fine, because nothing forced the compiler to deserialize stdlib metadata. Adding `listOf(...)` broke it. This is why the error tends to appear "out of nowhere" after you add a few lines of Kotlin in `MainActivity` or a method channel handler, even though the dependency upgrade happened weeks earlier.

## Fix 1: raise the Kotlin Gradle Plugin (recommended)

The rule is: KGP minor version must be at least the library's metadata minor version minus one. For metadata 2.4.0 that means 2.3.x or newer; matching it exactly (2.4.x) is the safest choice.

```kotlin
// android/settings.gradle.kts -- Flutter 3.44.8, AGP 9.0.1
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.3.20" apply false
}
```

With 2.3.20, the same repro compiled cleanly (`BUILD SUCCESSFUL`): one minor version of look-ahead is enough. Do it in this order:

1. Read X from the error ("binary version of its metadata is 2.4.0").
2. Open `android/settings.gradle.kts` (or `settings.gradle`) and set the `org.jetbrains.kotlin.android` version to X minus one minor or newer. On projects created before Flutter 3.16 the version lives in `android/build.gradle` as `ext.kotlin_version = '...'` inside `buildscript`; change it there.
3. Check the new KGP against your AGP and Gradle in the [Kotlin Gradle plugin compatibility table](https://kotlinlang.org/docs/gradle-configure-project.html#apply-the-plugin). KGP 2.3.20 supports Gradle 7.6.3 to 9.3.0 and AGP 8.2.2 to 9.0.0; KGP 2.4.20 needs AGP 8.5.2 or newer. Older Flutter projects on AGP 7.x have to bump AGP and Gradle in the same change.
4. Run `flutter clean` and rebuild, so no cached Gradle outputs from the old compiler linger.

Flutter 3.44.8's own tooling backs this up: the template ships KGP 2.3.20, the Flutter Gradle Plugin warns below 2.2.20 and errors below 2.0.0 (`warnKGPVersion` and `errorKGPVersion` in `packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt`). If you are still on a Kotlin 1.x project, you are going to hit this error with nearly every current AndroidX release, so this is the upgrade to do anyway.

## Fix 2: when the error is in a plugin module, still fix it in the app

If the failing task is `:some_plugin:compileReleaseKotlin`, the instinct is to blame the plugin's `build.gradle`. The repro shows why that is the wrong file. `shared_preferences_android` 2.5.1 declares its own KGP in its buildscript:

```kotlin
// ~/.pub-cache/hosted/pub.dev/shared_preferences_android-2.5.1/android/build.gradle.kts (excerpt)
val kotlinVersion = "2.3.0"
classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion")
```

Yet the error said "the compiler version 2.2.0". Plugins are subprojects of your app's Gradle build, and the KGP already loaded by the root build (from `settings.gradle.kts`, possibly upgraded by AGP) is the one that compiles them. The plugin's declaration does not win. So:

1. Raise the KGP in your app's `android/settings.gradle.kts`, exactly as in Fix 1.
2. If the plugin itself pins an old Kotlin in a way that still fails, upgrade the plugin (`flutter pub upgrade <name>` or bump its constraint in `pubspec.yaml`). Never edit files under `~/.pub-cache`: `pub get` overwrites them.

## Fix 3: find and pin the dependency that pulled the newer Kotlin

Sometimes you cannot raise KGP right now (a release branch, a frozen CI image). Then find who requested the new stdlib and pin that dependency back. From the `android/` folder:

```bash
./gradlew :app:dependencyInsight --dependency org.jetbrains.kotlin:kotlin-stdlib --configuration releaseRuntimeClasspath
```

In my repro the "Selection reasons" section explained the whole story in one line:

```text
- By conflict resolution: between versions 2.4.21, 2.2.10, 1.8.22, 2.0.21, 1.6.21, 1.7.10, 1.8.10, 1.3.20, 1.8.20, 1.9.24, 2.0.0, 1.9.25 and 2.0.20
```

Below that, each `org.jetbrains.kotlin:kotlin-stdlib:1.x -> 2.4.21` line is indented under the dependency that requested it. Walk up the tree to the one asking for 2.4.x, then either downgrade that library or the Flutter plugin that brings it. For a plugin's transitive dependency, run the same command against the plugin project (`:plugin_name:dependencyInsight`). Pinning is a short-term measure: the library author moved to the new Kotlin for a reason, and the next update of anything else will put you back here.

Do not "fix" it by forcing `kotlin-stdlib` down with a `resolutionStrategy.force(...)`. The library was compiled against the newer stdlib API and may call functions that do not exist in the older one, which turns a compile error into a `NoSuchMethodError` at runtime.

## Fix 4: -Xskip-metadata-version-check (last resort)

The compiler's own message suggests a flag, and it does work:

```kotlin
// android/app/build.gradle.kts -- Kotlin compiler option, use only temporarily
kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
        freeCompilerArgs.add("-Xskip-metadata-version-check")
    }
}
```

With it, the repro built. It is an `-X` flag, which means unsupported, and it only switches off the safety check: the compiler then reads metadata from a format it does not know. If the newer library uses a language feature encoded in a way your compiler cannot interpret, you get wrong signatures or a crash in the compiler instead of a clear error. It also only applies to the module you put it in, so a failing plugin module would still fail. Use it to unblock a hotfix build, and remove it when you bump KGP.

## Lookalikes that land here

- **`Your project requires a newer version of the Kotlin Gradle plugin`**: this is Flutter's own pre-flight check, not the Kotlin compiler. It has a different fix path, covered in [the older KGP version error post](/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/).
- **`Daemon compilation failed: null`**: an incremental-compilation crash inside the Kotlin daemon, not a version mismatch. See [fixing Daemon compilation failed: null](/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/).
- **Kotlin errors right after moving to AGP 9**: if the build broke when you upgraded AGP and you see `Cannot add extension with name 'kotlin'`, that is the built-in Kotlin migration. [The AGP 9 migration guide](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) walks through it, including why you must keep the KGP line in `settings.gradle.kts`.
- **`Execution failed for task ':app:compileFlutterBuildDebug'` or a bare `exit code 1`**: the summary line Flutter prints hides the real Gradle error. Scroll up or rerun with `--verbose`; [the assembleDebug exit code 1 guide](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) shows where to look.
- **"Expected version is 1.x" on a project you think is on Kotlin 2**: you are reading the wrong file. Look for a leftover `ext.kotlin_version` in `android/build.gradle`, or a `buildscript` block in the root project that still puts an old `kotlin-gradle-plugin` on the classpath.

## Related

- [Migrate a Flutter Android project to AGP 9 with built-in Kotlin](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)
- [Fix: Daemon compilation failed: null in a Flutter Android Gradle build](/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)
- [Fix: Gradle task assembleDebug failed with exit code 1 in Flutter](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)
- [Fix: Timeout waiting to lock journal cache in a Flutter Android build](/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/)

## Sources

- [Kotlin evolution principles: binary compatibility](https://kotlinlang.org/docs/kotlin-evolution-principles.html)
- [Kotlin Gradle plugin: compatibility with Gradle and AGP](https://kotlinlang.org/docs/gradle-configure-project.html#apply-the-plugin)
- [Android Gradle Plugin 9.0 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes) (KGP 2.2.10 runtime dependency)
- [Flutter: Kotlin and Gradle version requirements](https://docs.flutter.dev/release/breaking-changes/kotlin-version)
- [flutter/flutter#179253](https://github.com/flutter/flutter/issues/179253), the same mismatch reported with metadata 2.2.0 against an expected 1.8.0
