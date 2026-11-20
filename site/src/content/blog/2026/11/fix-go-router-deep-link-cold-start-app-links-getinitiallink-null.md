---
title: "Fix: go_router deep link lands on the wrong screen (or app_links getInitialLink() returns null) when the Flutter app was terminated"
description: "On an iOS cold start Flutter renders '/' first, then delivers the link. app_links 6.x misses it under UIScene. Upgrade to app_links 7, pick one link handler, and seed initialLocation."
pubDate: 2026-11-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "go-router"
  - "deep-links"
  - "ios"
---
On a cold start (the app was terminated), Flutter on iOS builds your `initialLocation` (usually `/`) and renders a frame before the deep link arrives through `pushRouteInformation`. If you also handle links with app_links, the same link gets navigated two or three times. On Flutter 3.38+ with the UIScene lifecycle, app_links 6.x never sees the launch URL, so `getInitialLink()` returns `null`. The fix: upgrade to app_links 7.x and use a single link handler. If you want no `/` frame, set `FlutterDeepLinkingEnabled` to `false` and create the `GoRouter` with `initialLocation` taken from `await AppLinks().getInitialLink()` before `runApp`.

Everything below was measured on Flutter 3.44.8 (Dart 3.12.2), go_router 18.1.4 and app_links 7.2.1 (plus 6.4.1 for comparison). The iOS runs used an iOS 26.5 iPhone 17e simulator with Xcode 27.1. The Android runs used an Android 16 (API 36) arm64 emulator.

## What the symptom looks like

The two Stack Overflow reports describe the same bug from different sides:

```text
// Report 1 (go_router + app_links): links work in foreground and background, but when
// the app is dead "it just goes to a black screen", even with delayed router.go() calls.

// Report 2 (app_links 6.4.1, Flutter 3.38, iOS 26.5, UIScene / FlutterImplicitEngineDelegate):
INITIAL URI => null
// while the native side logs: IOS DeepLink Received URL: flyfi://shareStory?albumId=ODg=
```

A third variant is tracked as [flutter/flutter#142988](https://github.com/flutter/flutter/issues/142988): on iOS a go_router `redirect` sees `/` first and the deep-link path second. On Android it sees only the deep-link path. If your `/` route is a splash screen that runs auth and calls `context.go('/login')`, that call can race with the deep link and override it. That is what most "the link opens the home screen instead" reports turn out to be.

## Why a cold-start link takes a detour through `/`

Three mechanisms are involved, and all three can be read in the engine and plugin sources.

**1. iOS delivers the link after the first frame.** With the UIScene lifecycle (the default template since Flutter 3.38), iOS hands a cold-start URL to `scene:willConnectToSession:options:` in `connectionOptions.URLContexts`. `launchOptions` no longer carries it. Flutter's `FlutterSceneLifeCycle.mm` forwards it to `-[FlutterEngine sendDeepLinkToFramework:]`. That method calls `waitForFirstFrame:3.0` and only then invokes `pushRouteInformation` on the navigation channel, with the full `url.absoluteString` as `location`. By then go_router has already built its initial location.

**2. Android passes the link as the initial route.** `FlutterActivityAndFragmentDelegate` reads the intent's data URI into `setInitialRoute(...)`, so `PlatformDispatcher.defaultRouteName` is the deep link before your `main()` runs. go_router's `_effectiveInitialLocation` prefers a non-`/` platform default over your `initialLocation`, so Android never builds `/`.

**3. app_links is a second, independent delivery path.** Its iOS plugin registers as an application delegate and (since 7.0.0) as a scene delegate. It stores the launch URL for `getInitialLink()` and also replays it to the first `uriLinkStream` listener. By default (`defaultUrlHandling = .never`) it reports the URL as unhandled, so Flutter's own deep linking runs too. `FlutterDeepLinkingEnabled` defaults to `YES` when the key is missing from `Info.plist`, and on Android `flutter_deeplinking_enabled` has defaulted to true since Flutter 3.27 ([breaking change note](https://docs.flutter.dev/release/breaking-changes/deep-links-flag-change)).

app_links 6.4.1's iOS plugin only calls `registrar.addApplicationDelegate`. It has no scene callbacks. Under UIScene the launch URL never reaches the application delegate's `launchOptions` path, so `getInitialLink()` returns `null`. The [app_links 7.0.0 changelog](https://pub.dev/packages/app_links/changelog) says the release "focuses on Flutter 3.38 release and especially iOS scene lifecycle breaking changes".

## Minimal repro

One `main.dart`, two routes, a `redirect` that logs every location it sees, and a log file with millisecond timestamps. The scheme is `sdrepro`, registered under `CFBundleURLTypes` in `ios/Runner/Info.plist` and as a `VIEW`/`BROWSABLE` intent filter in `AndroidManifest.xml`.

```dart
// Flutter 3.44.8, Dart 3.12, go_router 18.1.4, app_links 7.2.1
import 'dart:io';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

final clock = Stopwatch()..start();
late final File logFile;

void log(String msg) {
  final line = '[${clock.elapsedMilliseconds.toString().padLeft(5)} ms] $msg';
  debugPrint(line);
  logFile.writeAsStringSync('$line\n', mode: FileMode.append, flush: true);
}

GoRouter buildRouter(String initialLocation) => GoRouter(
      initialLocation: initialLocation,
      routes: [
        GoRoute(path: '/', builder: (_, __) => const Screen('Home')),
        GoRoute(
          path: '/game/:id',
          builder: (_, s) => Screen('Game ${s.pathParameters['id']}'),
        ),
      ],
      redirect: (context, state) {
        log('redirect uri=${state.uri} matched=${state.matchedLocation}');
        return null;
      },
      errorBuilder: (_, s) => Screen('Error: ${s.uri}'),
    );

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  logFile = File('${Directory.systemTemp.path}/sdrepro.log');
  WidgetsBinding.instance.addPostFrameCallback((_) => log('first frame'));

  // The common pattern: router starts at '/', app_links navigates later.
  final router = buildRouter('/');
  final appLinks = AppLinks();
  appLinks.getInitialLink().then((uri) {
    log('getInitialLink -> $uri');
    if (uri != null) router.go(uri.path);
  });
  appLinks.uriLinkStream.listen((uri) {
    log('uriLinkStream -> $uri');
    router.go(uri.path);
  });

  runApp(MaterialApp.router(routerConfig: router));
}

class Screen extends StatelessWidget {
  const Screen(this.title, {super.key});
  final String title;

  @override
  Widget build(BuildContext context) {
    log('build screen "$title"');
    return Scaffold(appBar: AppBar(title: Text(title)), body: Center(child: Text(title)));
  }
}
```

### How the cold start was triggered

On Android, `adb shell am start -W -a android.intent.action.VIEW -d 'sdrepro:///game/42' <package>` after `am force-stop` reports `LaunchState: COLD`. On the iOS simulator, `xcrun simctl openurl` (and any other app that calls `UIApplication.open`) now shows an "Open in ...?" confirmation. In this run a small XCUITest pressed it: terminate the app, open the URL from a helper app, then `XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"].tap()`. The app process is genuinely started by the URL, which is the case that matters.

Use a simulator or a profile/release build for this. A debug build launched from the iPhone home screen without the Flutter tool attached can crash during plugin registration ([flutter/flutter#149214](https://github.com/flutter/flutter/issues/149214)). app_links 7.2.1 detects that case, prints "Flutter application in debug mode can only be launched from Flutter tooling", and skips registration, so the plugin goes silent. That produces a separate "it only fails when terminated" bug on devices.

## What actually happens, measured

**go_router only, iOS, `FlutterDeepLinkingEnabled` not set (defaults to on):**

```text
[    0 ms] main defaultRouteName=/
[   99 ms] redirect uri=/ matched=/
[  132 ms] build screen "Home"
[  230 ms] first frame
[  264 ms] redirect uri=sdrepro:///game/42 matched=/game/42
[  296 ms] build screen "Game 42"
```

The link arrives after the first frame, as the engine source says. Without app_links this still ends on the right screen, but `/` was built and `redirect` ran for it.

**Same app, Android 16:**

```text
[    0 ms] main defaultRouteName=sdrepro:///game/42
[  259 ms] redirect uri=sdrepro:///game/42 matched=/game/42
[  353 ms] build screen "Game 42"
[  550 ms] first frame
```

No `/` at all. That is the platform difference reported in #142988.

**go_router plus app_links (the repro above), iOS:**

```text
[   88 ms] redirect uri=/ matched=/
[  113 ms] build screen "Home"
[  180 ms] first frame
[  200 ms] uriLinkStream -> sdrepro:///game/42
[  201 ms] redirect uri=/game/42 matched=/game/42
[  202 ms] getInitialLink -> sdrepro:///game/42
[  203 ms] redirect uri=/game/42 matched=/game/42
[  212 ms] build screen "Game 42"
[  253 ms] redirect uri=sdrepro:///game/42 matched=/game/42
[  271 ms] build screen "Game 42"
```

One tap, four `redirect` calls: `/`, then the link from the stream replay, from `getInitialLink()`, and from Flutter's own `pushRouteInformation`. With `context.go` this is idempotent, so the user still lands on Game 42. If you use `push`, analytics, or a redirect with side effects, each of the three link deliveries runs it again. On Android the same app shows `/game/42` from the platform default plus two more navigations from app_links.

**app_links 6.4.1, iOS, Flutter deep linking off:**

```text
[   94 ms] getInitialLink -> null
[  176 ms] redirect uri=/ matched=/
[  201 ms] build screen "Home"
[  312 ms] first frame
```

This is Stack Overflow report 2 exactly. The URL reached the scene, but the 6.x plugin was not listening there, and with Flutter's deep linking disabled nobody else delivered it. The user lands on Home.

## The fix, step by step

1. **Upgrade app_links to 7.x** if your iOS app uses UIScene (every app created on Flutter 3.38+, and every app that followed the [UIScene migration guide](https://docs.flutter.dev/release/breaking-changes/uiscenedelegate)). app_links 7.1.0+ requires Flutter 3.44. On 3.38-3.43, use 7.0.x.

   ```yaml
   # pubspec.yaml, Flutter 3.44.8
   dependencies:
     go_router: ^18.1.4
     app_links: ^7.2.1
   ```

2. **Pick one delivery path.** If go_router alone is enough (paths map 1:1 to routes), delete app_links and keep Flutter's deep linking on. Accept that iOS builds `/` once on a cold start, and make `/` cheap and side-effect free. If you need app_links (custom parsing, non-route links, attribution SDKs), turn Flutter's handling off so links stop arriving twice:

   ```xml
   <!-- ios/Runner/Info.plist -->
   <key>FlutterDeepLinkingEnabled</key>
   <false/>
   ```

   ```xml
   <!-- android/app/src/main/AndroidManifest.xml, inside <activity> -->
   <meta-data android:name="flutter_deeplinking_enabled" android:value="false" />
   ```

3. **Seed the router from the launch link instead of navigating after the fact.** Read `getInitialLink()` before `runApp`, build the `GoRouter` with that location, and only listen for links that arrive later:

   ```dart
   // Flutter 3.44.8, go_router 18.1.4, app_links 7.2.1
   Future<void> main() async {
     WidgetsFlutterBinding.ensureInitialized();

     final appLinks = AppLinks();
     final initial = await appLinks.getInitialLink();

     final router = buildRouter(initial == null ? '/' : toLocation(initial));

     // app_links replays the launch link to the first listener. Skip it,
     // because the router already starts there.
     appLinks.uriLinkStream
         .skip(initial == null ? 0 : 1)
         .listen((uri) => router.go(toLocation(uri)));

     runApp(MaterialApp.router(routerConfig: router));
   }

   String toLocation(Uri uri) => Uri(
         path: uri.path.isEmpty ? '/' : uri.path,
         queryParameters: uri.queryParameters.isEmpty ? null : uri.queryParameters,
       ).toString();
   ```

   Measured on iOS with `FlutterDeepLinkingEnabled` set to `false` and the link `sdrepro:///game/42?from=share`:

   ```text
   [   52 ms] getInitialLink -> sdrepro:///game/42?from=share
   [  136 ms] redirect uri=/game/42?from=share matched=/game/42
   [  160 ms] build screen "Game 42"
   [  255 ms] first frame
   ```

   One redirect, no `/`, and the first frame is already the target screen. `getInitialLink()` had the URL 15 to 52 ms after `main()` started in these runs, because the scene connects before Dart runs. On Android the same build produced a single redirect for `sdrepro:///game/42` and also never built `/`.

4. **Navigate with the router instance, not a `BuildContext` above it.** In Stack Overflow report 1, `context.go(...)` is called from the `State` that builds `MaterialApp.router`. That context sits above the `Router`, so `GoRouter.of(context)` has nothing to find. Keep a reference to the `GoRouter` (or use a `navigatorKey` context, as the asker's own workaround does) and call `router.go(...)`.

If you leave Flutter's deep linking on and still seed from app_links, it works, but iOS still delivers the link a second time. The measured run showed one extra `redirect` for `sdrepro:///game/42` at 261 ms and a rebuild of the same screen. That is harmless with `go` and wasteful with `push`.

## Gotchas that look like the same bug

**`myapp://game/42` is not `myapp:///game/42`.** With two slashes, `game` is the URI host and the path is `/42`. Flutter's deep linking passes the full URL to go_router, which matches on the path. Measured on both platforms:

```text
[  272 ms] redirect uri=sdrepro://game/42 matched=/42
[  293 ms] build screen "Error: sdrepro://game/42"
```

Use three slashes for custom schemes, use https universal/app links, or rebuild the location as `'/${uri.host}${uri.path}'` in your own handler. (That last option is plain `Uri` logic and was not part of the measured runs.)

**Slow startup can drop the link entirely.** `sendDeepLinkToFramework` waits at most 3 seconds for the first frame. On timeout it logs "Timeout waiting for first frame when launching a URL." and does not push the route. A `main()` that awaits Firebase, remote config, and a token refresh before `runApp` can exceed that on a cold device start. This comes from reading the 3.44.8 engine source and was not triggered in these runs. Render something immediately and do slow initialization inside the app.

**A splash route that navigates on a timer.** Because iOS builds `/` first, a splash screen that calls `context.go('/home')` after its init finishes can run after the deep link and override it. Put auth gating in `redirect`, which go_router re-runs for every location, instead of in a screen's `initState`.

**"Black screen" on cold start.** That symptom from report 1 did not reproduce here: every variant above rendered a real screen. When you see it, check the device log for an exception thrown during the first build or a redirect loop. A black screen means nothing was painted, which is different from painting the wrong route. On a physical iPhone, also rule out the debug-build launch problem described in the repro section.

**Universal links are the same story.** For https links iOS uses `connectionOptions.userActivities` and `scene:continueUserActivity:` instead of `URLContexts`, and Flutter's scene code forwards both the same way. The `/`-first ordering and the app_links overlap apply unchanged. Only the transport differs (associated domains plus `apple-app-site-association`, see the [universal links cookbook](https://docs.flutter.dev/cookbook/navigation/set-up-universal-links)).

## Related

- The base setup this post builds on: [nested routes and deep links with go_router](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/), including the platform config keys.
- If you are still choosing a router: [go_router vs auto_route vs Navigator 2.0](/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/).
- When a deep link lands inside a `StatefulShellRoute`, [keeping the NavigationBar tab in sync with the current route](/2026/10/how-to-keep-the-navigationbar-selected-tab-in-sync-with-the-current-route-in-go-router/) covers the shell side.
- Cold starts are not only about links: [restoring UI state after Android process death](/2026/10/how-to-restore-ui-state-after-android-process-death-in-flutter-with-restorationmixin/) uses a similar kill-and-relaunch test loop.
- Why the device test should be a profile build: [flavors vs build modes in Flutter](/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/).

## Sources

- [flutter/flutter#142988: deep links route to "/" before the expected path on iOS from a terminated state](https://github.com/flutter/flutter/issues/142988)
- [FlutterSceneLifeCycle.mm at 3.44.8](https://github.com/flutter/flutter/blob/3.44.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterSceneLifeCycle.mm) (`handleDeeplinkingForEngine:options:`) and [FlutterEngine.mm at 3.44.8](https://github.com/flutter/flutter/blob/3.44.8/engine/src/flutter/shell/platform/darwin/ios/framework/Source/FlutterEngine.mm) (`sendDeepLinkToFramework:`, 3-second first-frame wait)
- [go_router `router.dart`](https://github.com/flutter/packages/blob/main/packages/go_router/lib/src/router.dart) (`_effectiveInitialLocation`) and the [go_router package](https://pub.dev/packages/go_router)
- [app_links changelog](https://pub.dev/packages/app_links/changelog) (7.0.0 UIScene support, 7.1.0 Flutter 3.44 minimum)
- [Flutter deep linking overview](https://docs.flutter.dev/ui/navigation/deep-linking), [deep links flag change](https://docs.flutter.dev/release/breaking-changes/deep-links-flag-change), [UIScene migration guide](https://docs.flutter.dev/release/breaking-changes/uiscenedelegate)
- [flutter/flutter#149214: plugin registration crash when a debug build is launched from the iOS home screen](https://github.com/flutter/flutter/issues/149214)
- Stack Overflow questions [79878084](https://stackoverflow.com/questions/79878084) and [79950768](https://stackoverflow.com/questions/79950768)
