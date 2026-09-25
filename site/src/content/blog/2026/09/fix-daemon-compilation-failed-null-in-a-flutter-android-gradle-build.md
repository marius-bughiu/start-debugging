---
title: "Fix: e: Daemon compilation failed: null in a Flutter Android Gradle build"
description: "On Windows, Kotlin incremental compilation fails when the Flutter project and the pub cache sit on different drives. Move PUB_CACHE to the project's drive or turn off IC for pub-cache plugins."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
---

This happens on Windows when your Flutter project is on one drive (`D:\`) and the pub cache is on another (`C:\Users\<you>\AppData\Local\Pub\Cache`). Kotlin's incremental compiler stores every plugin source file as a path relative to your `android\` folder. No relative path exists from `D:\` to `C:\`, so `compileDebugKotlin` crashes for plugins such as `shared_preferences_android`. The best fix is to put `PUB_CACHE` on the same drive as your projects, then run `flutter clean` and `flutter pub get`. If you cannot do that, set `kotlin.incremental=false` for the plugin subprojects only (snippet below). On Kotlin Gradle Plugin 2.3.0 and older the APK still builds and the error is only noise. From KGP 2.3.20 (the Flutter 3.44 template) and KGP 2.4.0 (Flutter 3.47) the build can fail outright.

The versions below were checked against Flutter 3.47.5 (Dart 3.13.4, AGP 9.1.0, Gradle 9.3.1, KGP 2.4.0), `shared_preferences` 2.5.5 / `shared_preferences_android` 2.4.28, and the Kotlin Gradle Plugin source at tags `v1.9.22` through `v2.4.20`.

## The error in context

Reports in [flutter/flutter#173456](https://github.com/flutter/flutter/issues/173456) and [flutter/flutter#144566](https://github.com/flutter/flutter/issues/144566) all look like this, once per plugin:

```text
e: Daemon compilation failed: null
java.lang.Exception
	at org.jetbrains.kotlin.daemon.common.CompileService$CallResult$Error.get(CompileService.kt:69)
	at org.jetbrains.kotlin.daemon.common.CompileService$CallResult$Error.get(CompileService.kt:65)
	at org.jetbrains.kotlin.compilerRunner.GradleKotlinCompilerWork.compileWithDaemon(GradleKotlinCompilerWork.kt:244)
	...
Caused by: java.lang.AssertionError: java.lang.Exception: Could not close incremental caches in
  D:\src\my_app\build\shared_preferences_android\kotlin\compileReleaseKotlin\cacheable\caches-jvm\jvm\kotlin:
  class-fq-name-to-source.tab, source-to-classes.tab, internal-name-to-source.tab
	at org.jetbrains.kotlin.incremental.IncrementalCachesManager.close(IncrementalCachesManager.kt:55)
	...
	Suppressed: java.lang.IllegalArgumentException: this and base files have different roots:
	  C:\Users\me\AppData\Local\Pub\Cache\hosted\pub.dev\shared_preferences_android-2.4.28\android\src\main\kotlin\io\flutter\plugins\sharedpreferences\LegacySharedPreferencesPlugin.kt
	  and D:\src\my_app\android.
```

The top line says `null` because the daemon wraps the real failure in a bare `java.lang.Exception` with no message. The useful line is the last one: `this and base files have different roots`. If your log has it, this post is your fix. If it does not, jump to "Lookalikes" at the end.

## Why the Kotlin incremental compiler needs one drive

Kotlin incremental compilation (IC) keeps lookup tables under `build/<module>/kotlin/compile<Variant>Kotlin/cacheable/caches-jvm`. The tables map each source file to the classes it produces. To keep Gradle's build cache relocatable, Kotlin 1.9.20 started storing those paths relative to a base directory instead of as absolute paths. This is the converter from `build-common` in the Kotlin repo:

```kotlin
// Kotlin build-common, RelocatableFileToPathConverter.kt (unchanged through 2.4.20)
override fun toPath(file: File): String {
    // ...
    // Note: If the given file is located outside `baseDir`, the relative path will start with "../".
    // It's not "clean", but it can work.
    return file.relativeTo(baseDir).invariantSeparatorsPath
}
```

For source files, `baseDir` is the **root project directory**, which for a Flutter app is `<project>\android`. Flutter plugins are Gradle subprojects, but their sources live in the pub cache, outside that folder. On macOS and Linux that works, because every path shares the root `/`. On my Mac, the IC cache for `shared_preferences_android` actually contains this entry:

```text
../../../../../../../../Users/marius/.pub-cache/hosted/pub.dev/shared_preferences_android-2.4.28/android/src/main/kotlin/io/flutter/plugins/sharedpreferences/LegacySharedPreferencesPlugin.kt
```

On Windows, `D:\src\my_app\android` and `C:\Users\...\Pub\Cache` have different roots. No chain of `..\` gets you from one drive to the other, so `File.relativeTo` throws `IllegalArgumentException`. The exception fires while IC writes its caches, so it surfaces as "Could not close incremental caches" and the daemon reports it as "Daemon compilation failed".

That is also why the classic workarounds work: "move the project to `C:`", "downgrade Kotlin to 1.9.10" (the last version before relative paths), and "it only fails with some plugins" (only plugins with Kotlin sources go through the Kotlin compiler). JetBrains tracks the root cause as [KT-63983](https://youtrack.jetbrains.com/issue/KT-63983), which is still "To be discussed". A JetBrains engineer noted that the trivial fix (`relativeToOrSelf`) would cause incorrect build cache hits. The Flutter side is [flutter/flutter#105395](https://github.com/flutter/flutter/issues/105395), open since 2022.

The same crash hits any setup where sources and root project are on different roots: `subst` virtual drives ([KT-65155](https://youtrack.jetbrains.com/issue/KT-65155)), a RAM disk build directory, or a WSL path like `\mnt\d\project` mixed with `D:\project`.

## Why the APK sometimes builds anyway

Many people report that the log is full of `e:` lines and then prints `√ Built build\app\outputs\flutter-apk\app-release.apk`. Others, especially since Flutter 3.44, get a real `BUILD FAILED`. The difference is which compiler path the Kotlin Gradle Plugin takes after the daemon fails. I read it from the KGP source at each tag:

| KGP version | Default compiler path | Fallback after the daemon fails | Result on a cross-drive project |
| --- | --- | --- | --- |
| 1.9.20 to 2.3.0 | `GradleKotlinCompilerWork` | `compileInProcess`, which is explicitly **non-incremental** ("in-process execution strategy is non-incremental") | Noisy `e:` output, APK builds |
| 2.3.20 and later | Build Tools API (`kotlin.compiler.runViaBuildToolsApi` defaults to `true`) | `performCompilation(IN_PROCESS)` with the **same** incremental configuration, including `ROOT_PROJECT_DIR` | Fallback hits the same `relativeTo`, build can fail |

The Flutter template pins the KGP version in `android/settings.gradle.kts`, so your Flutter version at `flutter create` time decides which row you are in:

| Flutter template | `templateKotlinGradlePluginVersion` |
| --- | --- |
| 3.35.0 | 2.1.0 |
| 3.38.0, 3.41.0 | 2.2.20 |
| 3.44.0 | 2.3.20 |
| 3.47.0 to 3.47.5 | 2.4.0 |

This matches the issue threads. The 2025 reports on Flutter 3.32 and 3.35 say "the APK still builds". The June 2026 comments say "got this issue after upgrading to Flutter 3.44". The August 2026 report on 3.47.0 with AGP 9.1.0 and KGP 2.4.0 has `:shared_preferences_android:compileDebugKotlin` failing the build on a clean run. Those people are not seeing a new bug. The Kotlin fallback that used to hide the old one no longer does.

## Minimal repro

You need Windows with two drives (or one `subst` drive). Keep the default pub cache on `C:`:

```powershell
# Windows 11, Flutter 3.47.5, default PUB_CACHE on C:
D:
cd \src
flutter create --platforms=android daemon_repro
cd daemon_repro
flutter pub add shared_preferences
flutter build apk --debug
```

A freshly created 3.47.5 project gets `com.android.application` 9.1.0, `org.jetbrains.kotlin.android` 2.4.0 and Gradle 9.3.1, with Kotlin IC on by default. Without the plugin, the template app has nothing outside `android\` for Kotlin to compile, so it builds cleanly. That explains the common "it broke as soon as I added one package" observation.

## Fix 1: put the pub cache on the same drive as your projects

This is the recommended fix. It removes the cause and keeps incremental compilation everywhere. Pick a folder on the drive where your projects live, point `PUB_CACHE` at it, and re-resolve:

```powershell
# Windows, any Flutter 3.x: user-level env var, picked up by new shells and IDEs
[Environment]::SetEnvironmentVariable("PUB_CACHE", "D:\PubCache", "User")

# open a NEW terminal (and restart VS Code / Android Studio), then:
cd D:\src\my_app
flutter clean
flutter pub get
flutter build apk --debug
```

`flutter pub get` downloads packages into the new cache and regenerates `.dart_tool\package_config.json` and `.flutter-plugins-dependencies`. The Flutter Gradle plugin reads the plugin paths from those files, so every plugin subproject now resolves to `D:\PubCache\...`. `flutter clean` matters because the old IC caches under `build\` still hold paths from the previous layout. You can delete the old `C:\Users\<you>\AppData\Local\Pub\Cache` afterwards.

The limit of this fix: if you keep projects on several drives, only one of them can match the cache. For that case, use fix 2.

## Fix 2: turn off incremental compilation only for plugin subprojects

Plugins from the pub cache never change between builds, so IC saves you nothing on them. Your own `app` module is where IC pays off, and its sources are inside `android\`, so it is not affected. KGP reads `kotlin.incremental` per project, including project extra properties, so you can scope the switch. Append this to `android/build.gradle.kts`:

```kotlin
// android/build.gradle.kts, Flutter 3.47.5, AGP 9.1.0, KGP 2.4.0
// Kotlin incremental compilation stores source paths relative to this
// directory. Plugins from the pub cache live outside it, which breaks on
// Windows when the cache is on another drive (KT-63983). Turn IC off for
// those subprojects only; the :app module stays incremental.
subprojects {
    if (!projectDir.canonicalPath.startsWith(rootDir.canonicalPath)) {
        extra["kotlin.incremental"] = "false"
    }
}
```

For a Groovy `android/build.gradle`, the equivalent is:

```groovy
// android/build.gradle, Flutter 3.35 to 3.47
subprojects {
    if (!projectDir.canonicalPath.startsWith(rootDir.canonicalPath)) {
        ext.set("kotlin.incremental", "false")
    }
}
```

I checked this on macOS against the 3.47.5 repro project by looking at which modules write IC caches after `flutter clean && flutter build apk --debug`. Without the snippet, both `build/app/kotlin/compileDebugKotlin/cacheable/caches-jvm` and `build/shared_preferences_android/.../caches-jvm` exist. With it, only the `app` one does, and the APK builds. The Groovy version gave the same result. I have no second-drive Windows machine here, so I did not see the Windows crash disappear myself, but the mechanism is the same: with IC off, KGP builds no incremental configuration, and nothing calls `RelocatableFileToPathConverter`.

Two approaches that look right do **not** work, and I tried both on 3.47.5:

- `tasks.withType<KotlinCompile>().configureEach { incremental = false }` in `subprojects {}`. KGP's own configuration action runs `task.incremental = propertiesProvider.incrementalJvm ?: true` later and overwrites your value. A `doFirst` probe printed `incremental=true`.
- Wrapping the same thing in `afterEvaluate {}`. Same result: the caches were still written.

Setting the property that KGP itself reads is the only per-module switch that survives.

A path dependency inside your repo (`path: ../packages/my_plugin`) is also outside `android\`, so the snippet turns IC off for it too. That costs a full recompile of that plugin's Kotlin on each build, usually a second or two. If that matters, narrow the check to pub cache paths, for example `projectDir.canonicalPath.contains("Pub${File.separator}Cache")`.

## Fix 3: turn off Kotlin incremental compilation globally

The bluntest fix, and the one quoted most in the issue threads. In `android/gradle.properties`:

```properties
# android/gradle.properties, any Flutter / KGP version
kotlin.incremental=false
```

It works, and I confirmed that no `caches-jvm` folder is created for any module afterwards. The cost is that your `app` module's Kotlin also recompiles from scratch on every build. For the Flutter template's single `MainActivity.kt` that does not matter. For an app with a lot of native Kotlin (platform channels, a widget, a Wear OS module) it adds up during `flutter run`. Prefer fix 1 or fix 2 in that case.

## What not to do

- **Do not downgrade KGP to 1.9.10.** It is the last version before relative paths, so the crash goes away. But Flutter 3.47 rejects KGP below 2.2.20 and AGP 9 requires a modern KGP, so you would be pinning your whole Android toolchain to 2023.
- **Do not set `kotlin.compiler.runViaBuildToolsApi=false` to bring the old "APK builds anyway" behaviour back.** In KGP 2.4 that property is annotated as deprecated (KT-85433, "non-BTA JVM compiler invocation is deprecated"), and it still logs the crash on every build. It hides the problem until the next KGP removes it.
- **Do not set `kotlin.daemon.useFallbackStrategy=false`.** That turns the "APK builds anyway" case into a hard failure on old KGP versions too.
- **Do not move the Flutter SDK.** The SDK's location is irrelevant here. The Flutter Gradle plugin is an included build with its own root, and its sources sit next to it. Only the pub cache vs. project drive split matters.

## Lookalikes

Not every `Daemon compilation failed` line is this bug. Check the `Caused by` and `Suppressed` lines:

- **`Daemon compilation failed: Could not connect to Kotlin compile daemon`**. The daemon did not start or died, often because of antivirus interference or too little memory. Run `cd android; .\gradlew --stop`, then build again. On old KGP versions the fallback compiles without the daemon, so this one is usually harmless.
- **An `OutOfMemoryError` in the daemon or Gradle**. Raise `kotlin.daemon.jvmargs` and `org.gradle.jvmargs` in `gradle.properties`, see [flutter/flutter#133371](https://github.com/flutter/flutter/issues/133371).
- **`Module was compiled with an incompatible version of Kotlin`**. A plugin was built with a newer Kotlin metadata version than your KGP. That is a version mismatch, not an IC problem, and it is covered in [the AGP 9 migration guide](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/).
- **A generic `Gradle task assembleDebug failed with exit code 1`** with no Kotlin daemon lines. Start from [the general assembleDebug checklist](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

The raw daemon logs live in `android\.kotlin\errors\errors-<timestamp>.log` and `%TEMP%\kotlin-daemon.*.log`. Search them for `different roots` if the console output is truncated.

## Related

- [Migrate a Flutter Android project to AGP 9 with built-in Kotlin](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) explains the AGP 9.1 / KGP 2.4 template that turned this warning into a failure.
- [Fix: Gradle task assembleDebug failed with exit code 1 in Flutter](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) is the umbrella post for Android build failures.
- [Fix: A restricted method in java.lang.System has been called in a Flutter Gradle build](/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/), another loud Gradle message where you need to decide whether it is fatal.
- [Fix: flutter doctor --android-licenses fails with cmdline-tools 23](/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/) for the other common Windows Android toolchain issue this month.
- [Debugging Flutter iOS from Windows](/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) if Windows is your main Flutter machine.

## Sources

- [flutter/flutter#173456](https://github.com/flutter/flutter/issues/173456) (open), including the 2026-08-16 reproduction on Flutter 3.47.0, AGP 9.1.0, KGP 2.4.0, and [flutter/flutter#105395](https://github.com/flutter/flutter/issues/105395), the cross-drive tracking issue.
- [flutter/flutter#144566](https://github.com/flutter/flutter/issues/144566) and [flutter/flutter#170534](https://github.com/flutter/flutter/issues/170534), earlier reports with the full stack.
- [KT-63983](https://youtrack.jetbrains.com/issue/KT-63983), [KT-65155](https://youtrack.jetbrains.com/issue/KT-65155) and [KT-80077](https://youtrack.jetbrains.com/issue/KT-80077) on the Kotlin tracker.
- Kotlin source: [`RelocatableFileToPathConverter.kt`](https://github.com/JetBrains/kotlin/blob/master/build-common/src/org/jetbrains/kotlin/incremental/storage/RelocatableFileToPathConverter.kt), `GradleKotlinCompilerWork.kt` and `btapi/BuildToolsApiCompilationWork.kt` in `libraries/tools/kotlin-gradle-plugin`, and `PropertiesProvider.kt` / `KotlinCompileConfig.kt` at tags `v2.3.0`, `v2.3.20` and `v2.4.0`.
- Flutter source: `packages/flutter_tools/lib/src/android/gradle_utils.dart` (`templateKotlinGradlePluginVersion`) at tags 3.35.0 through 3.47.5.
- [Kotlin Gradle plugin compilation and caches](https://kotlinlang.org/docs/gradle-compilation-and-caches.html) on kotlinlang.org, for `kotlin.incremental`.
- [Environment variables for pub](https://dart.dev/tools/pub/environment-variables) on dart.dev, for `PUB_CACHE`.
