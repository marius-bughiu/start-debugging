---
title: "Fix: Unresolved reference 'Registrar' on plugin after plugin in a Flutter Android build"
description: "Flutter 3.29 removed the v1 embedding's Registrar. Find every plugin still using it in one pass, then run flutter pub upgrade --major-versions; plain pub upgrade won't cross majors."
pubDate: 2026-11-17
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
---

`Unresolved reference 'Registrar'` (Kotlin) or `error: cannot find symbol ... PluginRegistry.Registrar` (Java) means a plugin in your dependency tree still has a `registerWith(Registrar)` method from the Android v1 embedding, which Flutter removed in 3.29.0. Your app is fine; the plugin's version is too old. List every offending plugin in one pass (script below), then run `flutter pub upgrade --major-versions`. Plain `flutter pub upgrade` never crosses a `^` major boundary, which is why it "does nothing". Everything below was reproduced on Flutter 3.44.8 (Dart 3.12.2), AGP 9.0.1, Gradle 9.1.0, macOS.

## The error in context

The Kotlin flavour, from a plugin written in Kotlin (this is `speech_to_text` 6.6.2):

```text
e: file:///.../speech_to_text/android/src/main/kotlin/com/csdcorp/speech_to_text/SpeechToTextPlugin.kt:37:48 Unresolved reference 'Registrar'.
e: file:///.../speech_to_text/android/src/main/kotlin/com/csdcorp/speech_to_text/SpeechToTextPlugin.kt:139:37 Unresolved reference 'Registrar'.
e: file:///.../speech_to_text/android/src/main/kotlin/com/csdcorp/speech_to_text/SpeechToTextPlugin.kt:141:54 Unresolved reference 'activity'.
e: file:///.../speech_to_text/android/src/main/kotlin/com/csdcorp/speech_to_text/SpeechToTextPlugin.kt:142:23 Unresolved reference 'addRequestPermissionsResultListener'.
e: file:///.../speech_to_text/android/src/main/kotlin/com/csdcorp/speech_to_text/SpeechToTextPlugin.kt:143:55 Unresolved reference 'context'.
e: file:///.../speech_to_text/android/src/main/kotlin/com/csdcorp/speech_to_text/SpeechToTextPlugin.kt:143:76 Unresolved reference 'messenger'.

* What went wrong:
Execution failed for task ':speech_to_text:compileDebugKotlin'.
```

The Java flavour, from a plugin written in Java (this is `permission_handler_android` 10.3.6, pulled in by `permission_handler` 10.4.5):

```text
/Users/you/.pub-cache/hosted/pub.dev/permission_handler_android-10.3.6/android/src/main/java/com/baseflow/permissionhandler/PermissionHandlerPlugin.java:28: error: cannot find symbol
    @Nullable private io.flutter.plugin.common.PluginRegistry.Registrar pluginRegistrar;
                                                             ^
* What went wrong:
Execution failed for task ':permission_handler_android:compileDebugJavaWithJavac'.
```

The follow-on errors (`activity`, `context`, `messenger`, `addRequestPermissionsResultListener`) are all methods called on the missing `Registrar` object. Fix the first one and they disappear with it.

## Why this happens

Before Flutter 1.12, Android plugins registered themselves through a static `registerWith(PluginRegistry.Registrar registrar)` method. The v2 embedding replaced that with the `FlutterPlugin` and `ActivityAware` interfaces, but for years plugin templates kept `registerWith` around so the same plugin worked in both old and new apps. The [Removal of v1 Android embedding Java APIs](https://docs.flutter.dev/release/breaking-changes/v1-android-embedding) breaking change deleted the v1 classes in Flutter 3.29.0, and with them the `Registrar` interface. Checking the engine source confirms it: `PluginRegistry.java` references `Registrar` 18 times at the engine revision pinned by Flutter 3.27.4 and zero times at 3.29.0.

A plugin's Android code is compiled from source inside your app's Gradle build. So any plugin whose `.java` or `.kt` files still mention `Registrar` stops compiling the day you upgrade to Flutter 3.29 or later, regardless of how modern your own `android/` folder is. That is why the usual cleanup rituals do nothing here: regenerating `android/` with `flutter create .`, deleting `~/.gradle`, `flutter clean`, and `dart pub cache repair` all leave the plugin's source untouched. The broken file lives in the pub cache, at the exact version your `pubspec.lock` pins.

## Minimal repro

A fresh app on Flutter 3.44.8 with two dependencies from early 2024:

```yaml
# pubspec.yaml -- Flutter 3.44.8, Dart 3.12.2
dependencies:
  flutter:
    sdk: flutter
  permission_handler: ^10.4.5
  speech_to_text: ^6.6.2
```

```bash
# Flutter 3.44.8
flutter create --platforms=android reg_repro
cd reg_repro
# edit pubspec.yaml as above
flutter pub get
flutter build apk --debug
```

On the current toolchain this first fails somewhere you might not expect: `speech_to_text` 6.6.2 declares `jcenter()` in its `build.gradle`, and Gradle 9 removed that method, so the build stops with `Could not find method jcenter()` before any Kotlin compiles. On an older Gradle 8 project (what the Stack Overflow asker had) `jcenter()` still exists, so you land on `Unresolved reference 'Registrar'` instead. To reproduce the Kotlin error on Gradle 9 for this post, the plugin was copied into `third_party/speech_to_text`, its `jcenter()` swapped for `mavenCentral()`, and the dependency pointed at that path. The `Registrar` errors then match the ones above line for line.

## Why you hit them one plugin at a time

Gradle stops at the first failed task. `flutter build apk` runs `assembleDebug` without `--continue`, so you only ever see the first plugin that fails to compile. Fix it, rebuild, and the next one surfaces. That is the "every time I fix one plugin, the build fails on the next one" loop.

You can make Gradle report all of them at once by running it directly:

```bash
# Flutter 3.44.8, Gradle 9.1.0 -- run from the app root
cd android
./gradlew assembleDebug --continue
```

With both old plugins in the repro, one run reported `:permission_handler_android:compileDebugJavaWithJavac` and `:speech_to_text:compileDebugKotlin` together, plus `checkDebugAarMetadata` failures for both. Those last ones are a preview of the next problem: plugins this old compile against `android-33`, and current AndroidX libraries require 34 or later.

## Fix, in detail

### Step 1: list every plugin that still uses the v1 API

You don't need to compile to find them. After `flutter pub get`, the Flutter tool writes `.flutter-plugins-dependencies` in the app root with the resolved path of every Android plugin. Scan those paths for `Registrar`:

```python
# find_v1_plugins.py -- Python 3, run from the Flutter app root after `flutter pub get`
# Lists Android plugins that still reference the v1 embedding Registrar
# (removed in Flutter 3.29.0).
import json, pathlib, re

V1 = re.compile(r"\bRegistrar\b|\bregisterWith\s*\(")
deps = json.loads(pathlib.Path(".flutter-plugins-dependencies").read_text())

for plugin in deps["plugins"]["android"]:
    src = pathlib.Path(plugin["path"], "android", "src")
    hits = [
        f for f in src.rglob("*")
        if f.suffix in (".java", ".kt") and V1.search(f.read_text(errors="ignore"))
    ]
    if hits:
        print(f'{plugin["name"]}  ({plugin["path"]})')
        for f in hits:
            print(f"    {f.relative_to(plugin['path'])}")
```

Output on the repro:

```text
permission_handler_android  (/Users/you/.pub-cache/hosted/pub.dev/permission_handler_android-10.3.6/)
    android/src/main/java/com/baseflow/permissionhandler/PermissionHandlerPlugin.java
speech_to_text  (/Users/you/S/reg_repro/third_party/speech_to_text/)
    android/src/main/kotlin/com/csdcorp/speech_to_text/SpeechToTextPlugin.kt
```

This works on Windows too (the paths point into `%LOCALAPPDATA%\Pub\Cache`), and it catches transitive plugins such as `permission_handler_android`, which never appears in your `pubspec.yaml`. Grepping the whole pub cache instead is noisier, because the cache keeps every version you have ever downloaded.

### Step 2: upgrade across major versions

Here is why `flutter pub upgrade` "doesn't work". With `permission_handler: ^10.4.5` in the pubspec, it reports `No dependencies changed.`, and `flutter pub outdated` shows the gap:

```text
Package Name                           Current   Upgradable  Resolvable  Latest
direct dependencies:
permission_handler                     *10.4.5   *10.4.5     13.0.2      13.0.2
transitive dependencies:
permission_handler_android             *10.3.6   *10.3.6     14.1.1      14.1.1
```

"Upgradable" is the newest version your constraints allow. A caret constraint never crosses a major version, and the fix for these plugins shipped in a new major. To move past it, let pub rewrite the constraints. Preview it first:

```bash
# Flutter 3.44.8
flutter pub upgrade --major-versions --dry-run
```

```text
Would change 2 constraints in pubspec.yaml:
  permission_handler: ^10.4.5 -> ^13.0.2
  speech_to_text: ^6.6.2 -> ^7.5.0
```

Then apply it with `flutter pub upgrade --major-versions` and rerun the script from step 1. On the repro it printed nothing.

The versions where the `Registrar` code went away, checked by unpacking the published archives:

| Package | Last version with `Registrar` | First clean version | Reached via |
| --- | --- | --- | --- |
| `speech_to_text` | 6.6.2 | 7.0.0 | direct dependency |
| `permission_handler_android` | 12.0.5 | 12.0.6 (12.0.7 removed a leftover reference) | `permission_handler` 11.1.0 or later |

`permission_handler` 10.x pins `permission_handler_android ^10.3.0` and 11.0.x pins `^11.0.0`, so both stay broken. 11.1.0 moved to `^12.0.1`, which resolves to a clean 12.0.x. A major bump means reading the changelog, because the API may have changed. Do that once rather than chasing errors.

### Step 3: deal with what the upgrade brings along

On the repro, the build after the upgrade still failed, for a different reason:

```text
Warning: The plugin permission_handler_android requires Android SDK version 37 or higher.
Your project is configured to compile against Android SDK 36, but the following plugin(s) require to be compiled against a higher Android SDK version:
- permission_handler_android compiles against Android SDK 37
```

Current plugin releases compile against newer SDKs than the `flutter.compileSdkVersion` default (36 on Flutter 3.44.8). Raising it is safe, because `compileSdk` affects only which APIs you can compile against, not the devices you run on:

```kotlin
// android/app/build.gradle.kts -- Flutter 3.44.8, AGP 9.0.1
android {
    compileSdk = 37
    // ...
}
```

After that, `flutter build apk --debug` produced `app-debug.apk`. That was a build check only; the APK was not run on a device.

### Step 4 (last resort): patch a plugin nobody maintains

If the plugin is abandoned and has no clean version, vendor it. Copy its folder from the pub cache into your repo, point the dependency at the copy, and delete the v1 code. For a plugin that already implements `FlutterPlugin` (almost all of them do), `registerWith` is dead code, so removing it changes nothing at runtime:

```yaml
# pubspec.yaml -- Flutter 3.44.8
dependencies:
  speech_to_text:
    path: third_party/speech_to_text
```

```diff
// third_party/speech_to_text/android/src/main/kotlin/.../SpeechToTextPlugin.kt (6.6.2)
-import io.flutter.plugin.common.PluginRegistry.Registrar
 ...
-    companion object {
-        @JvmStatic
-        fun registerWith(registrar: Registrar) {
-            val speechPlugin = SpeechToTextPlugin()
-            speechPlugin.currentActivity = registrar.activity()
-            registrar.addRequestPermissionsResultListener(speechPlugin)
-            speechPlugin.onAttachedToEngine(registrar.context(), registrar.messenger())
-        }
-    }
```

On the repro, removing `Registrar` alone was not enough. The vendored 6.6.2 also needed `jcenter()` replaced with `mavenCentral()` and `compileSdkVersion 33` raised to 36 in its `build.gradle`. With those three edits the app built, and AGP 9 then warned that the plugin still applies the Kotlin Gradle Plugin itself (see [the built-in Kotlin migration](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)). An old plugin rarely has a single problem, and you now own the fork. Prefer an upgrade or a maintained alternative package whenever one exists.

## Gotchas and variants

- **`dependency_overrides` on the transitive plugin alone fails.** Forcing `permission_handler_android: ^12.0.13` while keeping `permission_handler: ^10.4.5` failed version solving: `permission_handler_android >=12.0.5 <14.0.0 depends on permission_handler_platform_interface ^4.2.0`, and `permission_handler` 10.x needs `^3.11.0`. Overriding the platform interface as well would compile against an API the Dart side was not written for. Upgrade the parent package instead.
- **Flutter's own hint shows up only for Java plugins.** For the Java error, Flutter 3.44.8 prints a "Flutter Fix" box blaming v1 embedding removal and suggesting `flutter pub upgrade`. The handler in `gradle_errors.dart` matches only lines containing `io.flutter.plugin.common.PluginRegistry.Registrar registrar`, so Kotlin plugins get no hint at all. And its advice of plain `flutter pub upgrade` won't cross the major version, as step 2 showed.
- **"I upgraded every package and it's still broken."** Check `pubspec.lock`, not `pubspec.yaml`. Another package (or an SDK constraint) can hold a plugin back. `flutter pub deps` shows who depends on it, and `flutter pub outdated` marks held-back packages with `*`.
- **Your own app code imports `io.flutter.app.FlutterActivity`.** Same removal, different symptom: the error points at `MainActivity`, not a plugin. Switch to `io.flutter.embedding.android.FlutterActivity` per the breaking-change page. If `MainActivity` compiles but crashes at launch, see the [ClassNotFoundException for MainActivity fix](/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/).
- **Pinning Flutter 3.27.x as a stopgap.** 3.27.4 still ships the `Registrar` interface (verified in the engine source, not by building), so an old SDK pinned through FVM will compile these plugins. It also freezes you before every Android toolchain fix since early 2025, so treat it as a way to ship one release, not as the fix.
- **Lookalike errors.** `Module was compiled with an incompatible version of Kotlin` is a Kotlin metadata mismatch, not the v1 removal; see [that fix](/2026/10/fix-module-was-compiled-with-an-incompatible-version-of-kotlin-in-a-flutter-android-build/). If the log only says `Gradle task assembleDebug failed with exit code 1`, scroll up for the first `e:` or `error:` line; [this walkthrough](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) explains how to find it.

## Related

- [Migrate a Flutter Android project to AGP 9 with built-in Kotlin](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/), the next wall old plugins hit after this one.
- [Fix: Gradle task assembleDebug failed with exit code 1 in a Flutter Android build](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) for reading the real error out of a Gradle log.
- [Fix: Module was compiled with an incompatible version of Kotlin](/2026/10/fix-module-was-compiled-with-an-incompatible-version-of-kotlin-in-a-flutter-android-build/) for the other common plugin-compile failure after a Flutter upgrade.
- [Migrate a Flutter 2 app to Flutter 3.x: the null safety checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/), if the project is old enough that the app itself still uses the v1 embedding.

## Sources

- [Stack Overflow: Flutter Android build fails on every plugin with 'Unresolved reference Registrar'](https://stackoverflow.com/questions/79895128)
- [Flutter docs: Removal of v1 Android embedding Java APIs](https://docs.flutter.dev/release/breaking-changes/v1-android-embedding)
- [Flutter docs: Supporting the new Android plugins APIs](https://docs.flutter.dev/release/breaking-changes/plugin-api-migration)
- [flutter/packages#6494: Remove references to v1 embedding](https://github.com/flutter/packages/pull/6494)
- [csdcorp/speech_to_text#545: Remove references to deprecated v1 Android embedding](https://github.com/csdcorp/speech_to_text/issues/545) and the [speech_to_text changelog](https://pub.dev/packages/speech_to_text/changelog)
- [permission_handler_android changelog](https://pub.dev/packages/permission_handler_android/changelog) (12.0.6 and 12.0.7)
- [`gradle_errors.dart` in flutter_tools](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/lib/src/android/gradle_errors.dart)
- [Dart docs: `dart pub upgrade --major-versions`](https://dart.dev/tools/pub/cmd/pub-upgrade#major-versions)
