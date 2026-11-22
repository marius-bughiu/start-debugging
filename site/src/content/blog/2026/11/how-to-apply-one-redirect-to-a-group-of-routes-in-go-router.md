---
title: "How to apply one shared redirect to a group of routes in go_router (without touching the global redirect)"
description: "Put the guarded routes under a builderless parent GoRoute and give that parent the redirect. It runs for go, push, deep links and cold starts, adds no Navigator and no page. Verified with widget tests on Flutter 3.44.8 and go_router 18.1.4, plus the self-redirect trap that silently lets users through and the metadata-based alternative."
pubDate: 2026-11-22
template: how-to
tags:
  - "flutter"
  - "dart"
  - "go-router"
  - "navigation"
  - "how-to"
---

To guard a group of routes in go_router with one `redirect`, nest them under a parent `GoRoute` that has a `redirect` and no `builder`. A route-level redirect runs whenever any route below it is matched, so every child is covered, including ones added later. A builderless parent ("redirect-only route") produces no page and no extra `Navigator`, which is what you lose by using a UI-less `ShellRoute` instead. Everything below was verified with widget tests on Flutter 3.44.8 (Dart 3.12.2) and go_router 18.1.4, the current release on 2026-11-22.

The question comes from a [Stack Overflow thread](https://stackoverflow.com/questions/80016954) where the asker tried four options (the global redirect, a shared function wired to every route, a `ProtectedGoRoute` subclass, and an empty `ShellRoute`) and asked which one is idiomatic. The answers there disagree on whether a builderless parent even works. It does, with two rules you have to follow, and with one trap that turns your guard into a no-op.

## The shape that works

```dart
// Flutter 3.44.8, Dart 3.12.2, go_router 18.1.4
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

final isAdmin = ValueNotifier<bool>(false);

String? adminGuard(BuildContext context, GoRouterState state) {
  if (!isAdmin.value) return '/home';            // 1. leave the group
  if (state.uri.path == '/admin') return '/admin/dashboard'; // 2. never stop on the parent
  return null;                                   // 3. let the child through
}

final router = GoRouter(
  initialLocation: '/home',
  refreshListenable: isAdmin, // re-run redirects when the role changes
  routes: [
    GoRoute(path: '/home', builder: (_, __) => const HomeScreen()),
    GoRoute(
      path: '/admin',
      redirect: adminGuard, // no builder, no pageBuilder
      routes: [
        GoRoute(path: 'dashboard', builder: (_, __) => const DashboardScreen()),
        GoRoute(path: 'secret', builder: (_, __) => const SecretScreen()),
      ],
    ),
  ],
);
```

`GoRoute` asserts that at least one of `builder`, `pageBuilder` or `redirect` is set, and the source names the builderless case explicitly: `bool get redirectOnly => pageBuilder == null && builder == null`. When the delegate turns the match list into pages, a `GoRoute` with no builder returns `null` from `_buildPageForGoRoute` and is skipped. So `/admin/dashboard` produces exactly one page, `DashboardScreen`, and `router.canPop()` is `false` right after `go('/admin/dashboard')`. Nothing for the back button to land on.

One of the answers on the thread says "a parent with no builder has nothing to build, so it throws". That is not what happens on go_router 18.1.4. It only throws when the parent is the **last** match, which is rule 2 below.

## Why a parent redirect covers every child

go_router collects redirects from the whole matched chain, not just the leaf. In `RouteConfiguration._processRouteLevelRedirects`, it visits every match in the `RouteMatchList`, keeps those whose route has a `redirect`, and evaluates them in tree order. The first one to return a non-null location wins. The dartdoc on `RouteBase.redirect` states the same thing: "If there are multiple redirects in the matched routes, the parent route's redirect takes priority over sub-route's."

The full order, logged from a test navigating an admin to `/admin/secret` where `secret` has its own redirect too:

```text
top-level redirect: /admin/secret
group redirect: uri=/admin/secret matched=/admin fullPath=/admin/secret
child redirect: /admin/secret
```

So the top-level `GoRouter.redirect` runs first, then the parent, then the child. Two details from that log matter when you write the guard:

- `state.matchedLocation` is the **parent's** location (`/admin`), not the URL being opened.
- `state.uri` and `state.fullPath` describe the full target (`/admin/secret`). Branch on `state.uri.path` if the guard needs to know which child is being opened.

When a route-level redirect returns a new location, go_router recurses back into the whole pipeline, so the top-level redirect runs again for `/home`. That is the third log line you see when a non-admin is bounced:

```text
top-level redirect: /admin/dashboard
group redirect: uri=/admin/dashboard matched=/admin fullPath=/admin/dashboard
top-level redirect: /home
```

## Every navigation path goes through it

The asker's worry with per-route wiring was forgetting a route. The equivalent worry here is forgetting a navigation path. These are the ones the test suite drove, all as a non-admin:

| Navigation | Result |
|---|---|
| `router.go('/admin/dashboard')` | Lands on `/home` |
| `router.push('/admin/secret')` | Redirected, but see the push gotcha below |
| Deep link while running (`pushRouteInformation` on `flutter/navigation`) | Lands on `/home` |
| Cold start with `initialLocation: '/admin/secret'` | Lands on `/home` |
| Role revoked while on `/admin/dashboard` (`isAdmin.value = false`) | Moved to `/home` via `refreshListenable` |

The deep-link case was simulated the way the engine delivers a link to a running app:

```dart
// Flutter 3.44.8: what the OS sends when a link opens a running app
Future<void> deepLink(WidgetTester tester, String location) async {
  final message = const JSONMethodCodec().encodeMethodCall(
    MethodCall('pushRouteInformation', {'location': location}),
  );
  await tester.binding.defaultBinaryMessenger
      .handlePlatformMessage('flutter/navigation', message, (_) {});
  await tester.pumpAndSettle();
}
```

The last row is the one people miss. Route-level redirects do not watch anything on their own; they run when the router re-parses. Pass the same `Listenable` that holds the role (a `ValueNotifier`, a `ChangeNotifier` auth service, a `GoRouterRefreshStream` wrapper for a Bloc) as `refreshListenable`, and a revoked role kicks the user out of the group immediately. If the cold-start path is the one misbehaving on a real device, that is usually a link-delivery problem rather than a redirect problem, covered in [why a go_router deep link lands on the wrong screen after a cold start](/2026/11/fix-go-router-deep-link-cold-start-app-links-getinitiallink-null/).

## The two rules a redirect-only parent imposes

### Rule 1: never stop on the parent itself

If someone navigates to `/admin` and the guard returns `null`, the leaf of the match list is the builderless route. In debug builds that trips an assertion in the parser:

```text
'package:go_router/src/parser.dart': Failed assertion: line 200 pos 21:
'!matchList.last.route.redirectOnly': A redirect-only route must redirect
to location different from itself.
 The offending route: GoRoute#c9c5b(name: null, path: "/admin", Redirect Only)
```

The fix is the second line of `adminGuard`: when `state.uri.path` is the parent's own path, send the user to a default child. With that line, `go('/admin')` lands on `/admin/dashboard`.

### Rule 2: never redirect into the group you are guarding

This is the trap, and it fails open. Suppose the group has a "request access" page and the guard sends non-admins there:

```dart
// Flutter 3.44.8, go_router 18.1.4 -- DO NOT DO THIS
redirect: (_, state) => isAdmin.value ? null : '/admin/dashboard',
```

You would expect either a loop error or the user being stuck. What the test actually shows is that a non-admin who opens `/admin/secret` ends up **looking at `DashboardScreen`**, no exception. Here is why. The first pass redirects `/admin/secret` to `/admin/dashboard`. The second pass matches the parent again, the guard returns `/admin/dashboard` again, and `_processRouteLevelRedirects` only treats a result as a redirect when `routeRedirectLocation != prevLocation`. Same location, so it counts as "no redirect" and the page is built.

That makes any page the guard redirects to inside its own subtree publicly reachable. Keep the fallback target outside the group (`/home`, `/login`, `/forbidden`), or, if it has to live under `/admin` in the URL, give it its own parent that is not guarded.

A real loop, by contrast, is reported loudly. If the top-level redirect sends `/home` to `/admin/dashboard` and the group sends non-admins to `/home`, go_router shows its error page with:

```text
GoException: redirect loop detected /admin/dashboard => /home => /admin/dashboard
```

## Keeping the URLs without an /admin prefix

The asker wanted `/dashboard` and `/secret`, not `/admin/dashboard`. You can keep flat URLs by giving the redirect-only parent the path `/`, even if another route already owns `/`:

```dart
// Flutter 3.44.8, go_router 18.1.4
GoRouter(
  routes: [
    GoRoute(
      path: '/',
      builder: (_, __) => const HomeScreen(),
      routes: [GoRoute(path: 'about', builder: (_, __) => const AboutScreen())],
    ),
    GoRoute(
      path: '/', // second '/' route: a redirect-only group with flat child paths
      redirect: (_, state) => isAdmin.value ? null : '/',
      routes: [
        GoRoute(path: 'dashboard', builder: (_, __) => const DashboardScreen()),
        GoRoute(path: 'secret', builder: (_, __) => const SecretScreen()),
      ],
    ),
  ],
);
```

The matcher walks the route tree depth-first and backtracks when a subtree has no match for the rest of the path, so `/about` still resolves through the first `/` route, while `/dashboard` and `/secret` resolve through the second. In the test, a non-admin opening `/dashboard` lands on `/` and an admin opening `/secret` sees `SecretScreen`. Rule 1 is handled for free here: a bare `/` matches the first route, which has a builder, so the redirect-only parent is never the leaf.

Two caveats. Declaration order matters: if two subtrees can both match a path, the first one wins, so keep guarded paths unique. And this is less obvious to the next reader than a prefix, so leave a comment on the second `/`.

## Why not a UI-less ShellRoute

The asker's own solution works. The test confirms the redirect on a `ShellRoute` runs for its children exactly like a `GoRoute` parent's. The cost is structural:

```dart
// Flutter 3.44.8, go_router 18.1.4 -- works, but adds a Navigator
ShellRoute(
  redirect: (_, __) => isAdmin.value ? null : '/home',
  builder: (_, __, child) => child,
  routes: [
    GoRoute(path: '/dashboard', builder: (_, __) => const DashboardScreen()),
    GoRoute(path: '/secret', builder: (_, __) => const SecretScreen()),
  ],
)
```

With this config there are two `Navigator` widgets in the tree instead of one, and `Navigator.of(context)` from `SecretScreen` is the nested one, not the root. Every guarded page now lives in a second stack. That changes how back gestures resolve (the inner stack pops first), means a `parentNavigatorKey` is needed for anything that must cover the whole screen (dialogs, full-screen pages), and splits transitions between the two levels: entering the group animates the shell page on the root navigator, moving inside it animates on the inner one. The same nested-navigator mechanics are behind several of the back-stack gotchas in [setting up nested routes and deep links with go_router](/2026/06/how-to-set-up-nested-routes-and-deep-links-with-go-router-in-flutter/). None of that is broken, but you pay for it in exchange for nothing, since the shell renders no UI. Use `ShellRoute` when you need persistent chrome around the child, and a redirect-only `GoRoute` when you only need a guard.

## The alternative: tag the group with metadata, check it once at the top

If what bothers you about the global redirect is that it has to know which paths are protected, invert it: let the routes declare a requirement and keep the top-level redirect generic. go_router 17.5.0 added `GoRoute.metadata`, which children inherit (a child's keys override the parent's), and the merged map is on `GoRouterState.metadata`, including the state passed to the top-level redirect.

```dart
// Flutter 3.44.8, go_router 18.1.4 (metadata needs go_router >= 17.5.0)
GoRouter(
  initialLocation: '/home',
  redirect: (_, state) {
    final role = state.metadata['requiresRole'];
    if (role == 'admin' && !isAdmin.value) return '/home';
    return null;
  },
  routes: [
    GoRoute(path: '/home', builder: (_, __) => const HomeScreen()),
    GoRoute(
      path: '/admin',
      metadata: const {'requiresRole': 'admin'},
      // still redirect-only: send the bare parent to a child
      redirect: (_, state) => state.uri.path == '/admin' ? '/admin/dashboard' : null,
      routes: [
        GoRoute(path: 'dashboard', builder: (_, __) => const DashboardScreen()),
        GoRoute(
          path: 'audit',
          metadata: const {'title': 'Audit'},
          builder: (_, __) => const AuditScreen(),
        ),
      ],
    ),
  ],
);
```

The test logged the state seen by the top-level redirect for `/admin/audit` as `{requiresRole: admin, title: Audit}`, so the flag came down from the parent and merged with the child's own key. A non-admin ends on `/home`, an admin reaches `/admin/audit`.

This scales better than one redirect per group when you have several roles: the top-level redirect becomes a policy function, and adding a protected route means putting it under the right parent (or adding one metadata key), not editing the redirect. The tradeoff is that the policy check runs on every navigation, not only inside the group, which is fine for a synchronous role lookup and worth caching if it is async.

## Gotchas worth knowing before you ship

**A redirected `push` still pushes.** As a non-admin, `router.push('/admin/secret')` resolved to `/home`, but the match list afterwards was `[/home, /home]` and `canPop()` was `true`. go_router keeps the push semantics and pushes the redirect target on top of the current stack. If a "you need admin access" bounce should not leave a duplicate page behind, use `go` for guarded destinations, or redirect to a dedicated page the user can pop away from deliberately.

**The guard is a navigation guard, not authorization.** Anything the protected screen loads still needs a server-side check. A redirect only stops the UI from rendering.

**`context` in the redirect belongs to the router, not to a page.** It is fine for `context.read` on providers above `MaterialApp.router`, but a redirect is a pure "where should this go" function and runs during route parsing, so it is the wrong place for side effects like dialogs or snackbars. Show those on the destination page. If a redirect is async and something awaits around it, the rules from [using BuildContext safely after an await](/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/) apply.

**`onEnter` is not a group guard.** go_router's newer top-level `onEnter` callback can block a navigation, but it is evaluated once per navigation against the literal target, before the redirect chain, and it is router-wide. For "these routes need X", a parent redirect or a metadata check is the better fit.

**Shell routes in the middle of the chain still work.** If the guarded group sits inside a `StatefulShellRoute` branch, put the redirect-only parent inside the branch's routes. The redirect collection walks into shell matches too: `RouteMatchList.visitRouteMatches` recurses into every `ShellRouteMatch` (read from the 18.1.4 source; the tests above did not include a shell branch). For the tab-index side of that setup, see [keeping the NavigationBar selected tab in sync with the current route](/2026/10/how-to-keep-the-navigationbar-selected-tab-in-sync-with-the-current-route-in-go-router/).

## Steps to convert per-route wiring to a group guard

1. Move the guarded routes under one parent `GoRoute`, either with a real prefix (`/admin`) or a second `/` parent if the URLs must stay flat.
2. Remove `builder` and `pageBuilder` from that parent and give it the shared `redirect`.
3. In the redirect, return a target outside the group for unauthorized users, and a default child when `state.uri.path` equals the parent's own path.
4. Pass the role or auth state as `refreshListenable` so a revoked role re-runs the guard.
5. Add a widget test that drives `go`, `push`, a cold start via `initialLocation`, and a role change, and asserts on what is on screen, not only on `router.state.uri`.

## How this was verified

Two widget test files ran under `flutter test` on macOS (Apple silicon), Flutter 3.44.8 stable, Dart 3.12.2, go_router 18.1.4 resolved from pub.dev. The first covers `go`, redirect order, `push`, deep link via `flutter/navigation`, cold start, the bare-parent fallback, the bare-parent assertion, the self-redirect trap, `refreshListenable` and the Navigator count (9 tests, all passing). The second covers the flat `/` group, the metadata policy, the UI-less `ShellRoute`, the redirected push stack and the redirect loop (5 tests, all passing). The outputs quoted above are copied from those runs. No physical device or browser was used, so platform link delivery itself is out of scope here.

If you are still choosing a router, the redirect story is one of the main differences covered in [go_router vs auto_route vs Navigator 2.0](/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/).

## Sources

- [go_router `RouteBase.redirect` API docs](https://pub.dev/documentation/go_router/latest/go_router/RouteBase/redirect.html)
- [go_router `RouteBase.metadata` API docs](https://pub.dev/documentation/go_router/latest/go_router/RouteBase/metadata.html)
- [go_router redirection example](https://github.com/flutter/packages/blob/main/packages/go_router/example/lib/redirection.dart)
- [go_router route metadata example](https://github.com/flutter/packages/blob/main/packages/go_router/example/lib/route_metadata.dart)
- [go_router changelog](https://pub.dev/packages/go_router/changelog) (17.5.0 adds route metadata)
- [Stack Overflow: How to apply a common redirect to a specific group of routes?](https://stackoverflow.com/questions/80016954)
