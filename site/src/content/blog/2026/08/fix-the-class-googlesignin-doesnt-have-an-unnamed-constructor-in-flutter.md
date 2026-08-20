---
title: "Fix: The class 'GoogleSignIn' doesn't have an unnamed constructor"
description: "google_sign_in 7.0.0 made GoogleSignIn a singleton. Replace GoogleSignIn(scopes: ...) with GoogleSignIn.instance, await initialize() once, then call authenticate()."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "google-sign-in"
  - "firebase"
---

`GoogleSignIn` became a singleton in `google_sign_in` 7.0.0 (published 24 June 2025), so `GoogleSignIn(...)` no longer compiles. Use `GoogleSignIn.instance`, `await` its new `initialize()` method exactly once at startup, and call `authenticate()` instead of `signIn()`. The `scopes:` argument you used to pass to the constructor has no direct replacement: authorization is now a separate step through `user.authorizationClient`. There is no automated migration, so budget real time for a real app.

## The error, in full

The analyzer reports this against a `pubspec.yaml` that resolves `google_sign_in` 7.x, on any platform:

```
error - The class 'GoogleSignIn' doesn't have an unnamed constructor. Try using one
        of the named constructors defined in 'GoogleSignIn' - lib\auth.dart:5:36 -
        new_with_undefined_constructor_default
```

The hint is a dead end. The only named constructor on the class is `GoogleSignIn._()`, which is private to the package, so there is nothing for you to call. The diagnostic comes from the analyzer's generic "no default constructor" rule and does not know that the package intends you to go through a static field instead.

It never arrives alone. Running `flutter analyze` on a typical 6.x sign-in file against `google_sign_in` 7.2.0 on Flutter 3.44.2 produces the full cascade:

```
error - The class 'GoogleSignIn' doesn't have an unnamed constructor
error - The method 'signIn' isn't defined for the type 'GoogleSignIn'
error - The method 'isSignedIn' isn't defined for the type 'GoogleSignIn'
error - The method 'signInSilently' isn't defined for the type 'GoogleSignIn'
error - The getter 'accessToken' isn't defined for the type 'GoogleSignInAuthentication'
 info - Uses 'await' on an instance of 'GoogleSignInAuthentication', which is not a
        subtype of 'Future'
```

That last `info` is worth reading carefully. `GoogleSignInAccount.authentication` is now a synchronous getter, so every `await account.authentication` in your codebase is a no-op that the analyzer only flags as a lint, not an error.

## Why the constructor disappeared in google_sign_in 7.0.0

The 6.x API was a Dart wrapper over the Google Sign-In SDK, which Google deprecated on both Android and Web. On Android the replacement is Credential Manager plus `AuthorizationClient`, and Google [has been telling developers since September 2024](https://android-developers.googleblog.com/2024/09/streamlining-android-authentication-credential-manager-replaces-legacy-apis.html) that the legacy `play-services-auth` sign-in APIs are going away. Those SDKs have a fundamentally different shape, so the Flutter plugin's surface changed with them.

Three of those changes explain almost every compile error you will hit.

The plugin no longer models "an object you configure and then use". The underlying SDKs are process-wide, and creating two `GoogleSignIn` objects in 6.x never actually worked. The package's migration guide is blunt about it: making the class a singleton just enforces a restriction that already existed.

Configuration moved from the constructor to an explicit async `initialize()` call. On web that call has real work to do and can take a noticeable amount of time, which a constructor cannot express.

Authentication and authorization are now separate. In 6.x, `GoogleSignIn(scopes: [...])` bundled "who is this user" with "let me read their contacts" into one consent prompt. In 7.x you authenticate first, then ask for scopes at the moment you actually need the data.

## Minimal repro: the 6.x code that stops compiling

```dart
// Flutter 3.44.2, Dart 3.12.2, google_sign_in 7.2.0
// Every line of this compiled fine on google_sign_in 6.3.0.
import 'package:google_sign_in/google_sign_in.dart';

final GoogleSignIn _googleSignIn = GoogleSignIn(
  scopes: <String>['email', 'https://www.googleapis.com/auth/contacts.readonly'],
);

Future<void> signIn() async {
  final GoogleSignInAccount? account = await _googleSignIn.signIn();
  if (account == null) return;
  final GoogleSignInAuthentication auth = await account.authentication;
  print(auth.accessToken);
  print(auth.idToken);
}
```

Do not reach for `dart fix` here. Running `dart fix --dry-run` on this file with `google_sign_in` 7.2.0 installed reports `Nothing to fix!`, because the package ships no deprecation shims for the removed members. Every call site is a manual edit.

## How do I replace GoogleSignIn(...) with the singleton?

Call `initialize()` once, before anything else touches the plugin. In a Flutter app that means `main()` or a one-shot bootstrap, not `initState` on a login screen that can be pushed twice.

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await GoogleSignIn.instance.initialize(
    // Both are optional. Omit them if your Info.plist GIDClientID or your
    // google-services.json already supplies the values.
    clientId: 'IOS_OR_WEB_CLIENT_ID.apps.googleusercontent.com',
    serverClientId: 'SERVER_CLIENT_ID.apps.googleusercontent.com',
  );

  runApp(const MyApp());
}
```

`initialize()` takes `clientId`, `serverClientId`, `nonce`, and `hostedDomain`. Values passed here take precedence over the ones in your platform configuration files. There is no `scopes` parameter and no `signInOption`: `SignInOption.games` was removed from the platform interface entirely.

The interactive sign-in call becomes:

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
Future<void> onSignInPressed() async {
  if (!GoogleSignIn.instance.supportsAuthenticate()) {
    return; // Web. See the renderButton section below.
  }
  try {
    final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();
    final String? idToken = user.authentication.idToken; // no await
  } on GoogleSignInException catch (e) {
    if (e.code == GoogleSignInExceptionCode.canceled) return;
    debugPrint('${e.code}: ${e.description}');
  }
}
```

Two type-level differences matter. `authenticate()` returns a non-nullable `GoogleSignInAccount`, so the `if (account == null)` guard from 6.x is now dead code. And cancellation is an exception rather than a null: the user backing out throws `GoogleSignInException` with a `code` of `GoogleSignInExceptionCode.canceled`. If you delete the old null check and forget the try/catch, every cancelled sign-in becomes an unhandled exception in your logs.

`GoogleSignInExceptionCode` also carries `interrupted`, `clientConfigurationError`, `providerConfigurationError`, `uiUnavailable`, `userMismatch`, and `unknownError`. It was accidentally left unexported in 7.0.0 and added back in 7.1.0, so require at least 7.1.0 if you want to switch on it.

## What replaces signIn, signInSilently, and currentUser?

Every removed member and its 7.x equivalent, checked against `google_sign_in` 7.2.0:

| google_sign_in 6.x | google_sign_in 7.x |
| --- | --- |
| `GoogleSignIn(...)` | `GoogleSignIn.instance` plus `await initialize(...)` |
| `signIn()` | `authenticate({scopeHint})` |
| `signInSilently()` | `attemptLightweightAuthentication()` |
| `isSignedIn()` | track it yourself from `authenticationEvents` |
| `currentUser` | track it yourself from `authenticationEvents` |
| `onCurrentUserChanged` | `authenticationEvents` |
| `canAccessScopes(scopes)` | `authorizationClient.authorizationForScopes(scopes)` |
| `requestScopes(scopes)` | `authorizationClient.authorizeScopes(scopes)` |
| `account.authHeaders` | `authorizationClient.authorizationHeaders(scopes)` |
| `account.serverAuthCode` | `authorizationClient.authorizeServer(scopes)` |
| `clearAuthCache(token:)` | `clearAuthorizationToken(accessToken:)`, added in 7.2.0 |
| `signOut()`, `disconnect()` | unchanged |

The two survivors are worth noting: `signOut()` and `disconnect()` kept their names and signatures, which is why a half-finished migration can compile in one file and fail in the next.

`attemptLightweightAuthentication()` has a return type that looks like a typo and is not. It returns `Future<GoogleSignInAccount?>?`, a nullable future. A null future means the platform cannot answer quickly (web with FedCM is the example the package gives), so you should render a signed-out UI and wait for `authenticationEvents` rather than awaiting anything.

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
final Future<GoogleSignInAccount?>? attempt =
    GoogleSignIn.instance.attemptLightweightAuthentication();
if (attempt != null) {
  final GoogleSignInAccount? user = await attempt;
}
```

Note also that "lightweight" is not "silent". The rename is deliberate: on web this can show a floating sign-in card, and on Android an account selection sheet. By default the call swallows `canceled`, `interrupted`, and `uiUnavailable` and returns null for them; pass `reportAllExceptions: true` if you want them thrown.

## Where did the scopes argument go?

Into a second, separate step. `GoogleSignInAccount` exposes an `authorizationClient`, and that client is where access tokens live now. The recommended shape is to try for an existing grant first and only show UI if that fails:

```dart
// Flutter 3.44.2, google_sign_in 7.2.0
const List<String> scopes = <String>[
  'https://www.googleapis.com/auth/contacts.readonly',
];

Future<String> accessTokenFor(GoogleSignInAccount user) async {
  // Returns null instead of prompting if the scopes are not yet granted.
  final GoogleSignInClientAuthorization? existing =
      await user.authorizationClient.authorizationForScopes(scopes);
  if (existing != null) return existing.accessToken;

  // Shows consent UI. Call it from a button press, not from initState.
  final GoogleSignInClientAuthorization granted =
      await user.authorizationClient.authorizeScopes(scopes);
  return granted.accessToken;
}
```

Those two methods reach the same platform entry point with a single flag flipped. Driving the flow against a fake `GoogleSignInPlatform` in a test records exactly this call sequence:

```
init
authenticate scopeHint=[]
clientAuth prompt=false     <- authorizationForScopes
clientAuth prompt=true      <- authorizeScopes
```

If you want the old combined consent prompt, pass `scopeHint` to `authenticate()`. It is a hint and nothing more: platforms that cannot combine the flows ignore it, and the package explicitly warns that `authorizationForScopes` may still return null afterwards. Write the fallback path anyway.

For a server exchange, `authorizeServer(scopes)` returns a `GoogleSignInServerAuthorization` carrying a `serverAuthCode`. It is a separate round trip from client authorization, which is the single most common surprise for apps that used to read `account.serverAuthCode` straight off the sign-in result.

## Where did authentication.accessToken go?

It moved to a different type, because an access token is an authorization artifact and `authentication` now carries only authentication artifacts. In 7.x, `GoogleSignInAuthentication` has exactly one field:

```dart
// google_sign_in 7.2.0, lib/src/token_types.dart
class GoogleSignInAuthentication {
  const GoogleSignInAuthentication({required this.idToken});
  final String? idToken;
}
```

The access token moved to `GoogleSignInClientAuthorization.accessToken`, which is non-nullable, and the server auth code to `GoogleSignInServerAuthorization.serverAuthCode`.

This is the change that breaks Firebase Auth integrations, and the fix is smaller than most migration threads suggest. `GoogleAuthProvider.credential` in `firebase_auth` 6.5.7 is declared as `credential({String? idToken, String? accessToken})` with an assert requiring at least one of the two. An ID token alone is enough:

```dart
// Flutter 3.44.2, google_sign_in 7.2.0, firebase_auth 6.5.7
Future<UserCredential> signInWithGoogle() async {
  final GoogleSignInAccount user = await GoogleSignIn.instance.authenticate();

  final AuthCredential credential = GoogleAuthProvider.credential(
    idToken: user.authentication.idToken,
  );
  return FirebaseAuth.instance.signInWithCredential(credential);
}
```

Do not call `authorizeScopes` just to produce an `accessToken` for this call. That triggers a consent prompt your users do not need, for scopes you are not going to use.

## What happens to authenticate on Flutter web?

It throws. `google_sign_in_web` 1.1.3 returns `false` from `supportsAuthenticate()`, and `authenticate()` raises:

```
UnimplementedError: authenticate is not supported on the web.
Instead, use renderButton to create a sign-in widget.
```

Google Identity Services requires the sign-in button to be rendered by its own SDK, so your custom `ElevatedButton` cannot trigger the flow. Guard with `supportsAuthenticate()` and, on web, render the widget from `package:google_sign_in_web/web_only.dart` and pick up the result from `authenticationEvents`. Note that the migration guide describes this as an `UnsupportedError` while the implementation actually throws `UnimplementedError`, so do not match on the exact type.

Related web-only trap: `authorizationRequiresUserInteraction()` returns `true` there, because the authorization flow uses a popup that browsers block outside a user gesture. Calling `authorizeScopes` from a `FutureBuilder` or from `initState` works on mobile and fails on web.

## Can I just pin google_sign_in 6.x instead?

For a short while, yes. `google_sign_in: 6.3.0` still resolves cleanly on Flutter 3.44.2, pulling `google_sign_in_android` 6.2.1 and `google_sign_in_ios` 5.9.0. Nothing in the current stable Flutter SDK blocks it.

Treat it as a stopgap and not a plan. The Android side of 6.x sits on the deprecated `play-services-auth` sign-in APIs that [Google's own migration page](https://developer.android.com/identity/sign-in/legacy-gsi-migration) says will be removed. You are choosing when to do this migration, not whether.

## Gotchas that survive a clean compile

**Skipping `initialize()` silently kills the event stream.** The app-facing package only synthesizes events onto `authenticationEvents` if `initialize()` determined that the platform implementation has no event stream of its own. A test with a fake platform confirms the failure mode: authenticate without initializing, and the stream stays empty with no exception thrown. Sign-in works, the UI never updates.

**Calling `initialize()` more than once is undefined behavior.** The package documents it in those words. A bootstrap that reruns on a provider rebuild will hit this.

**On Android, a configuration error can arrive as `canceled`.** The Credential Manager SDK returns a cancellation for some misconfigurations, and the plugin has no way to tell the difference. If `authenticate()` throws `canceled` right after the account picker, check the signing SHA for that build variant and confirm your `google-services.json` contains an `oauth_client` entry with `client_type: 3`.

**Your Flutter version may cap the Android implementation.** `google_sign_in` 7.2.0 itself requires Flutter 3.29 and Dart 3.7, but `google_sign_in_android` 7.2.16 requires Flutter 3.44 and Dart 3.12. On older Flutter, pub resolves an older implementation package instead of failing, so the plugin version in `pubspec.lock` is not the whole story. This is the same class of trap as [pinning the Flutter engine version for reproducible builds](/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).

**The package's own `testing.dart` still documents the 6.x API.** `FakeSignInBackend` carries a doc comment showing `GoogleSignIn()` and `setMockMethodCallHandler`. It was not updated for 7.x, and its method-channel names no longer match the plugin. Write a fake `GoogleSignInPlatform` and assign it to `GoogleSignInPlatform.instance` instead.

## Related

- The same shape of upgrade shows up in [migrating from Riverpod 2.x to Riverpod 3.0](/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/), where the compile errors are the easy part and the behaviour changes are not.
- A plugin upgrade that renames error values rather than APIs: [biometric_signature 10.0.0 and its new BiometricError values](/2026/02/biometric_signature-10-0-0-simpleprompt-is-the-feature-new-biometricerror-values-are-the-real-breaking-change-flutter-3-x/).
- Sign-in is one long async gap, so [guarding setState with the mounted check after an async gap](/2026/07/how-to-guard-setstate-with-the-mounted-check-after-an-async-gap-in-flutter/) applies directly to the code you are rewriting.
- If bumping the plugin also broke your iOS build, start with [CocoaPods could not find compatible versions for pod](/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).
- To keep an app buildable on more than one SDK while a migration like this lands, see [targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Sources

- [google_sign_in on pub.dev](https://pub.dev/packages/google_sign_in), version 7.2.0, published 17 September 2025. The `MIGRATION.md` shipped inside the package is the authoritative 6.x to 7.x mapping.
- [google_sign_in changelog](https://pub.dev/packages/google_sign_in/changelog), for the 7.0.0 breaking-change list and the 7.1.0 `GoogleSignInExceptionCode` export fix.
- [google_sign_in_android on pub.dev](https://pub.dev/packages/google_sign_in_android), whose README documents the `serverClientId` requirement and the `canceled`-means-misconfigured behaviour.
- [About the migration from legacy Google Sign-In](https://developer.android.com/identity/sign-in/legacy-gsi-migration) on Android Developers.
- [Streamlining Android authentication: Credential Manager replaces legacy APIs](https://android-developers.googleblog.com/2024/09/streamlining-android-authentication-credential-manager-replaces-legacy-apis.html), the September 2024 announcement behind the plugin rewrite.

Every error string, version resolution, and call sequence above was reproduced locally on Flutter 3.44.2 with Dart 3.12.2.
