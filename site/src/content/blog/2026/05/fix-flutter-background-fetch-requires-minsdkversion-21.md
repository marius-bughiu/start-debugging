---
title: "Fix: Flutter background_fetch plugin requires minSdkVersion 21"
description: "The fix in 30 seconds: set minSdkVersion to 21 (or higher) in android/app/build.gradle. background_fetch is built on Android's JobScheduler, which only exists from API 21."
pubDate: 2026-05-18
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "background_fetch"
---

The fix in one breath: the `background_fetch` plugin (Transistor Software) ships an `AndroidManifest.xml` and Kotlin code that wire up Android's `JobScheduler`, which was introduced in API 21 (Android 5.0 Lollipop). If your Flutter app's `android/app/build.gradle` still uses `minSdkVersion 19` (or `16`, on apps generated on a pre-2023 Flutter SDK), the manifest merger refuses the build with `uses-sdk:minSdkVersion 19 cannot be smaller than version 21 declared in library [:background_fetch]`. Open `android/app/build.gradle`, change `minSdkVersion` to at least `21`, run `flutter clean`, then `flutter pub get` and `flutter build apk`. If you are on a newer Flutter SDK that uses `minSdk flutter.minSdkVersion`, override the Flutter-wide default instead of hardcoding the number, otherwise the Flutter Gradle plugin will silently overwrite your edit on the next build.

```text
> Manifest merger failed : uses-sdk:minSdkVersion 19 cannot be smaller than version 21 declared in library [:background_fetch]
    /Users/me/myapp/build/background_fetch/intermediates/merged_manifest/debug/AndroidManifest.xml as the library might be using APIs not available in 19
    Suggestion: use a compatible library with a minSdk of at most 19,
        or increase this project's minSdk version to at least 21,
        or use tools:overrideLibrary="com.transistorsoft.flutter.backgroundfetch" to force usage (may lead to runtime failures)

FAILURE: Build failed with an exception.
BUILD FAILED in 14s
```

This guide is written against Flutter 3.41.5, Dart 3.11, `background_fetch` 1.6.2, Android Gradle Plugin 8.7, and Gradle 8.11, the stable channel as of May 2026. The error itself has been stable since `background_fetch` 1.0.0; only the default `minSdkVersion` that ships in a freshly generated Flutter project has moved, which is why some teams hit this on the first build of a recently-bumped app and others have never seen it.

## What the error actually says

The Android build system runs a manifest merger pass that combines the application's `AndroidManifest.xml` with the manifests of every AAR on the classpath. Each manifest declares a `<uses-sdk android:minSdkVersion="X"/>` tag. The merger picks the highest value and refuses to ship a build whose application-level `minSdkVersion` is lower than what any one library declares. `background_fetch` declares `minSdkVersion 21` in [its plugin manifest](https://github.com/transistorsoft/flutter_background_fetch/blob/master/android/src/main/AndroidManifest.xml), and the only way to satisfy the merger is to raise the application to match.

The error surfaces in three concrete forms depending on the Android Gradle Plugin version and the Flutter template generation:

```text
Manifest merger failed : uses-sdk:minSdkVersion 19 cannot be smaller than version 21
declared in library [:background_fetch]
```

```text
The plugin background_fetch requires a higher Android SDK version.
Fix this issue by adding the following to /Users/me/myapp/android/app/build.gradle:
android {
  defaultConfig {
    minSdkVersion 21
  }
}
```

```text
A problem occurred evaluating project ':background_fetch'.
> com.transistorsoft.flutter.backgroundfetch requires Android SDK 21 or above
```

The first is the raw manifest-merger output. The second is the `flutter` CLI's pre-flight hint, which only fires for plugins that have advertised their `minSdkVersion` through the Flutter plugin descriptor. The third is a Gradle assertion baked into the plugin's `android/build.gradle`. All three trace back to the same constraint: `JobScheduler` and the `android.app.job.JobInfo`, `JobService`, and `JobParameters` classes that `background_fetch` calls into were added in API 21. On API 19 they do not exist at all; on API 20 (Android Wear 4.4W) only a subset of `JobService` shipped. The plugin will not run on anything below 21, so the manifest merger blocks the build before you can ship a broken APK.

## Why API 21 specifically

`JobScheduler` exists for a reason: before it, scheduling repeating background work on Android meant `AlarmManager` with a wake lock, an `IntentService`, and a custom retry loop. That approach drained batteries, dodged Doze mode after Android 6.0, and was deprecated in pieces over Android 8.0, 9.0, and 10. `JobScheduler` lets the OS coalesce background work across apps, defer it for charge state or network type, and survive process death. `background_fetch` is, internally, a thin Dart-friendly wrapper over `JobScheduler` (and the iOS equivalent, `BGTaskScheduler`). It cannot, by construction, target an API lower than 21 without rewriting the entire backend.

The plugin's [README](https://pub.dev/packages/background_fetch) and `CHANGELOG.md` have stated this requirement since 1.0.0 in 2018, but the error only became common again in 2025 when Google Play started rejecting apps targeting `targetSdkVersion 33` or lower, prompting wide rebuilds of long-lived Flutter codebases that had not touched their `android/app/build.gradle` since 2019.

## A minimal repro

Create a Flutter app on an SDK that still defaults to `minSdkVersion 19`, add the plugin, and run a debug build:

```bash
# Flutter 3.7.0 (December 2022), the last template before the 19 -> 21 bump
flutter create background_fetch_repro
cd background_fetch_repro
flutter pub add background_fetch
flutter build apk --debug
```

`flutter pub add background_fetch` resolves to `^1.6.2` and writes a transitive dependency on the Android plugin manifest. The next build will fail with `Manifest merger failed`. The same error reproduces on a freshly-generated Flutter 3.41.5 project if you have manually downgraded `minSdkVersion` because a different plugin (`flutter_blue_classic`, for instance) appeared to need a lower value.

## The fix, in detail

There are three viable paths depending on which Flutter SDK generated the project. Pick the one whose `android/app/build.gradle` matches your tree.

### Path A: Groovy build.gradle with hardcoded numbers

If `android/app/build.gradle` contains a literal `minSdkVersion 19`, change the literal:

```groovy
// android/app/build.gradle
// Flutter 3.0 through 3.15 era template
android {
    compileSdkVersion 34

    defaultConfig {
        applicationId "com.example.myapp"
        minSdkVersion 21        // was 19
        targetSdkVersion 34
        versionCode flutterVersionCode.toInteger()
        versionName flutterVersionName
    }
}
```

Save, then run `flutter clean && flutter pub get && flutter build apk`. The merger now picks 21 from the app and accepts the plugin's `21`.

### Path B: Groovy build.gradle using flutter.minSdkVersion

Flutter 3.16 and later replace the literal with a reference to a property set by the Flutter Gradle plugin:

```groovy
// android/app/build.gradle
// Flutter 3.16 through 3.27 era template
android {
    defaultConfig {
        minSdkVersion flutter.minSdkVersion
    }
}
```

`flutter.minSdkVersion` defaulted to 21 from Flutter 3.16 onward, so this branch already passes. If your project is on this template and still fails the manifest merger, something has overridden the property. Check `android/local.properties` for a stale `flutter.minSdkVersion=19` line and delete it, or pass `-Pflutter.minSdkVersion=21` on the Gradle command line if your CI is injecting an old value. Do not replace the property reference with a literal; the Flutter Gradle plugin in 3.41 rewrites `android/app/build.gradle` on every `flutter run` under certain conditions ([flutter/flutter#177141](https://github.com/flutter/flutter/issues/177141)) and will undo your edit.

### Path C: Kotlin DSL build.gradle.kts

Flutter 3.29 switched the template to Kotlin DSL. The shape is the same with Kotlin syntax:

```kotlin
// android/app/build.gradle.kts
// Flutter 3.29 and later
android {
    defaultConfig {
        applicationId = "com.example.myapp"
        minSdk = flutter.minSdkVersion       // resolves to 21 on Flutter 3.29+
        targetSdk = flutter.targetSdkVersion
    }
}
```

If you need to pin a value explicitly (for instance, because another plugin requires 23), set `minSdk = 23` instead. The Flutter Gradle plugin respects explicit literals in the Kotlin DSL template; only the Groovy template currently has the overwrite bug.

After any of the three, run:

```bash
flutter clean
flutter pub get
flutter build apk --release
```

`flutter clean` matters here because the manifest merger caches its decision in `build/app/intermediates/merged_manifest/`. A subsequent build without a clean step will keep replaying the failed merge from disk and you will think the edit did nothing.

## What raising minSdkVersion to 21 actually costs you

API 21 means Android 5.0 Lollipop, released October 2014. Google's own [distribution dashboard](https://developer.android.com/about/dashboards) (last meaningful update before Google moved it inside Android Studio) puts the share of devices running below API 21 at well under 0.3 percent as of 2026, almost entirely older Kindle Fire tablets and unupdated emerging-market handsets. Play Store no longer accepts new releases targeting under API 24 anyway, so for an app distributed through Play this is moot. If you are sideloading APKs or shipping through alternative stores you may have a long-tail audience on API 19 or 20, in which case `background_fetch` simply is not an option: there is no shim. Use `WorkManager` directly through a [Pigeon](https://pub.dev/packages/pigeon) channel or accept a foreground service with a persistent notification.

## Gotchas after the merger passes

Several follow-on errors look like the first one but have different root causes. Recognise them so you do not keep raising `minSdkVersion` and break compatibility for nothing.

**Another plugin needs more than 21.** If after the fix you see `cannot be smaller than version 23 declared in library [:flutter_blue_plus]`, that is a different plugin asking for API 23. Raise `minSdkVersion` to match the highest declared by any plugin in your tree. Run `./gradlew app:dependencies` from `android/` to enumerate them.

**Manifest tag missing for headless tasks.** If you use `BackgroundFetch.registerHeadlessTask` to receive callbacks while the app is terminated, the manifest must declare the receiver. The plugin's manifest already includes it, but apps that manually set `tools:replace="android:label"` on the `<application>` tag (a fix from the AndroidX migration era) can accidentally also overwrite `android:name` or drop the receiver. Read [the AndroidX conflict guide](/2026/05/fix-androidx-conflict-during-flutter-android-build/) if you suspect this; the symptom is silent (no callback fires) rather than a build error.

**iOS BGTaskScheduler identifier missing.** The Android-side error is the loudest, but a parallel iOS configuration is required. `Info.plist` needs a `BGTaskSchedulerPermittedIdentifiers` array with `com.transistorsoft.fetch`, and the Xcode project must have the `background-fetch` capability enabled under Signing and Capabilities. The Android fix above will let the build pass on Android, but the iOS build still fails or, worse, builds and never fires a callback in production.

**Gradle daemon caches the merged manifest.** On CI, `flutter clean` is not always enough. The Gradle daemon keeps `:app:processDebugManifest` outputs in `~/.gradle/caches/`. If a CI run failed once with the old `minSdkVersion`, the next run may replay the failure unless you call `./gradlew --stop` before the next build or delete the cache directory.

**Jetifier on a recent AGP makes the error look different.** AGP 8.7 disables Jetifier by default. If you have explicitly re-enabled it in `gradle.properties` (`android.enableJetifier=true`), the manifest merger runs after Jetifier rewrites the library AAR, and the error message swaps `com.transistorsoft.flutter.backgroundfetch` for an `androidx.*`-rewritten name. Same root cause, different surface text. The fix is identical.

**Pinned NDK or buildToolsVersion below 30.** A very small number of long-lived projects pin `buildToolsVersion "29.0.3"` in `android/app/build.gradle`. `background_fetch` 1.6 was compiled against Android 14 build tools and will fail to link against `JobService` symbols under 30. Remove the pin or raise it to `34.0.0`.

## Related reading

The AndroidX migration is the other half of why Flutter Android builds break on old projects: see [AndroidX conflict during Flutter Android build](/2026/05/fix-androidx-conflict-during-flutter-android-build/) for the manifest merger and Jetifier behaviour in detail. If `flutter pub get` is the thing failing instead, [version solving failed in pubspec.yaml](/2026/05/fix-version-solving-failed-in-pubspec-yaml/) walks through reading the constraint solver's "because" chain. The iOS parallel for many of the same symptoms lives in [Failed to build iOS app with Xcode 16 and Flutter 3.x](/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/). And if the actual Android failure is the Gradle command line, not the manifest merger, [Gradle build failed to produce an .apk file in MAUI Android](/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) has the same triage steps with MAUI-specific paths but the AGP-side cache notes apply equally.

## Sources

- [`background_fetch` package on pub.dev](https://pub.dev/packages/background_fetch)
- [`flutter_background_fetch` Android install guide](https://github.com/transistorsoft/flutter_background_fetch/blob/master/help/INSTALL-ANDROID.md)
- [Android `JobScheduler` API reference (added in API 21)](https://developer.android.com/reference/android/app/job/JobScheduler)
- [Android Gradle Plugin manifest merger docs](https://developer.android.com/build/manage-manifests)
- [flutter/flutter#177141: Flutter Gradle plugin overwrites explicit `minSdk`](https://github.com/flutter/flutter/issues/177141)
- [Flutter 3.16 release notes: `minSdkVersion` default raised to 21](https://docs.flutter.dev/release/release-notes/release-notes-3.16.0)
