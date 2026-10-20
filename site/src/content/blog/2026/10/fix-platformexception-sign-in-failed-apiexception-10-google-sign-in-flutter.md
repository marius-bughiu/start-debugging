---
title: "Fix: PlatformException(sign_in_failed, com.google.android.gms.common.api.ApiException: 10) with Google Sign-In in Flutter"
description: "ApiException: 10 is DEVELOPER_ERROR: Google does not recognize the package name plus signing certificate SHA-1 of the installed APK. Register the SHA-1 of the key that actually signed the build, and pass the Web client ID as serverClientId."
pubDate: 2026-10-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "google-sign-in"
  - "firebase"
---

`ApiException: 10` is `CommonStatusCodes.DEVELOPER_ERROR`: Google Play services refused the sign-in because the pair "Android package name + SHA-1 of the certificate that signed the installed APK" does not match any Android OAuth client in the Google Cloud project behind your `serverClientId`. Your Dart code is fine. Run `./gradlew signingReport` (or `apksigner verify --print-certs` on the exact APK you installed), register that SHA-1 for that exact `applicationId`, and add the Play App Signing SHA-1 for store builds. Then check that `serverClientId` is the **Web** client ID, not the Android one. Verified against `google_sign_in` 6.3.0 (`google_sign_in_android` 6.2.1) and `google_sign_in` 7.2.0 (`google_sign_in_android` 7.2.18, `play-services-auth` 21.6.0, `androidx.credentials` 1.6.0) on Flutter 3.44.8 with AGP 9.0.1.

## The error, in full

On `google_sign_in` 6.x, `GoogleSignIn().signIn()` throws this on Android:

```
PlatformException(sign_in_failed, com.google.android.gms.common.api.ApiException: 10: , null, null)
```

On `google_sign_in` 7.x the same misconfiguration no longer reaches you as a `PlatformException`. The 7.x Android plugin reports failures as structured results and the Dart side turns them into a `GoogleSignInException`. Depending on which step fails, you see one of these:

```
GoogleSignInException(code GoogleSignInExceptionCode.unknownError, [28444] Developer console is not set up correctly., null)
GoogleSignInException(code GoogleSignInExceptionCode.canceled, ...)
GoogleSignInException(code GoogleSignInExceptionCode.unknownError, Authorization failed: 10: ..., null)
```

The first comes from Credential Manager during `authenticate()`. The second is the nasty one: the plugin's own README warns that some configuration errors make Credential Manager return "canceled" after the user picks an account, and the plugin cannot tell that apart from a real cancel. The third comes from `authorizationClient.authorizeScopes()`, which still goes through the Play services `AuthorizationClient` and surfaces the same status code 10. If you migrated from 6.x to 7.x and the error "changed", you probably did not fix anything, the same root cause is just reported differently.

## Why Google returns DEVELOPER_ERROR

The numbers are constants in Play services, not magic. I dumped them from the jars Gradle resolved for this repro:

```bash
# play-services-basement 18.1.0, play-services-auth 21.6.0
javap -constants -cp classes.jar com.google.android.gms.common.api.CommonStatusCodes
#   public static final int DEVELOPER_ERROR = 10;
javap -constants -cp classes.jar com.google.android.gms.auth.api.signin.GoogleSignInStatusCodes
#   public static final int SIGN_IN_FAILED = 12500;
#   public static final int SIGN_IN_CANCELLED = 12501;
```

In `google_sign_in_android` 6.2.1, `errorCodeForStatus` maps 12501 to `sign_in_canceled`, 4 to `sign_in_required`, 7 to `network_error`, and lets everything else, including 10, fall through to `sign_in_failed` with `e.toString()` as the message. That is why the string you search for always carries the fully qualified `ApiException` class name.

What DEVELOPER_ERROR means in practice: Google identifies an Android app by its package name and the SHA-1 fingerprint of its signing certificate, as described in Google's [Authenticating Your Client](https://developers.google.com/android/guides/client-auth) guide. When the app asks for an ID token for a Web client ID, Google looks for an Android OAuth client in the **same project** with that package name and that fingerprint. No match, error 10. In order of how often I see them, the causes are:

1. **The SHA-1 of the key that signed this build is not registered.** Usually the release key or the Play App Signing key, sometimes the debug key on a different machine or on CI.
2. **The package name does not match.** A flavor with `applicationIdSuffix` installs `com.example.app.dev`, but only `com.example.app` is registered.
3. **The wrong client ID is passed as `serverClientId`.** The Android client ID instead of the Web one, or a Web client from a different Google Cloud project.
4. **A stale `google-services.json`** without a Web OAuth client entry, so the plugin picks up nothing or the wrong `default_web_client_id`.

## Minimal repro

The smallest setup that produces the error is a correct Dart side with a Google Cloud project that does not know the signing key. This is the 7.x code. Nothing here is wrong, and that is the point:

```dart
// Flutter 3.44.8, google_sign_in 7.2.0 (google_sign_in_android 7.2.18)
import 'package:flutter/material.dart';
import 'package:google_sign_in/google_sign_in.dart';

// Web OAuth client ID (client_type 3), NOT the Android one.
const String kWebClientId = '1234567890-abc.apps.googleusercontent.com';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await GoogleSignIn.instance.initialize(serverClientId: kWebClientId);
  runApp(const MaterialApp(home: SignInPage()));
}

class SignInPage extends StatelessWidget {
  const SignInPage({super.key});

  Future<void> _signIn() async {
    try {
      final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();
      debugPrint('Signed in as ${user.email}');
    } on GoogleSignInException catch (e) {
      // e.code is a GoogleSignInExceptionCode, e.description holds the
      // platform message, for example "[28444] Developer console is not set up correctly".
      debugPrint('Google Sign-In failed: ${e.code.name} / ${e.description}');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: FilledButton(onPressed: _signIn, child: const Text('Sign in')),
        ),
      );
}
```

The project around it is the stock `flutter create` template with one change that most real apps have: a `dev` flavor with `applicationIdSuffix = ".dev"` and a release build signed by an upload keystore. Register only the debug SHA-1 for the base package, and every variant except `prodDebug` fails with error 10. I did not run a live sign-in against a Google Cloud project for this post (that needs a real account on a Play-enabled device); the build, signing and package-name output below is measured on this exact project.

## Fix 1: register the SHA-1 of the key that actually signed the build

Do not guess which key that is. Ask Gradle. From the `android/` folder of the Flutter project:

```bash
# Flutter 3.44.8, AGP 9.0.1, OpenJDK 17
cd android
./gradlew signingReport
```

The output lists every variant with its keystore and fingerprints. On the repro project, trimmed:

```
Variant: devDebug
Config: debug
Store: /Users/<you>/.android/debug.keystore
SHA1: <debug-sha1>
Variant: devRelease
Config: upload
Store: .../android/app/upload-keystore.jks
SHA1: 16:AF:74:41:29:46:E2:5B:13:BB:A5:A4:29:C5:CC:D8:36:83:06:E9
Variant: prodRelease
Config: upload
Store: .../android/app/upload-keystore.jks
SHA1: 16:AF:74:41:29:46:E2:5B:13:BB:A5:A4:29:C5:CC:D8:36:83:06:E9
```

Two things to read off this. First, debug and release are different keys, so they need two fingerprints. Second, the debug keystore lives in `~/.android/debug.keystore` on **each machine**. Your teammate's laptop and your CI runner each generate their own on first build, with different fingerprints. "Works on my machine, error 10 on yours" is exactly this.

Then add the fingerprint where your project is managed:

- **Firebase**: Project settings, Your apps, pick the Android app, Add fingerprint. Firebase creates the matching Android OAuth client in the underlying Google Cloud project for you.
- **Google Cloud only**: Google Auth Platform, Clients, Create client, type Android, enter the package name and SHA-1. One Android client per (package name, SHA-1) pair.

If you need the fingerprint of a build you already have, read it from the artifact rather than from the keystore you think was used. For an APK, use `apksigner` from the Android build-tools:

```bash
# Android build-tools 36.1.0
apksigner verify --print-certs build/app/outputs/flutter-apk/app-dev-release.apk
# Signer #1 certificate DN: CN=Repro
# Signer #1 certificate SHA-256 digest: af3cbfe5...cc071a0a
# Signer #1 certificate SHA-1 digest: 16af74412946e25b13bba5a429c5ccd8368306e9
```

Do not use `keytool -printcert -jarfile` on a Flutter APK. On this project it prints `Not a signed jar file`, because the template's `minSdk` is 24 and AGP only signs with APK Signature Scheme v2 (`apksigner verify -v` reports `Verified using v1 scheme (JAR signing): false`). `keytool -printcert -jarfile` does work on the `.aab`, which is jar-signed with the upload key.

### Store builds: add the Play App Signing key too

This is the cause behind most "works in my release APK, fails when installed from Google Play" reports. With Play App Signing, which is mandatory for new apps, Google strips your upload signature and re-signs the APKs it delivers with its own app signing key. The SHA-1 your users' devices present is **that** key's, which you never had locally. Copy it from Play Console, under Test and release, App integrity, App signing, "App signing key certificate", and register it next to the upload key. Internal testing tracks are re-signed the same way, so they catch this before production does.

The stock Flutter template makes this worse: its `release` build type signs with the debug key ("Signing with the debug keys for now, so `flutter run --release` works"). A release build that works locally may simply be a debug-signed build, which proves nothing about the key Play will use.

## Fix 2: register the package name that is actually installed

`signingReport` does not print package names. Read the installed one from the APK:

```bash
# Android build-tools 36.1.0
aapt2 dump badging build/app/outputs/flutter-apk/app-dev-release.apk | head -1
# package: name='net.startdebugging.gsiapp.dev' versionCode='1' versionName='0.1.0' ...
```

The `dev` flavor's `applicationIdSuffix` turned `net.startdebugging.gsiapp` into `net.startdebugging.gsiapp.dev`, which is a different app as far as Google is concerned. Each flavor needs its own Android OAuth client (Firebase: its own Android app with its own `google-services.json` under `android/app/src/<flavor>/`). Note that the `namespace` in `build.gradle.kts` is irrelevant here: only `applicationId` (plus suffixes) is what the device reports. If flavors are new to you, [what a Flutter flavor is and how it differs from a build mode](/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/) covers where `applicationIdSuffix` comes in.

## Fix 3: pass the Web client ID as serverClientId

The ID token is minted for your **server**, so the client ID you hand the plugin is the Web application client (Firebase calls it `client_type: 3` in `google-services.json`). The Android client is never passed in code, Google finds it by package name and SHA-1. Passing the Android client ID as `serverClientId`, or a Web client from another project, produces the same error 10.

```dart
// google_sign_in 7.2.0
await GoogleSignIn.instance.initialize(
  // From Google Auth Platform > Clients, type "Web application",
  // in the SAME project as the Android client.
  serverClientId: '1234567890-web.apps.googleusercontent.com',
);
```

```dart
// google_sign_in 6.3.0 (legacy API)
final googleSignIn = GoogleSignIn(
  serverClientId: '1234567890-web.apps.googleusercontent.com',
  scopes: ['email'],
);
```

If you omit `serverClientId`, both plugin versions fall back to the `default_web_client_id` string resource that the `google-services` Gradle plugin generates from `google-services.json`. In 7.x, if that resource is missing too, you get a different, explicit error: `GoogleSignInExceptionCode.clientConfigurationError` with "serverClientId must be provided on Android". If you see that, your `google-services.json` has no `oauth_client` entry with `client_type: 3`. Enable Google as a sign-in provider in Firebase (or add a web app to the project) and download the file again.

## Fix 4: re-download google-services.json and wait

After adding fingerprints in Firebase, download `google-services.json` again and replace `android/app/google-services.json`. Strictly, the Android client is matched server-side, so the file mostly matters for `default_web_client_id`, but a file from before the change is a common source of a stale or missing Web client entry. Then run `flutter clean` so the generated resources are rebuilt. Changes in Google Cloud are not always instant either; give a freshly added fingerprint a few minutes, and reports of it taking longer are common, before you conclude it did not work.

## Gotchas and lookalikes

**`ApiException: 12500` is not the same error.** 12500 is `SIGN_IN_FAILED`. It shows up for problems like an incomplete OAuth consent screen (missing support email, app name) rather than an unknown package and fingerprint. Fix the consent screen configuration first.

**`ApiException: 12501` is a cancel**, and the 6.x plugin maps it to `sign_in_canceled`. If a user did not actually cancel, look at configuration again, especially on 7.x, where Credential Manager can disguise a misconfiguration as a cancel.

**`ApiException: 7` is a network error** (`network_error` in 6.x). Emulators without connectivity produce it, not misconfiguration.

**No account on the device.** On 7.x an emulator without a signed-in Google account, or with "Sign in with Google" prompts disabled in the Google account settings, gives `NoCredentialException`, which the plugin reports as "No credential available". That is device state, not error 10. Use an emulator image with Google Play.

**Migrating to 7.x does not move the SHA requirement.** Credential Manager uses the same Android OAuth client lookup. If you are mid-migration and stuck on the constructor change, [the GoogleSignIn singleton migration post](/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/) covers the API side.

**Firebase Auth on top.** If you hand the Google ID token to `FirebaseAuth.signInWithCredential`, a correct Google configuration still leaves Firebase-side release problems, such as API key restrictions bound to the debug SHA-1. Those are covered in [Firebase Auth sign-in that does not persist in a release build](/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/).

**Release-only failures can be unrelated.** If the release build crashes before sign-in is even reached, that is a different problem, see [the "Could not create Dart VM instance" release-build fix](/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## A checklist that settles it

1. Build the exact variant that fails and run `apksigner verify --print-certs` and `aapt2 dump badging` on that APK.
2. In the Google Cloud project that owns your Web client ID, confirm an Android client exists with exactly that package name and SHA-1.
3. For Play-installed builds, add the App signing key certificate SHA-1 from Play Console.
4. Confirm `serverClientId` (or `default_web_client_id`) is the Web client of that same project.
5. Re-download `google-services.json`, `flutter clean`, rebuild, and give Google a few minutes.

If all five check out and you still get error 10, you are almost certainly looking at a different project than the one the token is requested from. Compare the numeric prefix of the Web client ID with the project number in the console.

## Related

- [Fix: The class 'GoogleSignIn' doesn't have an unnamed constructor](/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/)
- [Fix: Firebase Auth sign-in does not persist in a Flutter Android release build](/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/)
- [What is a Flutter flavor and how is it different from a build mode?](/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/)
- [Fix: Could not create Dart VM instance in a Flutter release build](/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)

## Sources

- [google_sign_in_android README: Integration and Troubleshooting](https://pub.dev/packages/google_sign_in_android)
- [google_sign_in on pub.dev](https://pub.dev/packages/google_sign_in)
- [Authenticating Your Client (SHA-1 fingerprints, signingReport)](https://developers.google.com/android/guides/client-auth)
- [CommonStatusCodes reference](https://developers.google.com/android/reference/com/google/android/gms/common/api/CommonStatusCodes)
- [Credential Manager troubleshooting guide](https://developer.android.com/identity/sign-in/credential-manager-troubleshooting-guide)
- [Use Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)
- [FlutterFire discussion #18477: ApiException 10 only in the Google Play version](https://github.com/firebase/flutterfire/discussions/18477)
