---
title: "Fix: [firebase_messaging/apns-token-not-set] APNS token has not been set on Flutter iOS"
description: "getToken() runs before APNs hands iOS the device token. Poll getAPNSToken() until it returns non-null, then call getToken(). Check the Push Notifications capability if it never arrives."
pubDate: 2026-08-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "firebase"
  - "dart"
---

You called `FirebaseMessaging.instance.getToken()` before APNs delivered the device token to iOS, and the plugin refuses to continue. Poll `getAPNSToken()` until it returns a non-null value, then call `getToken()`. If it stays null past ten seconds you have a configuration problem, not a race: the Push Notifications capability is missing, auto-init is disabled, or you are on a simulator that cannot register. This is verified against `firebase_messaging` 16.5.0 and `firebase_core` 4.13.0 on Flutter 3.44.2.

## The error in context

Current versions of the plugin throw this:

```
[firebase_messaging/apns-token-not-set] APNS token has not been received on the device yet. Please ensure the APNS token is available before calling `getAPNSToken()`.
```

Older versions worded it differently, which is why search results for this problem are split across two strings:

```
[firebase_messaging/apns-token-not-set] APNS token has not been set yet. Please ensure the APNS token is available by calling `getAPNSToken()`.
```

Both are the same `FirebaseException`, both carry `code: 'apns-token-not-set'`, and both come from the same place. The message is misleading in a specific way: it tells you to call `getAPNSToken()`, but `getAPNSToken()` is exactly what just failed. What it means is "wait until `getAPNSToken()` returns something".

## Why the token is missing when getToken runs

The check lives in Dart, not in native code. In `firebase_messaging_platform_interface` 4.9.3, `method_channel_messaging.dart` defines a private guard:

```dart
// firebase_messaging_platform_interface 4.9.3
Future<void> _APNSTokenCheck() async {
  if (defaultTargetPlatform == TargetPlatform.macOS ||
      defaultTargetPlatform == TargetPlatform.iOS) {
    String? token = await getAPNSToken();

    if (token == null) {
      throw FirebaseException(
        plugin: 'firebase_messaging',
        code: 'apns-token-not-set',
        message:
            'APNS token has not been received on the device yet. Please ensure the APNS token is available before calling `getAPNSToken()`.',
      );
    }
  }
}
```

On the native side, `getAPNSToken` is a direct read with no waiting and no retry:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)messagingGetAPNSToken:(id)arguments
         withMethodCallResult:(FLTFirebaseMethodCallResult *)result {
  NSData *apnsToken = [FIRMessaging messaging].APNSToken;
  if (apnsToken) {
    result.success(@{@"token" : [FLTFirebaseMessagingPlugin APNSTokenFromNSData:apnsToken]});
  } else {
    result.success(@{@"token" : [NSNull null]});
  }
}
```

That is the whole mechanism. `FIRMessaging.APNSToken` is nil until iOS calls `application:didRegisterForRemoteNotificationsWithDeviceToken:`, and that callback fires on Apple's schedule after a network round trip to APNs. It usually lands within a second or two of launch, but nothing in your app controls when. Firebase's own documentation states the constraint plainly: in iOS SDK 10.4.0 and higher, the APNs token must be available before you make API requests.

So the error is not "something is broken". In the common case it is "you asked too early".

## Which calls actually enforce the check

Exactly four methods await `_APNSTokenCheck()` in 4.9.3: `deleteToken()`, `getToken()`, `subscribeToTopic()`, and `unsubscribeFromTopic()`. Everything else, including `requestPermission()`, `getInitialMessage()`, and the `onMessage` stream, runs without it.

This explains a reported pattern that otherwise looks contradictory: permission prompts appear normally and foreground messages arrive, but `subscribeToTopic()` throws. Topic subscription is gated; message delivery is not.

`getAPNSToken()` itself is not gated. It returns null rather than throwing, which is what makes polling it safe.

## What does a minimal repro look like?

Any app that fetches the token during startup will hit this on a cold launch:

```dart
// Flutter 3.44.2, firebase_core 4.13.0, firebase_messaging 16.5.0
Future<String?> brokenRegisterForPush() async {
  await Firebase.initializeApp();
  return FirebaseMessaging.instance.getToken();
}
```

It throws intermittently, which is the worst property this bug has. On a warm launch, or on a device that already registered recently, the token is often already cached in `FIRMessaging` and the call succeeds. On a fresh install, a slow network, or the first launch after the app is reinstalled, it throws. Test on a clean install before assuming you fixed it.

## How do I wait for the APNs token before calling getToken?

There is no callback or stream for "APNs token is now available", so polling is the supported approach. This helper analyzes clean against `firebase_messaging` 16.5.0:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

/// Polls `getAPNSToken()` until APNs hands the token to the Firebase iOS SDK.
/// Returns null on non-Apple platforms and on timeout.
Future<String?> waitForAPNSToken({
  Duration timeout = const Duration(seconds: 10),
  Duration interval = const Duration(milliseconds: 250),
}) async {
  if (kIsWeb ||
      (defaultTargetPlatform != TargetPlatform.iOS &&
          defaultTargetPlatform != TargetPlatform.macOS)) {
    return null;
  }

  final stopwatch = Stopwatch()..start();
  while (stopwatch.elapsed < timeout) {
    final token = await FirebaseMessaging.instance.getAPNSToken();
    if (token != null) return token;
    await Future<void>.delayed(interval);
  }
  return null;
}
```

The null return on Android and web matters. If you write the guard as a bare `while (token == null)` loop without the platform check, `getAPNSToken()` returns null forever on Android and you spin until the timeout on every Android launch. The platform-interface implementation short-circuits to null for any non-Apple target before it ever touches the method channel.

Wire it into registration:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<String?> registerForPush() async {
  await Firebase.initializeApp();

  final messaging = FirebaseMessaging.instance;
  await messaging.setAutoInitEnabled(true);

  final settings = await messaging.requestPermission();
  debugPrint('authorizationStatus: ${settings.authorizationStatus}');

  final apnsToken = await waitForAPNSToken();
  if (apnsToken == null && !kIsWeb) {
    debugPrint('No APNs token: check Push Notifications capability.');
    return null;
  }

  return messaging.getToken();
}
```

Do the same before topic calls, since they are gated too:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<void> subscribeSafely(String topic) async {
  await waitForAPNSToken();
  await FirebaseMessaging.instance.subscribeToTopic(topic);
}
```

If you would rather not restructure existing startup code, catch the exception and retry once. This is strictly worse than waiting up front, because it burns a failed round trip first, but it is a small diff:

```dart
// Flutter 3.44.2, firebase_messaging 16.5.0
Future<String?> registerForPushHandled() async {
  try {
    return await FirebaseMessaging.instance.getToken();
  } on FirebaseException catch (e) {
    if (e.code == 'apns-token-not-set') {
      final token = await waitForAPNSToken();
      if (token == null) return null;
      return FirebaseMessaging.instance.getToken();
    }
    rethrow;
  }
}
```

Note that permission is a separate concern from token availability. Registering for remote notifications is what produces the APNs device token, and the plugin does that during registration rather than in response to the permission prompt. A user who denies the notification prompt can still have a valid APNs token, which is what makes silent background push work.

## What happens when auto-init is disabled?

This is the cause people miss, and it is worth understanding because the symptom is a token that never arrives no matter how long you poll.

If `FirebaseMessagingAutoInitEnabled` is set to `NO` in your `Info.plist`, or you called `setAutoInitEnabled(false)` and it persisted, the plugin does not register for remote notifications at startup at all:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
if ([FIRMessaging messaging].isAutoInitEnabled) {
  [self registerForRemoteNotifications];
}
```

And even if something else in your app registers, the delegate callback stashes the token and returns without handing it to `FIRMessaging`:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)application:(UIApplication *)application
    didRegisterForRemoteNotificationsWithDeviceToken:(NSData *)deviceToken {
  FIRMessaging *messaging = [FIRMessaging messaging];
  if (!messaging.isAutoInitEnabled) {
    _apnsToken = deviceToken;
    return;
  }
  // ... setAPNSToken happens only past this point
}
```

`FIRMessaging.APNSToken` stays nil, so `getAPNSToken()` keeps returning null and your poll loop times out, even though iOS successfully gave the app a device token.

The recovery path exists but you have to trigger it. `setAutoInitEnabled(true)` calls `registerForRemoteNotifications` and then flushes the stashed token, and a flush also runs at the top of every method call the plugin handles:

```objc
// FLTFirebaseMessagingPlugin.m, firebase_messaging 16.5.0
- (void)ensureAPNSTokenSetting {
  FIRMessaging *messaging = [FIRMessaging messaging];

  if (messaging.isAutoInitEnabled && messaging.APNSToken == nil && _apnsToken != nil) {
    [messaging setAPNSToken:_apnsToken type:FIRMessagingAPNSTokenTypeSandbox];
    _apnsToken = nil;
  }
}
```

If you deliberately delay FCM registration for consent reasons, that is fine, but `await messaging.setAutoInitEnabled(true)` has to come before you wait for the token. That is why it appears in `registerForPush()` above.

## What to check when the token never arrives

Work down this list in order. The first two account for most cases where polling times out on a physical device.

1. **Push Notifications capability.** In Xcode, open the Runner target, go to Signing and Capabilities, and confirm Push Notifications is listed. Without it the app has no `aps-environment` entitlement, `registerForRemoteNotifications` fails, and iOS calls `didFailToRegisterForRemoteNotificationsWithError:` instead. The plugin logs that error with `NSLog` and nothing else, so it is easy to miss. Check the Xcode console for a line about the app not being entitled for push.
2. **Background Modes.** Enable Background fetch and Remote notifications. FlutterFire's setup guide requires both, and APNs is needed for foreground and background messaging alike.
3. **APNs key uploaded to Firebase.** Firebase Console, Project Settings, Cloud Messaging tab. At least one key is required. A missing key does not block the APNs token itself, but it does break everything downstream, so fix it while you are here.
4. **Method swizzling.** Firebase's Flutter client guide is explicit that swizzling is required and that without it FCM token handling will not work. If you set `FirebaseAppDelegateProxyEnabled` to `NO` in `Info.plist`, you must forward the APNs delegate callbacks yourself. The simplest fix is to remove that key.
5. **Bundle ID mismatch.** The bundle identifier in Xcode must match the one in `GoogleService-Info.plist`. A mismatch here produces confusing downstream failures rather than a clean error.

## Does the iOS simulator give you an APNs token?

Sometimes, and the conditions are narrow enough to be worth stating exactly. The simulator supports real remote notifications and real device tokens only on iOS 16 and later, running on macOS 13 or later, on a Mac with Apple silicon or a T2 chip. Tokens are unique to the combination of that simulator and that Mac, and the simulator registers against the APNs sandbox environment.

Outside that combination, the simulator cannot register for remote notifications, `getAPNSToken()` returns null forever, and no amount of configuration fixes it. Before Xcode 14 no simulator could produce a device token at all. If you are chasing this error on an older simulator, an Intel Mac, or an iOS 15 runtime, switch to a physical device before changing any code.

## Gotchas and lookalikes

**Sandbox versus production token type.** The plugin picks the APNs token type from the `DEBUG` preprocessor macro at compile time, using `FIRMessagingAPNSTokenTypeSandbox` in debug builds and `FIRMessagingAPNSTokenTypeProd` otherwise. This never causes `apns-token-not-set`, but it does cause the classic "works in debug, silent in TestFlight" report. If notifications stop arriving in a release build, this is where to look, not here.

**Reinstalls invalidate tokens.** Deleting and reinstalling the app produces a new APNs token and a new FCM token. Server-side token records for the old install are dead. Listen to `FirebaseMessaging.instance.onTokenRefresh` and re-upload rather than fetching once at first launch and caching it forever.

**`getAPNSToken()` returning null is not this exception.** If you see a null APNs token but no thrown error, you called `getAPNSToken()` directly. It returns null by design; only the four gated methods convert that null into a `FirebaseException`.

**A ten second timeout is a guess, not a guarantee.** On a device with no network the callback simply never fires. Treat a timeout as a soft failure: return null, let the app run, and retry registration later rather than blocking your splash screen forever.

## Related

If you are working through iOS build and integration problems in a Flutter app, these cover the neighbouring failures: the [CocoaPods version resolution failures](/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) that show up right after adding Firebase plugins, the [Xcode 16 iOS build breakage](/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) and its four distinct causes, the [missing destination error](/2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build/) caused by a stale architecture exclusion in the Podfile, the [Dart VM crash on iOS debug builds](/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/) that no entitlement can fix, and the [google_sign_in 7.0 singleton migration](/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/) if you are wiring Firebase Auth at the same time.

## Sources

- [Set up a Firebase Cloud Messaging client app on Flutter](https://firebase.google.com/docs/cloud-messaging/flutter/client) - the APNs token requirement from iOS SDK 10.4.0 onward, and the method swizzling requirement.
- [FlutterFire Apple integration guide](https://firebase.flutter.dev/docs/messaging/apple-integration/) - Push Notifications capability, Background Modes, APNs key upload.
- `firebase_messaging_platform_interface` 4.9.3, `lib/src/method_channel/method_channel_messaging.dart` - the `_APNSTokenCheck()` guard and the four methods that await it.
- `firebase_messaging` 16.5.0, `ios/firebase_messaging/Sources/firebase_messaging/FLTFirebaseMessagingPlugin.m` - `messagingGetAPNSToken`, `ensureAPNSTokenSetting`, and the auto-init gate on registration.
- [flutterfire issue #10625](https://github.com/firebase/flutterfire/issues/10625) - the issue the `_APNSTokenCheck` source comment cites as the reason the guard exists.
- [Xcode 14 simulator push notification support](https://github.com/firebase/firebase-ios-sdk/pull/10503) - the firebase-ios-sdk change that made simulator device tokens usable.
