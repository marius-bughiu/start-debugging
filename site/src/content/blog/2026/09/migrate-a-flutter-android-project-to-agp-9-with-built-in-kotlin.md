---
title: "Migrate a Flutter Android project to AGP 9 with built-in Kotlin"
description: "The full path from an AGP 8 Flutter app that applies kotlin-android to AGP 9.1 with android.builtInKotlin=true on Flutter 3.47. Every step was built and measured, including the two edits that look optional and are not: kotlinOptions is a compile error under KGP 2.2+, and the KGP line in settings.gradle.kts has to stay."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
---

For a Flutter app created before Flutter 3.44, the migration is four edits: bump the Gradle wrapper to 9.3.1 and AGP to 9.1.0, bump the Kotlin Gradle Plugin (KGP) version in `settings.gradle.kts` to 2.4.0 but keep the line, replace `kotlinOptions` with a top-level `kotlin { compilerOptions { ... } }` block, and delete `id("kotlin-android")` from `app/build.gradle.kts`. Then flip `android.builtInKotlin=true` in `gradle.properties`, which needs Flutter 3.47 or later, and only once every plugin you depend on has dropped KGP too. Budget an hour for an app with current dependencies, longer if a plugin still applies `kotlin-android`. It is worth doing now: Flutter already refuses to build with Gradle below 8.14 or AGP below 8.11.1, and has announced it will remove KGP support entirely ([flutter#184837](https://github.com/flutter/flutter/issues/184837)).

Everything below was run on Flutter 3.47.4 stable (framework revision `9584c6713b`, Dart 3.13), OpenJDK 17.0.20 and Android SDK build-tools 36.1, starting from a project laid out exactly like the Flutter 3.35 `android-kotlin` template: AGP 8.9.1, KGP 2.1.0, Gradle 8.12, `id("kotlin-android")` in the app module and a `kotlinOptions` block. I also checked the final state on Flutter 3.44.8. Each step lists the exact output I got.

## Why this migration is not optional anymore

- **Flutter 3.47 enforces floors that an AGP 8 project from 2025 does not meet.** `DependencyVersionChecker.kt` in 3.47.4 errors on Gradle below 8.14.0, AGP below 8.11.1 and KGP below 2.2.20, and warns below Gradle 9.1.0, AGP 9.0.1 and KGP 2.3.20. My untouched 3.35-era project failed on the first build with `Your project's Gradle version (8.12.0) is lower than Flutter's minimum supported version of 8.14.0`.
- **AGP 9 flips two defaults.** Per the [AGP 9.0 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes), `android.builtInKotlin` and `android.newDsl` both default to `true`. Built-in Kotlin means AGP compiles Kotlin itself and applying `org.jetbrains.kotlin.android` is an error.
- **The opt-outs are temporary on both sides.** Flutter's own templates currently ship with `android.builtInKotlin=false` and `android.newDsl=false`, but the [built-in Kotlin migration overview](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin) says KGP support will be removed in a future Flutter release, and Google says the `newDsl=false` escape hatch goes away in AGP 10.
- **Your plugins are measured against the same rule.** Once you enable built-in Kotlin, any plugin that still applies `kotlin-android` fails your build, not its own CI. Finding those plugins early is most of the real work.

## What breaks

| Area | Change | Severity |
| --- | --- | --- |
| Gradle wrapper | Flutter 3.47 errors below 8.14; AGP 9.1 needs 9.3.1 | high |
| `kotlin-android` in the app module | Fails with built-in Kotlin enabled | high |
| `kotlinOptions { jvmTarget = ... }` | Script compilation error under KGP 2.2 and later | high |
| Plugins that apply KGP | Fail your build once `android.builtInKotlin=true` | high |
| `android.newDsl=true` | Flutter Gradle Plugin still casts to the old DSL, `ClassCastException` | high (keep it `false`) |
| KGP entry in `settings.gradle.kts` | Removing it drops Kotlin to AGP's bundled 2.2.10, below Flutter's floor | medium |
| `build.gradle` (Groovy) projects | Same edits, different syntax; pre-3.16 `buildscript` layouts need the declarative plugins migration first | medium |

## Pre-flight checklist

- **Flutter 3.47.x on the machine and in CI.** Flutter 3.44 added AGP 9 support with built-in Kotlin *disabled*; enabling it is only supported from 3.47. Check with `flutter --version`.
- **JDK 17 or newer for Gradle.** AGP 9 requires JDK 17. `flutter doctor -v` prints which JDK Flutter hands to Gradle; if it is a JRE or JDK 11, fix that first (see [the JAVA_COMPILER toolchain error](/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/) for how Flutter picks the JDK).
- **Android SDK build-tools 36.0.0 or newer.** That is AGP 9's minimum.
- **A clean working tree.** The Flutter tool rewrites `gradle.properties` on its own the first time it builds with 3.44+, so commit before you start and diff afterwards.
- **A list of your Android plugins.** `flutter pub deps --style=compact` is enough. You will check each one's changelog for built-in Kotlin support in step 6.

## Migration steps

1. **Let the Flutter tool add the two opt-out flags, then check them.** Run any Android build once with Flutter 3.44 or later. The tool's migrators append both flags to `android/gradle.properties` if they are missing. On my project the build still failed (because of Gradle 8.12), but the file was already rewritten:

   ```properties
   # android/gradle.properties, written by the Flutter 3.47.4 migrators
   org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError
   android.useAndroidX=true
   # This builtInKotlin flag was added automatically by Flutter migrator
   android.builtInKotlin=false
   # This newDsl flag was added automatically by Flutter migrator
   android.newDsl=false
   ```

   The migrator never runs for add-to-app host projects, because the host is a plain Android project. There you add both lines by hand to the host's `gradle.properties`. Verify: `grep -E 'builtInKotlin|newDsl' android/gradle.properties` prints both lines.

2. **Bump the Gradle wrapper to 9.3.1.** AGP 9.0.x needs Gradle 9.1.0 or later, and Flutter's tooling pairs AGP 9.1.x with 9.3.1 or later, which is also what the Flutter 3.47 template ships:

   ```properties
   # android/gradle/wrapper/gradle-wrapper.properties, Flutter 3.47.4
   distributionUrl=https\://services.gradle.org/distributions/gradle-9.3.1-all.zip
   ```

   Verify: `cd android && ./gradlew --version` reports `Gradle 9.3.1`.

3. **Bump AGP and KGP in `settings.gradle.kts`, and keep the Kotlin line.** These are the versions `flutter create` writes in 3.47.4:

   ```kotlin
   // android/settings.gradle.kts, Flutter 3.47.4, AGP 9.1.0, KGP 2.4.0
   plugins {
       id("dev.flutter.flutter-plugin-loader") version "1.0.0"
       id("com.android.application") version "9.1.0" apply false
       id("org.jetbrains.kotlin.android") version "2.4.0" apply false
   }
   ```

   It is tempting to delete the `org.jetbrains.kotlin.android` line, since the point of the migration is to stop using KGP. Do not. With `apply false` it only puts that Kotlin version on the build classpath, and built-in Kotlin compiles with it. When I removed it, AGP 9.1.0 fell back to its bundled Kotlin 2.2.10, and the Flutter Gradle Plugin rejected the build: `Your project's Kotlin version (2.2.10) is lower than Flutter's minimum supported version of 2.2.20`. The line also matters while `builtInKotlin=false`, because then the Flutter Gradle Plugin applies `kotlin-android` itself to every Android subproject that does not, and it needs KGP on the classpath to do it.

   Verify: nothing yet. The build still fails until step 4.

4. **Replace `kotlinOptions` with the `compilerOptions` DSL.** This is the edit that surprises people, because it is required even before you touch built-in Kotlin. With AGP 9.1.0, KGP 2.4.0, `kotlin-android` still applied and `builtInKotlin=false`, my build failed during script compilation:

   ```text
   Script compilation errors:
     Line 18:     kotlinOptions {
                  ^ 'fun BaseAppModuleExtension.kotlinOptions(configure: Action<DeprecatedKotlinJvmOptions>): Unit' is deprecated. Please migrate to the compilerOptions DSL.
     Line 19:         jvmTarget = JavaVersion.VERSION_11.toString()
                      ^ 'var jvmTarget: String' is deprecated. Please migrate to the compilerOptions DSL.
   ```

   [Kotlin 2.2.0 raised the `kotlinOptions` deprecation to an error](https://kotlinlang.org/docs/whatsnew22.html), and Flutter 3.47 will not let you stay below KGP 2.2.20, so there is no version combination where `kotlinOptions` survives. Move the JVM target out of the `android {}` block into a top-level `kotlin {}` block:

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.47.4, AGP 9.1.0, KGP 2.4.0
   android {
       // ...
       compileOptions {
           sourceCompatibility = JavaVersion.VERSION_17
           targetCompatibility = JavaVersion.VERSION_17
       }
       // kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }  <- delete
   }

   kotlin {
       compilerOptions {
           jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
       }
   }
   ```

   Keep `jvmTarget` equal to `targetCompatibility`. Old templates used 11, new ones use 17; either works as long as the two agree. Verify: `flutter build apk --debug` succeeds. At this point it also prints `WARNING: Your Android app project: app ... applies the Kotlin Gradle Plugin, which will cause build failures in future versions of Flutter.` That warning is expected, and it is what step 5 removes.

5. **Remove `kotlin-android` from the app module.** Delete the plugin line and nothing else:

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.47.4
   plugins {
       id("com.android.application")
       // id("kotlin-android")  <- delete
       // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
       id("dev.flutter.flutter-gradle-plugin")
   }
   ```

   If your app module uses the version catalog form, the line to delete is `alias(libs.plugins.kotlin.android)`. For a Groovy `build.gradle`, it is `apply plugin: 'kotlin-android'` or `id "kotlin-android"`, and the `kotlin { compilerOptions { ... } }` block from step 4 is valid Groovy as written. Verify: `flutter build apk --debug` succeeds with no KGP warning for `app`. With `builtInKotlin` still `false`, the Flutter Gradle Plugin now applies KGP on your behalf, which is why this intermediate state builds.

6. **Find the plugins that still apply KGP.** Build once more with `builtInKotlin=false` and read the Gradle output. Flutter 3.47 names them for you:

   ```text
   WARNING: Your app uses the following plugins that apply Kotlin Gradle Plugin (KGP): oldplug
   Future versions of Flutter will fail to build if your app uses plugins that apply KGP.
   Please check the changelogs of these plugins and upgrade to a version that supports Built-in Kotlin.
   ```

   For each plugin listed, check pub.dev for a newer version whose changelog mentions built-in Kotlin or AGP 9, and upgrade. If none exists, file an issue with the plugin (Flutter's app developer guide includes [an issue template](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers#report-incompatible-kotlin-gradle-plugin-usage-to-plugin-authors)) and stop here: you are on AGP 9 with built-in Kotlin disabled, which is a supported state. Verify: the warning no longer lists any plugin.

7. **Enable built-in Kotlin.** Only once step 6 comes back clean:

   ```properties
   # android/gradle.properties, Flutter 3.47.4, AGP 9.1.0
   android.builtInKotlin=true
   android.newDsl=false
   ```

   Leave `android.newDsl=false`. Verify: `flutter build apk --debug` succeeds with no KGP warnings, and then `flutter run` on a device or emulator launches the app.

## Verification checklist

- `flutter build apk --debug` and `flutter build appbundle --release` both succeed with no `applies the Kotlin Gradle Plugin` warning in the output.
- Your Kotlin code actually made it into the APK. I checked this because built-in Kotlin is a different compiler path: `unzip` the APK and search the `classes*.dex` files for your `MainActivity`. On my migrated project `Lnet/sd/app347/MainActivity;` was in `classes4.dex`.
- `flutter test` and any `integration_test` suites still pass on an Android device.
- CI uses the same Flutter version and JDK 17. A CI image stuck on Flutter 3.44 builds with built-in Kotlin enabled but prints a misleading message (see the gotchas).
- `git diff android/` shows only the files above. A migrator that silently rewrote something else is worth reading before you commit.

## Rollback plan

The migration is reversible at every step, and the cheapest rollback is partial. If a plugin breaks after step 7, set `android.builtInKotlin=false` again: with that flag AGP 9 accepts KGP, and the Flutter Gradle Plugin re-applies `kotlin-android` to modules that need it, so you do not need to restore the `kotlin-android` line in your app module. A full rollback to AGP 8 means restoring `settings.gradle.kts` and the wrapper from git, but on Flutter 3.47 you cannot go below AGP 8.11.1, Gradle 8.14 or KGP 2.2.20, so "rollback" really means AGP 8.11+, not your original 8.9. The `kotlin { compilerOptions }` change from step 4 stays either way.

## Gotchas I hit on the way

**The first error is not about Kotlin at all.** On the unmigrated project, Flutter 3.47.4 printed the real problem (Gradle 8.12 below 8.14) inside Gradle's output, then a boxed "Flutter Fix" underneath saying `Starting AGP 9+, only the new DSL interface will be read` and suggesting you opt out of `android.newDsl`. The project was on AGP 8.9.1. The box is a heuristic that fires on any failure to apply the Flutter Gradle Plugin, so read the `* What went wrong:` section first, the same advice as in [the assembleDebug exit code 1 guide](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

**The error message for a leftover `kotlin-android` depends on your KGP version.** With KGP 2.4.0 it is explicit:

```text
> Failed to apply plugin 'kotlin-android'.
   > ⛔ Failed to apply plugin 'org.jetbrains.kotlin.android'
     The 'org.jetbrains.kotlin.android' plugin is no longer required for Kotlin support since AGP 9.0.
     Solution: Remove the 'org.jetbrains.kotlin.android' plugin from this project's build file: app/build.gradle.kts.
```

With older KGP versions the same mistake shows up as `Cannot add extension with name 'kotlin'`, which is the form most Stack Overflow answers quote. The `Solution:` line is useful when the offender is a plugin: for my test plugin it pointed at `../../oldplug/android/build.gradle.kts`. For a pub.dev package the path points into `~/.pub-cache/hosted/pub.dev/<package>-<version>/android/`, which tells you exactly which package to upgrade. Do not edit files in the pub cache; they are overwritten on the next `pub get`.

**`android.newDsl=true` is still a hard failure.** With everything else migrated, setting it produced `class com.android.build.gradle.internal.dsl.ApplicationExtensionImpl$AgpDecorated_Decorated cannot be cast to class com.android.build.gradle.AbstractAppExtension`. The Flutter Gradle Plugin still reads the legacy DSL types ([flutter#180137](https://github.com/flutter/flutter/issues/180137) tracks the port). Leave the flag at `false` until a Flutter release says otherwise, and plan for that release to arrive before AGP 10.

**Flutter 3.44 half-works with built-in Kotlin enabled.** The docs say `android.builtInKotlin=true` needs 3.47. I ran the fully migrated project on Flutter 3.44.8 anyway: the APK built and `MainActivity` was in the dex, but the tool printed `Applying the Kotlin Android Plugin (KGP) was unsuccessful. KGP was not found on the classpath.` That comes from 3.44's Flutter Gradle Plugin, which does not read the flag and tries to apply KGP regardless. It is harmless in a trivial app and confusing in a CI log, so treat 3.47 as the real minimum, exactly as documented.

**Pre-3.16 projects need an earlier migration first.** If your `android/build.gradle` still has `buildscript { ext.kotlin_version = '...' }` and your app module uses `apply from: ".../flutter.gradle"`, the steps above do not map cleanly. Do the [declarative plugins migration](https://docs.flutter.dev/release/breaking-changes/flutter-gradle-plugin-apply) first, then come back to step 2. I did not reproduce that layout for this post; the Flutter doc is the reference there. If you are stuck on the old Kotlin version message instead, [the KGP version error post](/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/) covers where that version lives in older layouts.

**Gradle 9 surfaces other old warnings as errors.** Gradle 9 removed APIs that Gradle 8 only deprecated, so an old plugin can fail for reasons unrelated to Kotlin. If a JDK 24 warning like `A restricted method in java.lang.System has been called` shows up alongside, that one is covered in [its own post](/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/).

## Measured results

| Project state (Flutter 3.47.4 unless noted) | Result |
| --- | --- |
| AGP 8.9.1, KGP 2.1.0, Gradle 8.12, `kotlin-android` | Fails: Gradle below 8.14 |
| AGP 9.1.0, KGP 2.4.0, Gradle 9.3.1, `kotlinOptions` kept | Fails: script compilation errors |
| Same, `compilerOptions`, `kotlin-android` kept, `builtInKotlin=false` | Builds, KGP warning for `app` |
| Same, `builtInKotlin=true` | Fails: KGP no longer required since AGP 9.0 |
| `kotlin-android` removed, `builtInKotlin=true` | Builds, 4.0 s incremental |
| KGP line removed from `settings.gradle.kts` | Fails: Kotlin 2.2.10 below 2.2.20 |
| Plugin applying KGP, `builtInKotlin=true` | Fails, names the plugin's build file |
| Plugin applying KGP, `builtInKotlin=false` | Builds, warning lists the plugin |
| Migrated, `newDsl=true` | Fails: `ClassCastException` in the Flutter Gradle Plugin |
| Migrated, `builtInKotlin=true`, Flutter 3.44.8 | Builds, misleading "KGP was not found" message |

## Related

- [Fix: Gradle task assembleDebug failed with exit code 1 in a Flutter Android build](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)
- [Fix: Toolchain installation does not provide the required capabilities: [JAVA_COMPILER]](/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/)
- [Fix: A restricted method in java.lang.System has been called in a Flutter Gradle build](/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/)
- [Fix: flutter doctor --android-licenses fails with cmdline-tools 23](/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/)
- [Flutter: your project requires a newer version of the Kotlin Gradle plugin](/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/)

## Sources

- [Migrating Flutter Android projects to built-in Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin) and the [app developer guide](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), Flutter docs.
- [Built-in Kotlin migration for plugin authors](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-plugin-authors), Flutter docs.
- [Android Gradle Plugin 9.0 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes): Gradle 9.1.0, JDK 17, KGP 2.2.10 runtime dependency, new defaults.
- [What's new in Kotlin 2.2.0](https://kotlinlang.org/docs/whatsnew22.html): `kotlinOptions` deprecation raised to error.
- Flutter 3.47.4 source: `packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt` (version floors), `FlutterPluginUtils.kt` (`isBuiltInKotlinEnabled`, auto-applied KGP), `lib/src/android/migrations/disable_built_in_kotlin_migration.dart`.
- Flutter issues [#181383](https://github.com/flutter/flutter/issues/181383), [#183909](https://github.com/flutter/flutter/issues/183909), [#184837](https://github.com/flutter/flutter/issues/184837), [#180137](https://github.com/flutter/flutter/issues/180137).
