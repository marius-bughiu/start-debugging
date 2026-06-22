---
title: "How to set up nested routes and deep links with go_router in Flutter"
description: "Build a persistent shell with nested routes using ShellRoute and StatefulShellRoute, then wire up path-based deep links that rebuild the full page stack. Full config for Android and iOS, plus the gotchas that break the back stack."
pubDate: 2026-06-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "navigation"
---

To nest routes in Flutter with `go_router`, put child routes in the `routes:` list of a parent `GoRoute` so the URL builds up a page stack, and wrap a group of routes in a `ShellRoute` (or `StatefulShellRoute.indexedStack` for tab state) when they should share a persistent UI like a bottom navigation bar. Deep links then come almost for free: `go_router` parses the incoming path against that route tree and reconstructs the matching stack, so a link to `/orders/42` lands the user on the order detail page with `/orders` underneath it in the back stack. The only manual work is the native platform config that tells Android and iOS to hand the URL to Flutter in the first place. This guide uses `go_router` 17.3.0 (June 2026), Flutter 3.44 stable, and Dart 3.x.

The two ideas people conflate are nesting and deep linking, and they are genuinely separate. Nesting is about how your route tree is shaped: which screens sit inside which, and which layout persists across them. Deep linking is about an external URL entering the app and resolving to a screen. They meet at exactly one point: `go_router` uses the same declarative route table to render in-app navigation and to resolve a deep link, which is why a well-shaped route tree gives you correct deep links without extra code.

## How sub-routes turn a URL into a page stack

A `GoRoute` can carry its own `routes:` list. When the matched path goes deeper than the parent, `go_router` walks the tree and pushes one page per level, so the resulting back stack mirrors the URL segments.

```dart
// go_router 17.3.0, Flutter 3.44, Dart 3.x
final router = GoRouter(
  routes: [
    GoRoute(
      path: '/orders',
      builder: (context, state) => const OrdersScreen(),
      routes: [
        // matches /orders/42 -> stack is [OrdersScreen, OrderDetailScreen]
        GoRoute(
          path: ':id',
          builder: (context, state) {
            final id = state.pathParameters['id']!;
            return OrderDetailScreen(orderId: id);
          },
        ),
      ],
    ),
  ],
);
```

Two details matter here. First, child paths are relative: the child is `':id'`, not `'/orders/:id'`. A leading slash on a sub-route makes it an absolute, top-level route and breaks the nesting, which is one of the most common configuration mistakes. Second, because the stack is built from the URL, pressing the system back button on `/orders/42` pops to `/orders` even if the user arrived directly via a deep link. That is the entire payoff of declarative routing: the back stack is a function of the path, not of how the user got there.

Read a path parameter from `state.pathParameters` and a query parameter from `state.uri.queryParameters`. Both are plain strings, so parse and validate them in the builder rather than trusting the URL.

## Sharing a layout with ShellRoute

Sub-routes give you depth, but they do not give you a persistent frame. If `/orders` and `/profile` should both render inside the same scaffold with the same bottom bar, you want a `ShellRoute`. A `ShellRoute` introduces a nested `Navigator`: its child routes render into a `child` widget that you place inside your shell, and the shell itself never rebuilds as the user moves between children.

```dart
// go_router 17.3.0 -- one shared scaffold, swappable body
ShellRoute(
  builder: (context, state, child) => ScaffoldWithNavBar(child: child),
  routes: [
    GoRoute(path: '/orders', builder: (_, __) => const OrdersScreen()),
    GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
  ],
),
```

The `child` passed to the shell builder is the currently matched sub-route. Your `ScaffoldWithNavBar` puts `child` in the `body` and renders the `BottomNavigationBar` around it. Tapping a tab calls `context.go('/profile')`, the nested navigator swaps the body, and the scaffold stays mounted. That persistence is the whole reason to reach for `ShellRoute` instead of a plain list of top-level routes.

The limitation: `ShellRoute` keeps a single navigator, so all tabs share one back stack and the body is rebuilt from scratch each time you switch. Scroll position, form input, and any ephemeral state inside a tab are lost on switch. For many apps that is fine. For an Instagram-style app where each tab must remember where it was, you need the stateful variant.

## Giving each tab its own back stack with StatefulShellRoute

`StatefulShellRoute.indexedStack` creates a separate `Navigator` per branch and keeps all branches alive in an `IndexedStack`, so switching tabs preserves each tab's stack and state. This is the 2026 default for any app with a bottom navigation bar where tabs should be independent.

```dart
// go_router 17.3.0 -- independent stacks per tab
StatefulShellRoute.indexedStack(
  builder: (context, state, navigationShell) =>
      ScaffoldWithNavBar(navigationShell: navigationShell),
  branches: [
    StatefulShellBranch(
      routes: [
        GoRoute(
          path: '/orders',
          builder: (_, __) => const OrdersScreen(),
          routes: [
            GoRoute(
              path: ':id',
              builder: (context, state) =>
                  OrderDetailScreen(orderId: state.pathParameters['id']!),
            ),
          ],
        ),
      ],
    ),
    StatefulShellBranch(
      routes: [
        GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
      ],
    ),
  ],
)
```

The builder hands you a `StatefulNavigationShell` instead of a plain `child`. You switch branches with `navigationShell.goBranch(index)`, not `context.go(...)`, because `goBranch` restores that branch's existing stack rather than starting a new navigation:

```dart
// go_router 17.3.0 -- the nav bar drives the shell, not context.go
BottomNavigationBar(
  currentIndex: navigationShell.currentIndex,
  onTap: (index) => navigationShell.goBranch(
    index,
    // re-tapping the active tab pops to its root, like native apps
    initialLocation: index == navigationShell.currentIndex,
  ),
  items: const [
    BottomNavigationBarItem(icon: Icon(Icons.list), label: 'Orders'),
    BottomNavigationBarItem(icon: Icon(Icons.person), label: 'Profile'),
  ],
)
```

Recent versions also expose a `preload` flag on `StatefulShellBranch`, which builds a branch's first route before the user ever visits it, trading some startup cost for an instant first tab switch. Leave it off unless a profiler shows the first switch is janky.

## Configuring the platforms so a deep link reaches Flutter

A deep link only works if the operating system routes the URL to your app. `go_router` cannot do this part for you; it takes over only after Flutter receives the link. Flutter's built-in deep linking is enabled by default in Flutter 3.44, so you mostly add the platform routes and, on Android, opt in to App Links verification.

There are two kinds of links, and the native setup differs:

- **Custom scheme** (`myapp://orders/42`): trivial to set up, works offline, but any app can claim the same scheme. Fine for internal app-to-app handoffs.
- **Universal links / App Links** (`https://example.com/orders/42`): tied to a domain you own via a hosted association file, so only your app can claim them. This is what you want for links shared over the web.

On Android, add an `intent-filter` to the main activity in `android/app/src/main/AndroidManifest.xml`. The `android:autoVerify="true"` attribute is what promotes a plain `https` link into a verified App Link:

```xml
<!-- AndroidManifest.xml -->
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="example.com" />
</intent-filter>
```

Flutter's deep linking is on by default, but if you ever need to toggle it, the explicit flag is a `meta-data` entry named `flutter_deeplinking_enabled` set to `true` or `false`. App Links also require an `assetlinks.json` file hosted at `https://example.com/.well-known/assetlinks.json` containing your app's package name and signing fingerprint, or the OS will fall back to opening the browser.

On iOS, the equivalent `Info.plist` key is `FlutterDeepLinkingEnabled`. Universal links need an Associated Domains entitlement (`applinks:example.com`) plus an `apple-app-site-association` file hosted on your domain. A custom scheme instead uses a `CFBundleURLTypes` entry in `Info.plist`. The precise XML for both platforms lives in the Flutter cookbooks linked at the end; the key names above are the load-bearing parts.

## The step-by-step setup

Here is the full sequence to go from a flat app to nested routes with working deep links.

1. **Add and pin the dependency.** Run `flutter pub add go_router` and confirm `pubspec.yaml` shows `go_router: ^17.3.0`. Pin the major version because `go_router` has had breaking shell API changes across majors.
2. **Define the route tree.** Build a single `GoRouter` with your top-level routes. Nest detail screens inside their parent's `routes:` list using relative paths (`':id'`, never `'/parent/:id'`).
3. **Add a shell for shared layout.** Wrap tabbed routes in `StatefulShellRoute.indexedStack` (independent tab stacks) or `ShellRoute` (one shared stack). Render `navigationShell` or `child` inside your scaffold's body.
4. **Wire the router into the app.** Pass it to `MaterialApp.router(routerConfig: router)` so Flutter's `Router` widget drives navigation and the platform deep-link handler is connected.
5. **Navigate by path.** Use `context.go('/orders/42')` to replace the stack, `context.push('/orders/42')` to stack on top, and `navigationShell.goBranch(index)` to switch tabs without losing their state.
6. **Configure the platforms.** Add the Android `intent-filter` with `autoVerify` and the iOS Associated Domains entitlement, and host the `assetlinks.json` / `apple-app-site-association` files for verified links.
7. **Test the link end to end.** On Android, `adb shell am start -W -a android.intent.action.VIEW -d "https://example.com/orders/42"`. On iOS Simulator, `xcrun simctl openurl booted "https://example.com/orders/42"`. The app should open directly on the order detail screen with `/orders` in the back stack.

## Gotchas that quietly break navigation

**Absolute sub-route paths.** A child route written as `'/orders/:id'` instead of `':id'` silently becomes a top-level route. Nesting breaks and the back button stops returning to `/orders`. This is the single most common mistake.

**Showing a dialog or full-screen route inside a shell.** A login screen or modal usually should not render inside the bottom-nav scaffold. Give the route a `parentNavigatorKey` pointing at the root navigator's key so it pushes over the shell instead of inside it. Without this, your sign-in page appears with a bottom bar attached.

**Using `context.go` to switch tabs.** Inside a `StatefulShellRoute`, calling `context.go('/profile')` works but discards that branch's saved stack. Always use `navigationShell.goBranch(index)` from the nav bar so each tab remembers where it was.

**Reading a context after an async redirect.** Redirects and async navigation can rebuild or dispose the widget that triggered them. If you navigate after an `await`, guard the resume the same way you would anywhere else, as covered in [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/). Ignoring this surfaces the [deactivated widget's ancestor crash](/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/).

**Assuming a deep link is valid.** `state.pathParameters['id']` is whatever the URL contained, including garbage from a hand-typed or stale link. Parse it, validate it, and route to a not-found screen on failure. Pair this with graceful [network error handling](/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/) when the deep-linked resource has to be fetched and might be gone.

**Disposing controllers on screens that persist.** With `StatefulShellRoute.indexedStack`, tab screens stay alive in the background, so their controllers are not disposed on tab switch. That is usually what you want, but be deliberate about it, the same way you would when [disposing controllers to avoid leaks](/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/) on routes that truly come and go.

## When to graft typed routes on top

Everything above uses string paths. They are easy to read but easy to typo, and a wrong path string fails at runtime, not compile time. For a large app, add `go_router_builder` to generate type-safe route classes from annotated definitions, so `OrderDetailRoute(id: 42).go(context)` replaces the raw string and the compiler catches a missing parameter. The route tree shape, shells, and deep-link config are identical; typed routes are a code-generation layer over the same `GoRouter`. Start with strings, confirm the navigation model is right, then introduce typed routes once the structure is stable. If you are also picking a state management approach for the screens these routes render, the trade-offs in [Provider vs Riverpod vs Bloc](/2026/06/provider-vs-riverpod-vs-bloc-for-flutter-state-management-in-2026/) pair naturally with this routing setup.

## Sources

- [go_router package on pub.dev](https://pub.dev/packages/go_router) (version 17.3.0, June 2026)
- [ShellRoute class API](https://pub.dev/documentation/go_router/latest/go_router/ShellRoute-class.html)
- [StatefulShellRoute class API](https://pub.dev/documentation/go_router/latest/go_router/StatefulShellRoute-class.html)
- [Deep linking topic, go_router docs](https://pub.dev/documentation/go_router/latest/topics/Deep%20linking-topic.html)
- [Flutter deep linking documentation](https://docs.flutter.dev/ui/navigation/deep-linking)
