---
title: "Fix: NoSuchMethodError in SharedPreferencesAsyncApiRegistrar.getAll in a Flutter Android release build"
description: "shared_preferences_android 2.5.0/2.5.1 with jni 1.1.0 crash under R8. Run flutter pub upgrade until pubspec.lock shows 2.5.2+ or jni 1.1.1+."
pubDate: 2026-11-17
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "r8"
  - "shared-preferences"
---

If a Flutter app hangs on the splash screen in an Android release build and logcat shows `java.lang.NoSuchMethodError: no non-static method "Lio/flutter/plugins/sharedpreferences/SharedPreferencesAsyncApiRegistrar;.getAll(...Lkotlin/coroutines/Continuation;)Ljava/lang/Object;"`, your `pubspec.lock` has `shared_preferences_android` 2.5.0 or 2.5.1 together with `jni` 1.1.0. R8 renamed the Kotlin coroutine classes the JNI bindings look up by name. Run `flutter pub upgrade` and confirm the lockfile now shows `shared_preferences_android` 2.5.2 or newer (or `jni` 1.1.1 or newer); either one alone ships the missing keep rules. Everything below was reproduced on Flutter 3.44.8 (Dart 3.12.2), AGP 9.0.1, Gradle 9.1.0, KGP 2.3.20, JDK 17, with arm64 release APKs on an Android 16 (API 36) emulator.

## The error in context

This is the `SharedPreferencesWithCache` / `SharedPreferencesAsync` flavour, from `adb logcat` (trimmed):

```text
E flutter : [ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: PlatformException(PlatformException, java.lang.NoSuchMethodError: no non-static method "Lio/flutter/plugins/sharedpreferences/SharedPreferencesAsyncApiRegistrar;.getAll(Ljava/util/List;Lio/flutter/plugins/sharedpreferences/SharedPreferencesPigeonOptions;Lkotlin/coroutines/Continuation;)Ljava/lang/Object;", Exception in Java: java.lang.NoSuchMethodError: no non-static method "Lio/flutter/plugins/sharedpreferences/SharedPreferencesAsyncApiRegistrar;.getAll(...)"
E flutter : java.lang.NoSuchMethodError: no non-static method "Lio/flutter/plugins/sharedpreferences/SharedPreferencesAsyncApiRegistrar;.getAll(Ljava/util/List;Lio/flutter/plugins/sharedpreferences/SharedPreferencesPigeonOptions;Lkotlin/coroutines/Continuation;)Ljava/lang/Object;"
E flutter : 	at android.os.MessageQueue.nativePollOnce(Native Method)
E flutter : 	at android.os.Looper.loop(Looper.java:338)
```

If you still use the legacy `SharedPreferences.getInstance()` API, the class name is different, but it is the same bug:

```text
java.lang.NoSuchMethodError: no non-static method "Lio/flutter/plugins/sharedpreferences/SharedPreferencesApiRegistrar;.getAll(Ljava/lang/String;Ljava/util/List;Lkotlin/coroutines/Continuation;)Ljava/lang/Object;"
```

The symptoms that usually come with it:

- `flutter run` (debug) and `flutter run --profile` work. Only `--release` breaks.
- iOS is fine.
- Because the exception is thrown from `await SharedPreferences...` before `runApp()`, there is no red error screen. The app just sits on the launch screen, which makes it look like a hang rather than a crash.

## Why this happens

Starting with 2.5.0 (published 2026-10-17), `shared_preferences_android` no longer talks to its Kotlin code over a platform channel. Its changelog says "Updates internal implementation to use Pigeon JNI": the Dart side calls the Kotlin methods directly through `package:jni`, by class name and JNI method descriptor. The Kotlin API is made of `suspend` functions, so every descriptor ends in `Lkotlin/coroutines/Continuation;`, and the bindings also look up `kotlin.Unit`, `kotlin.Result`, `kotlin.Result$Failure`, `kotlin.coroutines.intrinsics.CoroutineSingletons` and `kotlin.coroutines.intrinsics.IntrinsicsKt` by name.

R8 has no idea that Dart code will ask for those names at runtime. Here is what happens in a release build with `shared_preferences_android` 2.5.0 and `jni` 1.1.0:

1. The registrar class itself survives, because it is annotated `@Keep`.
2. The Kotlin stdlib classes are not kept by anything. `jni` 1.1.0's `consumer-rules.pro` contains exactly one rule, `-keep class com.github.dart_lang.jni.** { *; }`, and the plugin ships no consumer rules at all.
3. R8 renames those classes, and it rewrites every descriptor that mentions them, including the parameter list of the kept `getAll`. In the APK, `getAll` now takes an `o1.d` instead of a `kotlin.coroutines.Continuation`.
4. The Dart bindings call `GetMethodID` with the original descriptor, which no longer exists, and JNI throws `NoSuchMethodError`.

You can see step 3 in the R8 mapping file of the broken build:

```bash
# Flutter 3.44.8, shared_preferences_android 2.5.0, jni 1.1.0
grep -E '^kotlin\.(Unit|Result|coroutines\.Continuation|coroutines\.intrinsics\.\w+) ' \
  build/app/outputs/mapping/release/mapping.txt
```

```text
kotlin.Result -> l1.d:
kotlin.Unit -> l1.g:
kotlin.coroutines.Continuation -> o1.d:
kotlin.coroutines.intrinsics.CoroutineSingletons -> p1.a:
```

In a working build the same command prints identity mappings such as `kotlin.coroutines.Continuation -> kotlin.coroutines.Continuation:`. That one grep tells you whether a given APK will crash, without installing it.

Debug and profile builds are not affected because they never run R8. In Flutter 3.44.8's Gradle plugin (`packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt`), the `profile` build type is created with `initWith(debugBuildType)`, and only the `release` build type gets `isMinifyEnabled = true` plus the default ProGuard files.

The bug was fixed twice, independently, which is why the version matrix matters:

- `shared_preferences_android` 2.5.2 (2026-10-22) added its own `android/consumer-rules.pro` with the six Kotlin keep rules and wired it up through `consumerProguardFiles` ([flutter/packages#13311](https://github.com/flutter/packages/pull/13311)).
- `jni` 1.1.1 (2026-10-27) added the same six rules to its own `consumer-rules.pro` ("Add ProGuard consumer rules for Kotlin classes used by suspend functions").

So the crash needs both halves: a JNI-based `shared_preferences_android` without rules (2.5.0 or 2.5.1) and a `jni` without rules (1.1.0). Anyone who resolved dependencies between 2026-10-17 and 2026-10-22 got exactly that combination, and a committed `pubspec.lock` keeps it forever.

## Minimal repro

```bash
# Flutter 3.44.8 stable, macOS, Android SDK 36
flutter create --platforms android -e --org dev.repro sprepro
cd sprepro
flutter pub add shared_preferences 'shared_preferences_android:2.5.0'
```

Force the old `jni` so today's resolver cannot paper over the bug, by adding this to `pubspec.yaml`:

```yaml
# Flutter 3.44.8: reproduce the 2026-10-17..22 lockfile state
dependency_overrides:
  jni: 1.1.0
```

Replace `lib/main.dart`:

```dart
// Flutter 3.44.8, Dart 3.12.2, shared_preferences 2.5.6
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final preferences = await SharedPreferencesWithCache.create(
    cacheOptions: const SharedPreferencesWithCacheOptions(),
  );
  final launches = (preferences.getInt('launches') ?? 0) + 1;
  await preferences.setInt('launches', launches);
  debugPrint('launches=$launches');
  runApp(MaterialApp(home: Scaffold(body: Center(child: Text('$launches')))));
}
```

Build, install and watch logcat:

```bash
# Flutter 3.44.8, arm64 emulator running Android 16 (API 36)
flutter build apk --release --target-platform android-arm64
adb install -r build/app/outputs/flutter-apk/app-release.apk
adb logcat -c
adb shell am start -n dev.repro.sprepro/.MainActivity
adb logcat -d | grep -E 'launches=|NoSuchMethodError'
```

With this setup the app throws the `NoSuchMethodError` above within a second of launch and `launches=` is never printed.

## Fix, in detail

Each fix below was built as an arm64 release APK and launched on the same Android 16 emulator, after `flutter clean` and a fresh `flutter pub get`. "Works" means logcat printed `launches=1` on first launch.

| `shared_preferences_android` | `jni` | Extra config | Result |
| --- | --- | --- | --- |
| 2.5.0 | 1.1.0 | none | `NoSuchMethodError` |
| 2.5.1 | 1.1.0 | none | `NoSuchMethodError` |
| 2.5.0 | 1.1.0 | keep rules in `android/app/proguard-rules.pro` | works |
| 2.5.0 | 1.1.1 | none | works |
| 2.5.2 | 1.1.0 | none | works |
| 2.5.5 | 1.1.2 | none | works (and `launches=2` after a force-stop and relaunch) |

### 1. Upgrade the transitive packages (recommended)

`shared_preferences_android` and `jni` are almost always transitive dependencies, which is the trap: bumping `shared_preferences` in `pubspec.yaml` does not move them. `shared_preferences` 2.5.6 only requires `shared_preferences_android: ^2.3.4`, so `flutter pub get` happily keeps 2.5.0 if that is what the lockfile says. In the repro, after removing the overrides and leaving only `shared_preferences: ^2.5.6`, `flutter pub get` still resolved `shared_preferences_android 2.5.0` and `jni 1.1.0`.

Check what you actually have:

```bash
# Flutter 3.44.8
flutter pub outdated
```

```text
Package Name                   Current   Upgradable  Resolvable  Latest
jni                            *1.1.0    1.1.2       1.1.2       1.1.2
shared_preferences_android     *2.5.0    2.5.5       2.5.5       2.5.5
```

Then upgrade:

```bash
# Flutter 3.44.8
flutter pub upgrade
```

```text
> jni 1.1.2 (was 1.1.0)
> shared_preferences_android 2.5.5 (was 2.5.0)
```

Commit the new `pubspec.lock`. If CI builds the release APK from a lockfile you did not update, CI keeps shipping the crash even though your machine is fixed.

Remove any workaround you added earlier: a `dependency_overrides` pin on `shared_preferences_android` blocks the upgrade, and the app-level keep rules become redundant once the packages carry their own.

### 2. Upgrade only `jni` when `shared_preferences_android` is held back

If something in your graph caps `shared_preferences_android` below 2.5.2, getting `jni` to 1.1.1 or newer is enough on its own (row four of the table). Its consumer rules are merged into every app that depends on it, so the plugin no longer needs to ship its own.

### 3. Add the keep rules to your app

If you cannot change dependency versions right now (a release branch, a frozen lockfile), put the rules in your app module. Flutter's Gradle plugin adds `android/app/proguard-rules.pro` to the release build type automatically when the file exists, so no Gradle edit is needed:

```text
# android/app/proguard-rules.pro
# Flutter 3.44.8, workaround for shared_preferences_android 2.5.0/2.5.1 + jni 1.1.0
-keep class kotlin.Unit { *; }
-keep class kotlin.Result { *; }
-keep class kotlin.Result$Failure { *; }
-keep class kotlin.coroutines.Continuation { *; }
-keep class kotlin.coroutines.intrinsics.CoroutineSingletons { *; }
-keep class kotlin.coroutines.intrinsics.IntrinsicsKt { *; }
```

These are the same six rules that `jni` 1.1.1 and `shared_preferences_android` 2.5.2 ship. Delete them once you can upgrade, so you are not maintaining a copy that may drift from the list in `jni`'s `lib/src/kotlin.dart`.

### 4. Pin the pre-JNI implementation

The workaround most people reached for while the fix was unpublished was going back to the last platform-channel version, 2.4.28:

```yaml
# pubspec.yaml, Flutter 3.44.8 (temporary)
dependency_overrides:
  shared_preferences_android: 2.4.28
```

Reporters on [flutter/flutter#194649](https://github.com/flutter/flutter/issues/194649) confirmed this works; it was not part of the emulator matrix above. It is the worst of the four options now: it freezes you on an old implementation and hides future fixes, and `dependency_overrides` applies silently. If you added it in October, it is probably still there.

## Gotchas and variants

- **Check the lockfile, not `pubspec.yaml`.** The versions that end up in the APK are the ones in `pubspec.lock`. After upgrading, confirm with `grep -A4 '^  shared_preferences_android:' pubspec.lock` and `grep -A4 '^  jni:' pubspec.lock`.
- **The mapping file is the fastest diagnostic.** If `kotlin.coroutines.Continuation` maps to anything other than itself in `build/app/outputs/mapping/release/mapping.txt`, any JNI-based plugin that calls Kotlin suspend functions can fail the same way, not just `shared_preferences`. Keeping `jni` at 1.1.1 or newer covers the Kotlin classes for all of them.
- **Stale builds lie.** When switching versions, run `flutter clean` first. In the repro, switching `shared_preferences_android` between 2.5.0 and 2.5.2 without a clean failed with `GeneratedPluginRegistrant.java:24: error: cannot find symbol`, because the generated registrant still referenced the previous plugin class.
- **Your crash reporter may never see it.** The exception is thrown before `runApp()`, which is often before a crash reporter has been initialised. If release users report "stuck on the splash screen" and your dashboard is empty, reproduce with a local release build and read logcat.
- **A different `NoSuchMethodError` in the same plugin.** Release builds of other plugins can fail with `ClassNotFoundException` or `NoSuchMethodError` for reasons that have nothing to do with JNI, for example a missing `@Keep` on a class used through reflection. The `Continuation` in the descriptor is the fingerprint of this specific bug.

## Related

- If your release build breaks in a different way after R8, [the Firebase Auth release-build persistence walkthrough](/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/) shows how to rule shrinking in or out with `-printusage`.
- Whether you should be using `shared_preferences` for this data at all is covered in [shared_preferences vs a JSON file for persisting settings in Flutter](/2026/10/shared-preferences-vs-json-file-for-persisting-settings-in-flutter/).
- Why the lockfile changes (or does not) when you expect it to: [pubspec.lock modified after flutter upgrade](/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/).
- If you reached for `dependency_overrides` as a stopgap, [pubspec_overrides.yaml and when to use it](/2026/11/what-is-pubspec-overrides-yaml-and-when-should-i-use-it-in-a-flutter-monorepo/) explains how overrides are applied.
- Another release-only Android build message with an R8 angle: [the unobfuscated DWARF debugging information warning](/2026/11/fix-unobfuscated-dwarf-debugging-information-warning-in-flutter-android-builds/).

## Sources

- [flutter/flutter#194649](https://github.com/flutter/flutter/issues/194649): the original report, with the mapping-file evidence and the version timeline.
- [flutter/packages#13311](https://github.com/flutter/packages/pull/13311): adds `consumer-rules.pro` to `shared_preferences_android`, released as 2.5.2.
- [dart-lang/native#3732](https://github.com/dart-lang/native/issues/3732): the request for `jni` to ship the Kotlin keep rules, released in `jni` 1.1.1.
- [`shared_preferences_android` changelog](https://pub.dev/packages/shared_preferences_android/changelog) and [`jni` changelog](https://pub.dev/packages/jni/changelog) on pub.dev.
- [Android docs: Configure and troubleshoot R8 keep rules](https://developer.android.com/topic/performance/app-optimization/add-keep-rules).
