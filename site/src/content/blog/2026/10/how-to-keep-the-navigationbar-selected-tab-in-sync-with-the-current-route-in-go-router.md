---
title: "How to Keep the NavigationBar Selected Tab in Sync with the Current Route Using StatefulShellRoute in go_router"
description: "Drive NavigationBar.selectedIndex from StatefulNavigationShell.currentIndex, never from a setState field or a copy made in initState. Measured on Flutter 3.44.8 and go_router 18.0.2: which patterns drift on deep links, context.go and cross-branch pushes, why location-based indexes lie, and how to react to tab changes with didUpdateWidget."
pubDate: 2026-10-11
template: how-to
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "navigation"
  - "how-to"
---

**Short answer:** do not store the selected tab yourself. Inside a `StatefulShellRoute`, go_router already knows which branch is active and hands it to you as `navigationShell.currentIndex`. Pass that straight to `NavigationBar.selectedIndex` on every build and switch tabs with `navigationShell.goBranch(index)`. A `_selectedIndex` field updated in `onDestinationSelected`, or a copy of `currentIndex` taken in `initState`, only changes when the user taps the bar, so it goes stale the moment a deep link, a `context.go` from inside a page, or a notification handler changes the route. Everything below was run with `flutter test` on Flutter 3.44.8 (Dart 3.12.2) and go_router 18.0.2, the latest release as of October 2026.

The bug report usually reads like this: "I open the app from a link to `/profile` and the bar still highlights Home", or "a button on the Orders page sends the user to Settings, the Settings page shows, but the bar still says Orders". The page is right and the bar is wrong, because two sources of truth disagree: the router's location and a piece of widget state that only the bar itself updates.

## Why the bar and the route drift apart

A `NavigationBar` is a dumb widget. It renders whatever `selectedIndex` you give it and calls `onDestinationSelected` when the user taps. It has no idea that a router exists. If you keep the index in a `StatefulWidget`, the only code path that updates it is the tap handler, and taps are just one of many ways the route changes:

- the app starts on a deep link or `initialLocation` that points into the second tab
- a page calls `context.go('/profile/settings')` (a "see all" link, a post-login redirect, a push-notification handler)
- a `redirect` sends the user somewhere else
- the browser back button on Flutter web, or state restoration after the OS killed the process

None of these touch your `_selectedIndex` field. The router rebuilds the shell with the new branch, your scaffold rebuilds with its old field value, and the bar lies.

go_router solves this for you, as long as you let it. When it builds a `StatefulShellRoute`, it creates a `StatefulNavigationShell` and computes `currentIndex` in the constructor from the navigator key of the branch that matched the current location (see `route.dart` in the go_router source, `_indexOfBranchNavigatorKey`). A new shell widget is created on every route change, so `currentIndex` is always the router's own answer to "which branch is showing right now".

## A minimal app that reproduces the drift

Two branches, Orders and Profile. The Orders page has a button that jumps straight into the Profile branch, which is exactly the kind of in-page navigation that breaks a hand-rolled index:

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
final router = GoRouter(
  initialLocation: '/orders',
  routes: [
    StatefulShellRoute.indexedStack(
      builder: (context, state, navigationShell) =>
          AppScaffold(navigationShell: navigationShell),
      branches: [
        StatefulShellBranch(routes: [
          GoRoute(
            path: '/orders',
            builder: (context, state) => const OrdersPage(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) =>
                    OrderPage(id: state.pathParameters['id']!),
              ),
            ],
          ),
        ]),
        StatefulShellBranch(routes: [
          GoRoute(
            path: '/profile',
            builder: (context, state) => const ProfilePage(),
            routes: [
              GoRoute(
                path: 'settings',
                builder: (context, state) => const SettingsPage(),
              ),
            ],
          ),
        ]),
      ],
    ),
  ],
);
```

And the scaffold most people write first, because it is how every `NavigationBar` sample without a router looks:

```dart
// Flutter 3.44.8, go_router 18.0.2 -- DRIFTS, do not copy
class AppScaffold extends StatefulWidget {
  const AppScaffold({super.key, required this.navigationShell});
  final StatefulNavigationShell navigationShell;

  @override
  State<AppScaffold> createState() => _AppScaffoldState();
}

class _AppScaffoldState extends State<AppScaffold> {
  int _selectedIndex = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: widget.navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: (index) {
          setState(() => _selectedIndex = index);
          widget.navigationShell.goBranch(index);
        },
        destinations: const [
          NavigationDestination(icon: Icon(Icons.list), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}
```

A slightly smarter variant initialises the field from the shell (`_selectedIndex = widget.navigationShell.currentIndex;` in `initState`). That fixes the cold start and nothing else. `StatefulNavigationShell` is keyed with a stable key per shell route, and your scaffold sits at the same position in the tree with the same type, so Flutter keeps its `State` across route changes. `initState` runs once per app session, not once per navigation.

## What each pattern actually shows

I drove all of these with widget tests (`tester.tap`, `GoRouter.go`, `GoRouter.push`) and read `NavigationBar.selectedIndex` after `pumpAndSettle`. "Correct" is the tab whose branch the visible page lives in.

| Scenario | Page shown | `setState` field | Copy in `initState` | `navigationShell.currentIndex` |
| --- | --- | --- | --- | --- |
| Cold start at `/profile` | Profile | 0 (wrong) | 1 | 1 |
| `context.go('/profile/settings')` from Orders | Settings | 0 (wrong) | 0 (wrong) | 1 |
| `router.go('/profile')` from outside the widget tree | Profile | 0 (wrong) | 0 (wrong) | 1 |
| `context.go('/orders/42')` from Profile | Order 42 | 0 | 1 (wrong) | 0 |
| User taps Profile, then Orders | Profile, Orders | 1, 0 | 1, 0 | 1, 0 |

Only the last row, the one every developer tests by hand, works for all three. The shell index was right in every scenario.

## The fix: read currentIndex on every build

The correct scaffold is stateless. It has nothing to keep, because the router keeps it:

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
class AppScaffold extends StatelessWidget {
  const AppScaffold({super.key, required this.navigationShell});
  final StatefulNavigationShell navigationShell;

  void _onTap(int index) {
    navigationShell.goBranch(
      index,
      // Tapping the tab you are already on pops that branch back to its root.
      initialLocation: index == navigationShell.currentIndex,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: navigationShell.currentIndex,
        onDestinationSelected: _onTap,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.list), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}
```

The steps, in order:

1. Make the shell scaffold take the `StatefulNavigationShell` from the `StatefulShellRoute` builder and render it as the `body`.
2. Set `NavigationBar.selectedIndex` to `navigationShell.currentIndex`. Delete any `_selectedIndex` field and every `setState` that touched it.
3. In `onDestinationSelected`, call `navigationShell.goBranch(index)`. Do not call `context.go('/profile')` to switch tabs: it works, but it throws away that branch's saved stack instead of restoring it.
4. Pass `initialLocation: index == navigationShell.currentIndex` so a second tap on the active tab resets it to the branch root, which is the behaviour iOS and Android users expect.
5. If the same scaffold renders a `NavigationRail` on wide screens, feed it the same `currentIndex`. One source, two widgets, no sync code.

There is no "update the bar when the route changes" step. A tap calls `goBranch`, the router changes location, go_router builds a new shell with a new `currentIndex`, and the bar follows. The tap does not even need to rebuild anything locally.

The 2026/06 guide on [nested routes and deep links with go_router](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/) shows this same wiring as part of a full shell setup. This post is about why the shortcuts around it break.

## Reacting to tab changes without storing the index

Sometimes you do need to know when the tab changed: logging a screen view, pausing a video on the tab you left, scrolling a list back to the top. The temptation is to bring back the `_selectedIndex` field "just for that". You do not need it. Make the scaffold a `StatefulWidget` again, but compare the old and new shell in `didUpdateWidget`:

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.0.2
class _AppScaffoldState extends State<AppScaffold> {
  @override
  void didUpdateWidget(AppScaffold oldWidget) {
    super.didUpdateWidget(oldWidget);
    final from = oldWidget.navigationShell.currentIndex;
    final to = widget.navigationShell.currentIndex;
    if (from != to) {
      analytics.logTabChange(from: from, to: to);
    }
  }

  @override
  Widget build(BuildContext context) {
    // selectedIndex still comes from widget.navigationShell.currentIndex
    return Scaffold(body: widget.navigationShell /* , bottomNavigationBar: ... */);
  }
}
```

Driven by `router.go('/profile')` and then `router.go('/orders')`, this logged `initState 0`, `tab changed 0 -> 1`, `tab changed 1 -> 0`. It fires for taps, deep links and programmatic navigation alike, because it watches the router's answer rather than the bar's input. Keep the work in `didUpdateWidget` cheap and free of navigation: calling `goBranch` from inside a build-phase callback is a fast way to get [setState() or markNeedsBuild() called during build](/2026/06/fix-setstate-or-markneedsbuild-called-during-build-in-flutter/).

## Gotchas and edge cases

### Deriving the index from the location lies after a cross-branch push

The other common pattern, inherited from plain `ShellRoute`, is to compute the index from the URL: `state.uri.path.startsWith('/profile') ? 1 : 0`. It survives deep links and `context.go`, which is why people trust it. It breaks on `push`.

When the Profile page calls `context.push('/orders/42')`, go_router 18.0.2 pushes the order page onto the *current* branch's navigator. I checked this in a test: the pushed page sits inside the shell scaffold, `currentIndex` stays 1, and after switching to Orders and back to Profile, the Profile tab still shows Order 42 on top of its stack. The location, however, is now `/orders/42`, so the location-derived bar highlights Orders while the user is inside the Profile stack. Tap Orders and you get the Orders branch, not the page you were looking at. `currentIndex` reported 1 the whole time, which matches where the page actually lives.

If you want an order detail to open under the Orders tab, use `context.go('/orders/42')` (it switches branch, and `currentIndex` becomes 0). If you want it on top of the current tab, `push` is fine. Either way, let `currentIndex` decide which tab is lit.

### Plain ShellRoute has no currentIndex

A non-stateful `ShellRoute` gives you a single nested navigator and a `child`, with no branches and no index. There you have to map location to tab yourself. Do it from the builder's `GoRouterState` (or `GoRouterState.of(context)`), and match on `uri.path`, not `matchedLocation`. In my test, after `push('/orders/7')` from `/profile`, the shell's state reported `uri=/orders/7`, `fullPath=/orders/:id` and `matchedLocation=/profile`. The same push caveat from the previous section applies, and it is one more reason to move tabbed layouts to `StatefulShellRoute.indexedStack` if you also want each tab to keep its own back stack (the [go_router vs auto_route vs Navigator 2.0 comparison](/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/) covers what each router offers for tabs).

### Full-screen routes on the root navigator

A checkout or a media viewer often lives under a branch's path but should cover the bar, so it is declared with `parentNavigatorKey: rootNavigatorKey`. Pushing it from Profile left `currentIndex` at 1 with no scaffold on stage, and popping returned to Profile with the right tab lit. Going to it directly with `router.go('/orders/checkout')` built the shell underneath with `currentIndex` 0, because the route belongs to the Orders branch. In both cases the bar is correct when it reappears, without any code.

### A branch that has no destination in the bar

It is common to have a branch that is reachable only by link, for example an Inbox branch opened from a notification, with no icon in the bar. `currentIndex` will then be 2 with two destinations, and `NavigationBar` asserts `0 <= selectedIndex && selectedIndex < destinations.length` in debug builds. Map branches to destinations explicitly instead of passing the index through:

```dart
// Flutter 3.44.8, go_router 18.0.2
// Branch order: 0 orders, 1 profile, 2 inbox (no bar destination).
const _branchForDestination = [0, 1];

int _destinationFor(int branch) {
  final i = _branchForDestination.indexOf(branch);
  return i == -1 ? 0 : i; // NavigationBar cannot show "nothing selected"
}

NavigationBar(
  selectedIndex: _destinationFor(navigationShell.currentIndex),
  onDestinationSelected: (i) =>
      navigationShell.goBranch(_branchForDestination[i]),
  destinations: const [ /* Orders, Profile */ ],
);
```

`NavigationRail.selectedIndex` is nullable, so on a rail you can return `null` and show no selection for hidden branches.

### Reordering or hiding tabs at runtime

If the destinations change based on a feature flag or the user's role, the branch list in the router usually does not. Keep the branch indexes fixed and remap them through a table as above. Changing the branches themselves on the fly means a new router configuration, and go_router 18.0.2's changelog notes a fix for pushed routes inside a shell being lost when a dynamic routing configuration changes, so stay on 18.0.2 or later if you do that.

### Testing the sync

Every scenario in the table above is a cheap widget test. Build a `MaterialApp.router` with your real router, start it at a deep link with `initialLocation`, call `router.go(...)` from the test, and assert on `tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex`. If your tabs show time-based content, combine this with the approach from [testing a Flutter widget at a fixed point in time](/2026/08/how-to-test-a-flutter-widget-at-a-fixed-point-in-time/) so the assertions are deterministic. One test per navigation entry point (deep link, in-page `go`, notification handler) catches the drift before a user does.

## The rule of thumb

If you find yourself writing `setState` next to a `NavigationBar` inside a go_router shell, stop. The router owns the location, the location decides the branch, and `StatefulNavigationShell.currentIndex` is that decision. Read it, never copy it, and the bar cannot fall out of sync no matter how the user got there.

## Sources

- [go_router 18.0.2 on pub.dev](https://pub.dev/packages/go_router) and its [changelog](https://pub.dev/packages/go_router/changelog)
- [StatefulShellRoute class API](https://pub.dev/documentation/go_router/latest/go_router/StatefulShellRoute-class.html)
- [StatefulNavigationShell class API](https://pub.dev/documentation/go_router/latest/go_router/StatefulNavigationShell-class.html) (`currentIndex`, `goBranch`)
- [go_router source: `lib/src/route.dart`](https://github.com/flutter/packages/blob/main/packages/go_router/lib/src/route.dart)
- [Official StatefulShellRoute example](https://github.com/flutter/packages/blob/main/packages/go_router/example/lib/stateful_shell_route.dart)
- [NavigationBar class API](https://api.flutter.dev/flutter/material/NavigationBar-class.html)
