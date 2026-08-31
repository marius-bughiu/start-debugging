---
title: "Fix: Firebase Auth sign-in does not persist in a Flutter Android release build"
description: "Firebase Auth restores the Android session from a private SharedPreferences file with no network call, so a release-only sign-out is never broken persistence. It is a different google-services.json, a rejected token refresh, App Check, or your own catch block."
pubDate: 2026-08-31
template: how-to
tags:
  - "errors"
  - "flutter"
  - "android"
  - "firebase"
  - "dart"
---

You sign in, kill the app, reopen it, and the user is gone. Only in release. In debug the session survives every restart. The important thing to know before you change anything is that Firebase Auth on Android restores the signed-in user from a private `SharedPreferences` file with no network call at all, so "persistence is broken in release" is almost never what is happening. Either the release build is opening a different store file, or something cleared the store: a token refresh that came back rejected rather than merely failed, App Check enforcement that only trusts your debug certificate, or your own startup code calling `signOut()` in a catch block. This is verified against `firebase_auth` 6.6.1 and `firebase_core` 4.14.0 on Flutter 3.47.1 with Dart 3.13.1, resolving `com.google.firebase:firebase-auth:24.2.0` on Android.

## Where the Android session actually lives

The Flutter plugin does not implement persistence. It forwards to the Android SDK, and the Android SDK writes the user to a `SharedPreferences` file. In `firebase-auth` 24.2.0 the store is `com.google.firebase.auth.internal.zzce`, whose constructor resolves to:

```java
// Decompiled from com.google.firebase:firebase-auth:24.2.0
// zzce(Context, String persistenceKey)
this.zzc = context.getSharedPreferences(
    String.format("com.google.firebase.auth.api.Store.%s", persistenceKey),
    Context.MODE_PRIVATE);
```

The persistence key comes from `FirebaseApp.getPersistenceKey()`, which is two URL-safe base64 values joined by a plus sign:

```java
// com.google.firebase:firebase-common
// getPersistenceKey() == base64Url(appName) + "+" + base64Url(options.getApplicationId())
```

For the default app, `[DEFAULT]` encodes to `W0RFRkFVTFRd`, so a real device path looks like this:

```
/data/data/<applicationId>/shared_prefs/com.google.firebase.auth.api.Store.W0RFRkFVTFRd+<base64url of mobilesdk_app_id>.xml
```

Two facts fall out of that constructor, and they steer the whole investigation. First, restoring the user is a disk read. `FirebaseAuth`'s constructor builds `zzce` and pulls the stored user out of it, so a device with no network still comes back signed in. Second, the file name is derived from the Google app ID in your `google-services.json`. Change that value between variants and you have not lost a session, you have stopped opening the file it was written to.

## Why `currentUser` is not racy on Android

There is a widely repeated claim that `FirebaseAuth.instance.currentUser` is null for a moment after startup and you have to wait for `authStateChanges()`. That is true on web and on the desktop embedders. It is not true on Android, and knowing this saves you from "fixing" a race that does not exist.

The Android plugin publishes the restored user as a plugin constant during `Firebase.initializeApp()`:

```kotlin
// firebase_auth 6.6.1, android/.../FlutterFirebaseAuthPlugin.kt
override fun getPluginConstantsForFirebaseApp(
    firebaseApp: FirebaseApp?
): Task<MutableMap<String, Any>> {
  // ...
  val firebaseAuth = FirebaseAuth.getInstance(firebaseApp!!)
  val firebaseUser = firebaseAuth.currentUser
  val user = PigeonParser.parseFirebaseUser(firebaseUser)
  if (user != null) {
    constants["APP_CURRENT_USER"] = PigeonParser.manuallyToList(user)
  }
  // ...
}
```

Those constants feed `MethodChannelFirebaseAuth.setInitialValues`, and the streams then replay that value before anything from the native event channel arrives:

```dart
// firebase_auth_platform_interface, method_channel_firebase_auth.dart
@override
Stream<UserPlatform?> authStateChanges() async* {
  yield currentUser;
  yield* _authStateChangesListeners[app.name]!.stream.map((event) => event.value);
}
```

So on Android, once `await Firebase.initializeApp()` has returned, `currentUser` is already correct and the first event from `authStateChanges()` is that same value. If it is null in release, the store was genuinely empty. Switching from `currentUser` to a `StreamBuilder` will not change the answer, though it is still the right shape for an auth gate for other reasons, which is worth reading about alongside [the trade-offs between StreamBuilder and Riverpod's AsyncValue](/2026/06/futurebuilder-streambuilder-vs-riverpod-asyncvalue-in-flutter/).

## Diagnostic steps that isolate the cause

Run these in order. Each one eliminates a whole class of explanation, and the first two take about five minutes.

1. **Make the release build debuggable so you can inspect it.**
   `adb shell run-as` refuses to touch a package that is not marked debuggable, which is why you cannot read the store out of a normal release APK. Add a throwaway build type in `android/app/build.gradle.kts`, build it, and delete it when you are done.

   ```kotlin
   // android/app/build.gradle.kts, temporary
   buildTypes {
       create("releaseProbe") {
           initWith(getByName("release"))
           isDebuggable = true
           matchingFallbacks += listOf("release")
       }
   }
   ```

2. **Confirm whether the store file exists and which one it is.**
   Sign in, force stop, then list the app's preferences directory. If the file is there and non-empty but the app still starts signed out, you have a code problem, not a storage problem. If the file is missing, something cleared it.

   ```bash
   adb shell run-as com.example.app ls -l shared_prefs/
   adb shell run-as com.example.app cat 'shared_prefs/com.google.firebase.auth.api.Store.W0RFRkFVTFRd+...xml'
   ```

3. **Compare the Google app ID that each variant actually compiles in.**
   The `google-services` Gradle plugin writes the parsed values into a generated resource file per variant. Diff them. A difference here explains the symptom completely and nothing else needs investigating.

   ```bash
   grep google_app_id android/app/build/generated/res/google-services/debug/values/values.xml
   grep google_app_id android/app/build/generated/res/google-services/release/values/values.xml
   ```

4. **Rule out R8 with the usage report rather than by guessing.**
   Code shrinking is on in Flutter release builds, so this is a fair suspect, but it is cheap to eliminate. Add `-printusage build/r8-usage.txt` to `android/app/proguard-rules.pro`, rebuild, and grep the report for `com.google.firebase.auth`.

5. **Watch the token refresh.**
   Enable verbose Firebase Auth logging and cold start the app with the network on. A refresh that fails with a transport error leaves the session alone. A refresh that is rejected is what clears it.

   ```bash
   adb shell setprop log.tag.FirebaseAuth VERBOSE
   adb logcat -s FirebaseAuth:V FirebaseApp:V
   ```

6. **Check the certificate fingerprints registered against the project.**
   Print the fingerprints your release variant is actually signed with, then compare against Firebase project settings, the Google Cloud API key restrictions, and the Play Console App Signing page.

   ```bash
   cd android && ./gradlew signingReport
   ```

## Cause 1: the release variant reads a different `google-services.json`

This is the most common answer and the easiest to overlook, because nothing about it looks like an authentication problem.

Android source sets let you drop a `google-services.json` into `android/app/src/debug/`, `android/app/src/prod/`, or any flavor directory, and the Gradle plugin picks the most specific one for the variant being built. The FlutterFire CLI encourages the same layout through `--android-out`. If your debug variant resolves a file from a development Firebase project and your release variant resolves one from production, then `options.getApplicationId()` differs, the persistence key differs, and the store file name differs.

The consequence is precise: a session written by one variant is invisible to the other, and a session written by the release variant before you swapped its config is invisible after. Step 3 above catches this in one command. The fix is not code, it is making sure the variant you ship signs in and reads back against the same project every time, and that anyone testing knows a config swap is equivalent to a sign-out.

An `applicationIdSuffix` on debug produces a related but simpler situation: two separate installs with separate sandboxes. That one is expected behaviour and is usually not what people are reporting.

## Cause 2: R8 is enabled in release, but the stock configuration is safe

Flutter enables code shrinking for release builds itself. From the Flutter Gradle plugin, verified against a local 3.44.8 SDK where this logic is unchanged since 3.44:

```kotlin
// packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt
if (FlutterPluginUtils.shouldShrinkResources(project)) {
    val releaseBuildType: BuildType = ...buildTypes.getByName("release")
    releaseBuildType.isMinifyEnabled = true
    releaseBuildType.isShrinkResources = FlutterPluginUtils.isBuiltAsApp(project)
    releaseBuildType.proguardFiles.add(...getDefaultProguardFile("proguard-android-optimize.txt"))
    releaseBuildType.proguardFiles.add(flutterProguardRules)
    // plus android/app/proguard-rules.pro if it exists
}
```

`shouldShrinkResources` returns true unless the `shrink` Gradle property is explicitly false, and the `--shrink` command line flag is now a documented no-op: its help text reads "This flag has no effect. Code shrinking is always enabled in release builds." So yes, R8 runs on your release build whether or not your `build.gradle.kts` says so.

That still does not make R8 the likely culprit, because `firebase-auth` ships consumer rules that AGP applies automatically. The entire `proguard.txt` inside the 24.2.0 AAR is:

```proguard
-keepclassmembers class * extends com.google.android.gms.internal.firebase-auth-api.zzalt {
  <fields>;
}
-dontwarn rx.**
-dontwarn android.crypto.hpke.**
```

Reach for step 4 rather than adding speculative `-keep class com.google.firebase.** { *; }` rules. A blanket keep rule hides the question instead of answering it, and if the usage report shows nothing from `com.google.firebase.auth` was removed, you have eliminated this branch for good.

## Cause 3: the refresh is rejected, and only in release

On cold start the SDK restores the user from disk and then refreshes the ID token, which lives for one hour, against `securetoken.googleapis.com`. The SDK treats a transport failure and a rejection differently. A transport failure leaves the stored user in place, which is why an offline device stays signed in. A rejection carrying a definitive code from the SDK's error table, values such as `TOKEN_EXPIRED`, `USER_DISABLED` and `USER_NOT_FOUND`, clears the stored user and fires the auth state listener with null. That is why the symptom is a clean sign-out and not a hang.

Two configurations turn a working refresh into a rejected one for release builds only.

**API key restrictions scoped to the debug certificate.** If the Firebase API key carries an Android apps application restriction, every request has to present a package name and a SHA-1 certificate fingerprint that appear on the list. A key restricted to the debug keystore's SHA-1 works perfectly in `flutter run` and returns `403 PERMISSION_DENIED` with "Requests from this Android client application are blocked" once the app is signed for release. There is a second, nastier variant of this. Firebase documents that Authentication needs two APIs in the key's API restrictions allowlist: the Identity Toolkit API (`identitytoolkit.googleapis.com`) and the Token Service API (`securetoken.googleapis.com`). Allowlist only the first and you get exactly the reported shape: signing in succeeds, and the refresh on next launch does not.

**App Check enforcement.** If App Check is enforced for Authentication, the client must attach an attestation token. The usual Flutter setup swaps providers by build mode:

```dart
// firebase_app_check, called after Firebase.initializeApp()
await FirebaseAppCheck.instance.activate(
  androidProvider: kDebugMode ? AndroidProvider.debug : AndroidProvider.playIntegrity,
);
```

The debug provider is registered by hand in the Firebase console and always works for you. Play Integrity needs the SHA-256 fingerprint of the certificate the installed app is actually signed with, and if you use Play App Signing that is Google's key, not your upload key. Miss it and App Check fails only in production. Firebase also notes that builds not distributed through Google Play cannot earn the `PLAY_RECOGNIZED` verdict, so an internally distributed release APK needs the corresponding advanced setting relaxed or it will fail attestation on a perfectly healthy device.

Both of these are fingerprint problems, and the same trap catches people twice: `flutter run --release` signs with the debug config, because Flutter's own template does that on purpose. The comment in the generated `android/app/build.gradle.kts` says so: "Signing with the debug keys for now, so `flutter run --release` works." A release build that works from your machine and fails from Play is a fingerprint difference, not a build mode difference.

## Cause 4: your own code performs the sign-out

Once the store, the config and the fingerprints check out, the remaining possibility is that the app did it. The usual shape is a startup call that exchanges the Firebase ID token for a session on your own backend:

```dart
// The bug: any failure is treated as an invalid session.
try {
  final token = await FirebaseAuth.instance.currentUser!.getIdToken();
  await api.exchange(token);
} catch (_) {
  await FirebaseAuth.instance.signOut(); // wipes a perfectly good session
}
```

In debug this catch block never runs. In release, an App Check or API key rejection lands there and the user is signed out by your own code, which then persists because the store really is empty on the next launch. Distinguish the cases by code:

```dart
try {
  final token = await FirebaseAuth.instance.currentUser!.getIdToken();
  await api.exchange(token);
} on FirebaseAuthException catch (e) {
  const fatal = {'user-token-expired', 'user-disabled', 'user-not-found', 'invalid-user-token'};
  if (fatal.contains(e.code)) {
    await FirebaseAuth.instance.signOut();
  } else {
    // network-request-failed, too-many-requests, and anything unexpected:
    // keep the session and retry later.
  }
}
```

Guarding that path also means you are not navigating away from the shell while an async call is still in flight, which is the same discipline as [cancelling stream subscriptions in dispose](/2026/07/how-to-cancel-a-streamsubscription-in-dispose-in-flutter/).

## Gotchas that look like this but are not

**The missing INTERNET permission answer is wrong for Firebase Auth.** Flutter's `src/main/AndroidManifest.xml` template declares no permissions, while the generated `src/debug/` and `src/profile/` manifests both declare `android.permission.INTERNET` with the comment that the tool needs it for hot reload. That genuinely does break plain `http` or `dio` calls in release builds. It does not break Firebase Auth, because the `firebase-auth` 24.2.0 library manifest declares the permission itself and the manifest merger folds it into your APK:

```xml
<!-- com.google.firebase:firebase-auth:24.2.0, AndroidManifest.xml -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

Confirm it for your own build rather than trusting either claim: `build/app/outputs/logs/manifest-merger-release-report.txt` records which library contributed each node.

**Android Auto Backup can hand a device a stale session.** `android:allowBackup` defaults to true and `SharedPreferences` files are included, so the auth store travels through cloud backup and device-to-device transfer. Neither Flutter's template nor the `firebase-auth` manifest excludes it. If your reports cluster around new devices restored from a backup, exclude it explicitly:

```xml
<!-- android/app/src/main/res/xml/data_extraction_rules.xml, API 31+ -->
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="sharedpref" />
  </cloud-backup>
  <device-transfer>
    <exclude domain="sharedpref" />
  </device-transfer>
</data-extraction-rules>
```

**Uninstalling clears the store, and so does clearing app data.** Firebase documents this as the only supported way to wipe native persistence. A tester who sideloads a fresh APK over an uninstall is not reproducing your bug.

## Related

If you are working through Android release and Firebase problems in a Flutter app, these cover the adjacent failures: the [`google_sign_in` 7.x singleton migration](/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/) that changes how you obtain credentials before handing them to Firebase Auth, the [APNs token ordering problem](/2026/08/fix-firebase-messaging-apns-token-not-set-on-flutter-ios/) that produces the same "works in debug, silent in release" shape on iOS, the [16 KB page size rejection](/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) that blocks the release upload itself, and the [edge-to-edge layout change after targeting SDK 35](/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) that arrives in the same upgrade window.

## Sources

- [Get Started with Firebase Authentication on Flutter](https://firebase.google.com/docs/auth/flutter/start) - the statement that native persistence is not configurable, and the difference between `authStateChanges`, `idTokenChanges` and `userChanges`.
- [Learn about and manage API keys for Firebase](https://firebase.google.com/docs/projects/api-keys) - Authentication requires both the Identity Toolkit API and the Token Service API in an API key's allowlist.
- [Get started using App Check with Play Integrity on Android](https://firebase.google.com/docs/app-check/android/play-integrity-provider) - the SHA-256 registration requirement and the `PLAY_RECOGNIZED` caveat for builds distributed outside Google Play.
- [flutterfire issue #12727](https://github.com/firebase/flutterfire/issues/12727) - the "Requests from this Android client application are blocked" 403 produced by Android application restrictions on the API key.
- `com.google.firebase:firebase-auth:24.2.0` - `com/google/firebase/auth/internal/zzce` for the `SharedPreferences` store name, `com/google/firebase/auth/internal/zzaq` for the server error code table, and the bundled `proguard.txt` and `AndroidManifest.xml`.
- `firebase_auth` 6.6.1 - `android/.../FlutterFirebaseAuthPlugin.kt` for `getPluginConstantsForFirebaseApp`, and `firebase_auth_platform_interface` `method_channel_firebase_auth.dart` for the streams that replay `currentUser`.
- Flutter SDK 3.44.8 - `packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt` for the release shrinking defaults, `runner/flutter_command.dart` for the no-op `--shrink` flag, and the `android.tmpl` manifest and Gradle templates.
