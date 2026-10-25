---
title: "How to Lock Screen Orientation for a Single Screen in Flutter (and Why iPad Multitasking Ignores It)"
description: "Lock one Flutter route to landscape or portrait with SystemChrome.setPreferredOrientations without breaking the rest of the app: a stack-based lock that survives pushReplacement and restores on pop, why the empty list is the wrong reset, why iPad multitasking and Android 16 large screens ignore the lock, and what UIRequiresFullScreen means after iPadOS 26 and the iOS 27 SDK. Tested on Flutter 3.47.8 with Dart 3.13.7 and Xcode 27.1."
pubDate: 2026-10-25
template: how-to
tags:
  - "flutter"
  - "dart"
  - "ios"
  - "android"
  - "how-to"
---

To lock one screen in Flutter, call `SystemChrome.setPreferredOrientations` when the route appears, then put the app's normal orientations back when the route leaves. Don't write the naive version, `initState` sets landscape and `dispose` resets to portrait. In a widget test on Flutter 3.47.8 (Dart 3.13.7) that version restores portrait only after the pop animation finishes. Worse, `pushReplacement` between two locked screens leaves the new screen in portrait. Use the small stack-based lock below and restore in `PopScope.onPopInvokedWithResult`. Even then, the lock is a request, not a guarantee. iPadOS ignores it while the app can multitask (Split View, Slide Over, and the iPadOS 26 windowing system). Android 16 ignores it on displays at least 600 dp wide once you target API 36, and Flutter 3.47.8 targets API 36 by default. The old iPad escape hatch, `UIRequiresFullScreen`, has been deprecated since iPadOS 26 and no longer opts out of resizing when you build with the iOS 27 SDK.

## What setPreferredOrientations actually does on each platform

`SystemChrome.setPreferredOrientations(List<DeviceOrientation>)` is a single platform-channel call, `SystemChrome.setPreferredOrientations`, that carries a list of enum names. It holds app-wide state. Nothing about it is scoped to a widget or a route. Whatever you set last stays in force until something sets it again. That includes a hot restart, because the preference lives in the native view controller or activity, not in Dart.

The platforms handle it differently, and the differences matter as soon as you try to "undo" a lock:

- **Android**: the engine's `PlatformChannel.decodeOrientations` turns the list into a bitmask, maps it to an `ActivityInfo.SCREEN_ORIENTATION_*` constant, and calls `activity.setRequestedOrientation(...)`. `[portraitUp]` becomes `SCREEN_ORIENTATION_PORTRAIT`, `[landscapeLeft, landscapeRight]` becomes `SCREEN_ORIENTATION_USER_LANDSCAPE`, and the empty list becomes `SCREEN_ORIENTATION_UNSPECIFIED`. A runtime request overrides the `android:screenOrientation` attribute in your manifest. So if the manifest says `portrait` and you "reset" with `[]`, the activity can rotate freely afterwards.
- **iOS**: `FlutterPlatformPlugin` builds a `UIInterfaceOrientationMask` and posts a notification. Every `FlutterViewController` stores the mask and returns it from `supportedInterfaceOrientations`. On iOS 16 and later it calls `requestGeometryUpdateWithPreferences:` on each connected `UIWindowScene` and then `setNeedsUpdateOfSupportedInterfaceOrientations`. The empty list becomes `UIInterfaceOrientationMaskAll`, which UIKit then intersects with the orientations in `Info.plist`. A failed geometry request is only logged ("Failed to change device orientation"). The Dart future still completes normally.

Two consequences follow. First, `[]` means "whatever the OS allows", not "the app's default". Always restore to an explicit list. Second, the call is fire-and-forget. Awaiting the future tells you the message was delivered, not that the screen rotated.

## The naive per-screen lock and how it breaks

This is the version most answers suggest:

```dart
// Flutter 3.47.8, Dart 3.13.7 -- naive, do not ship
class _VideoPageState extends State<VideoPage> {
  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
  }

  @override
  void dispose() {
    SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    super.dispose();
  }
}
```

I ran it in a widget test that intercepts `SystemChannels.platform` and logs each orientation call between navigation events. Here is the log on Flutter 3.47.8:

```text
naive push/pop: [landscapeLeft,landscapeRight] -- pop -- first frame of pop animation [portraitUp] -- pop animation done
naive replace:  [landscapeLeft,landscapeRight] -- replace [landscapeLeft,landscapeRight] [portraitUp]  => final [portraitUp]
```

The first line shows the timing bug. `dispose` runs only after the route's exit transition completes, so the previous screen slides back in while the device is still locked to landscape, then it snaps to portrait. On a real phone the user watches the previous screen animate back in a landscape layout for the whole pop transition, and only then does it rotate.

The second line is the correctness bug. With `pushReplacement` (or `go_router`'s `replace` / `go` to a sibling), the new route's `initState` runs before the old route's `dispose`. The incoming video page asks for landscape. Then the outgoing video page "cleans up" and forces portrait. The final state is portrait on a screen that wanted landscape. The same thing happens any time two locked screens overlap in their lifetimes, for example in a `TabBarView` or a `PageView` that keeps neighbours alive.

## A lock that is owned, stacked, and released on pop

The fix is to stop treating the orientation as something each screen sets and resets. Keep one app-wide stack of requests instead. Each screen pushes its own entry and removes only that entry, and the top of the stack (or the app default) is what gets sent to the platform:

```dart
// Flutter 3.47.8, Dart 3.13.7
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// App-wide orientation stack. The top entry wins; when it is empty the
/// app default applies.
class OrientationLocks {
  OrientationLocks._();

  static List<DeviceOrientation> appDefault = const [DeviceOrientation.portraitUp];
  static final List<(Object, List<DeviceOrientation>)> _stack = [];

  static void push(Object owner, List<DeviceOrientation> orientations) {
    _stack.removeWhere((e) => identical(e.$1, owner));
    _stack.add((owner, orientations));
    _apply();
  }

  static void remove(Object owner) {
    final before = _stack.length;
    _stack.removeWhere((e) => identical(e.$1, owner));
    if (_stack.length != before) _apply();
  }

  static void _apply() {
    final target = _stack.isEmpty ? appDefault : _stack.last.$2;
    SystemChrome.setPreferredOrientations(target);
  }
}
```

The widget that uses it pushes its lock when its route becomes current. It releases the lock in two places: when a pop starts (through `PopScope`), and in `dispose` as a fallback for routes removed without a pop, such as the old route in a `pushReplacement`:

```dart
// Flutter 3.47.8, Dart 3.13.7
/// Locks orientation while this widget's route is the current route.
class OrientationLock extends StatefulWidget {
  const OrientationLock({
    super.key,
    required this.orientations,
    required this.child,
  });

  final List<DeviceOrientation> orientations;
  final Widget child;

  @override
  State<OrientationLock> createState() => _OrientationLockState();
}

class _OrientationLockState extends State<OrientationLock> {
  ModalRoute<Object?>? _route;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    if (route != _route) {
      _route = route;
      // isCurrent is false while another route covers this one.
      if (route == null || route.isCurrent) {
        OrientationLocks.push(this, widget.orientations);
      }
    }
  }

  @override
  void didUpdateWidget(OrientationLock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!listEquals(oldWidget.orientations, widget.orientations)) {
      OrientationLocks.push(this, widget.orientations);
    }
  }

  @override
  void dispose() {
    OrientationLocks.remove(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope<Object?>(
      onPopInvokedWithResult: (didPop, result) {
        // Release the lock when the pop starts, not when the exit
        // animation ends, so the previous screen does not animate in
        // under the wrong orientation.
        if (didPop) OrientationLocks.remove(this);
      },
      child: widget.child,
    );
  }
}
```

Using it on a route is one wrapper:

```dart
// Flutter 3.47.8, Dart 3.13.7
Navigator.of(context).push(MaterialPageRoute<void>(
  builder: (_) => const OrientationLock(
    orientations: [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight],
    child: VideoPage(),
  ),
));
```

The same test harness, run against this version:

```text
stack push/pop: [landscapeLeft,landscapeRight] -- pop [portraitUp] -- first frame of pop animation -- pop animation done
stack replace:  [landscapeLeft,landscapeRight] -- replace [landscapeLeft,landscapeRight] [landscapeLeft,landscapeRight]  => final [landscapeLeft,landscapeRight]
```

Portrait is requested in the same frame that the pop begins, so the rotation and the reverse transition run together. After the replacement the video stays landscape, because removing the outgoing page's entry re-applies the incoming page's entry rather than the default.

A design choice is baked in here. A route without its own `OrientationLock` inherits the nearest lock below it on the stack. If a landscape player pushes a plain settings sheet, the sheet is landscape too. If you want "everything without a lock is portrait", wrap those routes with an explicit `OrientationLock(orientations: [DeviceOrientation.portraitUp])`. With `go_router`, put the wrapper in the route's `builder` or `pageBuilder`. `ModalRoute.of` and `PopScope` work the same inside a `ShellRoute`'s nested navigator, which the [nested routes and deep links with go_router](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) post walks through.

## Set the app default in the native project, not only in Dart

If the whole app is portrait except one screen, declare portrait natively as well, so the launch screen and the first frame are already correct:

1. In `android/app/src/main/AndroidManifest.xml`, add `android:screenOrientation="portrait"` to the `MainActivity` element.
2. In `ios/Runner/Info.plist`, keep `UISupportedInterfaceOrientations` (iPhone) and `UISupportedInterfaceOrientations~ipad` listing every orientation any screen will ever need. Flutter can only narrow what `Info.plist` allows. It can't add to it. The 3.47.8 template lists portrait and both landscapes for iPhone, and all four orientations for iPad.
3. In `main`, set `OrientationLocks.appDefault` and apply it before `runApp`:

```dart
// Flutter 3.47.8, Dart 3.13.7
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  OrientationLocks.appDefault = const [DeviceOrientation.portraitUp];
  await SystemChrome.setPreferredOrientations(OrientationLocks.appDefault);
  runApp(const MyApp());
}
```

Don't restrict iPhone's `Info.plist` to portrait only, then request landscape from Dart. On iOS 16+ the geometry request fails because the scene supports none of the requested orientations. It fails silently, apart from a log line in Xcode.

## Why iPad multitasking ignores the lock

The `setPreferredOrientations` doc comment in Flutter 3.47.8 says it plainly: "This setting will only be respected on iPad if multitasking is disabled." The reason is UIKit, not Flutter. When an app can share the screen (Split View, Slide Over, Stage Manager, and the freely resizable windows that arrived with iPadOS 26), the scene's size and orientation belong to the system. The user can rotate the iPad with your app in a side-by-side layout. The system won't rotate the whole screen for one app, so `supportedInterfaceOrientations` stops being honoured. Flutter still sends the request, and UIKit just doesn't act on it.

For years the documented workaround, and the one Flutter's docs still mention, was to opt out of multitasking. You did that by ticking "Requires full screen" in Xcode, which writes `UIRequiresFullScreen = YES` to `Info.plist`. That is no longer a long-term answer. Apple's [TN3192](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key) says:

- Starting in iPadOS 26, `UIRequiresFullScreen` and its compatibility mode are deprecated and will be ignored in a future release.
- Starting in iOS 27 and iPadOS 27, apps built with the iOS 27 SDK that set the key are resized discretely instead of being kept full screen. The only exception is when `UIRequiresFullScreenIgnoredStartingWithVersion` names version 27 or earlier.
- To support resizable scenes, an app should support all interface orientations.

Xcode 27.1 ships the iOS 27 SDK. So for a Flutter app you build today, ticking "Requires full screen" no longer opts the app out of resizing on iOS 27, and Apple has told developers to stop relying on it. Developer forum threads from the iPadOS 26.x cycle also report landscape-only apps showing up in portrait when the device's rotation lock is off. Treat any iPad orientation lock as best effort.

What Apple offers instead is a *temporary* lock. A view controller can override `prefersInterfaceOrientationLocked` and call `setNeedsUpdateOfPrefersInterfaceOrientationLocked()`. That asks the system to keep the scene's current orientation while that controller is visible, for example during a camera capture or a steering gesture in a game. TN3192 is explicit that the system "does not guarantee" it will honour the preference. Flutter 3.47.8's `FlutterViewController` does not override this property. You can do it in a subclass and drive it over a method channel:

```swift
// Flutter 3.47.8, Xcode 27.1, iOS 26+ for prefersInterfaceOrientationLocked
import Flutter
import UIKit

class LockableFlutterViewController: FlutterViewController {
  private var locked = false
  private var channel: FlutterMethodChannel?

  override func viewDidLoad() {
    super.viewDidLoad()
    channel = FlutterMethodChannel(
      name: "app/orientation_lock", binaryMessenger: engine.binaryMessenger)
    channel?.setMethodCallHandler { [weak self] call, result in
      guard let self, call.method == "setLocked", let value = call.arguments as? Bool else {
        result(FlutterMethodNotImplemented)
        return
      }
      self.locked = value
      if #available(iOS 26.0, *) {
        self.setNeedsUpdateOfPrefersInterfaceOrientationLocked()
      }
      result(nil)
    }
  }

  override var prefersInterfaceOrientationLocked: Bool {
    locked
  }
}
```

In `ios/Runner/Base.lproj/Main.storyboard`, change the root view controller's `customClass` from `FlutterViewController` to `LockableFlutterViewController` (with `customModuleProvider="target"`). Then call it from Dart:

```dart
// Flutter 3.47.8, Dart 3.13.7
const _lockChannel = MethodChannel('app/orientation_lock');

Future<void> setIpadOrientationLocked(bool locked) =>
    _lockChannel.invokeMethod<void>('setLocked', locked);
```

This keeps whatever orientation the scene already has. It doesn't rotate to landscape, so it complements `setPreferredOrientations` and doesn't replace it. I compiled this subclass into a Flutter 3.47.8 app with `flutter build ios --simulator` on Xcode 27.1 (deployment target iOS 15, hence the `#available` check). I did not test multitasking behaviour on a physical iPad, so verify it on hardware before you rely on it.

## Android 16 does the same thing on large screens

Android went down the same road. Per the [Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16#ignore-orientation), apps targeting API 36 ignore `screenOrientation`, `resizableActivity`, `minAspectRatio`, `maxAspectRatio`, `setRequestedOrientation()` and `getRequestedOrientation()` on displays whose smallest width is at least 600 dp. That covers tablets, foldables when unfolded, and desktop windows. Flutter's `setPreferredOrientations` is a `setRequestedOrientation()` call, and Flutter 3.47.8's Gradle plugin sets `flutter.targetSdkVersion` to 36. So a freshly created Flutter app will not lock orientation on a tablet. Flutter's own docs now carry this limitation.

The exceptions are games (declared with `android:appCategory="game"`), users who pick the app's default behaviour in the device's aspect ratio settings, and screens narrower than 600 dp. Phones are unaffected. There is a temporary opt-out:

```xml
<!-- android/app/src/main/AndroidManifest.xml, targetSdk 36 only -->
<activity android:name=".MainActivity" ...>
    <property
        android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"
        android:value="true" />
</activity>
```

Google states that the opt-out stops applying once you target API level 37. Treat it as time to fix your tablet layout, not as a fix. The same rule hit MAUI apps, and the [MAUI API level 36 migration](/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) post covers the manifest side in more detail.

## Gotchas when the screen does rotate

- **Lay out from constraints, not the lock.** The rotation arrives a frame or more after your call, and on iPad or Android 16 tablets it may never arrive. Build the locked screen with `OrientationBuilder` or `LayoutBuilder` so it renders correctly in whatever size it actually gets.
- **Use the display, not `MediaQuery.size`, to decide whether to lock.** On Android, letterboxing makes `MediaQueryData.size` report the letterboxed area. Flutter's docs recommend `View.of(context).display.size / display.devicePixelRatio` against a 600-logical-pixel breakpoint. Lock phones only, and send `[]` on tablets.
- **`landscapeLeft` means the device is turned counterclockwise.** `DeviceOrientation.landscapeLeft` is "90 degrees counterclockwise from portraitUp". Request both landscapes unless you have a reason to pin one. Otherwise a user who turned the phone the other way sees the screen flip upside down for them.
- **iPhones without a Home button never get `portraitDown`.** TN3192 notes that the system removes `portraitUpsideDown` from the supported set on those models, whatever you declare.
- **Resuming from background.** The native preference survives backgrounding, so you don't need to reapply it on resume. If you have other lifecycle code, the [AppLifecycleListener migration](/2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener/) is the cleaner place for it than a `WidgetsBindingObserver`.
- **Don't call it after an `await` without checking `mounted`.** Locking after an async video load is common. If the user already popped the route, a late `OrientationLocks.push` from a dead `State` leaves a lock that nothing removes. The rules from [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) apply here too.

## Related reading

- [Nested routes and deep links with go_router](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/), for where to put the `OrientationLock` wrapper in a route tree.
- [go_router vs auto_route vs Navigator 2.0](/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/), if you are choosing a router and care about how replacement routes are disposed.
- [Migrate from WidgetsBindingObserver to AppLifecycleListener](/2026/10/migrate-a-flutter-app-from-widgetsbindingobserver-to-applifecyclelistener/).
- [Migrate a .NET MAUI Android app to target API level 36](/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/), for the same Android 16 large-screen rule from the MAUI side.

## Sources

- [`SystemChrome.setPreferredOrientations` API docs](https://api.flutter.dev/flutter/services/SystemChrome/setPreferredOrientations.html) and the [3.47.8 source](https://github.com/flutter/flutter/blob/3.47.8/packages/flutter/lib/src/services/system_chrome.dart).
- Flutter engine at 3.47.8: [`FlutterViewController.mm`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterViewController.mm), [`FlutterPlatformPlugin.mm`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterPlatformPlugin.mm), [`PlatformChannel.java`](https://github.com/flutter/flutter/blob/3.47.8/engine/src/flutter/shell/platform/android/io/flutter/embedding/engine/systemchannels/PlatformChannel.java).
- [TN3192: Migrating your app from the deprecated UIRequiresFullScreen key](https://developer.apple.com/documentation/technotes/tn3192-migrating-your-app-from-the-deprecated-uirequiresfullscreen-key).
- [Android 16 behavior changes: ignore orientation, resizability, and aspect ratio restrictions](https://developer.android.com/about/versions/16/behavior-changes-16#ignore-orientation).
- Apple Developer Forums: [iPadOS 26.x ignores supportedInterfaceOrientations when orientation lock is off](https://developer.apple.com/forums/thread/811216).
