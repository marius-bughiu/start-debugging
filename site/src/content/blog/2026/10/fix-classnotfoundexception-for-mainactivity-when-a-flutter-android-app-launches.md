---
title: "Fix: ClassNotFoundException for MainActivity when a Flutter Android app launches"
description: "The manifest's .MainActivity resolves against the Gradle namespace, and no class with that name is in the APK. Make namespace, the Kotlin package line, and the manifest agree."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
---

The activity class named in your merged `AndroidManifest.xml` does not exist in the APK's dex files. In a Flutter app that almost always means one of three values drifted apart during a rename: `namespace` in `android/app/build.gradle.kts` (which `.MainActivity` in the manifest resolves against), the `package` line at the top of `MainActivity.kt`, or the flavor source set the file lives in. Make the `package` line equal to `namespace`, leave `applicationId` alone unless you really want a new store identity, then `flutter clean` and rebuild. The folder the `.kt` file sits in does not matter.

Everything below was reproduced on macOS with Flutter 3.44.8 (Dart 3.12.2), whose `flutter create` template pins AGP 9.0.1, Kotlin 2.3.20, and Gradle 9.1.0, running on an Android 16 (API 36) arm64 emulator. Each scenario was built with `flutter build apk`, inspected with `aapt2` and `dexdump` from build-tools 36.1.0, and launched with `adb shell am start`.

## The error in context

This is the crash from my repro after changing only `namespace` (paths shortened):

```text
E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: java.lang.RuntimeException: Unable to instantiate activity ComponentInfo{com.example.clsrepro/com.acme.shop.MainActivity}: java.lang.ClassNotFoundException: Didn't find class "com.acme.shop.MainActivity" on path: DexPathList[[zip file "/data/app/~~.../com.example.clsrepro-.../base.apk"],nativeLibraryDirectories=[/data/app/~~.../lib/arm64, /system/lib64, /system_ext/lib64]]
E AndroidRuntime: Caused by: java.lang.ClassNotFoundException: Didn't find class "com.acme.shop.MainActivity" on path: DexPathList[...]
```

Read the `ComponentInfo{A/B}` part carefully, because it tells you which value is wrong. `A` is the application ID the app was installed under. `B` is the fully qualified class the system tried to instantiate. If `B` is not a class that exists in your Kotlin code, the manifest and the code disagree. The build succeeds, the APK installs, and the app dies before the Flutter engine starts, so none of your Dart code or logging runs. The stack trace is in `adb logcat -b crash`.

## Why the class is missing

Android starts your app by reading the `android:name` of the launcher activity from the merged manifest and loading that exact class name from the APK's `classes*.dex`. The Flutter template writes it in shorthand:

```xml
<!-- android/app/src/main/AndroidManifest.xml, Flutter 3.44.8 template -->
<activity
    android:name=".MainActivity"
    android:exported="true"
    ... >
```

A name starting with a period is appended to the module's `namespace` from `build.gradle.kts`, not to the `applicationId` and not to whatever package your Kotlin file declares. The class that ends up in the dex is named by the `package` line in `MainActivity.kt`. Nothing in the build checks that those two match, so there are three ways to get the crash:

1. **`namespace` changed, the Kotlin `package` line did not.** The manifest now points at `<new namespace>.MainActivity`, the dex still has `<old package>.MainActivity`.
2. **The Kotlin `package` line changed, `namespace` did not.** The mirror image of 1.
3. **The class is not compiled into this variant at all.** Typically `MainActivity.kt` was moved into a flavor source set (`src/free/kotlin`) and you built another flavor, or the file was deleted when someone regenerated the `android/` folder.

It is not R8. The resource step (AAPT2) generates a keep rule for every class referenced in the manifest, so a release build cannot shrink `MainActivity` away. More on that below.

## Minimal repro

Start from a clean template and change one line:

```bash
# Flutter 3.44.8, AGP 9.0.1
flutter create --org com.example --platforms android clsrepro
cd clsrepro
```

```kotlin
// android/app/build.gradle.kts, Flutter 3.44.8 template, AGP 9.0.1
android {
    namespace = "com.acme.shop"          // was "com.example.clsrepro"
    // ...
    defaultConfig {
        applicationId = "com.example.clsrepro"
        // ...
    }
}
```

```kotlin
// android/app/src/main/kotlin/com/example/clsrepro/MainActivity.kt, unchanged
package com.example.clsrepro

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
```

`flutter build apk --debug` succeeds. Here is what is actually inside the APK, and what happened on launch, for every variant I tried:

| Scenario | Manifest `android:name` (merged) | Class in dex | Result |
|---|---|---|---|
| Template baseline | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | runs |
| `namespace` changed only | `com.acme.shop.MainActivity` | `com.example.clsrepro.MainActivity` | **ClassNotFoundException** |
| `applicationId` changed only | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | runs (installed as `com.acme.shop`) |
| Kotlin `package` line changed only | `com.example.clsrepro.MainActivity` | `com.acme.shop.MainActivity` | **ClassNotFoundException** |
| `namespace` and `package` line changed, file left in old folder | `com.acme.shop.MainActivity` | `com.acme.shop.MainActivity` | runs |
| `MainActivity.kt` in `src/free/kotlin`, `free` flavor | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | runs |
| same, `paid` flavor | `com.example.clsrepro.MainActivity` | (none) | **ClassNotFoundException** |
| Template baseline, `--release` (R8 on) | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | runs |

Two rows are worth staring at. Changing only `applicationId` is harmless, because the class name never depended on it. And moving the file to match the new package is not required: Kotlin does not enforce that the directory matches the `package` declaration, so the row with the file still under `com/example/clsrepro/` runs fine. Most "rename your Flutter package" guides tell you to move folders first, and that is the step that matters least.

## The fix, step by step

### 1. Read the three values off the built APK, not off your source

Source files can lie (an unsaved editor, a flavor override, a manifest placeholder). The APK cannot. With the Android SDK build-tools on your `PATH`:

```bash
# Android SDK build-tools 36.1.0, after flutter build apk --debug
APK=build/app/outputs/flutter-apk/app-debug.apk

# 1. The application ID it installs as
aapt2 dump packagename $APK

# 2. The activity class the manifest asks for
aapt2 dump xmltree --file AndroidManifest.xml $APK | grep -A2 "E: activity" | grep android:name

# 3. The MainActivity classes that actually exist
unzip -o -q $APK 'classes*.dex' -d /tmp/dex
for d in /tmp/dex/classes*.dex; do dexdump $d | grep "Class descriptor" | grep MainActivity; done
```

On the broken `namespace` repro this printed `com.acme.shop.MainActivity` for step 2 and `Lcom/example/clsrepro/MainActivity;` for step 3. If step 3 prints nothing, you are in the "not compiled into this variant" case; skip to step 4.

### 2. Make the Kotlin `package` line match `namespace`

Decide which name you want your code to live in, then set both to it:

```kotlin
// android/app/build.gradle.kts, AGP 9.0.1
android {
    namespace = "com.acme.shop"
    defaultConfig {
        applicationId = "com.acme.shop"   // only if you want a new store identity, see below
    }
}
```

```kotlin
// android/app/src/main/kotlin/com/acme/shop/MainActivity.kt, Flutter 3.44.8
package com.acme.shop

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
```

Move the file into `kotlin/com/acme/shop/` for tidiness if you like. It is optional for Kotlin. If your activity is a Java file (`MainActivity.java`, common in older Flutter projects) also move it: Java convention and IDE refactorings expect the directory to match the package.

If you would rather not touch `namespace`, you can instead write the fully qualified name in the manifest (`android:name="com.example.clsrepro.MainActivity"`). That works, but it hides the mismatch rather than removing it, and the next `namespace` change will not move it with you.

### 3. Grep for leftovers of the old name

A rename that misses one file produces exactly this crash. Search the whole `android/` tree, including manifests for other source sets (`src/debug/AndroidManifest.xml`, `src/profile/AndroidManifest.xml`) and any other Kotlin or Java files that declare the old package:

```bash
# from the Flutter project root
grep -rn "com.example.clsrepro" android/ --include='*.kt' --include='*.java' --include='*.xml' --include='*.kts' --include='*.gradle'
```

Custom `Application` subclasses, `BroadcastReceiver`s, and `Service`s declared with a leading period are resolved against `namespace` the same way, so they crash with the same exception (the message just names a different class, and for an `Application` it says "Unable to instantiate application").

### 4. If the class is missing entirely, fix the source set

When `dexdump` shows no `MainActivity` at all, find out where the file lives:

```bash
find android/app/src -name 'MainActivity.*'
```

Anything under `src/main/` is compiled into every variant. Anything under `src/<flavor>/` or `src/<buildType>/` is only compiled for that variant. In my repro, putting `MainActivity.kt` in `src/free/kotlin` and running `flutter run --flavor paid` produced `Didn't find class "com.example.clsrepro.MainActivity"` under the `com.example.clsrepro.paid` application ID. Either move the file back to `src/main/kotlin`, or give every flavor its own copy with the same package. If the file is simply gone (a regenerated `android/` folder), recreate it from the template above.

### 5. Clean and reinstall

```bash
# Flutter 3.44.8
flutter clean
flutter pub get
flutter run
```

Stale intermediates can keep an old dex around after a rename, and an old install under the previous application ID can still own the launcher icon you are tapping. If you changed `applicationId`, uninstall the old package (`adb uninstall com.example.clsrepro`) so you do not keep testing the previous build.

## Changing applicationId versus namespace

These two values answer different questions, and most crashes come from treating them as one:

- `applicationId` is the identity on the device and on Google Play. Changing it after publishing creates a different app as far as Play is concerned. It never affects class names.
- `namespace` is the package for the generated `R` and `BuildConfig` classes and the base for every shorthand class name in the manifest. It is a code concern only.

The Android docs recommend always setting `applicationId` explicitly, because if it is missing it falls back to `namespace`, and then a code-level rename silently changes your store identity too. The Flutter template already sets both. If all you want is a new bundle ID for a new store listing, change `applicationId` and nothing else: that is the only rename in the table above that cannot produce this crash.

There is also a cost to renaming the activity class itself after you ship. The `<activity>` docs say not to change `android:name` of an exported activity once the app is published. The Flutter `MainActivity` is exported, and launcher shortcuts and pinned icons on users' home screens reference the component by its class name. If you must move it, an `<activity-alias>` with the old name pointing at the new class keeps existing shortcuts working.

## Release builds and R8

A common guess is that R8 removed `MainActivity` in a release build. It does not, as long as the manifest names it. During resource processing AAPT2 writes a keep rule for every component it finds in the manifest. From my release build, `build/app/intermediates/aapt_proguard_file/release/processReleaseResources/aapt_rules.txt` contained:

```text
-keep class com.example.clsrepro.MainActivity { <init>(); }
```

and `mapping.txt` mapped the class to itself, unrenamed. The release APK launched fine. So if a release build fails with this error while debug works, look for a difference between the variants (a release-only manifest in `src/release/`, a flavor source set) before you start writing ProGuard rules. A class that R8 genuinely strips is one you only reach by reflection and never mention in a manifest, and that usually surfaces later as a `ClassNotFoundException` for that class, not for `MainActivity`.

## Lookalikes

- **A build error about `io.flutter.app.FlutterActivity` or `FlutterApplication`**: an app still on the v1 Android embedding. That is a migration problem, covered in the [Flutter 2 to 3.x migration checklist](/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/).
- **The build fails before an APK exists** (Kotlin daemon or Gradle errors): you never reach launch. See [Daemon compilation failed: null](/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/) and [Timeout waiting to lock journal cache](/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/).
- **`MissingPluginException` on a method channel**: the activity started fine, but a handler was registered in the wrong place. The channel registration pattern is in [adding platform-specific code without plugins](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

## Related

- [Migrate a Flutter Android project to AGP 9 with built-in Kotlin](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/), including how to confirm your `MainActivity` made it into the dex after the migration.
- [Fix: e: Daemon compilation failed: null in a Flutter Android Gradle build](/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)
- [How to add platform-specific code in Flutter without plugins](/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [Fix: Timeout waiting to lock journal cache in a Flutter Android build](/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/)

## Sources

- [Configure the app module: namespace and application ID](https://developer.android.com/build/configure-app-module), Android Developers.
- [`<activity>` element, `android:name`](https://developer.android.com/guide/topics/manifest/activity-element#nm), Android Developers.
- [Set the application ID](https://developer.android.com/build/configure-app-module#set-application-id), Android Developers.
- [Shrink, obfuscate, and optimize your app](https://developer.android.com/build/shrink-code), Android Developers.
- [Build and release an Android app](https://docs.flutter.dev/deployment/android), Flutter docs.
